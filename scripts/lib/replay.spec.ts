/**
 * The `--replay` path.
 *
 * Worth testing before any real recording exists, because the whole argument
 * for synthesizing a circuit (Phase 4 plan §1) is that a real log slots in
 * later *without rework*. An untested seam would not deliver that.
 *
 * The dash-record fixture is generated from the circuit itself, which makes the
 * round trip meaningful: drive the synthetic track, save it in the shape the
 * dash saves sessions in, replay it, and the line should come back.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { localFrame } = require('./geo');
const { CircuitDriver } = require('./circuit');
const { loadReplaySource } = require('./replay');

const TICK_MS = 100;

interface Local {
  x: number;
  y: number;
}

/** Perpendicular distance from a point to a segment, in metres. */
const pointToSegmentM = (p: Local, a: Local, b: Local) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  // Clamped, so a point beyond either end measures to that end rather than to
  // the segment's infinite extension.
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared),
  );

  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const workDir = mkdtempSync(join(tmpdir(), 'replay-spec-'));

const write = (name: string, contents: string) => {
  const path = join(workDir, name);
  writeFileSync(path, contents);
  return path;
};

/** Drive the circuit and capture it the way the dash's SessionModel would. */
const dashRecordFixture = (laps = 3) => {
  const driver = new CircuitDriver({ seed: 20260805, gpsNoiseM: 0 });
  const lapPaths: number[][] = [];
  let current: number[] = [];
  let previousLap = driver.lap;

  while (lapPaths.length < laps) {
    const sample = driver.step(TICK_MS);

    if (sample.lap !== previousLap) {
      // Lap 0 is the out-lap and is never saved, exactly as on the dash.
      if (previousLap > 0) lapPaths.push(current);
      current = [];
      previousLap = sample.lap;
    }

    current.push(sample.lat, sample.lon);
  }

  return {
    title: '2026-08-05 14:30',
    lapMs: driver.completedLapMs.slice(0, laps),
    lapPaths,
    trackName: 'Kaloyanovo',
  };
};

