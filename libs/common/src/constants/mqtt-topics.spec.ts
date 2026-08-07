import {
  BACKFILL_TOPIC_WILDCARD,
  DYNSEC_COMMAND_TOPIC,
  DYNSEC_RESPONSE_TOPIC,
  SESSION_TOPIC_WILDCARD,
  TELEMETRY_TOPIC_WILDCARD,
  carBackfillTopic,
  carPublishTopics,
  carRoleName,
  carSessionTopic,
  carTelemetryTopic,
  deviceIdFromTopic,
} from './mqtt-topics';

describe('mqtt-topics', () => {
  describe('topic builders', () => {
    it('builds the telemetry topic for a device', () => {
      expect(carTelemetryTopic('TEST123')).toBe('cars/TEST123/telemetry');
    });

    it('builds the session topic for a device', () => {
      expect(carSessionTopic('TEST123')).toBe('cars/TEST123/session');
    });

    it('builds the backfill topic for a device', () => {
      expect(carBackfillTopic('TEST123')).toBe('cars/TEST123/backfill');
    });
  });

  describe('wildcards', () => {
    it('match what the builders produce', () => {
      // The wildcard has to be the literal `+` where the builder puts the
      // deviceId, or ingest's subscription and the on-car publisher would
      // silently stop agreeing on the scheme.
      expect(TELEMETRY_TOPIC_WILDCARD).toBe('cars/+/telemetry');
      expect(SESSION_TOPIC_WILDCARD).toBe('cars/+/session');
      expect(BACKFILL_TOPIC_WILDCARD).toBe('cars/+/backfill');
    });
  });

  describe('deviceIdFromTopic', () => {
    it('extracts the deviceId from a telemetry topic', () => {
      expect(deviceIdFromTopic('cars/TEST123/telemetry')).toBe('TEST123');
    });

    it('extracts the deviceId from a session topic', () => {
      expect(deviceIdFromTopic('cars/TEST123/session')).toBe('TEST123');
    });

    it('returns null for a topic with too few segments', () => {
      expect(deviceIdFromTopic('cars/TEST123')).toBeNull();
    });

    it('returns null for a topic with too many segments', () => {
      expect(deviceIdFromTopic('cars/TEST123/telemetry/extra')).toBeNull();
    });

    it('returns null for a topic that is not under cars/', () => {
      expect(deviceIdFromTopic('other/TEST123/telemetry')).toBeNull();
    });

    it('returns null when the deviceId segment is empty', () => {
      expect(deviceIdFromTopic('cars//telemetry')).toBeNull();
    });
  });

  describe('carPublishTopics', () => {
    it('lists exactly the three topics a car may publish to', () => {
      expect(carPublishTopics('TEST123')).toEqual([
        'cars/TEST123/telemetry',
        'cars/TEST123/session',
        'cars/TEST123/backfill',
      ]);
    });
  });

  describe('dynsec constants', () => {
    it('keeps the command and response topics distinct', () => {
      expect(DYNSEC_COMMAND_TOPIC).toBe('$CONTROL/dynamic-security/v1');
      expect(DYNSEC_RESPONSE_TOPIC).toBe(
        '$CONTROL/dynamic-security/v1/response',
      );
      expect(DYNSEC_RESPONSE_TOPIC).not.toBe(DYNSEC_COMMAND_TOPIC);
    });
  });

  describe('carRoleName', () => {
    it('embeds the deviceId in the role name', () => {
      expect(carRoleName('TEST123')).toBe('car-TEST123');
    });
  });
});
