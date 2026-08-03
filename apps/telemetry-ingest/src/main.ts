import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Logger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { TelemetryIngestModule } from './telemetry-ingest.module';

/**
 * Pure MQTT consumer. Subscribes to the broker and (Phase 2) writes samples to
 * TimescaleDB + publishes to Redis for the live path. Runs as its own process
 * because its scaling and failure profile differ from the request/response API.
 */
async function bootstrap() {
  // A tiny context app just to resolve config before the microservice starts.
  const appContext = await NestFactory.createApplicationContext(
    TelemetryIngestModule,
    { bufferLogs: true },
  );
  const configService = appContext.get(ConfigService);
  const mqttUrl = configService.get<string>('MQTT_URL');
  await appContext.close();

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    TelemetryIngestModule,
    {
      transport: Transport.MQTT,
      options: { url: mqttUrl },
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));
  await app.listen();
}
bootstrap();
