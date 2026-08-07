import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Applies the configured CORS allowlist to the socket.io server.
 *
 * `@WebSocketGateway({ cors })` cannot do this. A decorator's arguments are
 * evaluated when the class is *defined* — before Nest exists, let alone
 * `ConfigService` — so anything there has to be a literal, which is how the
 * gateway ended up with `origin: true` hardcoded. An adapter is constructed in
 * `main.ts`, where config is already resolved.
 *
 * Leaving the gateway behind would be the easy mistake here. The live socket
 * carries exactly the data the REST tightening is meant to protect: a named
 * driver's GPS, in real time.
 *
 * **What this does and does not cover.** engine.io applies `cors` in its HTTP
 * request handler, so it governs the polling handshake — but browsers do not
 * enforce CORS on a WebSocket handshake at all, so a client opening the socket
 * with `transports: ['websocket']` never consults it. This is therefore defence
 * in depth, not the boundary. The boundary is the gateway's own handshake
 * middleware, which resolves the `Authentication` cookie and refuses the
 * connection outright, plus `requireReadableCar` on every `subscribe`; and the
 * cookie is `sameSite: 'lax'`, so a cross-site page cannot get the browser to
 * attach it in the first place. Tightening this further would mean an
 * `allowRequest` callback comparing `handshake.headers.origin` against the same
 * list — worth doing if the cookie's SameSite policy is ever relaxed.
 */
export class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly cors: CorsOptions,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, { ...options, cors: this.cors });
  }
}
