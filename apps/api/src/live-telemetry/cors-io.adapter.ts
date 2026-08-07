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
 * driver's GPS, in real time. A locked-down `/api` next to a websocket that
 * accepts any origin with credentials is not a smaller hole, it is the same one.
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