describe('dash session records', () => {
  it('replays a recorded racing line', () => {
    const record = dashRecordFixture();
    const source = loadReplaySource(
      write('session.json', JSON.stringify([record])),
    );

    const samples: any[] = [];
    for (let i = 0; i < 1200; i++) {
      const sample = source.step(TICK_MS);
      if (!sample) break;
      samples.push(sample);
    }

    expect(samples.length).toBe(1200);

    // Every replayed point sits *on* the recorded line — measured against the
    // nearest polyline **segment**, not the nearest vertex. Replay interpolates
    // along the line, so a point halfway down a chord is legitimately half a
    // chord from either end of it (up to ~2.5 m at 10 Hz and 180 km/h); a
    // vertex test would be measuring the recording's sample rate, not fidelity.
    const frame = localFrame(record.lapPaths[0][0], record.lapPaths[0][1]);
    const lines = record.lapPaths.map((flat) => {
      const points: { x: number; y: number }[] = [];
      for (let i = 0; i + 1 < flat.length; i += 2) {
        points.push(frame.toLocal(flat[i], flat[i + 1]));
      }
      return points;
    });

    for (const sample of samples) {
      const point = frame.toLocal(sample.lat, sample.lon);
      let nearest = Infinity;

      for (const line of lines) {
        for (let i = 1; i < line.length; i++) {
          nearest = Math.min(
            nearest,
            pointToSegmentM(point, line[i - 1], line[i]),
          );
        }
      }

      expect(nearest).toBeLessThan(0.05);
    }
  });

  it('reconstructs plausible speed from geometry and lap time', () => {
    // Constant-speed spreading, so this cannot recover the real speed trace —
    // but it must land in the right ballpark, or a replayed session would look
    // like a different car.
    const source = loadReplaySource(
      write('speed.json', JSON.stringify(dashRecordFixture())),
    );

    const speeds: number[] = [];
    for (let i = 0; i < 600; i++) {
      speeds.push(source.step(TICK_MS).speedKmh);
    }

    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    expect(mean).toBeGreaterThan(80);
    expect(mean).toBeLessThan(160);
  });

  it('runs out at the end of the recording', () => {
    // The default, and what lets the publisher close the session: a recording
    // is a finite thing, so a run replaying one is finite too.
    const record = dashRecordFixture(1);
    const source = loadReplaySource(write('once.json', JSON.stringify(record)));

    let steps = 0;
    while (source.step(TICK_MS)) {
      steps++;
      if (steps > 5000) break;
    }

    // The one lap it holds, to within a tick.
    expect(steps).toBeCloseTo(record.lapMs[0] / TICK_MS, -1);
    expect(source.step(TICK_MS)).toBeNull();
  });

  it('loops when asked to, rather than running dry', () => {
    const source = loadReplaySource(
      write('loop.json', JSON.stringify(dashRecordFixture(1))),
      { loop: true },
    );

    // Well past the single lap it holds.
    for (let i = 0; i < 2000; i++) {
      expect(source.step(TICK_MS)).not.toBeNull();
    }
    expect(source.step(TICK_MS).lap).toBeGreaterThan(1);
  });

  it('skips records saved before GPS-path capture existed', () => {
    const usable = dashRecordFixture(1);
    const source = loadReplaySource(
      write(
        'mixed.json',
        // Newest first, as the dash persists them — so the newest record is not
        // necessarily one that carries geometry.
        JSON.stringify([{ title: 'old', lapMs: [90000] }, usable]),
      ),
    );

    expect(source.step(TICK_MS)).not.toBeNull();
  });

  it('refuses a JSON file that is not a session record', () => {
    expect(() =>
      loadReplaySource(write('wrong.json', JSON.stringify({ hello: 'world' }))),
    ).toThrow(/not a dash session record/);
  });

  it('refuses a record whose only lap path is too short to interpolate', () => {
    const record = {
      lapMs: [90_000],
      lapPaths: [[42.34, 24.73]], // one point — nothing to draw a line between
    };

    expect(() =>
      loadReplaySource(write('short-lap.json', JSON.stringify(record))),
    ).toThrow(/no lap with usable geometry/);
  });

  it('refuses a record whose only lap has no recorded time', () => {
    const record = {
      lapMs: [0],
      lapPaths: [[42.34, 24.73, 42.341, 24.731]],
    };

    expect(() =>
      loadReplaySource(write('no-time-lap.json', JSON.stringify(record))),
    ).toThrow(/no lap with usable geometry/);
  });

  it('refuses a record whose only lap covered no measured distance', () => {
    // A path of coincident points — the dash's decimation can produce these —
    // has a real duration but nothing to spread it across.
    const record = {
      lapMs: [90_000],
      lapPaths: [[42.34, 24.73, 42.34, 24.73, 42.34, 24.73]],
    };

    expect(() =>
      loadReplaySource(write('stationary-lap.json', JSON.stringify(record))),
    ).toThrow(/no lap with usable geometry/);
  });
});

