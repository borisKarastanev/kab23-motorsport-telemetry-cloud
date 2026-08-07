import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import { corsOptionsFor } from './cors-origin';
import { AppModule } from './app.module';
import { CorsIoAdapter } from './live-telemetry/cors-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);

  /**
   * In production this sits behind nginx, which terminates TLS and forwards
   * plain HTTP over the compose network. Without this Express believes every
   * request arrived unencrypted from the proxy container's address, so
   * `req.secure` is false and pino logs one client IP for the entire internet.
   *
   * `1`, not `true`: trust exactly one hop. `true` trusts the whole
   * `X-Forwarded-For` chain, which the client controls, so anyone could name
   * their own source address in the logs.
   */
  app.set('trust proxy', 1);

  /**
   * An allowlist, replacing the `origin: true` of Phases 0–4 — see
   * `corsOptionsFor`. Empty in production, where nginx makes the app
   * same-origin.
   */
  const cors = corsOptionsFor(configService.get<string>('CORS_ORIGIN'));
  app.enableCors(cors);

  // The live gateway has to get the same policy; its decorator cannot read
  // config. See CorsIoAdapter.
  app.useWebSocketAdapter(new CorsIoAdapter(app, cors));

  // Without this Nest never calls onApplicationShutdown, so MqttAdminService
  // would leave its broker connection open on every SIGTERM.
  app.enableShutdownHooks();

  await app.listen(configService.get<number>('PORT') ?? 3000);
}
bootstrap();
