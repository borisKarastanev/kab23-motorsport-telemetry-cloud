#!/usr/bin/env bash
#
# Self-signed certificates for rehearsing the production stack locally.
#
# The point is to exercise the *real* TLS paths before a VPS exists — nginx on
# :443, mosquitto on :8883, and a publisher connecting over mqtts:// exactly as
# the on-car Pi will. So the files land in the same locations certbot would use,
# and the production compose file and configs are used unmodified.
#
# Produces a small CA as well as a server certificate, because a client needs
# something to trust: point NODE_EXTRA_CA_CERTS at the CA to run the mock
# publisher over mqtts://, and import it into the browser to lose the warning.
#
#   ./deploy/dev-certs.sh [hostname]        # default: telemetry.local
#
# Then add the hostname to /etc/hosts:
#   127.0.0.1  telemetry.local
#
# THIS IS NOT FOR A SERVER. On a real box use deploy/issue-certs.sh.

set -euo pipefail

cd "$(dirname "$0")/.."

DOMAIN="${1:-telemetry.local}"
LIVE="deploy/certbot/conf/live/${DOMAIN}"
CA_DIR="deploy/certbot/conf/local-ca"

mkdir -p "$LIVE" "$CA_DIR"

if [ ! -f "$CA_DIR/ca.pem" ]; then
    echo "Creating a local CA…"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
        -keyout "$CA_DIR/ca.key" -out "$CA_DIR/ca.pem" \
        -subj "/CN=kab23 telemetry local dev CA" 2>/dev/null
fi

echo "Issuing a server certificate for ${DOMAIN}…"

openssl req -newkey rsa:2048 -nodes \
    -keyout "$LIVE/privkey.pem" -out "$LIVE/server.csr" \
    -subj "/CN=${DOMAIN}" 2>/dev/null

# A SAN is not optional: every current client ignores CN, so a certificate
# without subjectAltName fails to verify no matter what it says.
openssl x509 -req -in "$LIVE/server.csr" -days 825 \
    -CA "$CA_DIR/ca.pem" -CAkey "$CA_DIR/ca.key" -CAcreateserial \
    -extfile <(printf 'subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth' "$DOMAIN") \
    -out "$LIVE/cert.pem" 2>/dev/null

# certbot's layout: fullchain is leaf + issuers. Mosquitto and nginx both read
# this name, so the rehearsal exercises the same config the server will.
cat "$LIVE/cert.pem" "$CA_DIR/ca.pem" > "$LIVE/fullchain.pem"
rm -f "$LIVE/server.csr"

PUBLIC_DOMAIN="$DOMAIN" ALLOW_WORLD_READABLE_KEY=1 ./deploy/sync-broker-certs.sh

cat <<EOF

Done. For ${DOMAIN}:

  /etc/hosts        127.0.0.1  ${DOMAIN}
  .env              PUBLIC_DOMAIN=${DOMAIN}
  CA for clients    $PWD/${CA_DIR}/ca.pem

  Mock publisher over TLS:
    NODE_EXTRA_CA_CERTS=$PWD/${CA_DIR}/ca.pem \\
      node scripts/mock-telemetry-publisher.js <deviceId> mqtts://${DOMAIN}:8883
EOF
