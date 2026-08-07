#!/usr/bin/env bash
#
# One-time Mosquitto dynamic-security bootstrap.
#
# Creates:
#   - the dynsec admin account (MQTT_ADMIN_USERNAME/MQTT_ADMIN_PASSWORD), used
#     only by apps/api to provision cars,
#   - the ingest account (MQTT_USERNAME/MQTT_PASSWORD), subscribe-only over
#     `cars/+/#`.
#
# Per-car accounts are NOT created here. They are issued at runtime by
# MqttAdminService when a car is registered, so a car's credential never passes
# through a shell or a file on disk.
#
# ORDER MATTERS. Mosquitto 2.1 does not refuse to start when the plugin has no
# config file — it **generates its own**, with a random `admin` password written
# to dynamic-security.json.pw, and logs "Dynamic security plugin config not
# found, generating a default config". That config knows nothing about the
# accounts in .env, so the API can never authenticate against it and every
# provisioning call fails with "Not authorized". This script therefore stops the
# broker before initialising, and refuses to run against a config it did not
# create unless you pass --reset.
#
# Usage:
#   ./scripts/init-mosquitto-dynsec.sh            # first-time setup
#   ./scripts/init-mosquitto-dynsec.sh --reset    # discard broker-side security
#                                                 # state and start over
#
# --reset removes only dynamic-security.json(.pw) from the broker's volume:
# accounts and ACLs, all of which this script and the API recreate. It does not
# touch the database, and never use `docker compose down -v` for this — that
# would take the TimescaleDB volume with it.

set -euo pipefail

cd "$(dirname "$0")/.."

RESET=0
if [ "${1:-}" = "--reset" ]; then
    RESET=1
fi

if [ ! -f .env ]; then
    echo "error: .env not found — copy .env.example and set the MQTT_* values first" >&2
    exit 1
fi

# Only the four variables this script needs, so a malformed line elsewhere in
# .env can't be executed as a side effect of sourcing the whole file.
for var in MQTT_ADMIN_USERNAME MQTT_ADMIN_PASSWORD MQTT_USERNAME MQTT_PASSWORD; do
    value="$(grep -E "^${var}=" .env | tail -n1 | cut -d= -f2-)"
    if [ -z "$value" ]; then
        echo "error: $var is not set in .env" >&2
        exit 1
    fi
    declare "$var=$value"
done

CONFIG=/mosquitto/data/dynamic-security.json

# Credentials reach the container as environment variables and are expanded by
# the shell *inside* it — never interpolated into a command string, where a
# password containing a quote would close the quoting and the rest would run as
# shell. This also keeps them off this host's process list. (They are still in
# the broker container's own argv for the duration of each call; mosquitto_ctrl
# accepts them no other way.)
CREDS_ENV=(
    -e "MQTT_ADMIN_USERNAME=$MQTT_ADMIN_USERNAME"
    -e "MQTT_ADMIN_PASSWORD=$MQTT_ADMIN_PASSWORD"
    -e "MQTT_USERNAME=$MQTT_USERNAME"
    -e "MQTT_PASSWORD=$MQTT_PASSWORD"
)

# `run` for anything that must work while the broker is stopped (it can override
# the entrypoint); `exec` for anything that talks to the running broker.
in_stopped_broker() {
    docker compose run --rm --no-deps "${CREDS_ENV[@]}" \
        --entrypoint sh mosquitto -c "$1"
}

# NB: `docker compose exec` has no --entrypoint flag — the command is given
# directly, which is why this passes `sh -c` rather than overriding anything.
ctrl() {
    docker compose exec -T "${CREDS_ENV[@]}" mosquitto sh -c \
        'mosquitto_ctrl -u "$MQTT_ADMIN_USERNAME" -P "$MQTT_ADMIN_PASSWORD" dynsec "$@"' \
        _ "$@"
}

# mosquitto_ctrl exits 0 even when the broker rejects it ("Connection error:
# Not authorized"), so every success test here has to read the output. Checking
# `$?` silently passes on failure — which is how a broken bootstrap would look
# like a working one.
ctrl_succeeded() {
    local output
    output="$(ctrl "$@" 2>&1 || true)"

    case "$output" in
        *"Connection error"*|*"Error:"*|*"error:"*) return 1 ;;
    esac

    [ -n "$output" ]
}

