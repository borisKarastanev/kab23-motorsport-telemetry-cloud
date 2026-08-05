import { LoggerModule, RedisModule } from '@app/common';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CarsModule } from '../cars/cars.module';
import { LiveTelemetryBusService } from './live-telemetry-bus.service';
import { LiveTelemetryGateway } from './live-telemetry.gateway';

/**
 * The live path's browser end: Redis subscriptions in, WebSocket rooms out.
 *
 * `CarsModule` is imported for its authorization primitives, not for its data —
 * the gateway runs `requireReadableCar` on every subscribe. `AuthModule` is
 * imported for `AuthService.userFromToken`, since a handshake happens outside
 * the request cycle where guards would normally do this.
 */
@Module({
  imports: [LoggerModule, RedisModule, AuthModule, CarsModule],
  providers: [LiveTelemetryBusService, LiveTelemetryGateway],
})
export class LiveTelemetryModule {}
