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
   *
   * **Defaults to empty, not to the dev origin.** A Joi default applies when the
   * key is *absent*, which is the state of every `.env` written before this key
   * existed — so defaulting to `http://localhost:4200` would silently allowlist
   * it on any box upgraded without editing `.env`. A security default has to
   * fail closed; `.env.example` carries the dev value instead.
   */
  CORS_ORIGIN: Joi.string().allow('').default(''),

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

  // Track map overlay (apps/api only — TrackMapService). Fetches a circuit's
  // outline from the Overpass API once per track, ever; nothing here is a
  // secret, since Overpass needs no key.
  OVERPASS_URL: Joi.string().default('https://overpass-api.de/api/interpreter'),
  // OSMF's usage policy requires an identifying UA on every request.
  OVERPASS_USER_AGENT: Joi.string().default(
    'motorsport-telemetry-cloud (contact via repository)',
  ),
  OVERPASS_TIMEOUT_MS: Joi.number().default(20000),
  OVERPASS_SEARCH_RADIUS_M: Joi.number().default(2000),
  // How long GET /tracks/:track/map awaits a cold fetch before answering
  // 'pending' and letting it finish in the background.
  TRACK_MAP_FETCH_DEADLINE_MS: Joi.number().default(8000),
  // How long an 'unavailable' track map is left alone before the next request
  // is allowed to retry Overpass, so a permanently-unmapped track does not
  // fire a query on every page load.
  TRACK_MAP_RETRY_AFTER_HOURS: Joi.number().default(24),
  // Lets a deployment switch off all outbound Overpass egress.
  TRACK_MAP_FETCH_ENABLED: Joi.boolean().default(true),
});
