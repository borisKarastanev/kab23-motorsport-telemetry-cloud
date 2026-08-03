import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, MqttContext, Payload } from '@nestjs/microservices';
import { SESSION_TOPIC_WILDCARD, TELEMETRY_TOPIC_WILDCARD } from '@app/common';

/**
 * Phase 0 shell: confirms the Pi → MQTT → cloud path end-to-end. Phase 2
 * replaces the log with a TimescaleDB write + Redis publish.
 *
 * Frames carry GPS traces — a named driver's location, and competitively
 * sensitive besides — so only shape/counts are logged at info level. Full
 * payloads go to debug, which stays off outside local troubleshooting.
 */
@Controller()
export class TelemetryController {
  private readonly logger = new Logger(TelemetryController.name);

  @EventPattern(TELEMETRY_TOPIC_WILDCARD)
  handleTelemetry(@Payload() data: unknown, @Ctx() context: MqttContext) {
    this.logger.log(
      `telemetry frame on ${context.getTopic()} (${
        Object.keys(data ?? {}).length
      } fields)`,
    );
    this.logger.debug(JSON.stringify(data));
  }

  @EventPattern(SESSION_TOPIC_WILDCARD)
  handleSession(@Payload() data: unknown, @Ctx() context: MqttContext) {
    const event = (data as { event?: string })?.event ?? 'unknown';
    this.logger.log(`session event '${event}' on ${context.getTopic()}`);
    this.logger.debug(JSON.stringify(data));
  }
}
