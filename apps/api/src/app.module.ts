import { Module } from '@nestjs/common';
import { DatabaseModule, LoggerModule } from '@app/common';
import { ConfigModule } from '@app/common/config/config.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { TeamsModule } from './teams/teams.module';
import { CarsModule } from './cars/cars.module';
import { SessionsModule } from './sessions/sessions.module';
import { LiveTelemetryModule } from './live-telemetry/live-telemetry.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    AuthModule,
    UsersModule,
    TeamsModule,
    CarsModule,
    SessionsModule,
    LiveTelemetryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
