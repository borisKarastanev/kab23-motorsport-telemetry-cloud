import {
  LKV_MAX_SEED_AGE_MS,
  LiveFrame,
  REDIS_CLIENT,
  lkvCarKey,
  parseLiveMessage,
} from '@app/common';
import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { CarsService } from '../cars/cars.service';
import { User } from '../users/entities/user.entity';
import { AUTH_COOKIE } from '../auth/auth.constants';
import { AuthService } from '../auth/auth.service';
import { LiveTelemetryBusService } from './live-telemetry-bus.service';

/** The socket.io room a car's viewers share. Not a Redis channel. */
export const carRoom = (carId: string) => `car:${carId}`;

interface LiveSocketData {
  user?: User;
  /** Cars this socket is currently in the room for. */
  cars: Set<string>;
  /** Fires when the connection's token expires. Cleared on disconnect. */
  expiryTimer?: NodeJS.Timeout;
}

/**
 * Live telemetry to the browser.
 *
 * Two separate checks guard this, and conflating them is the failure mode to
 * avoid:
 *
 * 1. **The handshake** proves who the viewer is, from the same `Authentication`
 *    cookie the REST API uses — through `AuthService`, so the token's shape and
 *    how it resolves to a user stay in one place. No valid cookie, no
 *    connection. It runs as
 *    socket.io *middleware* rather than in `handleConnection`, which matters:
 *    `handleConnection` is not awaited before messages are delivered, so a
 *    client that emits `subscribe` immediately on connect — as this repo's own
 *    Angular client does — would race an unfinished handshake. Middleware
 *    completes before the connection exists at all.
 * 2. **Every `subscribe`** proves they may watch *this car*. Being logged in
 *    says nothing about whose garage a car is in, and `carId` arrives from the
 *    client. `CarsService.requireReadableCar` is the same check the REST routes
 *    run, reused rather than reimplemented — there is no other way into a car's
 *    room.
 *
 * GPS traces are a named driver's location and are competitively sensitive.
 * A gap here is a cross-tenant leak, not a bug in a view.
 */
