# kab23-motorsport-telemetry-cloud

Cloud telemetry platform for the BMW E46 race dashboard project.

- **Drivers** — deep post-session analysis (racing line, braking points, lap deltas).
- **Team managers** — near-live (<1–2 s) tracking of their car(s) during a session.

Data source is the on-car Qt/QML dashboard (Raspberry Pi 4), which publishes
CAN + GPS telemetry over MQTT (LTE at the track).

Full architecture & decisions: `../motorsport-cloud-architecture.md`.

## Topology

```
Pi (CAN+GPS) --MQTT/TLS over LTE--> Mosquitto --> telemetry-ingest --> TimescaleDB (durable)
                                                                   \--> Redis pub/sub --> api (WS) --> Angular
```

- **`apps/api`** — NestJS modular monolith (REST + a socket.io gateway). Modules:
  `auth`, `users` (Phase 0); `teams`, `cars`, `sessions` (Phase 1–2); `live`
  (Phase 3); `analysis` (later).
- **`apps/telemetry-ingest`** — separate NestJS MQTT consumer. Its own process
  because ingest scales/fails independently of the request/response API.
- **`libs/common`** — shared TypeORM base classes, config, logger, enums,
  decorators, MQTT topic constants, the Redis module and the live wire contract.
- **`frontend`** — Angular standalone app: cookie-based auth shell plus the
  team-manager live view.

Storage: **PostgreSQL + TimescaleDB** (one engine — domain tables + telemetry
hypertables). **Redis** for the live path — pub/sub fan-out and a last-known-value
cache, never durable storage. **Mosquitto** for device ingress.

## Prerequisites

- **Node 24.18.1** (Angular 22 requires ≥ 22.22.3) — see `.nvmrc`; run `nvm use`.
- pnpm 9, Docker + Docker Compose.

## Run (localhost)

```bash
# 1. install
pnpm install

# 2. env
cp .env.example .env          # adjust secrets

# 3. one-time broker bootstrap — MUST run before the first `docker compose up`.
#    The broker rejects anonymous connections, and if it starts without a
#    dynamic-security config it generates its own with a random admin password,
#    which the API cannot authenticate against. If that already happened, pass
#    --reset to rebuild the broker's accounts from .env.
./scripts/init-mosquitto-dynsec.sh

# 4. infra (Postgres+Timescale, Redis, Mosquitto)
docker compose up -d timescaledb redis mosquitto

# 5a. API  (http://localhost:3000)
pnpm run start:api

# 5b. telemetry ingest (MQTT consumer)
pnpm run start:ingest

# 6. frontend — Angular 22 (http://localhost:4200)
cd frontend && pnpm install && pnpm start
```

Or run the whole backend + infra in containers:

```bash
docker compose up --build
```

## Smoke tests

```bash
# health
curl localhost:3000/health

# auth flow
curl -X POST localhost:3000/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"you@team.com","password":"Passw0rd!","role":"MANAGER"}'
curl -c cookies.txt -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"you@team.com","password":"Passw0rd!"}'
curl -b cookies.txt localhost:3000/auth/me

# telemetry path — register a car, issue its broker credential, then publish
curl -b cookies.txt -X POST localhost:3000/cars -H 'Content-Type: application/json' \
  -d '{"name":"E46","deviceId":"TEST123"}'
curl -b cookies.txt -X POST localhost:3000/cars/<carId>/mqtt-credentials
# → {"username":"TEST123","password":"…","issuedAt":"…"}   shown ONCE

MQTT_DEVICE_PASSWORD=<that password> node scripts/mock-telemetry-publisher.js TEST123

# read it back (downsampled, tenant-scoped)
curl -b cookies.txt 'localhost:3000/sessions/<sessionId>/telemetry?maxPoints=500'
```

Two flags on the publisher exercise the store-and-forward path without a real
LTE link: `DROP_EVERY=30` simulates a 5 s outage every 30 s (frames spool, then
replay on `cars/<deviceId>/backfill`), and `REPLAY_BACKFILL=1` sends every batch
twice — the row count must not change, because the hypertable dedups on
`(session_id, seq, time)`.

## Device credentials

The broker is not anonymous. Each car authenticates with its own credential and
is confined by ACL to publishing on `cars/<its-deviceId>/…`; it can subscribe to
nothing. Credentials are issued by `POST /cars/:id/mqtt-credentials` and shown
**once** — the platform stores no copy, so a lost credential is rotated by
calling the endpoint again. Changing a car's `deviceId` revokes the old one.

## Live view

`/live` in the Angular app lists the caller's cars; `/live/:carId` watches one.
Frames go ingest → Redis → WebSocket gateway → browser, published *before* the
database flush so a viewer never waits on it. Measured delivery latency
(Redis → gateway → browser) is ~1 ms locally, against a 1–2 s glass-to-glass
budget — the rest of that budget belongs to the LTE hop, which cannot be
measured until the on-car uplink ships.

Two checks guard it: the `Authentication` cookie at the socket handshake, and
`requireReadableCar` on every `subscribe`. A car outside the caller's tenant is
refused with the same flat "Car not found" the REST layer uses.

## Status — Phases 0–3 complete (cloud side)

- [x] NestJS monorepo (`api` monolith + `telemetry-ingest`) + `libs/common`
- [x] Postgres/TimescaleDB, Redis, Mosquitto via docker-compose
- [x] Cookie/JWT auth (register / login / me / logout), role-aware
- [x] `teams`, `cars`, `sessions` + per-team RBAC (Phase 1)
- [x] Per-car broker credentials and ACLs (Mosquitto dynamic security)
- [x] `telemetry_samples` hypertable + batched, dedup-safe write path
- [x] Device-driven sessions: the car opens and closes its own runs over MQTT
- [x] Store-and-forward backfill replay
- [x] Angular 22 auth shell (login → guarded dashboard, driver vs manager view)
- [x] Redis pub/sub fan-out + last-known-value cache (Phase 3)
- [x] WebSocket gateway with cookie auth and per-car authorization
- [x] Team-manager live view: gauges, SVG track trace, car picker

Next: **Phase 4** — lap segmentation, racing line, sector times and the driver
analysis UI. Phase 2's on-car uplink is deliberately scheduled last, after the
Phase 5 deploy, so TLS is already up when the dash first connects to a public
broker.
