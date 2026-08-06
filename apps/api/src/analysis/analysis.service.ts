import { SessionStatus } from '@app/common';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { Session } from '../sessions/entities/session.entity';
import { TracksService } from '../tracks/tracks.service';
import { Track } from '../tracks/entities/track.entity';
import { User } from '../users/entities/user.entity';
import { AnalysisSample, DerivedLap, Gate } from './analysis.types';
import { AnalysisSamplesRepository } from './analysis-samples.repository';
import { AnalysisSkipReason, LapsResponseDto } from './dto/laps-response.dto';
import {
  LapCompareDto,
  LapTraceDto,
  LapTracePointDto,
} from './dto/lap-trace.dto';
import { Lap } from './entities/lap.entity';
import { segmentLaps } from './lap-segmenter';
import { buildLapTrace, compareLaps } from './lap-trace';
import { LapsRepository } from './laps.repository';

/**
 * How many samples one request will pull into memory to derive laps.
 *
 * Derivation runs inside the request that asked for the laps, so this is the
 * ceiling on what that costs. 300 000 is eight hours at 10 Hz — far beyond any
 * real session, and reached only by one left open all day at a track day. Such
 * a session is refused with a reason rather than allowed to exhaust the API's
 * heap, and is the case the deferred `analysis-worker` (plan §0.3) exists for.
 */
export const MAX_ANALYSIS_SAMPLES = 300_000;

/**
 * How many sessions the `no-crossings` memo holds before the oldest is dropped.
 *
 * Small on purpose: it exists to stop one unanalysable session being re-scanned
 * on every page load, not to be a cache of the analysis.
 */
const NO_CROSSINGS_MEMO_SIZE = 256;

/** What a remembered `no-crossings` result was computed against. */
interface NoCrossingsMemo {
  sampleCount: number;
  trackUpdatedMs: number;
}

