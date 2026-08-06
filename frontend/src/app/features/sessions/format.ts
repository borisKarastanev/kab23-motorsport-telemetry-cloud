/**
 * Formatting for the analysis views: deltas and session lengths.
 *
 * Module functions, not a pipe: they are called from `computed()`s in three
 * components, and a pipe would only be reachable from templates.
 *
 * `lapTime` is re-exported rather than defined here — the live view renders lap
 * times too, so it lives in `core/`.
 */
export { lapTime } from '../../core/format';

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
