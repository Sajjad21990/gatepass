#!/usr/bin/env bash
# Gatepass end-to-end demo on NEAR testnet. Takes about 90 seconds.
#
# Needs: Docker running, Node 22.18+, ssh, and a .env with a funded testnet
# account (see README). Run from anywhere:
#
#   scripts/demo.sh [machine]
#
# Without an argument it uses a machine owned by your own account (registered
# on first run), so every step, including the withdrawal, works for anyone.
# If .env.renter exists, that account pays for the pass and the .env account
# is the machine owner; otherwise one account plays both parts.
#
# What it shows, in order:
#   1. the host trusts only its machine's CA key (held by nobody)
#   2. paying for 1 minute returns a pass signed by NEAR Chain Signatures
#   3. the pass logs in and runs a command
#   4. a long-running session is cut off when the paid minute is up
#   5. a fresh login with the same pass is refused
#   6. the payment is in the machine's earnings and the owner withdraws it
set -euo pipefail
cd "$(dirname "$0")/.."
GP=bin/gatepass

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
as_renter() { if [ -f .env.renter ]; then GATEPASS_ENV_FILE=.env.renter "$@"; else "$@"; fi; }

[ -f .env ] || { echo "No .env found. Run: node scripts/create-testnet-account.mjs" >&2; exit 1; }
OWNER=$(sed -n 's/^NEAR_ACCOUNT_ID=//p' .env)
MACHINE=${1:-demo-$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,8))' "$OWNER")}

step "1. Machines for rent"
if [ "$($GP machines --json | json "v.some(m=>m.id==='$MACHINE')")" != "true" ]; then
  $GP register "$MACHINE" --host 127.0.0.1 --port 2222 --user renter --price 0.01
fi
$GP machines

step "2. Start the demo host and give it the CA key of $MACHINE"
docker compose up -d --build --quiet-pull >/dev/null 2>&1 || docker compose up -d --build
$GP host-setup "$MACHINE" --write host/ca/gatepass_ca.pub
ssh-keygen -l -f host/ca/gatepass_ca.pub

step "3. Pay for 1 minute on $MACHINE and get a pass"
SERIAL=$(as_renter $GP rent "$MACHINE" --minutes 1 --no-ssh --json | json 'v.serial')
echo "pass #$SERIAL"
ssh-keygen -L -f "passes/$SERIAL/key-cert.pub" | sed -n '2,13p'

step "4. Log in with the pass and run a command"
$GP ssh "$SERIAL" -- 'echo "hello from $(whoami)@$(hostname)"; uname -sm'

step "5. Start a long job; the host ends it when the paid minute is up"
set +e
$GP ssh "$SERIAL" -- 'i=0; while true; do echo "  job running, ${i}s"; i=$((i+5)); sleep 5; done'
echo "session exit code: $?"
set -e

step "6. Try to log in again with the same pass (must be refused)"
sleep 2
if $GP ssh "$SERIAL" -- whoami; then
  echo "UNEXPECTED: an expired pass was accepted" >&2
  exit 1
fi
echo "refused, as expected"

step "7. The pass is on-chain, and the owner collects the payment"
$GP passes "$MACHINE" | head -4
if [ "$($GP machines --json | json "v.find(m=>m.id==='$MACHINE').owner")" = "$OWNER" ]; then
  $GP withdraw "$MACHINE"
else
  echo "(skipping withdrawal: $MACHINE belongs to another account)"
fi

printf '\n\033[1mDemo complete.\033[0m\n'
