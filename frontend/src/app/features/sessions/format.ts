/**
 * Shared formatting for lap times and deltas.
 *
 * Module functions, not a pipe: they are called from `computed()`s in three
 * components, and a pipe would only be reachable from templates.
 */

/**
 * Lap time as m:ss.mmm.
 *
 * Milliseconds rather than the on-car dash's tenths: this is post-session
 * analysis, where the difference between two laps is routinely under a tenth
 * and rounding it away is rounding away the answer.
 *
 * Rounded *before* the split, not after. Splitting first and rounding the
 * remainder turns 59 999.6 ms into "0:60.000" — the seconds field rounds up past
 * the minute it was already divided out of.
 */
export function lapTime(ms: number | null | undefined): string {
  if (ms == null) {
    return '—';
  }

  const whole = Math.round(ms);
  const minutes = Math.floor(whole / 60000);
  const seconds = ((whole % 60000) / 1000).toFixed(3).padStart(6, '0');

  return `${minutes}:${seconds}`;
}

/**
 * A delta as +/-s.mmm.
 *
 * The sign is always shown, including for a gain: "0.184" and "-0.184" differ
 * by one character that is easy to miss, where "+0.184" and "-0.184" do not.
 */
export function signedSeconds(ms: number | null | undefined): string {
  if (ms == null) {
    return '—';
  }

  const seconds = ms / 1000;
  return `${seconds >= 0 ? '+' : '−'}${Math.abs(seconds).toFixed(3)}`;
}

/** A session's wall-clock length, as a human reads it. */
export function duration(fromIso: string, toIso?: string): string {
  if (!toIso) {
    return '—';
  }

  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return '—';
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);

  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
