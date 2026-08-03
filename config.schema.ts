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
});
