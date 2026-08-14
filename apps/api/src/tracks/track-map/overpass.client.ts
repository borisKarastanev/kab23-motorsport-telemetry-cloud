import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OverpassResponse } from './track-map.types';

/** Anything that stops a usable `OverpassResponse` reaching the caller. */
export class OverpassError extends Error {}

/**
 * One query against the public Overpass API: every `highway=raceway` way
 * within a radius of a point.
 *
 * **Every defensive check here was hit while validating this feature against
 * the real service, not written speculatively:**
 *
 * - Overpass answers a rejected or malformed query with an **HTML page,
 *   sometimes under a 200 status** — a rate-limit or syntax-error page is not
 *   guaranteed to come back as 4xx. `content-type` is checked before
 *   `JSON.parse` runs, so a bad response fails with a clear `OverpassError`
 *   instead of a `SyntaxError` several stack frames from the cause.
 * - `[out:json][timeout:…]` inside the query is Overpass's own server-side
 *   budget; `AbortSignal.timeout` is this side's, independent of it, so a
 *   connection that never gets a response at all still gives up.
 * - OSMF's usage policy requires an identifying `User-Agent` on every request.
 */
@Injectable()
export class OverpassClient {
  constructor(private readonly config: ConfigService) {}

  async fetchRaceways(lat: number, lon: number): Promise<OverpassResponse> {
    const url = this.config.get<string>('OVERPASS_URL')!;
    const radiusM = this.config.get<number>('OVERPASS_SEARCH_RADIUS_M')!;
    const timeoutMs = this.config.get<number>('OVERPASS_TIMEOUT_MS')!;
    const userAgent = this.config.get<string>('OVERPASS_USER_AGENT')!;

    // Overpass's own budget must expire *before* this side's abort, so a slow
    // query comes back as a clean Overpass timeout response rather than a
    // mid-flight abort. One second of headroom, floored at 1 s so a very short
    // configured timeout still produces a valid query.
    const serverTimeoutS = Math.max(1, Math.floor(timeoutMs / 1000) - 1);
    const query =
      `[out:json][timeout:${serverTimeoutS}];` +
      `way(around:${radiusM},${lat},${lon})["highway"="raceway"];` +
      `out geom;`;

    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': userAgent,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Inside the try: an abort during the *body* read rejects here, not at
      // `fetch`, and outside this block it would escape as a raw DOMException
      // rather than the OverpassError this class exists to guarantee.
      text = await response.text();
    } catch (error) {
      throw new OverpassError(
        `Overpass request failed: ${(error as Error).message}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok || !contentType.includes('application/json')) {
      throw new OverpassError(
        `Overpass returned ${response.status} (${contentType || 'no content-type'})`,
      );
    }

    try {
      return JSON.parse(text) as OverpassResponse;
    } catch {
      throw new OverpassError('Overpass response was not valid JSON');
    }
  }
}
