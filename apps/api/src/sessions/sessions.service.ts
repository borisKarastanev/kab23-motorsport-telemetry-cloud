import { MANAGING_TEAM_ROLES, SessionStatus, UserRole } from '@app/common';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CarsService } from '../cars/cars.service';
import { TeamsService } from '../teams/teams.service';
import { User } from '../users/entities/user.entity';
import { SessionsRepository } from './sessions.repository';
import { Session } from './entities/session.entity';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';
import { QuerySessionsDto } from './dto/query-sessions.dto';
import {
  DEFAULT_MAX_POINTS,
  QueryTelemetryDto,
} from './dto/query-telemetry.dto';
import { TelemetryRepository } from './telemetry.repository';
import { TelemetryPointDto } from './dto/telemetry-point.dto';
import { LapSummaryRepository } from './lap-summary.repository';
import { SessionListItemDto } from './dto/session-list-item.dto';

@Injectable()
export class SessionsService {
  constructor(
    private readonly sessionsRepository: SessionsRepository,
    private readonly carsService: CarsService,
    private readonly teamsService: TeamsService,
    private readonly telemetryRepository: TelemetryRepository,
    private readonly lapSummaryRepository: LapSummaryRepository,
  ) {}

  async create(
    user: User,
    createSessionDto: CreateSessionDto,
  ): Promise<Session> {
    const { carId, track, startedAt, driverId } = createSessionDto;

    // Seeing a car is enough to run it: a team DRIVER can start their own
    // session on a team car without being able to edit the car itself.
    const car = await this.carsService.requireReadableCar(user, carId);

    const resolvedDriverId = await this.resolveDriver(
      user,
      car.teamId,
      driverId,
    );

    return this.sessionsRepository.create(
      new Session({
        carId,
        driverId: resolvedDriverId,
        track,
        startedAt: startedAt ? new Date(startedAt) : new Date(),
        status: SessionStatus.LIVE,
      }),
    );
  }

  /**
   * Opening a session for somebody else is a manager action, and the nominated
   * driver must already be in the car's team — otherwise any manager could
   * attach a run to an arbitrary user id.
   */
  private async resolveDriver(
    user: User,
    carTeamId: string | undefined,
    requestedDriverId?: string,
  ): Promise<string> {
    if (!requestedDriverId || requestedDriverId === user.id) {
      return user.id;
    }

    if (!carTeamId) {
      throw new ForbiddenException('Cannot assign a session to another driver');
    }

    // Two independent lookups on the same team — one round trip, not two.
    const [, membership] = await Promise.all([
      this.teamsService.requireTeamRole(
        user,
        carTeamId,
        ...MANAGING_TEAM_ROLES,
      ),
      this.teamsService.getMembership(requestedDriverId, carTeamId),
    ]);

    if (!membership) {
      throw new ForbiddenException('Driver is not a member of the car team');
    }

    return requestedDriverId;
  }

  async findAll(
    user: User,
    query: QuerySessionsDto,
  ): Promise<SessionListItemDto[]> {
    return this.withLapSummary(await this.findVisible(user, query));
  }

  private async findVisible(
    user: User,
    query: QuerySessionsDto,
  ): Promise<Session[]> {
    const { carId, teamId, status } = query;

    // Narrowing to one car authorizes that car directly; the caller's unrelated
    // sessions are not part of what they asked for.
    if (carId) {
      await this.carsService.requireReadableCar(user, carId);
      return this.sessionsRepository.findVisible(null, [carId], status);
    }

    // A dropped teamId would silently return every session on the platform
    // under a query the caller reads as team-scoped.
    if (teamId) {
      if (user.role !== UserRole.ADMIN) {
        await this.teamsService.requireTeamRole(user, teamId);
      }
      const teamCarIds = await this.carsService.getVisibleCarIds(user, teamId);
      return this.sessionsRepository.findVisible(null, teamCarIds, status);
    }

    if (user.role === UserRole.ADMIN) {
      return this.sessionsRepository.findAllFiltered(status);
    }

    const carIds = await this.carsService.getVisibleCarIds(user);
    return this.sessionsRepository.findVisible(user.id, carIds, status);
  }

  /**
   * Attach each session's lap count and best lap.
   *
   * One grouped query for the whole page — the sessions have already been
   * scoped, so the ids handed over are exactly the ones the caller may see.
   * Zero and null for a session nobody has opened yet: derivation is lazy, so
   * "no laps" and "not analyzed" are the same state, and the list says so
   * rather than guessing.
   */
  private async withLapSummary(
    sessions: Session[],
  ): Promise<SessionListItemDto[]> {
    const summaries = await this.lapSummaryRepository.findBySessions(
      sessions.map((session) => session.id),
    );

    return sessions.map((session) =>
      Object.assign(session as SessionListItemDto, {
        lapCount: summaries.get(session.id)?.lapCount ?? 0,
        bestLapMs: summaries.get(session.id)?.bestLapMs ?? null,
      }),
    );
  }

