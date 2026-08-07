#!/usr/bin/env bash
#
# Certificate renewal. Run from a systemd timer or cron on the host, twice a day
# — certbot only acts inside the renewal window, so running it often is free and
# a single daily attempt gives one retry before expiry.
#
# Driven from the host rather than a long-lived sidecar container on purpose. The
# post-renewal steps have to reload nginx and restart mosquitto, and a container
# that can do that is a container with the docker socket mounted — an internet-
# facing service with root on the host. A host script has that access already.
#
# Webroot, not standalone: nginx is running now and holds :80, and it serves
# /.well-known/acme-challenge/ from the same directory this mounts.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f docker-compose.prod.yaml"

BEFORE=""
if [ -f deploy/mosquitto/certs/fullchain.pem ]; then
    BEFORE="$(sha256sum deploy/mosquitto/certs/fullchain.pem | cut -d' ' -f1)"
fi

docker run --rm \
    -v "$PWD/deploy/certbot/conf:/etc/letsencrypt" \
    -v "$PWD/deploy/certbot/www:/var/www/certbot" \
    certbot/certbot renew --webroot --webroot-path /var/www/certbot --quiet

./deploy/sync-broker-certs.sh

AFTER="$(sha256sum deploy/mosquitto/certs/fullchain.pem | cut -d' ' -f1)"

if [ "$BEFORE" = "$AFTER" ]; then
    echo "Certificate unchanged; nothing to reload."
    exit 0
fi

echo "Certificate changed — reloading services."

# nginx rereads the certificate on SIGHUP without dropping connections.
$COMPOSE exec -T web nginx -s reload

# Mosquitto 2 does reload TLS material on SIGHUP, but only for listeners that
# were already configured — a restart is the one that is unambiguously correct,
# and a broker restart costs a reconnect the cars' store-and-forward already
# handles. Do not optimise this into a SIGHUP without testing it against a real
# device.
$COMPOSE restart mosquitto

echo "Renewal complete."
