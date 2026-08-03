#!/usr/bin/env node
/**
 * Simulates the on-car Pi uplink: publishes telemetry frames at 10 Hz to
 * `cars/<deviceId>/telemetry` over MQTT (the confirmed persist rate). Useful
 * for exercising the ingest service before the real Pi uplink exists.
 *
 * Usage:
 *   node scripts/mock-telemetry-publisher.js [deviceId] [mqttUrl]
 *   node scripts/mock-telemetry-publisher.js TEST123 mqtt://localhost:1883
 */
const mqtt = require('mqtt');

const deviceId = process.argv[2] || 'TEST123';
const url = process.argv[3] || process.env.MQTT_URL || 'mqtt://localhost:1883';
const HZ = 10;

const client = mqtt.connect(url);
const telemetryTopic = `cars/${deviceId}/telemetry`;
const sessionTopic = `cars/${deviceId}/session`;

let t = 0;

client.on('connect', () => {
  console.log(`[mock] connected ${url}, publishing ${telemetryTopic} @ ${HZ}Hz`);
  client.publish(
    sessionTopic,
    JSON.stringify({ event: 'start', track: 'Kaloyanovo', at: Date.now() }),
    { qos: 1 },
  );

  setInterval(() => {
    t += 1 / HZ;
    // Rough BMW E46 mock, mirroring the dash MockCanProvider shape.
    const rpm = Math.round(2500 + 1700 * Math.sin(t / 5));
    const frame = {
      ts: Date.now(),
      rpm,
      coolant: 88 + 2 * Math.sin(t / 20),
      oil: 96 + 3 * Math.sin(t / 25),
      speed: Math.round(80 + 60 * Math.abs(Math.sin(t / 8))),
      lat: 42.61 + 0.001 * Math.sin(t / 10),
      lon: 24.98 + 0.001 * Math.cos(t / 10),
    };
    client.publish(telemetryTopic, JSON.stringify(frame), { qos: 0 });
  }, 1000 / HZ);
});

client.on('error', (err) => {
  console.error('[mock] error', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  client.publish(
    sessionTopic,
    JSON.stringify({ event: 'stop', at: Date.now() }),
    { qos: 1 },
    () => {
      client.end();
      process.exit(0);
    },
  );
});
