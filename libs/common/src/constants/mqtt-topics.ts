/**
 * MQTT topic scheme for device telemetry.
 *
 * Cars publish to `cars/<deviceId>/…`; the ingest service subscribes to the `+`
 * wildcard to receive every car. Keep producers (on-car Pi uplink) and this
 * consumer in agreement by sharing these constants.
 *
 * Three topics, each with a different delivery contract:
 *
 * - `telemetry` — QoS 0, one frame per message at 10 Hz. A dropped live frame
 *   is not worth a retransmit: the device spools its own durable copy, which
 *   arrives on `backfill`.
 * - `session` — QoS 1. Losing a lifecycle event would strand every frame that
 *   follows it, since the session row is what a frame gets attributed to.
 * - `backfill` — QoS 1. Store-and-forward replay once the LTE link returns.
 *
 * Nothing is published retained. A retained `session` start would be redelivered
 * on every ingest reconnect and re-open a session that has already ended.
 */
export const TELEMETRY_TOPIC_WILDCARD = 'cars/+/telemetry';
export const SESSION_TOPIC_WILDCARD = 'cars/+/session';
export const BACKFILL_TOPIC_WILDCARD = 'cars/+/backfill';

export const carTelemetryTopic = (deviceId: string) =>
  `cars/${deviceId}/telemetry`;
export const carSessionTopic = (deviceId: string) => `cars/${deviceId}/session`;
export const carBackfillTopic = (deviceId: string) =>
  `cars/${deviceId}/backfill`;

/**
 * The `<deviceId>` out of a `cars/<deviceId>/…` topic, or null if the topic is
 * not one of ours.
 *
 * The broker ACL already confines a car to its own topic, so the deviceId here
 * is authenticated: a frame arriving on `cars/X/telemetry` was published by
 * whoever holds X's credential and nobody else. That is what makes it safe to
 * attribute a frame to a tenant from the topic alone.
 */
export const deviceIdFromTopic = (topic: string): string | null => {
  const segments = topic.split('/');
  return segments.length === 3 && segments[0] === 'cars' && segments[1]
    ? segments[1]
    : null;
};

/**
 * Every topic a car may publish to, and nothing else — the broker ACL is built
 * from exactly this list, so a topic added above without a matching ACL fails
 * at provisioning time rather than silently at the track.
 */
export const carPublishTopics = (deviceId: string): string[] => [
  carTelemetryTopic(deviceId),
  carSessionTopic(deviceId),
  carBackfillTopic(deviceId),
];

/**
 * Mosquitto 2.x dynamic-security control topics. Clients, roles and ACLs are
 * managed at runtime by publishing commands here, so registering a car needs
 * no file write into the broker container and no config reload.
 */
export const DYNSEC_COMMAND_TOPIC = '$CONTROL/dynamic-security/v1';
export const DYNSEC_RESPONSE_TOPIC = '$CONTROL/dynamic-security/v1/response';

/** One role per car — the ACLs embed that car's deviceId. */
export const carRoleName = (deviceId: string) => `car-${deviceId}`;
