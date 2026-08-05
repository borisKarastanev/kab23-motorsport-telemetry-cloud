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
   * answer again. Clears the laps first so the result replaces rather than
   * merges — a corrected gate can yield *fewer* laps, and an upsert would leave
   * the extras behind.
   */
  async recompute(user: User, sessionId: string): Promise<LapsResponseDto> {
    const session = await this.sessionsService.requireReadableSession(
      user,
      sessionId,
    );

    await this.lapsRepository.deleteBySession(sessionId);
    await this.sessionsService.setAnalyzedAt(sessionId, null);

    return this.derive({ ...session, analyzedAt: null } as Session);
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

  private async derive(session: Session): Promise<LapsResponseDto> {
    // A live session is still accumulating laps; deriving now would persist a
    // partial answer and stamp `analyzedAt` on it, and the stamp is what stops
    // it being re-derived once the session actually ends.
    if (session.status === SessionStatus.LIVE) {
      return this.respond(session, [], 'session-live');
    }

    const track = await this.tracksService.resolve(session.track);
    if (!track) {
      // Not an error, and not a licence to guess where the line might be. See
      // `TracksService.resolve` — a car may legitimately report a track this
      // platform has never heard of.
      return this.respond(session, [], 'no-track-gate');
    }

    const from = session.startedAt;
    const to = session.endedAt ?? new Date();

    const count = await this.samplesRepository.countRange(session.id, from, to);
    if (!count) {
      return this.respond(session, [], 'no-samples');
    }
    if (count > MAX_ANALYSIS_SAMPLES) {
      // The session id is not personal data and is what makes this actionable;
      // nothing about the driver, the car or the trace goes into the log.
      this.logger.warn(
        `Session ${session.id} holds ${count} samples, above the ${MAX_ANALYSIS_SAMPLES} ceiling for in-request derivation`,
      );
      return this.respond(session, [], 'too-many-samples');
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
      return this.respond(session, [], 'no-crossings');
    }

    const laps = this.toRows(session.id, derived);
    await this.lapsRepository.insertIgnoringDuplicates(laps);

    // Stamped **last**, after the rows are committed. A crash between the two
    // leaves the session looking underived, and the next read simply tries
    // again — where stamping first would leave a session permanently showing
    // laps it never got.
    const analyzedAt = new Date();
    await this.sessionsService.setAnalyzedAt(session.id, analyzedAt);

    // Read back rather than returning what was just built: a concurrent derive
    // may have won the insert race, and the rows in the database are the ones
    // every later read will return.
    return this.respond(
      { ...session, analyzedAt } as Session,
      await this.lapsRepository.findBySession(session.id),
    );
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

  private async traceFor(
    lap: Lap,
    maxPoints: number,
  ): Promise<LapTracePointDto[]> {
    const samples: AnalysisSample[] = await this.samplesRepository.findRange(
      lap.sessionId,
      lap.startedAt,
      lap.endedAt,
    );

    return buildLapTrace(samples, maxPoints);
  }

  private respond(
    session: Session,
    laps: Lap[],
    reason?: AnalysisSkipReason,
  ): LapsResponseDto {
    return {
      laps,
      analyzedAt: session.analyzedAt ?? null,
      // A reason alongside a non-empty list would be a contradiction, so the
      // shape makes it impossible rather than relying on callers not to.
      ...(laps.length ? {} : { reason }),
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
