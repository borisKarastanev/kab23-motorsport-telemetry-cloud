import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, MqttContext, Payload } from '@nestjs/microservices';
import {
  BACKFILL_TOPIC_WILDCARD,
  deviceIdFromTopic,
  SESSION_TOPIC_WILDCARD,
  TELEMETRY_TOPIC_WILDCARD,
} from '@app/common';
import { TelemetryService } from './telemetry.service';

/**
 * The MQTT edge of the ingest service. Every handler does the same three
 * things: pull the deviceId out of the topic, hand the payload to
 * `TelemetryService`, and never throw.
 *
 * The deviceId comes from the topic rather than the payload on purpose. The
 * broker ACL confines each car to `cars/<its-deviceId>/…`, so the topic is
 * authenticated — a body field would be whatever the publisher chose to claim.
 *
 * Frames carry GPS traces — a named driver's location, and competitively
 * sensitive besides — so nothing here logs a payload at any level, not even
 * debug.
 */
@Controller()
export class TelemetryController {
  private readonly logger = new Logger(TelemetryController.name);

  constructor(private readonly telemetryService: TelemetryService) {}

  @EventPattern(TELEMETRY_TOPIC_WILDCARD)
  handleTelemetry(
    @Payload() data: unknown,
    @Ctx() context: MqttContext,
  ): Promise<void> {
    return this.dispatch(context, (deviceId) =>
      this.telemetryService.handleFrame(deviceId, data),
    );
  }

  @EventPattern(SESSION_TOPIC_WILDCARD)
  handleSession(
    @Payload() data: unknown,
    @Ctx() context: MqttContext,
  ): Promise<void> {
    return this.dispatch(context, (deviceId) =>
      this.telemetryService.handleSessionEvent(deviceId, data),
    );
  }

  @EventPattern(BACKFILL_TOPIC_WILDCARD)
  handleBackfill(
    @Payload() data: unknown,
    @Ctx() context: MqttContext,
  ): Promise<void> {
    return this.dispatch(context, (deviceId) =>
      this.telemetryService.handleBackfill(deviceId, data),
    );
  }

  /**
   * An event has no caller to return an error to, so a rejected promise here
   * would surface as an unhandled rejection with the payload attached. Every
   * failure stops at this boundary.
   */
  private async dispatch(
    context: MqttContext,
    handle: (deviceId: string) => Promise<void>,
  ): Promise<void> {
    const deviceId = deviceIdFromTopic(context.getTopic());

    if (!deviceId) {
      this.logger.warn('Message on an unrecognised topic shape');
      return;
    }

    try {
      await handle(deviceId);
    } catch (error) {
      this.logger.error(`Ingest failed: ${(error as Error).message}`);
    }
  }
}
