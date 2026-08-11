import { REDIS_CLIENT, lkvCarKey } from '@app/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { CarsService } from '../cars/cars.service';
import { User } from '../users/entities/user.entity';
import { LiveTelemetryBusService } from './live-telemetry-bus.service';
import { LiveTelemetryGateway, carRoom } from './live-telemetry.gateway';

const CAR_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const user = { id: USER_ID } as User;

/** Enough of a socket.io Socket for the gateway's use of it. */
const fakeSocket = (cookie?: string) => {
  const rooms = new Set<string>();
  return {
    data: {} as Record<string, unknown>,
    handshake: { headers: cookie ? { cookie } : {} },
    rooms,
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn(async (room: string) => {
      rooms.add(room);
    }),
    leave: jest.fn(async (room: string) => {
      rooms.delete(room);
    }),
  };
};

type FakeSocket = ReturnType<typeof fakeSocket>;

describe('LiveTelemetryGateway', () => {
  let gateway: LiveTelemetryGateway;
  let bus: jest.Mocked<Partial<LiveTelemetryBusService>>;
  let cars: jest.Mocked<Partial<CarsService>>;
  let auth: jest.Mocked<Partial<AuthService>>;
  let redis: { get: jest.Mock };

  /** Runs the connection middleware, returning what it passed to `next`. */
  const handshake = async (client: FakeSocket): Promise<Error | undefined> => {
    let refusal: Error | undefined;
    await gateway.authenticate(client as unknown as Socket, (error) => {
      refusal = error;
    });
    return refusal;
  };

  /** A socket that has been through a successful handshake. */
  const connected = async (): Promise<FakeSocket> => {
    const client = fakeSocket('Authentication=a.valid.token');
    await handshake(client);
    return client;
  };

  beforeEach(async () => {
    bus = {
      setHandler: jest.fn(),
      addViewer: jest.fn().mockResolvedValue(undefined),
      removeViewer: jest.fn().mockResolvedValue(undefined),
    };
    cars = { requireReadableCar: jest.fn().mockResolvedValue({ id: CAR_ID }) };
    auth = { userFromToken: jest.fn().mockResolvedValue({ user }) };
    redis = { get: jest.fn().mockResolvedValue(null) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LiveTelemetryGateway,
        { provide: LiveTelemetryBusService, useValue: bus },
        { provide: CarsService, useValue: cars },
        { provide: AuthService, useValue: auth },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    gateway = moduleRef.get(LiveTelemetryGateway);
  });

  describe('handshake', () => {
    it('resolves the user from the Authentication cookie', async () => {
      const client = await connected();

      expect(auth.userFromToken).toHaveBeenCalledWith('a.valid.token');
      expect(client.data.user).toBe(user);
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('reads its cookie out of a header carrying several', async () => {
      const client = fakeSocket('foo=bar; Authentication=a.valid.token; x=y');
      await handshake(client);

      expect(auth.userFromToken).toHaveBeenCalledWith('a.valid.token');
    });

    it('refuses the connection outright when there is no cookie', async () => {
      // Refused in middleware, not after connecting: `handleConnection` is not
      // awaited before messages are delivered, so a client that emits
      // `subscribe` on connect would otherwise race an unfinished handshake.
      const client = fakeSocket();

      const refusal = await handshake(client);

      expect(refusal).toBeInstanceOf(Error);
      expect((client.data as { user?: unknown }).user).toBeUndefined();
    });

    it('refuses a socket whose token does not verify', async () => {
      auth.userFromToken.mockRejectedValue(new Error('invalid signature'));
      const client = fakeSocket('Authentication=forged');

      const refusal = await handshake(client);

      // Generic, like a failed login: no hint about which part was wrong.
      expect(refusal?.message).toBe('Unauthorized');
    });

    it('lets a valid cookie through', async () => {
      const client = fakeSocket('Authentication=a.valid.token');

      expect(await handshake(client)).toBeUndefined();
    });
  });

  describe('authorization', () => {
    it('refuses a car outside the caller tenant and joins no room', async () => {
      // The tenant boundary of the whole live path. Being connected says
      // nothing about whose garage a car is in.
      cars.requireReadableCar.mockRejectedValue(new NotFoundException());
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.rooms.has(carRoom(CAR_ID))).toBe(false);
      expect(bus.addViewer).not.toHaveBeenCalled();
      expect(redis.get).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Car not found',
      });
    });

    it('does not distinguish a missing car from someone else car', async () => {
      // Two different messages would confirm the id belongs to a real car in
      // another team's garage.
      cars.requireReadableCar.mockRejectedValue(new NotFoundException());
      const client = await connected();
      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      const [[, refused]] = client.emit.mock.calls;
      expect(refused).toEqual({ message: 'Car not found' });
    });

    it('authorizes before subscribing, not after', async () => {
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(cars.requireReadableCar.mock.invocationCallOrder[0]).toBeLessThan(
        bus.addViewer.mock.invocationCallOrder[0],
      );
    });

    it('refuses a subscribe from a socket with no user', async () => {
      // Not reachable through the middleware, but the check stays: a future
      // change that lets an unauthenticated socket through must not also hand
      // it another team's telemetry.
      const client = fakeSocket();
      await handshake(client);
      client.emit.mockClear();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(cars.requireReadableCar).not.toHaveBeenCalled();
      expect(bus.addViewer).not.toHaveBeenCalled();
    });

    it('refuses a subscribe with no car id', async () => {
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, {});

      expect(cars.requireReadableCar).not.toHaveBeenCalled();
    });
  });

  describe('subscribe', () => {
    it('joins the room and registers a viewer', async () => {
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.rooms.has(carRoom(CAR_ID))).toBe(true);
      expect(bus.addViewer).toHaveBeenCalledWith(CAR_ID);
    });

    it('seeds the new viewer from the last-known value', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ v: 1, carId: CAR_ID }));
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(redis.get).toHaveBeenCalledWith(lkvCarKey(CAR_ID));
      expect(client.emit).toHaveBeenCalledWith('frame', {
        v: 1,
        carId: CAR_ID,
      });
    });

    it('still subscribes when there is no last-known value', async () => {
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.rooms.has(carRoom(CAR_ID))).toBe(true);
      expect(client.emit).not.toHaveBeenCalledWith('frame', expect.anything());
    });

    it('does not seed from a stale cached frame', async () => {
      // A frame in flight can re-`SET` the key after the stop that deleted it,
      // and a finished run's last position must not be shown as a live fix.
      redis.get.mockResolvedValue(
        JSON.stringify({ v: 1, carId: CAR_ID, pt: Date.now() - 60_000 }),
      );
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.emit).not.toHaveBeenCalledWith('frame', expect.anything());
    });

    it('does not seed from a cached frame of an unknown version', async () => {
      // The same check the bus applies. A rolling deploy can leave a v2 value
      // in the cache while this instance still speaks v1.
      redis.get.mockResolvedValue(
        JSON.stringify({ v: 2, carId: CAR_ID, pt: Date.now() }),
      );
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.emit).not.toHaveBeenCalledWith('frame', expect.anything());
    });

    it('holds one viewer slot per car however many subscribes race', async () => {
      // Both would otherwise clear the `has` guard before either reached the
      // `add`, taking the refcount to 2 against a single Set entry that
      // handleDisconnect releases once.
      const client = await connected();

      await Promise.all([
        gateway.subscribe(client as unknown as Socket, { carId: CAR_ID }),
        gateway.subscribe(client as unknown as Socket, { carId: CAR_ID }),
      ]);

      expect(bus.addViewer).toHaveBeenCalledTimes(1);
    });

    it('releases its claim when the bus refuses the car', async () => {
      bus.addViewer.mockRejectedValue(new Error('redis is down'));
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.rooms.has(carRoom(CAR_ID))).toBe(false);
      // Not left claimed, so a retry after Redis recovers actually subscribes.
      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });
      expect(bus.addViewer).toHaveBeenCalledTimes(2);
    });

    it('is idempotent for a car the socket already watches', async () => {
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });
      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(bus.addViewer).toHaveBeenCalledTimes(1);
    });
  });

  describe('teardown', () => {
    it('releases every car the socket held on disconnect', async () => {
      // Otherwise the refcount never returns to zero and this instance keeps
      // decoding a car nobody is watching.
      const client = await connected();
      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      gateway.handleDisconnect(client as unknown as Socket);

      expect(bus.removeViewer).toHaveBeenCalledWith(CAR_ID);
    });

    it('leaves the room on unsubscribe', async () => {
      const client = await connected();
      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      await gateway.unsubscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(client.rooms.has(carRoom(CAR_ID))).toBe(false);
      expect(bus.removeViewer).toHaveBeenCalledWith(CAR_ID);
    });

    it('ignores an unsubscribe for a car the socket does not watch', async () => {
      const client = await connected();

      await gateway.unsubscribe(client as unknown as Socket, { carId: CAR_ID });

      expect(bus.removeViewer).not.toHaveBeenCalled();
    });
  });

  describe('afterInit', () => {
    it('wires the connection middleware and the bus handler onto the server', async () => {
      const use = jest.fn();
      const to = jest.fn().mockReturnValue({ emit: jest.fn() });
      const server = { use, to } as unknown as import('socket.io').Server;
      // `@WebSocketServer()` normally populates this before Nest calls
      // `afterInit`; nothing does that wiring in this unit test.
      (gateway as unknown as { server: unknown }).server = server;

      gateway.afterInit(server);

      // The middleware is registered as a plain function that fires-and-forgets
      // `authenticate`; call it the way socket.io would to prove it is wired to
      // the real handshake logic rather than a no-op.
      expect(use).toHaveBeenCalledWith(expect.any(Function));
      const middleware = use.mock.calls[0][0] as (
        socket: unknown,
        next: (error?: Error) => void,
      ) => void;
      const client = fakeSocket();
      const next = jest.fn();
      middleware(client, next);
      // `authenticate` is async and fired without awaiting; give its promise a
      // tick to settle before asserting.
      await Promise.resolve();
      await Promise.resolve();
      expect(next).toHaveBeenCalled();

      // The bus handler fans a frame out to the car's room. Capture what
      // `setHandler` was registered with and invoke it directly, since the
      // real bus is mocked in this suite.
      expect(bus.setHandler).toHaveBeenCalledWith(expect.any(Function));
      const handler = bus.setHandler.mock.calls[0][0] as (message: {
        carId: string;
        kind: string;
        payload: unknown;
      }) => void;
      const emit = jest.fn();
      to.mockReturnValue({ emit });

      handler({ carId: CAR_ID, kind: 'frame', payload: { v: 1 } });

      expect(to).toHaveBeenCalledWith(carRoom(CAR_ID));
      expect(emit).toHaveBeenCalledWith('frame', { v: 1 });
    });
  });

  describe('seed failures', () => {
    it('logs and still leaves the subscribe successful when redis.get throws', async () => {
      redis.get.mockRejectedValue(new Error('redis down'));
      const client = await connected();

      await gateway.subscribe(client as unknown as Socket, { carId: CAR_ID });

      // A missing seed costs one frame of blank gauges — it must not fail the
      // subscribe that has already been authorized.
      expect(client.rooms.has(carRoom(CAR_ID))).toBe(true);
      expect(client.emit.mock.calls.some(([event]) => event === 'error')).toBe(
        false,
      );
    });
  });

  describe('cookie parsing', () => {
    it('skips a malformed part with no = and keeps looking', async () => {
      const client = fakeSocket('malformed; Authentication=a.valid.token');
      await handshake(client);

      expect(auth.userFromToken).toHaveBeenCalledWith('a.valid.token');
    });

    it('returns null when no part matches the cookie name', async () => {
      const client = fakeSocket('foo=bar; baz=qux');

      const refusal = await handshake(client);

      expect(refusal).toBeInstanceOf(Error);
      expect(auth.userFromToken).not.toHaveBeenCalled();
    });
  });

  describe('token expiry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('drops the socket when the token expires', async () => {
      // A browser left open on the pit wall would otherwise still be streaming
      // at midnight on a token that expired at lunchtime.
      auth.userFromToken.mockResolvedValue({
        user,
        exp: Math.floor(Date.now() / 1000) + 60,
      });

      const client = await connected();
      expect(client.disconnect).not.toHaveBeenCalled();

      jest.advanceTimersByTime(60_000);

      expect(client.emit).toHaveBeenCalledWith('error', {
        message: 'Session expired',
      });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it('drops a socket whose token was already expired', async () => {
      auth.userFromToken.mockResolvedValue({
        user,
        exp: Math.floor(Date.now() / 1000) - 1,
      });

      const client = await connected();

      expect(client.disconnect).toHaveBeenCalled();
    });

    it('cancels the expiry timer when the socket goes away first', async () => {
      auth.userFromToken.mockResolvedValue({
        user,
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      const client = await connected();

      gateway.handleDisconnect(client as unknown as Socket);
      client.disconnect.mockClear();
      jest.advanceTimersByTime(60_000);

      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });
});
