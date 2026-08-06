/**
 * Formatting shared across features.
 *
 * Only what more than one feature needs lives here — the live view and the
 * analysis view both render lap times, and they were rendering them through two
 * copies of the same rounding rule.
 */

/**
 * Lap time as `m:ss.mmm`, or fewer decimals on request.
 *
 * Rounded *before* the split, not after. Splitting first and rounding the
 * remainder turns 59 999.6 ms into "0:60.000" and 59 990 ms into "0:60.0" — the
 * seconds field rounds up past the minute it was already divided out of. That
 * is the whole reason this is one function: it is a one-line mistake that reads
 * as correct, and it was previously fixed in two places that had no way of
 * staying fixed together.
 *
 * The live view asks for tenths, matching what the on-car dash shows. Post-
 * session analysis asks for milliseconds, because the difference between two
 * laps is routinely under a tenth and rounding it away is rounding away the
 * answer.
 */
export function lapTime(
  ms: number | null | undefined,
  decimals: 1 | 3 = 3,
): string {
  if (ms == null) {
    return '—';
  }

  const scale = 10 ** (3 - decimals);
  const whole = Math.round(ms / scale) * scale;
  const minutes = Math.floor(whole / 60000);
  // Width is two digits, the point, and the decimals — so "05.0", "33.123".
  const seconds = ((whole % 60000) / 1000)
    .toFixed(decimals)
    .padStart(decimals + 3, '0');

  return `${minutes}:${seconds}`;
}