describe('JSONL frame logs', () => {
  const frames = [
    {
      v: 1,
      sid: 'a',
      seq: 1,
      lat: 42.34,
      lon: 24.73,
      speed: 120,
      rpm: 5200,
      gx: 0.4,
      gy: -0.2,
      gz: 1,
      lap: 2,
      lapMs: 1000,
    },
    {
      v: 1,
      sid: 'a',
      seq: 2,
      lat: 42.341,
      lon: 24.731,
      speed: 118,
      rpm: 5100,
      gx: 0.5,
      gy: -0.9,
      gz: 1,
      lap: 2,
      lapMs: 1100,
    },
  ];

  const log = () =>
    loadReplaySource(
      write('log.jsonl', frames.map((f) => JSON.stringify(f)).join('\n')),
    );

  it('passes recorded channels through untouched', () => {
    const sample = log().step(TICK_MS);

    expect(sample.lat).toBe(42.34);
    expect(sample.speedKmh).toBe(120);
    expect(sample.rpm).toBe(5200);
    expect(sample.gLat).toBe(0.4);
    expect(sample.gLon).toBe(-0.2);
  });

  it('never replays the recorded identity fields', () => {
    // A recorded frame's own sid/seq are the hypertable's dedup key. Replaying
    // them would make the whole run collide with the original and vanish, which
    // looks exactly like a broken ingest path.
    const sample = log().step(TICK_MS);

    expect(sample.sid).toBeUndefined();
    expect(sample.seq).toBeUndefined();
  });

  it("replays on the log's own clock, not one frame per tick", () => {
    // A 25 Hz recording pushed one-frame-per-call through the 10 Hz publisher
    // would be stretched 2.5×. The publisher mints `mono`, so ingest would
    // believe it and every derived lap time would come out 2.5× long with
    // nothing anywhere saying so.
    // 250 frames 40 ms apart — 10 s at 25 Hz. `lap` rides along as the frame's
    // index, since it is passed through untouched.
    const recorded = Array.from({ length: 250 }, (_, i) => ({
      v: 1,
      mono: i * 40,
      lat: 42.34 + i * 1e-5,
      lon: 24.73,
      speed: 100,
      lap: i,
    }));

    const source = loadReplaySource(
      write('25hz.jsonl', recorded.map((f) => JSON.stringify(f)).join('\n')),
    );

    const played: any[] = [];
    for (
      let sample = source.step(TICK_MS);
      sample;
      sample = source.step(TICK_MS)
    ) {
      played.push(sample);
    }

    // 10 s of recording replayed at 10 Hz is ~100 frames, not 250.
    expect(played.length).toBeCloseTo(100, -1);

    // Decimated, not truncated: it starts at the first recorded frame and ends
    // within one tick of the last, having stepped ~2.5 frames per tick.
    // One tick spans 2.5 recorded frames, so the final tick can legitimately
    // land short of the last one — but only by that much.
    expect(played[0].lap).toBe(0);
    expect(played[played.length - 1].lap).toBeGreaterThanOrEqual(
      recorded.length - 4,
    );
  });

  it('falls back to one frame per tick when the log has no clock', () => {
    // A hand-written fixture, or a log from before `mono` existed. Pacing off a
    // fabricated clock would be worse than admitting there is none.
    const source = log();

    expect(source.step(TICK_MS).speedKmh).toBe(120);
    expect(source.step(TICK_MS).speedKmh).toBe(118);
    expect(source.step(TICK_MS)).toBeNull();
    // Once exhausted, it stays exhausted rather than restarting the log.
    expect(source.step(TICK_MS)).toBeNull();
  });

  it('loops a clockless log rather than running dry', () => {
    const source = loadReplaySource(
      write('loop.jsonl', frames.map((f) => JSON.stringify(f)).join('\n')),
      { loop: true },
    );

    const speeds: number[] = [];
    for (let i = 0; i < 6; i++) {
      speeds.push(source.step(TICK_MS).speedKmh);
    }

    // Two frames, six steps: the recording repeats twice over.
    expect(speeds).toEqual([120, 118, 120, 118, 120, 118]);
  });

  it("loops a clocked log rather than running dry", () => {
    // A 40 ms recording replayed well past its own span at a 100 ms tick.
    const recorded = [
      { v: 1, mono: 0, lat: 42.34, lon: 24.73, speed: 100, lap: 1 },
      { v: 1, mono: 40, lat: 42.341, lon: 24.73, speed: 110, lap: 1 },
    ];
    const source = loadReplaySource(
      write('loop-clock.jsonl', recorded.map((f) => JSON.stringify(f)).join('\n')),
      { loop: true },
    );

    const speeds: number[] = [];
    for (let i = 0; i < 10; i++) {
      speeds.push(source.step(TICK_MS).speedKmh);
    }

    // Every value seen belongs to the two-frame recording, however far past
    // its own span the clock has been driven.
    expect(speeds.every((speed) => speed === 100 || speed === 110)).toBe(true);
    expect(speeds).toContain(100);
  });

  it('rejects a malformed line by number', () => {
    expect(() =>
      loadReplaySource(write('bad.jsonl', '{"v":1}\nnot json')),
    ).toThrow(/line 2/);
  });

  it('rejects an empty file', () => {
    expect(() => loadReplaySource(write('empty.jsonl', '\n\n'))).toThrow(
      /empty/,
    );
  });
});
