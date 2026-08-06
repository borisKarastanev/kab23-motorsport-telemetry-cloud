'use strict';

/**
 * Replay sources for the mock publisher — play a recorded drive instead of a
 * synthesized one.
 *
 * Built now, before any recording exists, because the Phase 4 plan's whole
 * argument for synthesizing a circuit is that a real log can slot in later
 * *without rework*. That promise is only worth anything if the seam exists.
 *
 * Both sources here implement the same contract as `CircuitDriver`:
 *
 *     step(dtMs) -> { lat, lon, speedKmh, rpm, gLat, gLon, gVert, lap, lapMs }
 *
 * so `mock-telemetry-publisher.js` neither knows nor cares which one it holds.
 *
 * **Identity fields are never replayed.** A recorded frame carries its own
 * `sid` and `seq`, and reusing them would make a replay collide with the
 * original run on the hypertable's `(session_id, seq, time)` dedup index — the
 * replay would be silently discarded as a duplicate, which looks exactly like a
 * broken ingest path. The publisher mints a fresh `sid` per run and owns `seq`;
 * these sources return physical channels only.
 *
 * **A replay ends by default.** `step` returns null once the recording runs
 * out, which is what lets the publisher close the session — a recording is a
 * finite thing and a run that replays one should be finite too. `loop: true`
 * repeats it instead, for driving a long test off a short record.
 */

const fs = require('fs');
const { distanceM, localFrame } = require('./geo');
const { rpmFor } = require('./circuit');

const G = 9.80665;

/**
 * Load a replay file, picking the format from its contents rather than its
 * extension — a `.json` could be either, and guessing wrong produces a confusing
 * parse error rather than a useful message.
 */
