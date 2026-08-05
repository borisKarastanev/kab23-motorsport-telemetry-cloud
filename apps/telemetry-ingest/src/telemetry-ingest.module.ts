import { Module } from '@nestjs/common';
import { DatabaseModule, LoggerModule, RedisModule } from '@app/common';
import { ConfigModule } from '@app/common/config/config.module';
import { TelemetryController } from './telemetry/telemetry.controller';
import { TelemetryService } from './telemetry/telemetry.service';
import { TelemetryWriterService } from './telemetry/telemetry-writer.service';
import { LivePublisherService } from './telemetry/live-publisher.service';
import { TelemetrySchemaService } from './telemetry/telemetry-schema.service';
import { DeviceRegistryService } from './telemetry/device-registry.service';
import { TelemetrySample } from './telemetry/entities/telemetry-sample.entity';
import { IngestSessionsService } from './sessions/ingest-sessions.service';
import { CarRef } from './sessions/entities/car-ref.entity';
import { SessionRef } from './sessions/entities/session-ref.entity';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    RedisModule,
    // `TelemetrySample` is registered for its metadata only — it is
    // `synchronize: false` and written through the query builder. `CarRef` and
    // `SessionRef` are thin views of tables `apps/api` owns; see
    // `car-ref.entity.ts` for why they are duplicated rather than shared.
    DatabaseModule.forFeature([TelemetrySample, CarRef, SessionRef]),
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    TelemetryWriterService,
    LivePublisherService,
    TelemetrySchemaService,
    DeviceRegistryService,
    IngestSessionsService,
  ],
})
export class TelemetryIngestModule {}
