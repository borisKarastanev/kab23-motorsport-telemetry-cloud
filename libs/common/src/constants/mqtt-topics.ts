/**
 * MQTT topic scheme for device telemetry.
 *
 * Cars publish to `cars/<deviceId>/telemetry`; the ingest service subscribes to
 * the `+` wildcard to receive every car. Keep producers (on-car Pi uplink) and
 * this consumer in agreement by sharing these constants.
 */
export const TELEMETRY_TOPIC_WILDCARD = 'cars/+/telemetry';
export const SESSION_TOPIC_WILDCARD = 'cars/+/session';

export const carTelemetryTopic = (deviceId: string) =>
  `cars/${deviceId}/telemetry`;
export const carSessionTopic = (deviceId: string) => `cars/${deviceId}/session`;
