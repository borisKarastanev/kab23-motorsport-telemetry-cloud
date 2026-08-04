import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { ConfigModule } from '@app/common/config/config.module';
import { TelemetryIngestModule } from './telemetry-ingest.module';

/**
 * Pure MQTT consumer. Subscribes to the broker, writes samples to TimescaleDB
 * and (Phase 3) publishes to Redis for the live path. Runs as its own process
 * because its scaling and failure profile differ from the request/response API.
 */
async function bootstrap() {
  // A tiny context app just to resolve config before the microservice starts:
  // the transport options are needed before the app itself exists.
  //
  // Deliberately ConfigModule alone rather than TelemetryIngestModule — the
  // ingest module now pulls in DatabaseModule, and booting the whole thing here
  // would open and tear down a Postgres pool on every start just to read four
  // environment variables.
  const appContext = await NestFactory.createApplicationContext(ConfigModule, {
    bufferLogs: true,
  });
  const configService = appContext.get(ConfigService);
  const mqttUrl = configService.get<string>('MQTT_URL');
  const username = configService.get<string>('MQTT_USERNAME');
  const password = configService.get<string>('MQTT_PASSWORD');
  await appContext.close();

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    TelemetryIngestModule,
    {
      transport: Transport.MQTT,
      // The broker rejects anonymous connections from Phase 2 on. This account
      // is subscribe-only over `cars/+/#` (scripts/init-mosquitto-dynsec.sh).
      options: { url: mqttUrl, username, password },
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));

  // Load-bearing, not boilerplate: TelemetryWriterService drains its buffer in
  // onApplicationShutdown, and Nest only calls that if shutdown hooks are
  // enabled. Without it every restart silently discards up to 250 ms of
  // buffered samples per car.
  app.enableShutdownHooks();

  await app.listen();
}
bootstrap();
