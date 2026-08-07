#!/usr/bin/env bash
#
# First-time Let's Encrypt issuance, before the stack has ever started.
#
# Standalone rather than webroot, and only this once: the nginx template's :443
# server block references ssl_certificate, so nginx cannot start without a
# certificate — and webroot issuance needs a running nginx to serve the
# challenge. Standalone breaks that circle by binding :80 itself.
#
# Renewals afterwards go through the running nginx; see renew-certs.sh.
#
# Requires: ports 80 and 443 open, DNS A record for PUBLIC_DOMAIN already
# pointing at this host, and nothing else bound to :80.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
    echo "error: .env not found — copy .env.example and fill it in first" >&2
    exit 1
fi

for var in PUBLIC_DOMAIN LETSENCRYPT_EMAIL; do
    value="$(grep -E "^${var}=" .env | tail -n1 | cut -d= -f2-)"
    if [ -z "$value" ]; then
        echo "error: $var is not set in .env" >&2
        exit 1
    fi
    declare "$var=$value"
done

if docker compose ps --status running --services 2>/dev/null | grep -qx web; then
    echo "error: the web service is running and holding :80." >&2
    echo "       Stop it first (docker compose -f docker-compose.prod.yaml stop web)," >&2
    echo "       or if you already have a certificate use renew-certs.sh instead." >&2
    exit 1
fi

mkdir -p deploy/certbot/conf deploy/certbot/www

docker run --rm \
    -p 80:80 \
    -v "$PWD/deploy/certbot/conf:/etc/letsencrypt" \
    -v "$PWD/deploy/certbot/www:/var/www/certbot" \
    certbot/certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$LETSENCRYPT_EMAIL" \
    -d "$PUBLIC_DOMAIN"

# The broker serves the same certificate on 8883 — the car and the browser reach
# the same hostname.
PUBLIC_DOMAIN="$PUBLIC_DOMAIN" ./deploy/sync-broker-certs.sh

echo
echo "Certificate issued for ${PUBLIC_DOMAIN}."
echo "Next: docker compose -f docker-compose.prod.yaml up -d --build"
