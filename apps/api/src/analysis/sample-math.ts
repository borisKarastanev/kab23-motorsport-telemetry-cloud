/**
 * The small rules every stage of the derivation shares.
 *
 * Each of these was written three or four times over Phase 4 — once in the
 * crossing maths, once in the segmenter, once in the trace builder — and the
 * copies had already begun to drift. They are collected here not for tidiness
 * but because two of them are load-bearing invariants: whether a fix counts as
 * located decides whether it reaches the racing line at all, and how a channel
 * is interpolated onto the start/finish line has to be the *same* rule in the
 * segmenter (which stores the lap) and in the trace builder (which redraws it),
 * or a lap and its own trace disagree about where the line is.
 */

/**
 * Does this fix have a usable position?
 *
 * A fix without one cannot sit on a racing line, cannot contribute to a
 * crossing, and must never be drawn: plotting a missing lat/lon as (0, 0) puts
 * the car in the Gulf of Guinea and draws a line to it from wherever it really
 * was.
 *
 * `Number.isFinite` does not coerce, so it rejects `null`, `undefined`, strings
 * and `NaN` on its own — no `typeof` guard needed in front of it.
 */
export const isPositioned = (
  fix: {
    lat?: number;
    lon?: number;
  } | null,
): boolean =>
  fix != null && Number.isFinite(fix.lat) && Number.isFinite(fix.lon);

/**
 * A channel's value a fraction `t` of the way between two fixes.
 *
 * Both endpoints must be present. A half-known interval interpolates to a
 * fabricated number, and a channel that is missing at one end is better carried
 * through as missing than guessed from the other.
 */
export const lerpChannel = (
  a: number | undefined,
  b: number | undefined,
  t: number,
): number | undefined => (a == null || b == null ? undefined : a + t * (b - a));

/** Trim float noise off a value bound for the wire. */
export const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