  async findOne(user: User, sessionId: string): Promise<Session> {
    return this.requireReadableSession(user, sessionId);
  }

  async update(
    user: User,
    sessionId: string,
    updateSessionDto: UpdateSessionDto,
  ): Promise<Session> {
    await this.requireWritableSession(user, sessionId);
    return this.sessionsRepository.findOneAndUpdate(
      { id: sessionId },
      updateSessionDto,
    );
  }

  /**
   * Closing is one-way. Re-closing would move `endedAt` under telemetry that
   * has already been attributed to the original window, so a second call is a
   * conflict rather than a no-op.
   */
  async close(user: User, sessionId: string): Promise<Session> {
    const session = await this.requireWritableSession(user, sessionId);

    if (session.status !== SessionStatus.LIVE) {
      throw new ConflictException('Session is not live');
    }

    return this.sessionsRepository.findOneAndUpdate(
      { id: sessionId },
      { status: SessionStatus.COMPLETED, endedAt: new Date() },
    );
  }

  async remove(user: User, sessionId: string): Promise<void> {
    await this.requireWritableSession(user, sessionId);
    await this.sessionsRepository.findOneAndDelete({ id: sessionId });
  }

  /**
   * Downsampled telemetry for one session.
   *
   * Deliberately minimal — this exists so the Phase 2 write path is verifiable
   * without reading SQL by hand. The analysis API (lap deltas, sector times,
   * racing line) is Phase 4 and will not be built on this shape.
   *
   * Scoped through the same `requireReadableSession` as every other session
   * read, so a session outside the caller's tenant 404s here exactly as it does
   * elsewhere. GPS traces are a named driver's location: there is no route to
   * this data that skips that check.
   */
  async getTelemetry(
    user: User,
    sessionId: string,
    query: QueryTelemetryDto,
  ): Promise<TelemetryPointDto[]> {
    const session = await this.requireReadableSession(user, sessionId);

    // A session with no explicit end is still running, so "now" is its edge.
    const from = query.from ? new Date(query.from) : session.startedAt;
    const to = query.to ? new Date(query.to) : (session.endedAt ?? new Date());

    return this.telemetryRepository.findDownsampled(
      sessionId,
      from,
      to,
      query.maxPoints ?? DEFAULT_MAX_POINTS,
    );
  }

  /**
   * Stamp the moment the lap derivation last ran.
   *
   * Exposed for `AnalysisService`, which owns when that happens. Unauthorized
   * on purpose: it is only ever reached through a session the caller has
   * already been scoped to, and adding a check here would be a second predicate
   * to keep in step with `requireReadableSession` rather than a second defence.
   *
   * There is deliberately no "un-analyze": a recompute swaps the laps and the
   * stamp forward together, so a session never sits in a state where it has
   * been analyzed but says it has not.
   */
  async setAnalyzedAt(sessionId: string, analyzedAt: Date): Promise<void> {
    await this.sessionsRepository.findOneAndUpdate(
      { id: sessionId },
      {
        analyzedAt,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Scoping
  // ---------------------------------------------------------------------------

  /**
   * The driver's own run, or any session on a car the caller can see.
   *
   * Public because `AnalysisService` is a second module reading this session's
   * data, and it must go through *this* check rather than write its own. GPS
   * traces are a named driver's location: a second, independently maintained
   * scoping predicate is a second chance to get one wrong.
   */
  async requireReadableSession(
    user: User,
    sessionId: string,
  ): Promise<Session> {
    return this.requireSession(user, sessionId, (u, carId) =>
      this.carsService.requireReadableCar(u, carId),
    );
  }

  /**
   * The driver themselves, or a manager of the team the car runs under.
   *
   * Goes straight to the car write check rather than running the read check
   * first — `requireWritableCar` already refuses unreadable cars with a 404,
   * so layering the two would only re-resolve the same car and membership.
   */
  private async requireWritableSession(
    user: User,
    sessionId: string,
  ): Promise<Session> {
    return this.requireSession(user, sessionId, (u, carId) =>
      this.carsService.requireWritableCar(u, carId),
    );
  }

  private async requireSession(
    user: User,
    sessionId: string,
    authorizeCar: (user: User, carId: string) => Promise<unknown>,
  ): Promise<Session> {
    const session = await this.sessionsRepository.findOne({ id: sessionId });

    if (user.role === UserRole.ADMIN || session.driverId === user.id) {
      return session;
    }

    try {
      await authorizeCar(user, session.carId);
    } catch (error) {
      // Restated in terms of the session so the message never reveals that the
      // id is real and belongs to a car in someone else's garage. Only the two
      // authorization outcomes are remapped — a DB failure must not read as
      // "not found".
      if (error instanceof NotFoundException) {
        throw new NotFoundException('Session not found');
      }
      if (error instanceof ForbiddenException) {
        throw new ForbiddenException(
          'Insufficient permissions for this session',
        );
      }
      throw error;
    }

    return session;
  }
}