# The only check that means anything: not "does a config exist" but "can the
# account the API will use actually log in". A broker-generated config passes
# the first test and fails the second, which is exactly the trap.
admin_works() {
    docker compose ps --status running --services 2>/dev/null | grep -qx mosquitto \
        && ctrl_succeeded listClients
}

if admin_works; then
    echo "Dynamic security is already set up for '$MQTT_ADMIN_USERNAME' — nothing to do."
    exit 0
fi

if in_stopped_broker "test -f $CONFIG" 2>/dev/null; then
    if [ "$RESET" -eq 0 ]; then
        echo "error: the broker already has a dynamic-security config, but '$MQTT_ADMIN_USERNAME'" >&2
        echo "       cannot authenticate against it." >&2
        echo >&2
        echo "       Mosquitto generates its own config (with a random admin password, see" >&2
        echo "       dynamic-security.json.pw) the first time it starts without one, so this" >&2
        echo "       is what you get if the broker came up before this script ran." >&2
        echo >&2
        echo "       Re-run with --reset to discard the broker's accounts and ACLs and" >&2
        echo "       recreate them from .env. Nothing else is affected." >&2
        exit 1
    fi

    echo "Removing the existing dynamic-security config…"
    docker compose stop mosquitto >/dev/null 2>&1 || true
    in_stopped_broker "rm -f $CONFIG ${CONFIG}.pw"
fi

# Must be stopped: a running broker owns the file and would regenerate it.
docker compose stop mosquitto >/dev/null 2>&1 || true

echo "Initialising dynamic security…"
# Single-quoted so expansion happens in the container, from the env above.
in_stopped_broker 'mosquitto_ctrl dynsec init '"$CONFIG"' "$MQTT_ADMIN_USERNAME" "$MQTT_ADMIN_PASSWORD"'

echo "Starting broker to create the ingest account…"
docker compose up -d mosquitto

# The broker must actually be up before the poll below means anything.
#
# The failure this catches: under docker-compose.prod.yaml the first listener is
# 8883 with a certfile, and mosquitto exits at startup when it cannot load one —
# so if certificates have not been issued yet (DEPLOY.md §2.3, which must run
# before this script) the container crash-loops. Without this check the poll
# below just times out and reports "broker did not accept 'admin'", blaming
# authentication for a TLS problem and sending you to --reset, which does not
# help. Same guard idiom as issue-certs.sh's :80 check.
sleep 2
if ! docker compose ps --status running --services 2>/dev/null | grep -qx mosquitto; then
    echo "error: the broker exited immediately after starting." >&2
    echo >&2
    echo "       Most likely its TLS certificate is missing. The production" >&2
    echo "       config's first listener is 8883 with" >&2
    echo "       certfile /mosquitto/certs/fullchain.pem, and mosquitto refuses" >&2
    echo "       to start without it — issue certificates first:" >&2
    echo >&2
    echo "         sudo ./deploy/issue-certs.sh" >&2
    echo >&2
    echo "       Then re-run this script. Broker log:" >&2
    docker compose logs --tail=15 mosquitto >&2 || true
    exit 1
fi

# The broker needs a moment to bind before mosquitto_ctrl can talk to it.
for _ in $(seq 1 30); do
    if ctrl_succeeded listClients; then
        break
    fi
    sleep 0.5
done

if ! ctrl_succeeded listClients; then
    echo "error: broker did not accept '$MQTT_ADMIN_USERNAME' after initialising" >&2
    exit 1
fi

# Receiving a message needs BOTH a subscribe ACL and a publishClientReceive
# ACL — a subscribe-only role without the latter silently receives nothing.
ctrl createRole telemetry-ingest
ctrl addRoleACL telemetry-ingest subscribePattern 'cars/+/#' allow
ctrl addRoleACL telemetry-ingest publishClientReceive 'cars/#' allow

# The ingest account's own password stays in the container's environment for
# the same reason the admin one does — never on this shell's command line.
docker compose exec -T "${CREDS_ENV[@]}" mosquitto sh -c \
    'mosquitto_ctrl -u "$MQTT_ADMIN_USERNAME" -P "$MQTT_ADMIN_PASSWORD" \
        dynsec createClient "$MQTT_USERNAME" -p "$MQTT_PASSWORD"'

ctrl addClientRole "$MQTT_USERNAME" telemetry-ingest

echo
echo "Done. Broker now requires authentication."
echo "Cars are provisioned through the API: POST /cars/:id/mqtt-credentials"
