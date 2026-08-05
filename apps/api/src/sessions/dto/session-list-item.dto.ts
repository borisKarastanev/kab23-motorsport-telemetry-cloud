import { Session } from '../entities/session.entity';

/**
 * A session as the list shows it: the row, plus what its laps add up to.
 *
 * Both derived fields are **null/0 until the session has been analyzed**, and
 * that is not a gap to paper over. Derivation is lazy (Phase 4 plan §0.3): a
 * completed session that nobody has opened yet genuinely has no laps, and the
 * list showing "—" is the truth. Opening it derives them.
 */
export interface SessionListItemDto extends Session {
  lapCount: number;
  /** The fastest lap, or null when there are none. */
  bestLapMs: number | null;
}
