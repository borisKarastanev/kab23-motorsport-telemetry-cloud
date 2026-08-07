#!/usr/bin/env bash
#
# Copies the current certificate into a form Mosquitto can actually read.
#
# certbot writes /etc/letsencrypt/live/<domain>/privkey.pem as a symlink into
# archive/, root-owned and mode 0600. Mosquitto runs as uid 1883 and will refuse
# to start if that tree is mounted straight in — so the pair is copied out and
# chowned instead, and deploy/certbot/conf is never mounted into the broker.
#
# Called by issue-certs.sh (first issuance), renew-certs.sh (renewal), and
# dev-certs.sh (local rehearsal). Idempotent.
#
# Run as root on a server: the destination key must end up owned by uid 1883 and
# mode 0600. `ALLOW_WORLD_READABLE_KEY=1` relaxes that to 0644 for the local
# self-signed rehearsal, where there is no real key to protect — it is opt-in
# rather than a silent fallback, because a 0644 private key on a VPS is readable
# by every account on the box.

set -euo pipefail

cd "$(dirname "$0")/.."

PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-}"
if [ -z "$PUBLIC_DOMAIN" ] && [ -f .env ]; then
    PUBLIC_DOMAIN="$(grep -E '^PUBLIC_DOMAIN=' .env | tail -n1 | cut -d= -f2-)"
fi

if [ -z "$PUBLIC_DOMAIN" ]; then
    echo "error: PUBLIC_DOMAIN is not set (env or .env)" >&2
    exit 1
fi

SRC="deploy/certbot/conf/live/${PUBLIC_DOMAIN}"
DEST="deploy/mosquitto/certs"

if [ ! -f "$SRC/fullchain.pem" ] || [ ! -f "$SRC/privkey.pem" ]; then
    echo "error: no certificate at $SRC — run deploy/issue-certs.sh first" >&2
    exit 1
fi

if [ "$(id -u)" -ne 0 ] && [ "${ALLOW_WORLD_READABLE_KEY:-0}" != "1" ]; then
    echo "error: run this as root (sudo) so the broker key can be chowned to uid 1883." >&2
    echo "       For a local self-signed rehearsal only, set ALLOW_WORLD_READABLE_KEY=1." >&2
    exit 1
fi

mkdir -p "$DEST"

# -L to follow certbot's symlinks into archive/; a copy of a dangling symlink is
# a file mosquitto cannot open.
cp -L "$SRC/fullchain.pem" "$DEST/fullchain.pem"
cp -L "$SRC/privkey.pem" "$DEST/privkey.pem"

chmod 0644 "$DEST/fullchain.pem"

if [ "$(id -u)" -eq 0 ]; then
    # 1883 is the uid inside eclipse-mosquitto:2, not a port number.
    chown 1883:1883 "$DEST/fullchain.pem" "$DEST/privkey.pem"
    chmod 0600 "$DEST/privkey.pem"
else
    chmod 0644 "$DEST/privkey.pem"
    echo "warning: key left world-readable (ALLOW_WORLD_READABLE_KEY=1)." >&2
    echo "         Acceptable for a local self-signed cert. Never on a server." >&2
fi

echo "Broker certificates synced for ${PUBLIC_DOMAIN}"
