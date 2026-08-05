#!/usr/bin/env node
/**
 * Simulates the on-car Pi uplink: publishes telemetry frames at 10 Hz to
 * `cars/<deviceId>/telemetry` over MQTT (the confirmed persist rate). Exercises
 * the ingest service before the real Pi uplink exists, and implements the same
 * wire contract the dash will (see libs/common/src/constants/mqtt-topics.ts and
 * ~/development/phase2-pi-cloud-uplink-plan.md).
 *
 * The car drives a **synthetic circuit anchored on Kaloyanovo's real, confirmed
 * start/finish gate** (scripts/lib/circuit.js). This is the Phase 4
 * prerequisite: the previous version traced an arbitrary ~110 m circle with no
 * gate anywhere near it and with speed/rpm/g as sine waves unrelated to the
 * path, so lap segmentation and braking-point detection had nothing real to
 * work against. Speed now falls out of the track's curvature, and the g
 * channels out of the speed, so the channels and the geometry agree.
 *
 * The broker is no longer anonymous, so this needs a car's credentials — issue
 * them with `POST /cars/:id/mqtt-credentials` and pass the secret in
 * MQTT_DEVICE_PASSWORD. The username is the deviceId.
 *
 * Usage:
 *   MQTT_DEVICE_PASSWORD=… node scripts/mock-telemetry-publisher.js [deviceId] [mqttUrl]
 *   MQTT_DEVICE_PASSWORD=… node scripts/mock-telemetry-publisher.js --replay run.jsonl TEST123
 *
 * Options:
 *   --replay <file> replay a recorded drive instead of the synthetic circuit.
 *                   Accepts a JSONL frame log, or a dash session record
 *                   (`{lapMs, lapPaths}`) — see scripts/lib/replay.js for what
 *                   each format can and cannot reproduce.
 *   --seed <n>      PRNG seed for the circuit's per-lap variation (default
 *                   20260805). Same seed, same laps.
 *   --lap-m <n>     lap length in metres (default 2100, a plausible club
 *                   circuit). The shape is scaled but still fitted to the same
 *                   real gate, so it crosses correctly at any size — 600 m
 *                   gives ~30 s laps at 44–133 km/h, which is what makes an
 *                   end-to-end lap-derivation check take two minutes instead
 *                   of four and a half.
 *
 * Options (env):
 *   DROP_EVERY=30   simulate a 5 s link outage every 30 s: frames are spooled
 *                   and replayed on `backfill`, as the Pi's store-and-forward
 *                   does. Verifies the backfill path without a real LTE link.
 *   REPLAY_BACKFILL=1  send every backfill batch twice, to prove the ingest
 *                   dedup index makes a re-sent batch a no-op. (Unrelated to
 *                   `--replay`: this one duplicates backfill batches.)
 *   GPS_NOISE_M=0.7 GPS jitter, 1σ per axis. Non-zero by default so the
 *                   segmenter's crossing debounce is actually exercised.
 */
const mqtt = require('mqtt');
const { randomUUID } = require('crypto');
const { CircuitDriver, KALOYANOVO } = require('./lib/circuit');
const { loadReplaySource } = require('./lib/replay');

// Flags first, so the existing positional [deviceId] [mqttUrl] contract — which
// both local smoke tests depend on — keeps working with or without them.
const argv = process.argv.slice(2);
const positional = [];
let replayFile = null;
let seed = 20260805;
let targetLapM;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--replay') {
    replayFile = argv[++i];
  } else if (argv[i] === '--seed') {
    seed = Number(argv[++i]);
  } else if (argv[i] === '--lap-m') {
    targetLapM = Number(argv[++i]);
  } else {
    positional.push(argv[i]);
  }
}

const deviceId = positional[0] || 'TEST123';
const url = positional[1] || process.env.MQTT_URL || 'mqtt://localhost:1883';
const password = process.env.MQTT_DEVICE_PASSWORD;
const username = process.env.MQTT_DEVICE_USERNAME || deviceId;
const dropEvery = Number(process.env.DROP_EVERY) || 0;
const replayBackfill = process.env.REPLAY_BACKFILL === '1';
const gpsNoiseM =
  process.env.GPS_NOISE_M !== undefined ? Number(process.env.GPS_NOISE_M) : 0.7;

const HZ = 10;
const TICK_MS = 1000 / HZ;
const OUTAGE_MS = 5000;
const BACKFILL_BATCH = 200;

if (!password) {
  console.error(
    '[mock] MQTT_DEVICE_PASSWORD is not set — the broker requires per-car\n' +
      '       credentials. Issue them with POST /cars/:id/mqtt-credentials.',
  );
  process.exit(1);
}

// The driving model. Both kinds expose the same `step(dtMs)`, so nothing below
// this line knows which one it is holding.
let source;
try {
  source = replayFile
    ? loadReplaySource(replayFile)
    : new CircuitDriver({ seed, gpsNoiseM, ...(targetLapM ? { targetLapM } : {}) });
} catch (error) {
  console.error(`[mock] ${error.message}`);
  process.exit(1);
}

const client = mqtt.connect(url, { username, password });
const telemetryTopic = `cars/${deviceId}/telemetry`;
const sessionTopic = `cars/${deviceId}/session`;
const backfillTopic = `cars/${deviceId}/backfill`;

// One run = one `sid`. It is the idempotency key that keeps a replayed backlog
// in a single session row rather than opening a second one. Minted here even on
// `--replay`: a recorded frame's own sid must never be reused, or the replay
// would collide with the original run on the dedup index and vanish.
const sid = randomUUID();
const startedAt = Date.now();
let seq = 0;

