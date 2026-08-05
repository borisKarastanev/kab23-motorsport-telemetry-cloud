import { SessionStatus } from '@app/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Session } from '../sessions/entities/session.entity';
import { SessionsService } from '../sessions/sessions.service';
import { Track } from '../tracks/entities/track.entity';
import { TracksService } from '../tracks/tracks.service';
import { User } from '../users/entities/user.entity';
import { AnalysisSample } from './analysis.types';
import { AnalysisSamplesRepository } from './analysis-samples.repository';
import { AnalysisService, MAX_ANALYSIS_SAMPLES } from './analysis.service';
import { Lap } from './entities/lap.entity';
import { LapsRepository } from './laps.repository';

// The mock publisher's circuit generator, driven here so the derivation runs
// against real geometry rather than a hand-built trace. `require` because
// `scripts/` is plain CommonJS — see `lap-segmenter.spec.ts` for the full note.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const circuit = require('../../../../scripts/lib/circuit');
const { CircuitDriver, KALOYANOVO } = circuit;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_START = new Date('2026-08-05T10:00:00.000Z');

const KALOYANOVO_TRACK = {
  slug: 'kaloyanovo',
  sfLat1: KALOYANOVO.gate.lat1,
  sfLon1: KALOYANOVO.gate.lon1,
  sfLat2: KALOYANOVO.gate.lat2,
  sfLon2: KALOYANOVO.gate.lon2,
} as Track;

/** Two-and-a-bit laps of the mock circuit, as stored samples would look. */
function mockSamples(seconds = 200): AnalysisSample[] {
  const driver = new CircuitDriver({ seed: 20260805 });

  return Array.from({ length: seconds * 10 }, (_, i) => {
    const frame = driver.step(100);
    return {
      time: new Date(SESSION_START.getTime() + (i + 1) * 100),
      lat: frame.lat,
      lon: frame.lon,
      speedKmh: frame.speedKmh,
      rpm: frame.rpm,
      coolantC: 90,
      oilC: 100,
      gLat: frame.gLat,
      gLon: frame.gLon,
    };
  });
}

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: SESSION_ID,
    track: 'kaloyanovo',
    status: SessionStatus.COMPLETED,
    startedAt: SESSION_START,
    endedAt: new Date(SESSION_START.getTime() + 200_000),
    analyzedAt: null,
    ...overrides,
  }) as Session;