function loadReplaySource(filePath, options = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not a single JSON document — treat it as JSONL below.
  }

  if (parsed) {
    const record = findDashRecord(parsed);
    if (record) {
      return new DashRecordSource(record, options);
    }
    throw new Error(
      `${filePath}: parsed as JSON but carries no lapPaths — not a dash session record`,
    );
  }

  const frames = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${filePath}: line ${index + 1} is not valid JSON`);
      }
    });

  if (!frames.length) {
    throw new Error(`${filePath}: empty`);
  }

  return new FrameLogSource(frames, options);
}

/**
 * The first record carrying GPS geometry.
 *
 * The dash persists its sessions as an *array*, newest first, and records saved
 * before GPS-path capture existed have no `lapPaths` at all — so the newest
 * record is not necessarily a usable one.
 */
function findDashRecord(parsed) {
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  return (
    candidates.find(
      (record) =>
        Array.isArray(record?.lapPaths) &&
        record.lapPaths.length &&
        Array.isArray(record?.lapMs),
    ) ?? null
  );
}

/**
 * Replays a dash session record: `{ lapMs: [...], lapPaths: [[lat, lon, …]] }`,
 * where each `lapPaths` entry is a flat coordinate array parallel to `lapMs`.
 *
 * **Lossy, and worth being explicit about.** These records carry geometry and a
 * total time per lap — nothing else. No per-point timestamps, no rpm, no CAN
 * channels, and the paths are decimated by the dash before they are saved. What
 * comes out is a *real racing line* with *synthesized telemetry*:
 *
 * - Points are spread across the lap by **cumulative distance**, i.e. assuming
 *   constant speed. That is plainly wrong through a corner, and it means a
 *   braking-point detector run against this source will find the corner but not
 *   the driver's actual brake application.
 * - Speed comes from point-to-point spacing over that assumed timing, rpm from
 *   the same gear map the circuit generator uses, lateral g from the path's
 *   curvature, longitudinal g from the change in derived speed.
 *
 * Use it to check that segmentation copes with a real line's noise and
 * decimation. Do not use it to validate anything about the channels.
 */
class DashRecordSource {
  constructor(record, { loop = false } = {}) {
    this.loop = loop;
    this.laps = record.lapPaths
      .map((flat, index) => buildLap(flat, record.lapMs[index]))
      .filter(Boolean);

    if (!this.laps.length) {
      throw new Error('dash record has no lap with usable geometry');
    }

    this.lapIndex = 0;
    this.lapMs = 0;
    this.lap = 1;
    this.previousSpeedKmh = 0;
    this.exhausted = false;
  }

  step(dtMs) {
    if (this.exhausted) {
      return null;
    }

    this.lapMs += dtMs;
    let lap = this.laps[this.lapIndex];

    while (this.lapMs >= lap.totalMs) {
      this.lapMs -= lap.totalMs;
      this.lapIndex += 1;

      if (this.lapIndex >= this.laps.length) {
        if (!this.loop) {
          this.exhausted = true;
          return null;
        }
        this.lapIndex = 0;
      }

      this.lap += 1;
      lap = this.laps[this.lapIndex];
    }

    return sampleAlongLap(lap, this.lapMs, this.lap, dtMs, this);
  }
}

/**
 * Replays a JSONL frame log — one `TelemetryFrameDto` per line, which is what a
 * dump straight off the ingest path or a future `--record` flag would produce.
 *
 * Lossless for every channel the log actually contains. Missing channels stay
 * missing rather than being reconstructed: a log is evidence, and quietly
 * filling gaps in it would defeat the reason for replaying one.
 *
 * **Replayed on the log's own clock**, not one frame per call. A 25 Hz dash log
 * pushed through the publisher's 10 Hz tick would otherwise be stretched 2.5× —
 * and since the publisher mints `mono`, ingest would believe it, so every
 * derived lap time, sector and braking-zone duration would come out 2.5× long
 * with nothing anywhere saying so. Frames the tick has already passed are
 * skipped instead, which preserves the recording's duration at whatever rate
 * the publisher runs.
 */
class FrameLogSource {
  constructor(frames, { loop = false } = {}) {
    this.frames = frames;
    this.loop = loop;
    this.index = 0;
    this.exhausted = false;

    // Relative ms of each frame, or null if the log carries no usable clock —
    // then there is nothing to honour and one frame per call is the best
    // available reading of it.
    this.times = relativeTimes(frames);
    this.spanMs = this.times ? this.times[this.times.length - 1] : 0;
    this.elapsedMs = 0;
  }

  step(dtMs) {
    if (this.exhausted) {
      return null;
    }

    return this.times ? this.stepByClock(dtMs) : this.stepByIndex();
  }

  /** One frame per call: the log has no timestamps to pace it by. */
  stepByIndex() {
    if (this.index >= this.frames.length) {
      if (!this.loop) {
        this.exhausted = true;
        return null;
      }
      this.index = 0;
    }

    return toSample(this.frames[this.index++]);
  }

  stepByClock(dtMs) {
    if (this.elapsedMs > this.spanMs) {
      if (!this.loop) {
        this.exhausted = true;
        return null;
      }
      this.elapsedMs -= this.spanMs;
      this.index = 0;
    }

    // Skip every frame the clock has gone past, so a log recorded faster than
    // the publisher's tick is decimated rather than stretched.
    while (
      this.index + 1 < this.frames.length &&
      this.times[this.index + 1] <= this.elapsedMs
    ) {
      this.index++;
    }

    const frame = this.frames[this.index];
    this.elapsedMs += dtMs;

    return toSample(frame);
  }
}

/**
 * Each frame's offset from the first, in ms, or null if the log has no clock.
 *
 * `mono` is the field the Pi mints for exactly this purpose and is preferred:
 * `ts` is wall clock from a device with no RTC, and can step. Either way the
 * series has to be non-decreasing and cover some span, or it is not a clock —
 * a log written by a test fixture routinely has neither field, and falling back
 * is better than pacing off a fabricated one.
 */
function relativeTimes(frames) {
  for (const field of ['mono', 'ts']) {
    if (!frames.every((frame) => Number.isFinite(frame?.[field]))) {
      continue;
    }

    const base = frames[0][field];
    const times = frames.map((frame) => frame[field] - base);

    const monotonic = times.every((t, i) => i === 0 || t >= times[i - 1]);
    if (monotonic && times[times.length - 1] > 0) {
      return times;
    }
  }

  return null;
}

/** One wire frame as the publisher's sample shape. */
function toSample(frame) {
  // Physical channels only — see the note on identity fields at the top.
  return {
    lat: frame.lat,
    lon: frame.lon,
    speedKmh: frame.speed,
    rpm: frame.rpm,
    gLat: frame.gx,
    gLon: frame.gy,
    gVert: frame.gz,
    lap: frame.lap,
    lapMs: frame.lapMs,
  };
}

/**
 * Turn one flat `[lat, lon, lat, lon, …]` path into a distance-indexed lap.
 *
 * Returns null for a path too short to interpolate along, or a lap with no
 * recorded time — both appear in real records and neither is an error.
 */
function buildLap(flat, totalMs) {
  if (!Array.isArray(flat) || flat.length < 4 || !totalMs) {
    return null;
  }

  const points = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    points.push({ lat: flat[i], lon: flat[i + 1] });
  }

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] +
        distanceM(
          points[i - 1].lat,
          points[i - 1].lon,
          points[i].lat,
          points[i].lon,
        ),
    );
  }

  const total = cumulative[cumulative.length - 1];
  if (total <= 0) {
    return null;
  }

  // Elapsed time at each point, assuming constant speed — see the class note.
  const elapsed = cumulative.map((d) => (d / total) * totalMs);

  return { points, cumulative, elapsed, totalMs, lengthM: total };
}

/** Position and derived channels at `lapMs` into a lap. */
function sampleAlongLap(lap, lapMs, lapNumber, dtMs, state) {
  const { points, elapsed } = lap;

  let i = 1;
  while (i < elapsed.length - 1 && elapsed[i] < lapMs) {
    i++;
  }

  const span = elapsed[i] - elapsed[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (lapMs - elapsed[i - 1]) / span));

  const a = points[i - 1];
  const b = points[i];
  const lat = a.lat + (b.lat - a.lat) * f;
  const lon = a.lon + (b.lon - a.lon) * f;

  const segmentM = lap.cumulative[i] - lap.cumulative[i - 1];
  const speedKmh = (segmentM / (span / 1000)) * 3.6;

  const gLon = (speedKmh - state.previousSpeedKmh) / 3.6 / (dtMs / 1000) / G;
  state.previousSpeedKmh = speedKmh;

  return {
    lat,
    lon,
    speedKmh,
    rpm: rpmFor(speedKmh),
    gLat: lateralG(points, i, speedKmh),
    gLon,
    gVert: 1,
    lap: lapNumber,
    lapMs: Math.round(lapMs),
  };
}

/**
 * Lateral g from the path's curvature at a point, via the circumscribed circle
 * of its two neighbours. Zero where the geometry is degenerate — three points
 * on a straight give an infinite radius, and a decimated path routinely has
 * coincident points.
 */
function lateralG(points, i, speedKmh) {
  const p = points[i - 1];
  const q = points[i];
  const r = points[Math.min(i + 1, points.length - 1)];

  const frame = localFrame(q.lat, q.lon);
  const a = frame.toLocal(p.lat, p.lon);
  const b = frame.toLocal(r.lat, r.lon);

  const ax = -a.x;
  const ay = -a.y;
  const bx = b.x;
  const by = b.y;

  const denominator =
    Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(bx - ax, by - ay);
  if (denominator < 1e-6) {
    return 0;
  }

  const kappa = (2 * (ax * by - ay * bx)) / denominator;
  const speedMs = speedKmh / 3.6;

  return (speedMs * speedMs * kappa) / G;
}

module.exports = {
  loadReplaySource,
  DashRecordSource,
  FrameLogSource,
};
