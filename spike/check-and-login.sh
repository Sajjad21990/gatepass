#!/usr/bin/env bash
# Inspect the certificate with ssh-keygen -L, then try to log in to the Docker
# sshd with it. Run sign-cert.mjs first, and `docker compose up -d` in the repo root.
set -euo pipefail
cd "$(dirname "$0")"

CERT=out/key-cert.pub
KEY=out/key
HOST=${GATEPASS_HOST:-127.0.0.1}
PORT=${GATEPASS_PORT:-2222}
LOGIN=${GATEPASS_USER:-renter}

echo "== 1. ssh-keygen -L (does OpenSSH parse our hand-built certificate?)"
ssh-keygen -L -f "$CERT"

echo
echo "== 2. CA fingerprint the host trusts"
ssh-keygen -l -f ../host/ca/gatepass_ca.pub

SSH_OPTS=(-p "$PORT" -i "$KEY" -o IdentitiesOnly=yes -o IdentityAgent=none
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR
  -o BatchMode=yes -o ConnectTimeout=10)

echo
echo "== 3. login WITH the certificate (must succeed)"
ssh "${SSH_OPTS[@]}" -o CertificateFile="$CERT" "$LOGIN@$HOST" \
  'echo "LOGIN OK as $(whoami) on $(hostname)"; uname -a'

echo
echo "== 4. login WITHOUT the certificate (must be refused)"
# ssh auto-loads <key>-cert.pub when it sits next to the key, so test with a
# copy of the key that has no certificate beside it.
BARE=$(mktemp -d)
trap 'rm -rf "$BARE"' EXIT
cp "$KEY" "$BARE/key" && chmod 600 "$BARE/key"
BARE_OPTS=("${SSH_OPTS[@]}")
BARE_OPTS[3]="$BARE/key"
if ssh "${BARE_OPTS[@]}" "$LOGIN@$HOST" true 2>/dev/null; then
  echo "UNEXPECTED: bare key was accepted" >&2
  exit 1
fi
echo "refused, as expected"
