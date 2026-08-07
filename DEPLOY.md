# Deploying to a single VPS

The whole platform runs from one `docker compose` file on one box:
`docker-compose.prod.yaml`. This document is the runbook for putting it there and
keeping it running.

`docker-compose.yaml` (no suffix) is the **development** file and is not used on a
server. It publishes Postgres and the plaintext broker to the host and bind-mounts
the working tree over the built image — all correct locally, all wrong on a public
address. See the header of `docker-compose.prod.yaml` for why the production file
is standalone rather than an override layer.

---

## 1. What the box needs

| | |
|---|---|
| Host | 2 vCPU / 4 GB is comfortable for a handful of cars; Timescale is the memory-hungry part |
| Software | Docker Engine with the Compose plugin. Nothing else — no Node, no Postgres |
| DNS | One `A` record for `PUBLIC_DOMAIN` pointing at the box. The browser and the car use **the same hostname** |
| Firewall | Inbound **80**, **443**, **8883** only |

**Do not open 5432, 6379 or 1883.** The production compose file publishes none of
them; Postgres, Redis and the plaintext broker listener are reachable only over
the internal compose network. If you find yourself adding a port mapping to debug
something, use `docker compose exec` instead.

Port 80 is not optional even though everything redirects off it: Let's Encrypt's
HTTP-01 challenge is served there.

---

## 2. First deploy

```bash
git clone <repo> && cd kab23-motorsport-telemetry-cloud
cp .env.example .env
```

### 2.1 Fill in `.env`

Every `change_me` value needs a real secret. Generate them, do not invent them:

```bash
openssl rand -base64 36     # once per secret
```

The ones that matter:

| Key | Notes |
|---|---|
| `NODE_ENV` | **`production`**, exactly. It gates the auth cookie's `Secure` flag and is validated against a closed set at boot, so a typo fails loudly instead of silently shipping a cookie without `Secure` |
| `CORS_ORIGIN` | **Empty.** nginx serves the app and proxies `/api` from one hostname, so nothing legitimate is cross-origin |
| `PUBLIC_DOMAIN` | The DNS name. Used by nginx, certbot and the broker's TLS listener |
| `LETSENCRYPT_EMAIL` | Expiry notices |
| `REDIS_PASSWORD` | Required in production — the stack refuses to start without it |
| `DB_PASSWORD`, `JWT_SECRET`, `MQTT_PASSWORD`, `MQTT_ADMIN_PASSWORD` | Long random strings, all different |

`.env` is gitignored and must stay that way. It is the only place real secrets
live; `.dockerignore` keeps it out of every image layer, because a layer survives
deleting the file.

### 2.2 Point every compose command at the production file

```bash
export COMPOSE_FILE=docker-compose.prod.yaml
```

Compose reads `COMPOSE_FILE` natively, so this makes plain `docker compose …` —
and `scripts/init-mosquitto-dynsec.sh`, which shells out to it — target the right
stack. Put it in the deploy user's shell profile so it is not something to
remember.

### 2.3 Bootstrap the broker's security, before the first `up`

```bash
./scripts/init-mosquitto-dynsec.sh
```

**Order matters.** Mosquitto 2.1 does not refuse to start without a
dynamic-security config — it generates its own, with a random `admin` password
dropped in `dynamic-security.json.pw`. That config knows nothing about the
accounts in `.env`, so the API can never authenticate and every car provisioning
call comes back "Not authorized". If that has already happened, `--reset`
discards the generated config and rebuilds from `.env`.

Never use `docker compose down -v` to clean this up. `-v` takes the TimescaleDB
volume with it, and that is every session ever recorded.

### 2.4 Issue the first certificate

```bash
sudo ./deploy/issue-certs.sh
```

Standalone mode, and only this once: the nginx config references
`ssl_certificate`, so nginx cannot start without a certificate — and webroot
issuance needs a running nginx to serve the challenge. Standalone binds :80
itself and breaks the circle. Renewals afterwards go through the running nginx.

The script also copies the certificate to where Mosquitto can read it. That copy
is not incidental: certbot writes `privkey.pem` root-owned `0600` as a symlink
into `archive/`, and Mosquitto runs as uid 1883, so mounting `/etc/letsencrypt`
into the broker gives a container that cannot read its own key.

### 2.5 Up

```bash
docker compose up -d --build
```

Boot order is enforced by the file, not by you:

```
timescaledb (healthy) → migrate (exits 0) → api + telemetry-ingest → web
```

`migrate` is a one-shot container that runs the schema migrations and exits;
`api` and `telemetry-ingest` both declare `service_completed_successfully` on it,
so a failed migration stops the deploy instead of crash-looping a service that
looks like it has a bug.

### 2.6 Check it

```bash
docker compose ps                       # every service Up, migrate Exited (0)
curl -sI https://$PUBLIC_DOMAIN/ | head -1
curl -s  https://$PUBLIC_DOMAIN/api/health
openssl s_client -connect $PUBLIC_DOMAIN:8883 -servername $PUBLIC_DOMAIN </dev/null 2>/dev/null | grep "Verify return code"
```

