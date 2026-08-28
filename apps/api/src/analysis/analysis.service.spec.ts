import { SessionStatus } from '@app/common';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Session } from '../sessions/entities/session.entity';
import { SessionsService } from '../sessions/sessions.service';
import { Track } from '../tracks/entities/track.entity';
import { TracksService } from '../tracks/tracks.service';
import { PENDING } from '../tracks/track-map/track-map.types';
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
  let tracks: jest.Mocked<
    Pick<TracksService, 'resolve' | 'getTrackMap' | 'setDerivedSectorGates'>
  >;
  let laps: jest.Mocked<
    Pick<
      LapsRepository,
      | 'findBySession'
      | 'findOneByNumber'
      | 'insertIgnoringDuplicates'
      | 'replaceSession'
    >
  >;
  let samples: jest.Mocked<
    Pick<
      AnalysisSamplesRepository,
      'findRange' | 'countRange' | 'findLapWindow'
    >
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
    tracks = {
      resolve: jest.fn().mockResolvedValue(KALOYANOVO_TRACK),
      // No track map wired up in this suite — the reference-lap fallback
      // (step 4 of `sector-gates.ts`) is what runs. The centreline path gets
      // its own coverage in `sector-gates.spec.ts`.
      getTrackMap: jest.fn().mockResolvedValue(PENDING),
      setDerivedSectorGates: jest.fn().mockResolvedValue(undefined),
    };
    laps = {
      findBySession: jest.fn<Promise<Lap[]>, [string]>(async () => stored),
      findOneByNumber: jest.fn(
        async (_sessionId: string, lapNumber: number) =>
          stored.find((lap) => lap.lapNumber === lapNumber) ?? null,
      ),
      insertIgnoringDuplicates: jest.fn(async (rows: Lap[]) => {
        stored = rows;
      }),
      replaceSession: jest.fn(async (_sessionId: string, rows: Lap[]) => {
        stored = rows;
      }),
    };
    samples = {
      countRange: jest.fn().mockResolvedValue(data.length),
      findRange: jest.fn(async (_id: string, from: Date, to: Date) =>
        data.filter((sample) => sample.time >= from && sample.time <= to),
      ),
      // The window plus the fix either side of it, as the real query returns —
      // the crossing instants fall between stored samples, so a lap's trace
      // cannot be anchored on the line without them.
      findLapWindow: jest.fn(async (_id: string, from: Date, to: Date) => [
        ...data.filter((sample) => sample.time < from).slice(-1),
        ...data.filter((sample) => sample.time >= from && sample.time <= to),
        ...data.filter((sample) => sample.time > to).slice(0, 1),
      ]),
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
      stored = [
        { lapNumber: 1, sectorMs: [], brakingPoints: [], distanceM: 0 } as Lap,
      ];

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

    it('does not re-segment a no-crossings session on every read', async () => {
      // Not stamping `analyzedAt` is what lets a corrected gate be picked up on
      // the next load. Without a memo it also means re-reading and re-cutting
      // up to MAX_ANALYSIS_SAMPLES rows on every page load, forever.
      samples.findRange.mockResolvedValue([]);
      samples.countRange.mockResolvedValue(10);

      await service.getLaps(user, SESSION_ID);
      const second = await service.getLaps(user, SESSION_ID);

      expect(second).toMatchObject({ laps: [], reason: 'no-crossings' });
      expect(samples.findRange).toHaveBeenCalledTimes(1);
    });

    it('re-segments a no-crossings session once backfill lands', async () => {
      samples.findRange.mockResolvedValue([]);
      samples.countRange.mockResolvedValue(10);
      await service.getLaps(user, SESSION_ID);

      // More samples than last time: the memo describes a session that no
      // longer exists, and the crossings may be in the rows that just arrived.
      samples.countRange.mockResolvedValue(11);
      await service.getLaps(user, SESSION_ID);

      expect(samples.findRange).toHaveBeenCalledTimes(2);
    });

    it('re-segments a no-crossings session when the gate is corrected', async () => {
      samples.findRange.mockResolvedValue([]);
      samples.countRange.mockResolvedValue(10);
      await service.getLaps(user, SESSION_ID);

      tracks.resolve.mockResolvedValue({
        ...KALOYANOVO_TRACK,
        updatedAt: new Date('2026-08-06T09:00:00.000Z'),
      } as Track);
      await service.getLaps(user, SESSION_ID);

      expect(samples.findRange).toHaveBeenCalledTimes(2);
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

      // Replaced in one call, not cleared and re-inserted: a corrected gate can
      // yield *fewer* laps, so an upsert would leave the extras behind.
      expect(laps.replaceSession).toHaveBeenCalledWith(
        SESSION_ID,
        expect.any(Array),
      );
      expect(result.laps.length).toBeGreaterThanOrEqual(2);
    });

    it('re-derives a session that was already analyzed', async () => {
      sessions.requireReadableSession.mockResolvedValue(
        session({ analyzedAt: new Date('2026-08-05T12:00:00.000Z') }),
      );

      await service.recompute(user, SESSION_ID);

      expect(samples.findRange).toHaveBeenCalled();
      expect(laps.replaceSession).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['too-many-samples', () => samples.countRange.mockResolvedValue(1e9)],
      ['no-samples', () => samples.countRange.mockResolvedValue(0)],
      ['no-track-gate', () => tracks.resolve.mockResolvedValue(null)],
      ['no-crossings', () => samples.findRange.mockResolvedValue([])],
    ])(
      'keeps the existing laps when the re-derivation ends in %s',
      async (reason, breakIt) => {
        // The failure this guards: the old code deleted first and derived
        // after, so a session that has since grown past the sample ceiling on
        // backfill — or whose track slug stopped resolving — answered the
        // button press by destroying the laps it already had, permanently.
        const derived = (await service.getLaps(user, SESSION_ID)).laps;
        expect(derived.length).toBeGreaterThanOrEqual(2);

        sessions.requireReadableSession.mockResolvedValue(
          session({ analyzedAt: new Date() }),
        );
        breakIt();

        const result = await service.recompute(user, SESSION_ID);

        expect(result.reason).toBe(reason);
        expect(result.laps).toEqual(derived);
        expect(stored).toEqual(derived);
        expect(laps.replaceSession).not.toHaveBeenCalled();
      },
    );

    it('keeps the laps of a session that went live again', async () => {
      const derived = (await service.getLaps(user, SESSION_ID)).laps;
      sessions.requireReadableSession.mockResolvedValue(
        session({ status: SessionStatus.LIVE, analyzedAt: new Date() }),
      );

      const result = await service.recompute(user, SESSION_ID);

      expect(result).toMatchObject({ reason: 'session-live' });
      expect(result.laps).toEqual(derived);
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

    it('opens and closes the trace on the start/finish line', async () => {
      const [lap] = (await service.getLaps(user, SESSION_ID)).laps;
      const trace = await service.getLapTrace(
        user,
        SESSION_ID,
        lap.lapNumber,
        Number.MAX_SAFE_INTEGER,
      );
      const last = trace.points[trace.points.length - 1];

      // No stored sample sits on the crossing instant, so a plain range read
      // would start the axis at the first fix *past* the line and end it at the
      // last one before — leaving the trace short at both ends and giving two
      // laps distance axes with different origins.
      const inRange = await samples.findRange(
        SESSION_ID,
        lap.startedAt,
        lap.endedAt,
      );
      expect(inRange[0].time.getTime()).toBeGreaterThan(
        lap.startedAt.getTime(),
      );

      // The header and the chart describe the same lap: both endpoints are
      // rounded to the millisecond independently, so allow one.
      expect(Math.abs(last.elapsedMs - lap.lapMs)).toBeLessThanOrEqual(1);
      expect(Math.abs(last.distM - lap.distanceM)).toBeLessThan(2);
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

  describe('sector scheme', () => {
    it('stamps the session as gates-derived once a gate set resolves', async () => {
      const result = await service.getLaps(user, SESSION_ID);

      expect(result.sectorScheme).toBe('gates');
      expect(sessions.setAnalyzedAt).toHaveBeenCalledWith(
        SESSION_ID,
        expect.any(Date),
        'gates',
      );
    });

    it('persists a freshly derived gate set exactly once', async () => {
      await service.getLaps(user, SESSION_ID);

      expect(tracks.setDerivedSectorGates).toHaveBeenCalledTimes(1);
      expect(tracks.setDerivedSectorGates).toHaveBeenCalledWith(
        KALOYANOVO_TRACK.id,
        expect.objectContaining({ source: 'reference-lap' }),
      );
    });

    it('does not fetch the track map when the gates are already known', async () => {
      // `getTrackMap` races an outbound Overpass fetch against
      // TRACK_MAP_FETCH_DEADLINE_MS on a cold or stale track — up to eight
      // seconds in front of a derive whose gates were on the track row all
      // along. Steps 1–2 of the resolution ladder need no ring at all.
      await service.getLaps(user, SESSION_ID);
      const [, persisted] = tracks.setDerivedSectorGates.mock.calls[0];

      // The row that first derivation wrote, as the next session at this track
      // finds it.
      tracks.resolve.mockResolvedValue({
        ...KALOYANOVO_TRACK,
        derivedSectorGates: persisted,
      } as Track);
      tracks.getTrackMap.mockClear();
      tracks.setDerivedSectorGates.mockClear();

      const result = await service.recompute(user, SESSION_ID);

      expect(result.sectorScheme).toBe('gates');
      expect(tracks.getTrackMap).not.toHaveBeenCalled();
      // Read back, not re-derived: nothing new to persist either.
      expect(tracks.setDerivedSectorGates).not.toHaveBeenCalled();
    });

    it('falls back to distance fractions when no lap crosses the known gates', async () => {
      // The poisoning case: a gate set derived from one session's best lap can
      // be a few metres wide and sit on that lap's line, and another session at
      // the same track driving a different line misses it entirely. Applied
      // blind that leaves every lap with `sectorMs: []` — no sector table, no
      // optimal lap (`pickBestSectors` needs two laps with complete splits) —
      // for every session at that track, for good.
      tracks.resolve.mockResolvedValue({
        ...KALOYANOVO_TRACK,
        derivedSectorGates: {
          // A gate a few hundred kilometres away: crossed by nothing.
          gates: [{ lat1: 0, lon1: 0, lat2: 0.001, lon2: 0 }],
          source: 'reference-lap',
          derivedAt: '2026-08-01T00:00:00.000Z',
        },
      } as Track);

      const result = await service.getLaps(user, SESSION_ID);

      expect(result.sectorScheme).toBe('distance');
      // The distance-fraction splits the segmenter already produced, intact.
      for (const derivedLap of result.laps) {
        expect(derivedLap.sectorMs).toHaveLength(3);
      }
      expect(result.optimal).not.toBeNull();
    });
  });

  describe('optimal lap', () => {
    it('includes the optimal lap summary alongside the laps', async () => {
      const result = await service.getLaps(user, SESSION_ID);

      expect(result.optimal).not.toBeNull();
      expect(result.optimal!.lapMs).toBeGreaterThan(0);
      expect(result.optimal!.sectors).toHaveLength(3);
    });

    it("is the sum of the session's three lowest sector times", async () => {
      const { laps: derived, optimal } = await service.getLaps(
        user,
        SESSION_ID,
      );
      const bestPerSector = [0, 1, 2].map((i) =>
        Math.min(...derived.map((lap) => lap.sectorMs[i])),
      );

      expect(optimal!.lapMs).toBe(bestPerSector.reduce((a, b) => a + b, 0));
      expect(optimal!.lapMs).toBeLessThanOrEqual(
        Math.min(...derived.map((lap) => lap.lapMs)),
      );
    });

    describe('getOptimalTrace', () => {
      it('stitches a trace from the contributing laps', async () => {
        await service.getLaps(user, SESSION_ID);

        const trace = await service.getOptimalTrace(user, SESSION_ID, 200);

        expect(trace.lapNumber).toBe('optimal');
        expect(trace.points.length).toBeGreaterThan(1);
        expect(trace.points[0].distM).toBe(0);
        for (let i = 1; i < trace.points.length; i++) {
          expect(trace.points[i].distM).toBeGreaterThanOrEqual(
            trace.points[i - 1].distM,
          );
          expect(trace.points[i].elapsedMs).toBeGreaterThanOrEqual(
            trace.points[i - 1].elapsedMs,
          );
        }
        expect(trace.points[trace.points.length - 1].elapsedMs).toBe(
          trace.lapMs,
        );
      });

      it('404s when a contributing lap has no readable trace', async () => {
        // A partial stitch used to come back instead: two thirds of the
        // geometry, with the last point still pinned to the full three-sector
        // time and a `distanceM` short by a third, all reported as complete.
        await service.getLaps(user, SESSION_ID);
        samples.findLapWindow.mockResolvedValue([]);

        await expect(
          service.getOptimalTrace(user, SESSION_ID, 200),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('404s when fewer than two laps are eligible', async () => {
        stored = [
          {
            lapNumber: 1,
            sectorMs: [],
            brakingPoints: [],
            distanceM: 0,
          } as Lap,
        ];
        sessions.requireReadableSession.mockResolvedValue(
          session({ analyzedAt: new Date() }),
        );

        await expect(
          service.getOptimalTrace(user, SESSION_ID, 200),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('compare', () => {
      it("compares 'optimal' against a numbered lap", async () => {
        await service.getLaps(user, SESSION_ID);

        const result = await service.compare(
          user,
          SESSION_ID,
          ['optimal', 1],
          100,
        );

        expect(result.lapA).toBe('optimal');
        expect(result.lapB).toBe(1);
        expect(result.points.length).toBeGreaterThan(0);
      });

      it("compares a numbered lap against 'optimal'", async () => {
        await service.getLaps(user, SESSION_ID);

        const result = await service.compare(
          user,
          SESSION_ID,
          [1, 'optimal'],
          100,
        );

        expect(result.lapA).toBe(1);
        expect(result.lapB).toBe('optimal');
      });

      it('404s on the same condition the trace route does', async () => {
        // Not a 200 carrying `{ distanceM: 0, points: [] }` — that renders as
        // an empty delta chart with no error, where the frontend already has a
        // missing-trace path.
        await service.getLaps(user, SESSION_ID);
        stored = stored.map((row) => ({ ...row, sectorMs: [] }) as Lap);

        await expect(
          service.compare(user, SESSION_ID, ['optimal', 1], 100),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
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
      ['getOptimalTrace', () => service.getOptimalTrace(user, SESSION_ID, 100)],
    ])('refuses %s across a tenant boundary', async (_name, call) => {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);

      // And nothing leaked on the way out: no samples read, no rows touched.
      expect(samples.findRange).not.toHaveBeenCalled();
      expect(samples.countRange).not.toHaveBeenCalled();
      expect(laps.findBySession).not.toHaveBeenCalled();
      expect(laps.findOneByNumber).not.toHaveBeenCalled();
      expect(laps.replaceSession).not.toHaveBeenCalled();
      expect(laps.insertIgnoringDuplicates).not.toHaveBeenCalled();
    });
  });
});