/**
 * Lap, sector and braking-point derivation.
 *
 * **Derivation is lazy and runs on read**, not on a bus event. The obvious
 * alternative — have ingest fire it when a session closes — cannot work here:
 * `apps/telemetry-ingest` must not import from `apps/api`, and the Redis
 * channel it does publish `stop` on is subscribed refcounted per car, only
 * while somebody is watching the live view. A session that ended with nobody
 * watching would never be analyzed, and an always-on subscription would put
 * every team's data through every API node — the exact thing
 * `LiveTelemetryBusService`'s refcounting exists to prevent.
 *
 * So: the first read of a completed session derives it, persists the rows and
 * stamps `analyzedAt`; every later read is a plain select. That is idempotent,
 * survives an API restart, needs no cross-process bus, and puts the cost where
 * somebody is already waiting for the answer.
 *
 * Every entry point scopes through `SessionsService.requireReadableSession`.
 * There is no route to a driver's GPS trace that skips it.
 */
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  /**
   * Sessions whose last segmentation found no crossing, and what it saw.
   *
   * `no-crossings` deliberately does not stamp `analyzedAt`, so that a
   * corrected gate is picked up on the next read with nothing to undo. Without
   * a memo that costs a full re-read and re-segmentation of up to
   * `MAX_ANALYSIS_SAMPLES` rows on *every* load of a session the frontend links
   * straight to. Keyed on the two things that can change the answer — the
   * track's gate and the sample count, which is what backfill moves — so
   * neither correction is masked by it.
   *
   * In-memory and per node: it is a cost optimisation, never a source of truth,
   * and a restart or a second API instance simply pays the scan once more.
   */
  private readonly noCrossings = new Map<string, NoCrossingsMemo>();

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly tracksService: TracksService,
    private readonly lapsRepository: LapsRepository,
    private readonly samplesRepository: AnalysisSamplesRepository,
  ) {}

  async getLaps(user: User, sessionId: string): Promise<LapsResponseDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );

    if (session.analyzedAt) {
      return this.respond(
        session,
        await this.lapsRepository.findBySession(sessionId),
      );
    }

    return this.derive(session);
  }

  /**
   * Force a recompute.
   *
   * Needed when a track's gate is corrected in the seed, or when the device's
   * own lap count disagrees with ours and somebody wants to see this side's
   * answer again. The result *replaces* rather than merges — a corrected gate
   * can yield fewer laps, and an upsert would leave the extras behind — but the
   * old rows are only dropped once there are new ones to put in their place.
   *
   * That ordering is the whole point. Deleting up front, as this used to, meant
   * any of `derive`'s four empty outcomes destroyed a good set of laps for
   * good: a session that has since grown past `MAX_ANALYSIS_SAMPLES` on
   * backfill, or whose track slug stopped resolving, would answer the button
   * press by throwing away the answer it already had.
   */
  async recompute(user: User, sessionId: string): Promise<LapsResponseDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );

    // A forced recompute is exactly the case the memo must not answer: the
    // gate may have been corrected without the track row moving.
    this.noCrossings.delete(sessionId);

    return this.derive(session, { replace: true });
  }

  async getLapTrace(
    user: User,
    sessionId: string,
    lapNumber: number,
    maxPoints: number,
  ): Promise<LapTraceDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );
    const lap = await this.requireLap(session, lapNumber);

    return {
      lapNumber: lap.lapNumber,
      lapMs: lap.lapMs,
      distanceM: lap.distanceM,
      points: await this.traceFor(lap, maxPoints),
    };
  }

  async compare(
    user: User,
    sessionId: string,
    lapNumbers: number[],
    maxPoints: number,
  ): Promise<LapCompareDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );

    const [a, b] = await Promise.all(
      lapNumbers.map((lapNumber) => this.requireLap(session, lapNumber)),
    );

    // Full-rate traces, not decimated ones: the delta is a subtraction of two
    // interpolations, and thinning the inputs first would put decimation error
    // straight into the answer. The output budget is applied to the delta
    // series itself, below.
    const [traceA, traceB] = await Promise.all([
      this.traceFor(a, Number.MAX_SAFE_INTEGER),
      this.traceFor(b, Number.MAX_SAFE_INTEGER),
    ]);

    return {
      lapA: a.lapNumber,
      lapB: b.lapNumber,
      ...compareLaps(traceA, traceB, maxPoints),
    };
  }

  // ---------------------------------------------------------------------------
  // Derivation
  // ---------------------------------------------------------------------------

  private async derive(
    session: Session,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<LapsResponseDto> {
    // A live session is still accumulating laps; deriving now would persist a
    // partial answer and stamp `analyzedAt` on it, and the stamp is what stops
    // it being re-derived once the session actually ends.
    if (session.status === SessionStatus.LIVE) {
      return this.skip(session, 'session-live', replace);
    }

    const track = await this.tracksService.resolve(session.track);
    if (!track) {
      // Not an error, and not a licence to guess where the line might be. See
      // `TracksService.resolve` — a car may legitimately report a track this
      // platform has never heard of.
      return this.skip(session, 'no-track-gate', replace);
    }

    const from = session.startedAt;
    const to = session.endedAt ?? new Date();

    const count = await this.samplesRepository.countRange(session.id, from, to);
    if (!count) {
      return this.skip(session, 'no-samples', replace);
    }
    if (count > MAX_ANALYSIS_SAMPLES) {
      // The session id is not personal data and is what makes this actionable;
      // nothing about the driver, the car or the trace goes into the log.
      this.logger.warn(
        `Session ${session.id} holds ${count} samples, above the ${MAX_ANALYSIS_SAMPLES} ceiling for in-request derivation`,
      );
      return this.skip(session, 'too-many-samples', replace);
    }

    const trackUpdatedMs = track.updatedAt?.getTime() ?? 0;
    const memo = this.noCrossings.get(session.id);
    if (
      memo &&
      memo.sampleCount === count &&
      memo.trackUpdatedMs === trackUpdatedMs
    ) {
      // Same gate, same samples: the segmentation would reach the same answer
      // it did last time, at the cost of reading every row again.
      return this.skip(session, 'no-crossings', replace);
    }

    const samples = await this.samplesRepository.findRange(
      session.id,
      from,
      to,
    );
    const derived = segmentLaps(samples, gateOf(track));

    if (!derived.length) {
      // Samples and a gate, but no crossing: the car never completed a lap, or
      // the session is from a different track than it claims. Deliberately not
      // stamped as analyzed — a corrected gate should be able to find laps here
      // on the next read without anyone having to call `analyze`.
      this.rememberNoCrossings(session.id, {
        sampleCount: count,
        trackUpdatedMs,
      });
      return this.skip(session, 'no-crossings', replace);
    }

    const laps = this.toRows(session.id, derived);
    // Only now is there something to replace the old rows with. `replace`
    // clears and re-inserts in one transaction so a recompute never leaves a
    // reader looking at a session with no laps at all.
    if (replace) {
      await this.lapsRepository.replaceSession(session.id, laps);
    } else {
      await this.lapsRepository.insertIgnoringDuplicates(laps);
    }

    // Stamped **last**, after the rows are committed. A crash between the two
    // leaves the session looking underived, and the next read simply tries
    // again — where stamping first would leave a session permanently showing
    // laps it never got.
    const analyzedAt = new Date();
    await this.sessionsService.setAnalyzedAt(session.id, analyzedAt);
    this.noCrossings.delete(session.id);

    // Read back rather than returning what was just built: a concurrent derive
    // may have won the insert race, and the rows in the database are the ones
    // every later read will return.
    return this.respond(
      { ...session, analyzedAt } as Session,
      await this.lapsRepository.findBySession(session.id),
    );
  }

  /**
   * Nothing was derived, and nothing is destroyed on the way out.
   *
   * On a plain read there are no laps to report either way. On a forced
   * recompute the previously derived laps are still the best answer anyone
   * has — the re-derivation did not disprove them, it declined to run — so they
   * are returned alongside the reason it declined.
   */
  private async skip(
    session: Session,
    reason: AnalysisSkipReason,
    replace: boolean,
  ): Promise<LapsResponseDto> {
    return this.respond(
      session,
      replace ? await this.lapsRepository.findBySession(session.id) : [],
      reason,
    );
  }

  private rememberNoCrossings(sessionId: string, memo: NoCrossingsMemo): void {
    // Insertion-ordered, so the first key is the least recently written.
    if (this.noCrossings.size >= NO_CROSSINGS_MEMO_SIZE) {
      const oldest = this.noCrossings.keys().next().value;
      this.noCrossings.delete(oldest);
    }

    this.noCrossings.set(sessionId, memo);
  }

  private toRows(sessionId: string, derived: DerivedLap[]): Lap[] {
    const bestMs = Math.min(...derived.map((lap) => lap.lapMs));
    // `indexOf` rather than every lap matching `bestMs`: two identical lap
    // times to the millisecond is unlikely but not impossible, and two rows
    // flagged best would show up as two best laps in the session list.
    const bestIndex = derived.findIndex((lap) => lap.lapMs === bestMs);

    return derived.map(
      (lap, i) =>
        new Lap({
          sessionId,
          lapNumber: lap.lapNumber,
          startedAt: lap.startedAt,
          endedAt: lap.endedAt,
          lapMs: lap.lapMs,
          distanceM: lap.distanceM,
          maxSpeedKmh: lap.maxSpeedKmh ?? undefined,
          minSpeedKmh: lap.minSpeedKmh ?? undefined,
          sectorMs: lap.sectorMs,
          brakingPoints: lap.brakingPoints,
          isBest: i === bestIndex,
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Traces
  // ---------------------------------------------------------------------------

  private async requireLap(session: Session, lapNumber: number): Promise<Lap> {
    const lap = await this.lapsRepository.findOneByNumber(
      session.id,
      lapNumber,
    );

    if (!lap) {
      // Phrased in terms of the lap, not the session: the caller has already
      // been scoped to the session, so this reveals nothing.
      throw new NotFoundException('Lap not found');
    }

    return lap;
  }

  /**
   * A lap's trace, opening and closing **on the start/finish line**.
   *
   * `findLapWindow` rather than `findRange`, and the bounds passed through: the
   * lap's own timestamps are interpolated crossing instants that no stored
   * sample sits on, so a plain range read would start the distance axis at the
   * first fix past the line. See `findLapWindow` for why that matters to every
   * comparison built on this.
   */
  private async traceFor(
    lap: Lap,
    maxPoints: number,
  ): Promise<LapTracePointDto[]> {
    const samples: AnalysisSample[] =
      await this.samplesRepository.findLapWindow(
        lap.sessionId,
        lap.startedAt,
        lap.endedAt,
      );

    return buildLapTrace(samples, maxPoints, {
      startMs: lap.startedAt.getTime(),
      endMs: lap.endedAt.getTime(),
    });
  }

  /**
   * The one place a `LapsResponseDto` is built.
   *
   * `reason` answers "why is there nothing new", so it is carried whenever
   * there is one — including the forced recompute that declined to run and kept
   * the laps it already had, which is the only case where a reason and a
   * non-empty list are both true. Every other path passes no reason at all, so
   * a client can still read an absent `reason` as "this is a fresh
   * derivation"; what it must not do is read a present one as "there are no
   * laps". See `LapsResponseDto`.
   */
  private respond(
    session: Session,
    laps: Lap[],
    reason?: AnalysisSkipReason,
  ): LapsResponseDto {
    return {
      laps,
      analyzedAt: session.analyzedAt ?? null,
      ...(reason ? { reason } : {}),
    };
  }
}

/** A track's S/F gate in the shape the crossing maths wants. */
const gateOf = (track: Track): Gate => ({
  lat1: track.sfLat1,
  lon1: track.sfLon1,
  lat2: track.sfLat2,
  lon2: track.sfLon2,
});
