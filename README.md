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

# 5. schema. There is no `synchronize` any more — in development either — so
#    this is required on a fresh volume and after any pull that adds a
#    migration. An existing database built by the old `synchronize: true` is
#    adopted with `--fake` once; see DEPLOY.md §5.
pnpm run migration:run

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

## Deploying

`docker-compose.prod.yaml` runs the whole platform on a single VPS behind nginx,
with TLS for the browser (443) and for cars (8883). **[DEPLOY.md](./DEPLOY.md)**
is the runbook — including how to rehearse the entire production stack locally
against self-signed certificates before a server exists.

The file above (`docker-compose.yaml`, no suffix) is for development only: it
publishes Postgres and the plaintext broker to the host and mounts the working
tree over the built image.

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

# post-session analysis — laps derive on the first read of a closed session
curl -b cookies.txt localhost:3000/sessions/<sessionId>/laps
curl -b cookies.txt -X POST localhost:3000/sessions/<sessionId>/analyze   # force a recompute
curl -b cookies.txt 'localhost:3000/sessions/<sessionId>/laps/1/trace?maxPoints=500'
curl -b cookies.txt 'localhost:3000/sessions/<sessionId>/compare?laps=1,2'
```

`GET /laps` answers `{"laps":[], "reason":"…"}` rather than an error when there
is nothing to derive: `session-live` (still running), `no-track-gate`
(`Session.track` matched no row in `tracks`, so there is no start/finish line to
cut on), `no-samples`, `no-crossings` (the car never crossed the line) or
`too-many-samples`. None of those are failures, and the reason says which it is.

Two env flags on the publisher exercise the store-and-forward path without a
real LTE link: `DROP_EVERY=30` simulates a 5 s outage every 30 s (frames spool,
then replay on `cars/<deviceId>/backfill`), and `REPLAY_BACKFILL=1` sends every
batch twice — the row count must not change, because the hypertable dedups on
`(session_id, seq, time)`.

### What the mock actually drives

The car laps a **synthetic circuit anchored on Kaloyanovo's real, confirmed
start/finish gate** (`scripts/lib/circuit.js`), producing ~64 s laps over a
2 100 m loop at 70–185 km/h. The gate is copied verbatim from the on-car dash's
`data/track-db.json`; the shape is designed, not surveyed, and is *fitted* to
the gate so it always crosses it perpendicularly and centrally.

Speed is solved from the track's curvature (cornering limit, then braking and
traction passes), and the g channels are derived from that speed — so the
braking zones a detector finds correspond to corners that are really there.
This is what Phase 4's lap segmentation, sector splits and braking-point
detection are developed against; the previous mock traced an arbitrary circle
with no gate and with channels unrelated to the path.

```bash
--seed <n>        per-lap pace variation (default 20260805). Same seed, same laps.
--lap-m <n>       lap length in metres (default 2100). The shape scales but stays
                  fitted to the same real gate, so it crosses correctly at any
                  size; 600 m gives ~30 s laps, which is what makes an end-to-end
                  lap-derivation check take two minutes rather than four and a half.
GPS_NOISE_M=0.7   GPS jitter, 1σ per axis. Non-zero by default, so the
                  segmenter's crossing debounce is genuinely exercised.
--replay <file>   replay a recorded drive instead: a JSONL frame log, or a dash
                  session record (`{lapMs, lapPaths}`). See scripts/lib/replay.js
                  for what each format can and cannot reproduce — a dash record
                  carries geometry only, so its channels are reconstructed. A
                  frame log is replayed on its own `mono`/`ts` clock, so a 25 Hz
                  recording keeps its duration through the 10 Hz publisher. The
                  run ends and the session closes when the recording does.
--replay-loop     repeat the recording rather than ending with it, for driving a
                  long run off a short record.
```

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

## Status — Phases 0–4 and the Phase 5 deploy slice complete (cloud side)

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
- [x] Lap segmentation, sector times, braking points + driver analysis UI (Phase 4)
- [x] TypeORM migrations — `synchronize` is off everywhere (Phase 5)
- [x] Production compose for a single VPS, publishing only 80/443/8883 (Phase 5)
- [x] TLS end-to-end: nginx + certbot for the app, Mosquitto on 8883 for cars (Phase 5)

Next: **Phase 2's on-car uplink**, which was deliberately scheduled last so that
TLS would already be up when the dash first connects to a public broker. It now
is.

Still open in Phase 5, scheduled with or after the Pi: backups (nothing yet
copies the TimescaleDB volume off the box — see DEPLOY.md §6),
retention/compression policies, and the device provisioning flow.
