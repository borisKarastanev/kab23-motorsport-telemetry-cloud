import { SessionStatus } from '@app/common';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { Session } from '../sessions/entities/session.entity';
import { TracksService } from '../tracks/tracks.service';
import { Track } from '../tracks/entities/track.entity';
import { readyCircuit } from '../tracks/track-map/track-map.geometry';
import { User } from '../users/entities/user.entity';
import {
  AnalysisSample,
  DerivedLap,
  Gate,
  SectorScheme,
} from './analysis.types';
import { AnalysisSamplesRepository } from './analysis-samples.repository';
import { AnalysisSkipReason, LapsResponseDto } from './dto/laps-response.dto';
import {
  LapCompareDto,
  LapTraceDto,
  LapTracePointDto,
} from './dto/lap-trace.dto';
import { LapRef, OptimalLapDto } from './dto/optimal-lap.dto';
import { Lap } from './entities/lap.entity';
import { segmentLaps } from './lap-segmenter';
import { buildLapTrace, compareLaps } from './lap-trace';
import { LapsRepository } from './laps.repository';
import { buildOptimalLap, stitchOptimalTrace } from './optimal-lap';
import {
  deriveSectorGates,
  knownSectorGates,
  SectorGatesResolution,
} from './sector-gates';
import { sectorTimesFromGates } from './sectors';

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

  /**
   * The optimal lap's racing line — 404 when fewer than two laps are eligible,
   * per the shared specification.
   */
  async getOptimalTrace(
    user: User,
    sessionId: string,
    maxPoints: number,
  ): Promise<LapTraceDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );

    const { plan, points } = await this.optimalTraceFor(session, maxPoints);

    return {
      lapNumber: 'optimal',
      lapMs: plan.lapMs,
      // The last stitched point's own cumulative distance, not `plan.distanceM`
      // — that one is an equal-fraction approximation (see `buildOptimalLap`),
      // and the trace already has the real, gate-clipped total. Non-empty by
      // construction: `optimalTraceFor` throws rather than return no points.
      distanceM: points[points.length - 1].distM,
      points,
      seams: plan.seams,
    };
  }

  async compare(
    user: User,
    sessionId: string,
    refs: LapRef[],
    maxPoints: number,
  ): Promise<LapCompareDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );

    // Full-rate traces, not decimated ones: the delta is a subtraction of two
    // interpolations, and thinning the inputs first would put decimation error
    // straight into the answer. The output budget is applied to the delta
    // series itself, below.
    const [traceA, traceB] = await Promise.all(
      refs.map((ref) => this.traceForRef(session, ref)),
    );

    return {
      lapA: refs[0],
      lapB: refs[1],
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

    let samples = await this.samplesRepository.findRange(session.id, from, to);
    const sfGate = gateOf(track);
    // Segmented once, on the S/F gate alone: resolving sector gates (below)
    // needs a completed lap's own trace to derive or validate against, which
    // is the chicken-and-egg this two-step order breaks. Every `DerivedLap`
    // still carries its own `points`, so applying gates afterwards costs a
    // pass over each lap's own (small) trace, never a second walk of the raw
    // sample array.
    const derived = segmentLaps(samples, sfGate);
    // Nothing below reads the raw samples again, and they are the largest
    // thing this request allocated. The `points` the segmenter just built are
    // a second copy of the same session — see `releaseLapPoints`, which drops
    // those the moment the rows are built.
    samples = null;

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

    const { laps: gatedDerived, sectorScheme } = await this.applySectorGates(
      track,
      sfGate,
      derived,
    );

    const laps = this.toRows(session.id, gatedDerived);
    // Every `DerivedLap` carries its own `points`, so between them the two
    // arrays still hold every positioned sample of the session — the thing
    // `LapSegmenter.closeLap`'s `this.points = null` used to release, and no
    // longer does now that `points` is part of its result. Nothing below reads
    // them: `toRows` has already run, and `respond` re-reads from the database.
    // Holding a whole session's trace across three database round trips is the
    // cost `MAX_ANALYSIS_SAMPLES` exists to bound, and this is the last point
    // at which it can be given back.
    releaseLapPoints(derived, gatedDerived);
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
    await this.sessionsService.setAnalyzedAt(
      session.id,
      analyzedAt,
      sectorScheme,
    );
    this.noCrossings.delete(session.id);

    // Read back rather than returning what was just built: a concurrent derive
    // may have won the insert race, and the rows in the database are the ones
    // every later read will return.
    return this.respond(
      { ...session, analyzedAt, sectorScheme } as Session,
      await this.lapsRepository.findBySession(session.id),
    );
  }

  /**
   * Resolve this track's sector gates and, if any were found *and work here*,
   * replace every lap's distance-fraction `sectorMs` with gate-anchored ones.
   *
   * The single place `sector-gates.ts` is reached from: it decides *what* the
   * gates are, this decides *what to do with them* — apply them to the laps
   * just segmented, and persist a brand-new derivation so every later session
   * at this track reads it back as a plain value.
   *
   * **A resolved gate set is not automatically a usable one.**
   * `sectorTimesFromGates` returns `[]` for a lap that does not cross every
   * gate exactly once, in order — the honest answer for a lap that went off,
   * but also what a *bad gate set* produces for every lap of a session. A set
   * derived from one session's best lap can be a few metres wide and sit on
   * that lap's line; another session at the same track driving a different line
   * may miss it entirely. Applied blind, that turns a session's whole sector
   * table into "—/—/—", takes the optimal lap with it (`pickBestSectors`
   * excludes a lap with no splits, and under two eligible laps there is none),
   * and leaves the caption claiming fixed gates — a strictly worse answer than
   * the distance fractions the laps already carried. So the gated result is
   * only kept if at least one lap actually produced splits from it; otherwise
   * this reports `'distance'` and the segmenter's own fractions stand.
   *
   * The persist is likewise deferred until the set has proved itself on this
   * session, so a derivation that turns out not to work is never written to the
   * track for every future session to inherit.
   */
  private async applySectorGates(
    track: Track,
    sfGate: Gate,
    derived: DerivedLap[],
  ): Promise<{ laps: DerivedLap[]; sectorScheme: SectorScheme }> {
    // Steps 1–2 first and on their own: `getTrackMap` below can spend up to
    // `TRACK_MAP_FETCH_DEADLINE_MS` on an outbound Overpass fetch, and a track
    // whose gates are surveyed or already derived needs no ring at all.
    const resolution =
      knownSectorGates({
        surveyedGates: track.sectorGates,
        persistedDerivedGates: track.derivedSectorGates ?? null,
      }) ?? (await this.deriveSectorGatesFor(track, sfGate, derived));

    if (!resolution) {
      return { laps: derived, sectorScheme: 'distance' };
    }

    const gates = resolution.gates;
    const laps = derived.map((lap) => ({
      ...lap,
      sectorMs: sectorTimesFromGates(lap.points, gates),
    }));

    if (!laps.some((lap) => lap.sectorMs.length)) {
      // Not one lap of this session crosses the set cleanly. The session id and
      // the gate source are what make this actionable; nothing about the
      // driver or the trace goes into the log.
      this.logger.warn(
        `Track ${track.id} has ${resolution.source} sector gates that no lap of this session crosses cleanly; falling back to distance fractions`,
      );
      return { laps: derived, sectorScheme: 'distance' };
    }

    if (resolution.newlyDerived) {
      await this.tracksService.setDerivedSectorGates(track.id, {
        ...resolution.newlyDerived,
        derivedAt: new Date().toISOString(),
      });
    }

    return { laps, sectorScheme: 'gates' };
  }

  /** Steps 3–4, and the only thing here that needs the track map. */
  private async deriveSectorGatesFor(
    track: Track,
    sfGate: Gate,
    derived: DerivedLap[],
  ): Promise<SectorGatesResolution | null> {
    const referenceLap = fastestLap(derived);
    const circuit = readyCircuit(await this.tracksService.getTrackMap(track));

    return deriveSectorGates({
      sfGate,
      ring: circuit?.ring,
      centrelineLengthM: circuit?.centrelineLengthM,
      referenceLap: {
        points: referenceLap.points,
        distanceM: referenceLap.distanceM,
      },
    });
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
    // The lap itself, not every lap matching its time: two identical lap times
    // to the millisecond is unlikely but not impossible, and two rows flagged
    // best would show up as two best laps in the session list.
    const best = fastestLap(derived);

    return derived.map(
      (lap) =>
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
          isBest: lap === best,
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

  /** One side of a comparison: a numbered lap's own trace, or the stitch. */
  private async traceForRef(
    session: Session,
    ref: LapRef,
  ): Promise<LapTracePointDto[]> {
    if (ref === 'optimal') {
      return (await this.optimalTraceFor(session, Number.MAX_SAFE_INTEGER))
        .points;
    }

    const lap = await this.requireLap(session, ref);
    return this.traceFor(lap, Number.MAX_SAFE_INTEGER);
  }

  /**
   * The optimal lap's plan and stitched trace together — the one place both
   * `getOptimalTrace` and `traceForRef('optimal')` build it, so a session
   * being compared against `'optimal'` and a session displaying it directly
   * can never disagree about what it is.
   *
   * **Throws rather than answering emptily.** `GET :id/optimal/trace` and
   * `?laps=optimal,3` fail on exactly the same conditions — fewer than two
   * eligible laps, or a contributing lap whose trace cannot be read — so they
   * answer the same way. A 200 carrying `{ distanceM: 0, points: [] }` would
   * render as an empty delta chart with no error, where the frontend already
   * handles a missing trace through `guarded`.
   */
  private async optimalTraceFor(
    session: Session,
    maxPoints: number,
  ): Promise<{ plan: OptimalLapDto; points: LapTracePointDto[] }> {
    const laps = await this.lapsRepository.findBySession(session.id);
    const plan = buildOptimalLap(laps);
    if (!plan) {
      throw new NotFoundException('Optimal lap not available');
    }

    // At most three contributing laps, usually one or two — never every lap
    // of the session, and each taken once even if it won more than one sector.
    // Read out of the rows already in hand rather than re-queried: `plan` was
    // built from `laps` a moment ago, so a winning lap number is by
    // construction one of them.
    const byLapNumber = new Map(laps.map((lap) => [lap.lapNumber, lap]));
    const contributingLaps = [
      ...new Set(plan.sectors.map((sector) => sector.lapNumber)),
    ].map((lapNumber) => byLapNumber.get(lapNumber));
    const traces = await Promise.all(
      // Full-rate first, decimate last — the same order `compare` already
      // uses, so thinning error never enters the stitch.
      contributingLaps.map((lap) =>
        this.traceFor(lap, Number.MAX_SAFE_INTEGER),
      ),
    );
    const contributingByLap = new Map(
      contributingLaps.map((lap, i) => [
        lap.lapNumber,
        // The lap's own splits travel with its trace: the stitch cuts each
        // sector at the instant that lap's own sector time says it ended,
        // which is where its gate crossing was. See `stitchOptimalTrace`.
        { sectorMs: lap.sectorMs, points: traces[i] },
      ]),
    );

    const points = stitchOptimalTrace(plan, contributingByLap, maxPoints);
    if (!points.length) {
      throw new NotFoundException('Optimal lap not available');
    }

    return { plan, points };
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
      optimal: buildOptimalLap(laps),
      ...(session.sectorScheme ? { sectorScheme: session.sectorScheme } : {}),
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

/**
 * Drop each derived lap's own trace, once the rows are built.
 *
 * Emptied rather than set null so the field keeps its declared type; either
 * way what matters is that the `LapPoint[]` becomes unreachable. Takes every
 * array the derivation touched because `applySectorGates` returns fresh lap
 * objects that share the same `points` arrays — releasing one list and not the
 * other would release nothing.
 */
function releaseLapPoints(...lapSets: DerivedLap[][]): void {
  for (const laps of lapSets) {
    for (const lap of laps) {
      lap.points = [];
    }
  }
}

/**
 * The quickest lap of a set, as the object itself.
 *
 * Two callers within one derivation: the row builder flags it `isBest`, and
 * the gate resolution derives sector gates from it — the only reference
 * candidate there is. Folded rather than `Math.min(...laps.map(…))`, which
 * spreads one argument per lap and would be a stack overflow rather than a
 * slow answer on a session whose gate only matched twice.
 */
function fastestLap<T extends { lapMs: number }>(laps: T[]): T {
  return laps.reduce((best, lap) => (lap.lapMs < best.lapMs ? lap : best));
}