// Monotonic ms since start, matching the field the Pi sends. `ts` is wall clock
// and may be wrong on a device with no RTC; ingest anchors on `mono` instead.
const mono = () => Date.now() - startedAt;

/** Spooled frames during a simulated outage, drained on "reconnect". */
const spool = [];
let offlineUntil = 0;
// An absolute deadline rather than a modulo window on `mono`: setInterval
// drifts, so a tick landing a few ms late would skip the window entirely and
// the run would never exercise the backfill path this flag exists to test.
let nextOutageAt = dropEvery ? Date.now() + dropEvery * 1000 : Infinity;

/** Trim float noise out of the payload; these are 10 Hz messages over LTE. */
const round = (value, places) =>
  value === undefined || value === null || !Number.isFinite(value)
    ? undefined
    : Number(value.toFixed(places));

/**
 * One wire frame from one physical sample.
 *
 * Engine temperatures are the only channels invented here rather than derived
 * from the drive: they have no relationship to the racing line, and doing them
 * this way means the replay sources — which have no CAN data at all — get the
 * same treatment as the circuit.
 */
function buildFrame(sample) {
  const elapsedS = mono() / 1000;

  return {
    v: 1,
    sid,
    seq: ++seq,
    ts: Date.now(),
    mono: mono(),
    rpm: sample.rpm,
    coolant: round(88 + 2 * Math.sin(elapsedS / 20), 1),
    oil: round(96 + 3 * Math.sin(elapsedS / 25), 1),
    speed: round(sample.speedKmh, 1),
    lat: round(sample.lat, 7),
    lon: round(sample.lon, 7),
    gx: round(sample.gLat, 3),
    gy: round(sample.gLon, 3),
    gz: round(sample.gVert, 3),
    lap: sample.lap,
    lapMs: sample.lapMs,
    fix: 3,
    sats: 11,
  };
}

function drainSpool() {
  while (spool.length) {
    const frames = spool.splice(0, BACKFILL_BATCH);
    const batch = JSON.stringify({ v: 1, sid, frames });
    client.publish(backfillTopic, batch, { qos: 1 });
    if (replayBackfill) {
      // Deliberately re-send: the Pi does this whenever a PUBACK is lost, so
      // ingest must dedupe rather than double-count.
      client.publish(backfillTopic, batch, { qos: 1 });
    }
    console.log(
      `[mock] backfilled ${frames.length} frames${replayBackfill ? ' (sent twice)' : ''}`,
    );
  }
}

client.on('connect', () => {
  console.log(
    `[mock] connected ${url} as ${username}, publishing ${telemetryTopic} @ ${HZ}Hz (sid ${sid})`,
  );
  console.log(
    replayFile
      ? `[mock] replaying ${replayFile}`
      : `[mock] driving the synthetic ${KALOYANOVO.name} circuit ` +
          `(${Math.round(source.lapLengthM)} m lap, seed ${seed}, GPS noise ${gpsNoiseM} m)`,
  );

  client.publish(
    sessionTopic,
    JSON.stringify({
      v: 1,
      sid,
      event: 'start',
      at: Date.now(),
      mono: mono(),
      track: KALOYANOVO.slug,
      trackName: KALOYANOVO.name,
    }),
    { qos: 1 },
  );

  const timer = setInterval(() => {
    const sample = source.step(TICK_MS);

    // A replay source runs out; the circuit never does.
    if (!sample) {
      clearInterval(timer);
      console.log('[mock] replay exhausted — closing the session');
      stop();
      return;
    }

    const frame = buildFrame(sample);
    const now = Date.now();

    if (now >= nextOutageAt) {
      offlineUntil = now + OUTAGE_MS;
      nextOutageAt = offlineUntil + dropEvery * 1000;
      console.log(`[mock] simulating ${OUTAGE_MS / 1000}s link outage`);
    }

    if (now < offlineUntil) {
      spool.push(frame);
      return;
    }

    if (spool.length) {
      drainSpool();
    }

    client.publish(telemetryTopic, JSON.stringify(frame), { qos: 0 });
  }, TICK_MS);
});

client.on('error', (err) => {
  console.error('[mock] error', err.message);
  process.exit(1);
});

/**
 * Close the run.
 *
 * The `laps` and `topSpeedKmh` here are the drive's *actual* figures, not the
 * hardcoded pair the old mock sent. `SessionEventDto` keeps this field "for
 * cross-checking the cloud's own Phase 4 derivation" — which only works if the
 * device's numbers are true, so that a disagreement with the segmenter means
 * something.
 */
function stop() {
  drainSpool();

  const laps = source.completedLapMs ?? [];

  if (laps.length) {
    const best = Math.min(...laps);
    console.log(
      `[mock] ${laps.length} timed lap(s), best ${(best / 1000).toFixed(3)}s ` +
        `[${laps.map((ms) => (ms / 1000).toFixed(3)).join(', ')}]`,
    );
  }

  client.publish(
    sessionTopic,
    JSON.stringify({
      v: 1,
      sid,
      event: 'stop',
      at: Date.now(),
      mono: mono(),
      laps: laps.slice(0, 500),
      topSpeedKmh: round(source.topSpeedKmh, 1),
    }),
    { qos: 1 },
    () => {
      client.end();
      process.exit(0);
    },
  );
}

process.on('SIGINT', stop);
