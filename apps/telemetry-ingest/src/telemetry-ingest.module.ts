import { Module } from '@nestjs/common';
import { LoggerModule } from '@app/common';
import { ConfigModule } from '@app/common/config/config.module';
import { TelemetryController } from './telemetry/telemetry.controller';

@Module({
  imports: [ConfigModule, LoggerModule],
  controllers: [TelemetryController],
})
export class TelemetryIngestModule {}