Then register the first user through the app and provision a car:
`POST /cars/:id/mqtt-credentials` returns the broker password **once** and stores
it nowhere — not plaintext, not hashed. Only `Car.mqttProvisionedAt` is
persisted. Losing it means rotating, never looking it up. The car connects to
`mqtts://$PUBLIC_DOMAIN:8883`.

---

## 3. Certificate renewal

```bash
sudo ./deploy/renew-certs.sh
```

Renews through the running nginx (webroot), re-syncs the broker's copy, and
reloads nginx and mosquitto **only if the certificate actually changed**. Safe to
run when nothing is due — certbot no-ops outside the renewal window.

Install it as a systemd timer, twice a day, so a failed attempt has a retry
before expiry:

```ini
# /etc/systemd/system/telemetry-certs.service
[Unit]
Description=Renew telemetry TLS certificates
[Service]
Type=oneshot
WorkingDirectory=/opt/kab23-motorsport-telemetry-cloud
ExecStart=/opt/kab23-motorsport-telemetry-cloud/deploy/renew-certs.sh
```

```ini
# /etc/systemd/system/telemetry-certs.timer
[Unit]
Description=Renew telemetry TLS certificates twice daily
[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now telemetry-certs.timer
```

Renewal restarts Mosquitto, which drops every car's connection for a moment. That
is intentionally left as a restart rather than a `SIGHUP`: cars reconnect and
their store-and-forward backlog replays into the same session row, because the
device's `sid` is the idempotency key and `seq` backs the hypertable's dedup
index.

---

## 4. Upgrades

```bash
git pull
docker compose up -d --build
```

`migrate` reruns automatically and applies only what is new. A schema change ships
as a migration in `db/migrations/`; see §5.

Rolling back the code is `git checkout <previous>` and the same command. Rolling
back a **schema** change is not symmetric — see §6.

---

## 5. Schema changes

`synchronize` is off everywhere, including development. Migrations are the only
thing that changes the schema, in dev and in production alike, so that drift
surfaces on your machine rather than on the box.

After editing an entity:

```bash
npx typeorm-ts-node-commonjs -d typeorm.config.ts migration:generate db/migrations/WhatChanged
```

Written out in full rather than wrapped in a pnpm script because it takes a path
argument, and pnpm inserts a literal `--` before passthrough args when the target
script already has its own — the same trap the CI test step documents.

Run and inspect locally with `pnpm run migration:run` / `migration:show` /
`migration:revert`.

**Anything TypeORM cannot express — hypertables, compression, retention — is
hand-written into the migration.** `migration:generate` will not emit it and will
not notice it is missing. The baseline is the worked example.

### Adopting an existing database

A database created by the old `synchronize: true` already has the tables but no
`migrations` row, so the baseline would fail on its first `CREATE TABLE`. Mark it
as applied instead:

```bash
pnpm run migration:run -- --fake      # or: npx typeorm-ts-node-commonjs -d typeorm.config.ts migration:run --fake
```

Then confirm there was no drift — `migration:generate` should say *"No changes in
database schema were found"*.

---

## 6. Backups

**Not yet implemented — this is the largest known gap in the deploy.** The stack
runs, but nothing takes a copy of `timescale_data`. Until the backup slice lands
(see the architecture doc's Phase 5, "with or after the Pi"), take a manual dump
before anything risky:

```bash
docker compose exec -T timescaledb pg_dump -U "$DB_USERNAME" -Fc "$DB_DATABASE" > backup-$(date +%F).dump
```

Copy it **off the box**. A dump on the same disk as the database is not a backup.

Two footguns worth repeating:

- `docker compose down -v` destroys the TimescaleDB volume. There is no undo.
- The baseline migration's `down()` drops every table including
  `telemetry_samples`. It is a development revert path, not an operational one.

---

## 7. Rehearsing all of this locally

The full production stack runs on a developer machine against self-signed
certificates, which is how this document was validated before any VPS existed:

```bash
./deploy/dev-certs.sh telemetry.local          # local CA + server cert
export COMPOSE_FILE=docker-compose.prod.yaml
export COMPOSE_PROJECT_NAME=kab23-prod-rehearsal   # keeps dev volumes separate
./scripts/init-mosquitto-dynsec.sh
docker compose up -d --build
```

Set `PUBLIC_DOMAIN=telemetry.local`, `NODE_ENV=production`, `CORS_ORIGIN=` and a
`REDIS_PASSWORD` in `.env` first. The generated certificate carries `localhost`
and `127.0.0.1` in its SAN as well, so `https://localhost` and
`mqtts://localhost:8883` both verify without touching `/etc/hosts`.

Publish to it exactly as the car will:

```bash
NODE_EXTRA_CA_CERTS=$PWD/deploy/certbot/conf/local-ca/ca.pem \
MQTT_DEVICE_PASSWORD=<from POST /cars/:id/mqtt-credentials> \
  node scripts/mock-telemetry-publisher.js <deviceId> mqtts://localhost:8883
```

Tear the rehearsal down with `docker compose down` (no `-v` habit) and restore
your development `.env`.
