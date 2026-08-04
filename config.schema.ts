import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // API
  PORT: Joi.number().default(3000),

  // Domain database (PostgreSQL + TimescaleDB extension)
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),

  // Auth
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.number().default(3600),

  // Redis (live pub/sub + last-known-value cache) — wired in Phase 3
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  // MQTT broker (device telemetry ingress)
  MQTT_URL: Joi.string().default('mqtt://localhost:1883'),

  // The ingest service's own broker account (subscribe-only over `cars/+/#`).
  // Required, not defaulted: the broker rejects anonymous connections from
  // Phase 2 on, so a missing value must fail at boot rather than at the track.
  MQTT_USERNAME: Joi.string().required(),
  MQTT_PASSWORD: Joi.string().required(),

  // Dynamic-security admin, used ONLY by apps/api to provision per-car broker
  // accounts. Never handed to a device.
  //
  // Optional here, deliberately: this schema is shared by every process, and
  // making it required would force the credential into telemetry-ingest's
  // environment too — a process whose broker role is subscribe-only and which
  // never reads these. `MqttAdminService` enforces their presence in the one
  // app that does need them, so the check is not lost, just narrowed.
  MQTT_ADMIN_USERNAME: Joi.string().allow('').optional(),
  MQTT_ADMIN_PASSWORD: Joi.string().allow('').optional(),
});