describe('AnalysisService', () => {
  const user = { id: 'user-1' } as User;

  let service: AnalysisService;
  let sessions: jest.Mocked<
    Pick<SessionsService, 'requireReadableSession' | 'setAnalyzedAt'>
  >;
  let tracks: jest.Mocked<Pick<TracksService, 'resolve'>>;
  let laps: jest.Mocked<
    Pick<
      LapsRepository,
      | 'findBySession'
      | 'findOneByNumber'
      | 'insertIgnoringDuplicates'
      | 'deleteBySession'
    >
  >;
  let samples: jest.Mocked<
    Pick<AnalysisSamplesRepository, 'findRange' | 'countRange'>
  >;

  /** Rows the service "persisted", so findBySession can hand them back. */
  let stored: Lap[];

  beforeEach(async () => {
    stored = [];
    const data = mockSamples();

    sessions = {
      requireReadableSession: jest.fn().mockResolvedValue(session()),
      setAnalyzedAt: jest.fn().mockResolvedValue(undefined),
    };
    tracks = { resolve: jest.fn().mockResolvedValue(KALOYANOVO_TRACK) };
    laps = {
      findBySession: jest.fn<Promise<Lap[]>, [string]>(async () => stored),
      findOneByNumber: jest.fn(
        async (_sessionId: string, lapNumber: number) =>
          stored.find((lap) => lap.lapNumber === lapNumber) ?? null,
      ),
      insertIgnoringDuplicates: jest.fn(async (rows: Lap[]) => {
        stored = rows;
      }),
      deleteBySession: jest.fn<Promise<void>, [string]>(async () => {
        stored = [];
      }),
    };
    samples = {
      countRange: jest.fn().mockResolvedValue(data.length),
      findRange: jest.fn(async (_id: string, from: Date, to: Date) =>
        data.filter((sample) => sample.time >= from && sample.time <= to),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AnalysisService,
        { provide: SessionsService, useValue: sessions },
        { provide: TracksService, useValue: tracks },
        { provide: LapsRepository, useValue: laps },
        { provide: AnalysisSamplesRepository, useValue: samples },
      ],
    }).compile();

    service = moduleRef.get(AnalysisService);
  });

  describe('lazy derivation', () => {
    it('derives, persists and returns laps on the first read', async () => {
      const result = await service.getLaps(user, SESSION_ID);

      expect(result.laps.length).toBeGreaterThanOrEqual(2);
      expect(result.reason).toBeUndefined();
      expect(laps.insertIgnoringDuplicates).toHaveBeenCalledTimes(1);
      expect(result.laps.map((lap) => lap.lapNumber)).toEqual(
        result.laps.map((_, i) => i + 1),
      );
    });

    it('stamps analyzedAt only after the rows are written', async () => {
      // The ordering is the whole recovery story: a crash between the two
      // leaves the session looking underived and the next read retries. Stamped
      // first, the session would permanently show laps it never got.
      const order: string[] = [];
      laps.insertIgnoringDuplicates.mockImplementation(async (rows: Lap[]) => {
        order.push('insert');
        stored = rows;
      });
      sessions.setAnalyzedAt.mockImplementation(async () => {
        order.push('stamp');
      });

      await service.getLaps(user, SESSION_ID);

      expect(order).toEqual(['insert', 'stamp']);
    });

    it('does not re-derive a session already analyzed', async () => {
      sessions.requireReadableSession.mockResolvedValue(
        session({ analyzedAt: new Date() }),
      );
      stored = [{ lapNumber: 1 } as Lap];

      const result = await service.getLaps(user, SESSION_ID);

      expect(result.laps).toEqual(stored);
      // Not "did not insert" — did not even look at the samples. Deriving and
      // then discarding would be the same answer at the same cost as the bug.
      expect(samples.countRange).not.toHaveBeenCalled();
      expect(samples.findRange).not.toHaveBeenCalled();
      expect(laps.insertIgnoringDuplicates).not.toHaveBeenCalled();
    });

    it('flags exactly one lap as best', async () => {
      const { laps: derived } = await service.getLaps(user, SESSION_ID);
      const best = derived.filter((lap) => lap.isBest);

      expect(best).toHaveLength(1);
      expect(best[0].lapMs).toBe(Math.min(...derived.map((lap) => lap.lapMs)));
    });

    it('derives sectors and braking points alongside the lap', async () => {
      const [lap] = (await service.getLaps(user, SESSION_ID)).laps;

      expect(lap.sectorMs).toHaveLength(3);
      expect(lap.brakingPoints.length).toBeGreaterThan(0);
      expect(lap.distanceM).toBeGreaterThan(1000);
    });
  });

  describe('when there is nothing to derive', () => {
    it('returns no-track-gate for a track the platform does not carry', async () => {
      tracks.resolve.mockResolvedValue(null);

      const result = await service.getLaps(user, SESSION_ID);

      expect(result).toMatchObject({ laps: [], reason: 'no-track-gate' });
      // Not an error and not a guess: no samples read, nothing stamped, so a
      // track added to the seed later makes the next read work.
      expect(samples.findRange).not.toHaveBeenCalled();
      expect(sessions.setAnalyzedAt).not.toHaveBeenCalled();
    });

    it('returns session-live for a session still running', async () => {
      sessions.requireReadableSession.mockResolvedValue(
        session({ status: SessionStatus.LIVE, endedAt: undefined }),
      );

      const result = await service.getLaps(user, SESSION_ID);

      expect(result).toMatchObject({ laps: [], reason: 'session-live' });
      expect(sessions.setAnalyzedAt).not.toHaveBeenCalled();
    });

    it('returns no-samples for a session that recorded nothing', async () => {
      samples.countRange.mockResolvedValue(0);

      const result = await service.getLaps(user, SESSION_ID);

      expect(result).toMatchObject({ laps: [], reason: 'no-samples' });
      expect(samples.findRange).not.toHaveBeenCalled();
    });

    it('refuses a session too large to derive in one request', async () => {
      samples.countRange.mockResolvedValue(MAX_ANALYSIS_SAMPLES + 1);

      const result = await service.getLaps(user, SESSION_ID);

      expect(result).toMatchObject({ laps: [], reason: 'too-many-samples' });
      // Counted, then refused — the point is to never pull the rows in.
      expect(samples.findRange).not.toHaveBeenCalled();
    });

    it('returns no-crossings without stamping the session', async () => {
      // Samples and a gate, but the car never crossed the line — a session
      // that ran at a different track than it claims, say. Not stamping is
      // deliberate: a corrected gate must be able to find laps on the next
      // read without anyone calling analyze.
      samples.findRange.mockResolvedValue([]);
      samples.countRange.mockResolvedValue(10);

      const result = await service.getLaps(user, SESSION_ID);

      expect(result).toMatchObject({ laps: [], reason: 'no-crossings' });
      expect(sessions.setAnalyzedAt).not.toHaveBeenCalled();
      expect(laps.insertIgnoringDuplicates).not.toHaveBeenCalled();
    });

    it('never reports a reason alongside laps', async () => {
      const result = await service.getLaps(user, SESSION_ID);

      expect(result.laps.length).toBeGreaterThan(0);
      expect(result).not.toHaveProperty('reason');
    });
  });

  describe('recompute', () => {
    it('replaces the previous derivation rather than merging into it', async () => {
      await service.getLaps(user, SESSION_ID);
      sessions.requireReadableSession.mockResolvedValue(
        session({ analyzedAt: new Date() }),
      );

      const result = await service.recompute(user, SESSION_ID);

      // Cleared first: a corrected gate can yield *fewer* laps, and an upsert
      // would leave the extras behind.
      expect(laps.deleteBySession).toHaveBeenCalledWith(SESSION_ID);
      expect(sessions.setAnalyzedAt).toHaveBeenCalledWith(SESSION_ID, null);
      expect(result.laps.length).toBeGreaterThanOrEqual(2);
    });

    it('re-derives a session that was already analyzed', async () => {
      sessions.requireReadableSession.mockResolvedValue(
        session({ analyzedAt: new Date('2026-08-05T12:00:00.000Z') }),
      );

      await service.recompute(user, SESSION_ID);

      expect(samples.findRange).toHaveBeenCalled();
      expect(laps.insertIgnoringDuplicates).toHaveBeenCalledTimes(1);
    });
  });

  describe('traces', () => {
    beforeEach(async () => {
      await service.getLaps(user, SESSION_ID);
    });

    it('returns a distance-indexed trace for one lap', async () => {
      const trace = await service.getLapTrace(user, SESSION_ID, 1, 200);

      expect(trace.lapNumber).toBe(1);
      expect(trace.points.length).toBeLessThanOrEqual(201);
      expect(trace.points[0].distM).toBe(0);
      expect(trace.points[0].elapsedMs).toBe(0);

      // Monotonic on both axes — the property every consumer assumes.
      for (let i = 1; i < trace.points.length; i++) {
        expect(trace.points[i].distM).toBeGreaterThanOrEqual(
          trace.points[i - 1].distM,
        );
        expect(trace.points[i].elapsedMs).toBeGreaterThan(
          trace.points[i - 1].elapsedMs,
        );
      }
    });

    it('carries the channels the charts draw', async () => {
      const trace = await service.getLapTrace(user, SESSION_ID, 1, 50);
      const point = trace.points[10];

      expect(point.speedKmh).toBeGreaterThan(0);
      expect(point.rpm).toBeGreaterThan(0);
      expect(point.coolantC).toBe(90);
      expect(point.gLat).not.toBeNull();
    });

    it('404s for a lap the session does not have', async () => {
      await expect(
        service.getLapTrace(user, SESSION_ID, 99, 100),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('compare', () => {
    beforeEach(async () => {
      await service.getLaps(user, SESSION_ID);
    });

    it('returns a distance-aligned delta between two laps', async () => {
      const result = await service.compare(user, SESSION_ID, [1, 2], 100);

      expect(result.lapA).toBe(1);
      expect(result.lapB).toBe(2);
      expect(result.points).toHaveLength(100);
      expect(result.points[0].distM).toBe(0);
      expect(result.points[0].deltaMs).toBe(0);
      expect(result.points[99].distM).toBeCloseTo(result.distanceM, 1);
    });

    it('ends the delta at the difference in lap times', async () => {
      const { laps: derived } = await service.getLaps(user, SESSION_ID);
      const result = await service.compare(user, SESSION_ID, [1, 2], 200);
      const final = result.points[result.points.length - 1];

      // The two laps cover the same distance, so the delta at the end of the
      // common axis is the lap-time difference. Anything else means the
      // alignment drifted.
      const expected = derived[1].lapMs - derived[0].lapMs;
      expect(Math.abs(final.deltaMs - expected)).toBeLessThan(250);
    });

    it('compares a lap against itself as a flat zero', async () => {
      const result = await service.compare(user, SESSION_ID, [1, 1], 50);

      for (const point of result.points) {
        expect(point.deltaMs).toBe(0);
      }
    });

    it('404s when either lap is missing', async () => {
      await expect(
        service.compare(user, SESSION_ID, [1, 99], 100),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('tenant scoping', () => {
    beforeEach(() => {
      // What `requireReadableSession` throws for a session on another team's
      // car: a 404, not a 403, so the id's existence is not confirmed.
      sessions.requireReadableSession.mockRejectedValue(
        new NotFoundException('Session not found'),
      );
    });

    it.each([
      ['getLaps', () => service.getLaps(user, SESSION_ID)],
      ['recompute', () => service.recompute(user, SESSION_ID)],
      ['getLapTrace', () => service.getLapTrace(user, SESSION_ID, 1, 100)],
      ['compare', () => service.compare(user, SESSION_ID, [1, 2], 100)],
    ])('refuses %s across a tenant boundary', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);

      // And nothing leaked on the way out: no samples read, no rows touched.
      expect(samples.findRange).not.toHaveBeenCalled();
      expect(samples.countRange).not.toHaveBeenCalled();
      expect(laps.findBySession).not.toHaveBeenCalled();
      expect(laps.findOneByNumber).not.toHaveBeenCalled();
      expect(laps.deleteBySession).not.toHaveBeenCalled();
      expect(laps.insertIgnoringDuplicates).not.toHaveBeenCalled();
    });
  });
});
