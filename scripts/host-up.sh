#!/usr/bin/env bash
# List THIS computer for rent on Gatepass, reachable from the internet.
#
#   scripts/host-up.sh <machine-id> <public-host-or-ip> [price-per-minute-in-NEAR] [port]
#
#   scripts/host-up.sh judge-box 203.0.113.7 0.01 2222
#
# Run it on the machine you want to rent out (for example a small VPS) from a
# checkout of this repo, with Docker running and a .env holding the owner's
# testnet account (node scripts/create-testnet-account.mjs).
#
# What it does:
#   1. registers the machine on the contract under your account (first run)
#   2. starts the sandboxed sshd container, listening on all interfaces
#   3. gives the container this machine's own CA key from the contract
#   4. publishes the container's SSH host key on-chain so renters can pin it
#
# Afterwards anyone with a testnet account can run, from their own computer:
#   bin/gatepass rent <machine-id> --minutes 1 -- uname -a
#
# Open the chosen TCP port in your firewall or cloud security group.
set -euo pipefail
cd "$(dirname "$0")/.."
GP=bin/gatepass

MACHINE=${1:?usage: scripts/host-up.sh <machine-id> <public-host-or-ip> [price] [port]}
PUBLIC_HOST=${2:?usage: scripts/host-up.sh <machine-id> <public-host-or-ip> [price] [port]}
PRICE=${3:-0.01}
PORT=${4:-2222}

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

[ -f .env ] || { echo "No .env found. Run: node scripts/create-testnet-account.mjs" >&2; exit 1; }
OWNER=$(sed -n 's/^NEAR_ACCOUNT_ID=//p' .env)

echo "== 1. Register $MACHINE (owner $OWNER)"
INFO=$($GP machines --json | json "(m=>m?[m.owner,m.host,m.port].join('|'):'')(v.find(m=>m.id==='$MACHINE'))")
if [ -z "$INFO" ]; then
  $GP register "$MACHINE" --host "$PUBLIC_HOST" --port "$PORT" --user renter --price "$PRICE"
elif [ "$INFO" != "$OWNER|$PUBLIC_HOST|$PORT" ]; then
  echo "$MACHINE already exists as $INFO (owner|host|port), which does not match. Pick another machine id." >&2
  exit 1
else
  echo "already registered"
fi

echo "== 2. Start the sandboxed sshd on port $PORT, all interfaces"
GATEPASS_BIND=0.0.0.0 GATEPASS_PORT=$PORT docker compose up -d --build host gate

echo "== 3. Give it the CA key of $MACHINE"
$GP host-setup "$MACHINE" --write host/ca/gatepass_ca.pub
ssh-keygen -l -f host/ca/gatepass_ca.pub

echo "== 4. Publish its SSH host key on-chain"
KEY=$(docker compose exec -T host cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)
CURRENT=$($GP machines --json | json "(v.find(m=>m.id==='$MACHINE').host_key||'').split(' ').slice(0,2).join(' ')")
[ "$CURRENT" = "$KEY" ] && echo "already published" || $GP set-host-key "$MACHINE" "$KEY"

echo
echo "$MACHINE is listed at renter@$PUBLIC_HOST:$PORT for $PRICE NEAR per minute."
echo "Anyone can now rent it:  bin/gatepass rent $MACHINE --minutes 1 -- uname -a"
echo "Watch logins:            docker compose logs -f host"
