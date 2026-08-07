import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Turns the `CORS_ORIGIN` env value into a CORS `origin` setting.
 *
 * Lives in `apps/api`, not `libs/common`: only this app serves browsers, and
 * putting it in the shared barrel made `apps/telemetry-ingest` — which imports
 * that barrel for enums and MQTT topic constants — pull in a CORS helper and
 * `@nestjs/common`'s CorsOptions for nothing.
 *
 * Phases 0–4 ran `origin: true` — reflect whatever `Origin` the request carried,
 * with `credentials: true` alongside. That is correct for the Angular dev server
 * on :4200 and wrong the moment this is reachable from the internet: any page on
 * any host could then call the API with the viewer's `Authentication` cookie
 * attached and read the response. The cookie is `httpOnly`, so the attacker
 * cannot steal the token itself — they can do something better, which is use it.
 *
 * In production the app is served by the same nginx that proxies `/api`, so it
 * is **same-origin** and needs no CORS at all. That is what an empty value
 * means, and it is the intended production setting: `origin: false` sends no
 * `Access-Control-Allow-Origin`, which same-origin requests never look for.
 */
const parseCorsOrigins = (value?: string): string[] =>
  (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

export const corsOptionsFor = (value?: string): CorsOptions => {
  const origins = parseCorsOrigins(value);

  return {
    // An explicit allowlist, never `true`. Passing the array to `origin` makes
    // the framework compare and echo one entry, so `Vary: Origin` and the
    // credentialed-request rules are handled for us.
    origin: origins.length > 0 ? origins : false,
    credentials: true,
  };
};
