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

# 3. infra (Postgres+Timescale, Redis, Mosquitto)
docker compose up -d timescaledb redis mosquitto

# 4a. API  (http://localhost:3000)
pnpm run start:api

# 4b. telemetry ingest (MQTT consumer)
pnpm run start:ingest

# 5. frontend — Angular 22 (http://localhost:4200)
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

# telemetry path — publish mock frames at 10 Hz and watch the ingest logs
node scripts/mock-telemetry-publisher.js TEST123
```

## Status — Phase 0 (scaffold) complete

- [x] NestJS monorepo (`api` monolith + `telemetry-ingest`) + `libs/common`
- [x] Postgres/TimescaleDB, Redis, Mosquitto via docker-compose
- [x] Cookie/JWT auth (register / login / me / logout), role-aware
- [x] MQTT ingest shell receiving `cars/+/telemetry` and `cars/+/session`
- [x] Angular 22 auth shell (login → guarded dashboard, driver vs manager view)

Next: **Phase 1** — teams/cars/sessions domain + RBAC; then Phase 2 telemetry
persistence to Timescale hypertables.
