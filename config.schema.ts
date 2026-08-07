import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // API
  PORT: Joi.number().default(3000),

  /**
   * Read since Phase 0 (`AuthService.login` gates the cookie's `secure` flag on
   * it) but never validated until now. That gap is worth closing here rather
   * than later: `NODE_ENV=Production` is not `'production'`, so the deployed API
   * would go on issuing the auth cookie without `Secure` over a public HTTPS
   * endpoint, and nothing anywhere would say so.
   */
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  /**
   * Comma-separated list of browser origins allowed to call this API with
   * credentials. Empty means same-origin only, which is the production setting:
   * nginx serves the Angular bundle and proxies /api from one hostname, so no
   * cross-origin request should succeed. See `corsOptionsFor`.
   */
  CORS_ORIGIN: Joi.string().allow('').default('http://localhost:4200'),

  // Domain database (PostgreSQL + TimescaleDB extension)
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_DATABASE: Joi.string().required(),

  // Auth
  JWT_SECRET: Joi.string().required(),
  JWT_EXPIRATION: Joi.number().default(3600),

  // Redis — live pub/sub fan-out + last-known-value cache.
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),

  // Optional, and blank in local compose where Redis is not reachable off the
  // container network. The seam exists now so Phase 5 sets a password on a
  // deployed box by editing `.env`, not by retrofitting config onto a live
  // service.
  REDIS_PASSWORD: Joi.string().allow('').optional(),

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