// CORS is deliberately absent here. It is applied to the whole socket.io server
// by `CorsIoAdapter` in main.ts, from the same `CORS_ORIGIN` allowlist the REST
// API uses — a decorator argument is evaluated before ConfigService exists, so
// this is the only place the two can be kept in step.
@WebSocketGateway({ namespace: '/live' })
export class LiveTelemetryGateway
  implements OnGatewayInit, OnGatewayDisconnect
{
  private readonly logger = new Logger(LiveTelemetryGateway.name);

  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly bus: LiveTelemetryBusService,
    private readonly cars: CarsService,
    private readonly auth: AuthService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  afterInit(server: Server): void {
    // Registered here rather than in a Nest guard: guards run per message, and
    // the connection itself has to be refused before it exists.
    server.use((socket, next) => void this.authenticate(socket, next));

    this.bus.setHandler(({ carId, kind, payload }) => {
      this.server.to(carRoom(carId)).emit(kind, payload);
    });
  }

  /**
   * Socket.io connection middleware: resolves the viewer or refuses the
   * connection. Nothing is delivered to a socket until this calls `next`.
   */
  async authenticate(
    socket: Socket,
    next: (error?: Error) => void,
  ): Promise<void> {
    const data: LiveSocketData = { cars: new Set() };
    socket.data = data;

    try {
      const token = LiveTelemetryGateway.cookie(
        socket.handshake.headers.cookie,
        AUTH_COOKIE,
      );

      if (!token) {
        throw new Error('no token');
      }

      const { user, exp } = await this.auth.userFromToken(token);
      data.user = user;
      // Started here rather than in `handleConnection`, so the one value it
      // needs travels as an argument instead of parked on the socket.
      this.scheduleExpiry(socket, exp);
      next();
    } catch {
      // Deliberately no reason given, and nothing logged about who tried: the
      // same generic outcome as a failed login, for the same reason.
      next(new Error('Unauthorized'));
    }
  }

  handleDisconnect(client: Socket): void {
    const data = client.data as LiveSocketData;

    clearTimeout(data.expiryTimer);

    // Release every car this socket was holding, or the refcount never returns
    // to zero and the instance keeps decoding a car nobody is watching.
    for (const carId of data.cars) {
      void this.bus.removeViewer(carId);
    }
    data.cars.clear();
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, body: { carId?: string }): Promise<void> {
    const data = client.data as LiveSocketData;
    const carId = body?.carId;

    if (!data.user || !carId) {
      client.emit('error', { message: 'Invalid subscribe request' });
      return;
    }

    if (data.cars.has(carId)) {
      return;
    }

    // Claimed before *any* await, and released on every failure path below.
    // Two `subscribe` messages for the same car arriving back to back would
    // otherwise both clear the guard above while the first was still in the
    // authorization call, take the refcount to 2, and leave one viewer's worth
    // of it permanently held — `handleDisconnect` releases once per Set entry.
    data.cars.add(carId);

    try {
      // The tenant boundary. Everything below this line assumes it passed.
      await this.cars.requireReadableCar(data.user, carId);
    } catch {
      // Restated flat, exactly as the REST layer does: distinguishing "no such
      // car" from "not yours" would confirm the id belongs to someone else's
      // garage.
      data.cars.delete(carId);
      client.emit('error', { message: 'Car not found' });
      return;
    }

    try {
      await this.bus.addViewer(carId);
    } catch {
      data.cars.delete(carId);
      client.emit('error', { message: 'Live feed unavailable' });
      return;
    }

    // Independent: the seed is a `GET` emitted to this socket alone, and joining
    // the room shares no state with it. Serialising them would spend a Redis
    // round trip of the very latency the seed exists to remove.
    await Promise.all([client.join(carRoom(carId)), this.seed(client, carId)]);
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(client: Socket, body: { carId?: string }): Promise<void> {
    const data = client.data as LiveSocketData;
    const carId = body?.carId;

    if (!carId || !data.cars.delete(carId)) {
      return;
    }

    await client.leave(carRoom(carId));
    await this.bus.removeViewer(carId);
  }

  // ---------------------------------------------------------------------------

  /**
   * The last-known value, so a viewer joining mid-session renders immediately
   * instead of waiting for the next frame.
   *
   * Runs after the authorization above, never before it — this is a read of
   * another party's position, and its only protection is where it sits.
   */
  private async seed(client: Socket, carId: string): Promise<void> {
    try {
      const cached = await this.redis.get(lkvCarKey(carId));
      if (!cached) {
        return;
      }

      // Decoded through the same gate the bus applies to every message, not a
      // second copy of it: without the version check a rolling deploy — ingest
      // already on v2, this instance still on v1 — would seed a viewer with a
      // payload it would have refused had it arrived over the channel.
      const frame = parseLiveMessage<LiveFrame>(cached);
      if (!frame) {
        return;
      }

      // A frame can outlive the `stop` that deleted this key: frames and
      // session events arrive on different MQTT topics, so one still in flight
      // re-`SET`s it afterwards. Seeding from that would show a finished run's
      // last position as a live fix — the exact thing the TTL exists to stop.
      if (Date.now() - frame.pt > LKV_MAX_SEED_AGE_MS) {
        return;
      }

      // To this socket alone: the rest of the room has been receiving these
      // live all along.
      client.emit('frame', frame);
    } catch {
      // A missing seed costs one frame of blank gauges. Not worth failing a
      // subscribe that has already been authorized.
      this.logger.warn('Could not seed a viewer from the last-known value');
    }
  }

  /**
   * Drops the socket when its token expires.
   *
   * `JWT_EXPIRATION` defaults to an hour, but a socket outlives that trivially
   * — a browser left open on the pit wall would otherwise still be streaming at
   * midnight on a token that expired at lunchtime. Re-authorizing every frame
   * is the wrong end of the trade; disconnecting at expiry lets the client
   * reconnect through the normal cookie flow.
   */
  private scheduleExpiry(client: Socket, exp?: number): void {
    if (!exp) {
      return;
    }

    const remainingMs = exp * 1000 - Date.now();
    if (remainingMs <= 0) {
      client.disconnect(true);
      return;
    }

    (client.data as LiveSocketData).expiryTimer = setTimeout(() => {
      client.emit('error', { message: 'Session expired' });
      client.disconnect(true);
    }, remainingMs);
  }

  /**
   * One cookie out of a raw `Cookie` header.
   *
   * Hand-parsed rather than reusing `cookie-parser`: that is Express
   * middleware, and a WebSocket handshake never passes through the middleware
   * chain. Only the value is read — never logged, never echoed.
   */
  private static cookie(
    header: string | undefined,
    name: string,
  ): string | null {
    if (!header) {
      return null;
    }

    for (const part of header.split(';')) {
      const index = part.indexOf('=');
      if (index === -1) {
        continue;
      }
      if (part.slice(0, index).trim() === name) {
        return decodeURIComponent(part.slice(index + 1).trim());
      }
    }

    return null;
  }
}
