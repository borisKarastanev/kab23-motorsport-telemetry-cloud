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

- **`apps/api`** — NestJS modular monolith (REST + later WebSocket). Modules:
  `auth`, `users` (Phase 0); `teams`, `cars`, `sessions`, `analysis` (later).
- **`apps/telemetry-ingest`** — separate NestJS MQTT consumer. Its own process
  because ingest scales/fails independently of the request/response API.
- **`libs/common`** — shared TypeORM base classes, config, logger, enums,
  decorators, MQTT topic constants (ported from the car-repair-shop reference).
- **`frontend`** — Angular standalone app; cookie-based auth shell.

Storage: **PostgreSQL + TimescaleDB** (one engine — domain tables + telemetry
hypertables). **Redis** for the live path (Phase 3). **Mosquitto** for device
ingress.

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

## Status — Phases 0–2 complete

- [x] NestJS monorepo (`api` monolith + `telemetry-ingest`) + `libs/common`
- [x] Postgres/TimescaleDB, Redis, Mosquitto via docker-compose
- [x] Cookie/JWT auth (register / login / me / logout), role-aware
- [x] `teams`, `cars`, `sessions` + per-team RBAC (Phase 1)
- [x] Per-car broker credentials and ACLs (Mosquitto dynamic security)
- [x] `telemetry_samples` hypertable + batched, dedup-safe write path
- [x] Device-driven sessions: the car opens and closes its own runs over MQTT
- [x] Store-and-forward backfill replay
- [x] Angular 22 auth shell (login → guarded dashboard, driver vs manager view)

Next: **Phase 3** — Redis pub/sub + WebSocket gateway for the near-live
team-manager view.
