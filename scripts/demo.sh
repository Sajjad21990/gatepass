#!/usr/bin/env bash
# Gatepass end-to-end demo on NEAR testnet. Takes about 90 seconds.
#
# Needs: Docker running, Node 22.18+, and a .env with a funded testnet account
# and GATEPASS_CONTRACT (see README). Run from anywhere:
#
#   scripts/demo.sh [machine]
#
# What it shows, in order:
#   1. the host trusts only the contract's CA key (held by nobody)
#   2. paying for 1 minute returns a pass signed by NEAR Chain Signatures
#   3. the pass logs in and runs a command
#   4. a long-running session is cut off when the paid minute is up
#   5. a fresh login with the same pass is refused
#   6. the payment is in the machine's earnings and the owner withdraws it
set -euo pipefail
cd "$(dirname "$0")/.."
MACHINE=${1:-gpu-1}
GP=bin/gatepass

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "1. Start the demo host and give it the contract's CA key"
docker compose up -d --build --quiet-pull 2>&1 | grep -v '^$' | tail -3 || true
$GP host-setup --write host/ca/gatepass_ca.pub
ssh-keygen -l -f host/ca/gatepass_ca.pub

step "2. Machines for rent"
$GP machines

step "3. Pay for 1 minute on $MACHINE and get a pass"
SERIAL=$($GP rent "$MACHINE" --minutes 1 --no-ssh --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).serial))')
echo "pass #$SERIAL"
ssh-keygen -L -f "passes/$SERIAL/key-cert.pub" | sed -n '1,13p'

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
$GP withdraw "$MACHINE"

printf '\n\033[1mDemo complete.\033[0m\n'
