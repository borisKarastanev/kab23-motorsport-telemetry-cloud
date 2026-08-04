#!/usr/bin/env node
/**
 * Simulates the on-car Pi uplink: publishes telemetry frames at 10 Hz to
 * `cars/<deviceId>/telemetry` over MQTT (the confirmed persist rate). Exercises
 * the ingest service before the real Pi uplink exists, and implements the same
 * wire contract the dash will (see libs/common/src/constants/mqtt-topics.ts and
 * ~/development/phase2-pi-cloud-uplink-plan.md).
 *
 * The broker is no longer anonymous, so this needs a car's credentials — issue
 * them with `POST /cars/:id/mqtt-credentials` and pass the secret in
 * MQTT_DEVICE_PASSWORD. The username is the deviceId.
 *
 * Usage:
 *   MQTT_DEVICE_PASSWORD=… node scripts/mock-telemetry-publisher.js [deviceId] [mqttUrl]
 *
 * Options (env):
 *   DROP_EVERY=30   simulate a 5 s link outage every 30 s: frames are spooled
 *                   and replayed on `backfill`, as the Pi's store-and-forward
 *                   does. Verifies the backfill path without a real LTE link.
 *   REPLAY_BACKFILL=1  send every backfill batch twice, to prove the ingest
 *                   dedup index makes a re-sent batch a no-op.
 */
const mqtt = require('mqtt');
const { randomUUID } = require('crypto');

const deviceId = process.argv[2] || 'TEST123';
const url = process.argv[3] || process.env.MQTT_URL || 'mqtt://localhost:1883';
const password = process.env.MQTT_DEVICE_PASSWORD;
const username = process.env.MQTT_DEVICE_USERNAME || deviceId;
const dropEvery = Number(process.env.DROP_EVERY) || 0;
const replayBackfill = process.env.REPLAY_BACKFILL === '1';

const HZ = 10;
const OUTAGE_MS = 5000;
const BACKFILL_BATCH = 200;

if (!password) {
  console.error(
    '[mock] MQTT_DEVICE_PASSWORD is not set — the broker requires per-car\n' +
      '       credentials. Issue them with POST /cars/:id/mqtt-credentials.',
  );
  process.exit(1);
}

const client = mqtt.connect(url, { username, password });
const telemetryTopic = `cars/${deviceId}/telemetry`;
const sessionTopic = `cars/${deviceId}/session`;
const backfillTopic = `cars/${deviceId}/backfill`;

// One run = one `sid`. It is the idempotency key that keeps a replayed backlog
// in a single session row rather than opening a second one.
const sid = randomUUID();
const startedAt = Date.now();
let seq = 0;
let t = 0;

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

function buildFrame() {
  t += 1 / HZ;
  // Rough BMW E46 mock, mirroring the dash MockCanProvider/RaceBox shape.
  return {
    v: 1,
    sid,
    seq: ++seq,
    ts: Date.now(),
    mono: mono(),
    rpm: Math.round(2500 + 1700 * Math.sin(t / 5)),
    coolant: 88 + 2 * Math.sin(t / 20),
    oil: 96 + 3 * Math.sin(t / 25),
    speed: Math.round(80 + 60 * Math.abs(Math.sin(t / 8))),
    lat: 42.61 + 0.001 * Math.sin(t / 10),
    lon: 24.98 + 0.001 * Math.cos(t / 10),
    gx: 1.2 * Math.sin(t / 3),
    gy: 0.8 * Math.cos(t / 4),
    gz: 1 + 0.1 * Math.sin(t),
    lap: 1 + Math.floor(t / 90),
    lapMs: Math.round((t % 90) * 1000),
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
  client.publish(
    sessionTopic,
    JSON.stringify({
      v: 1,
      sid,
      event: 'start',
      at: Date.now(),
      mono: mono(),
      track: 'kaloyanovo',
      trackName: 'Kaloyanovo',
    }),
    { qos: 1 },
  );

  setInterval(() => {
    const frame = buildFrame();
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
  }, 1000 / HZ);
});

client.on('error', (err) => {
  console.error('[mock] error', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  drainSpool();
  client.publish(
    sessionTopic,
    JSON.stringify({
      v: 1,
      sid,
      event: 'stop',
      at: Date.now(),
      mono: mono(),
      laps: [92310, 91480],
      topSpeedKmh: 163,
    }),
    { qos: 1 },
    () => {
      client.end();
      process.exit(0);
    },
  );
});
