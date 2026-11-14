#!/usr/bin/env bash
# An AI agent rents a machine by itself. Takes one to two minutes.
#
#   scripts/agent-demo.sh ["task in plain words"]
#
# Sets up two machines owned by your account (a cheap one and a dearer one,
# each a separate Docker sshd with its own CA key), then hands the task to
# agent/agent.ts. The agent pays from the .env.renter account if that file
# exists, otherwise from the .env account.
#
# With AGENT_LLM_API_KEY set (see .env.example) a model decides what to rent
# and what to run. Without it, a fixed rule is used and no model is involved.
set -euo pipefail
cd "$(dirname "$0")/.."
GP=bin/gatepass

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
as_renter() { if [ -f .env.renter ]; then GATEPASS_ENV_FILE=.env.renter "$@"; else "$@"; fi; }

[ -f .env ] || { echo "No .env found. Run: node scripts/create-testnet-account.mjs" >&2; exit 1; }
OWNER=$(sed -n 's/^NEAR_ACCOUNT_ID=//p' .env)
BASE=demo-$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,8))' "$OWNER")
SMALL=$BASE
BIG=$BASE-big
TASK=${1:-"Find out how many CPU cores and how much memory a rented machine has, and which Linux kernel it runs."}

step "1. Two machines for rent, owned by $OWNER"
LISTED=$($GP machines --json)
echo "$LISTED" | json "v.some(m=>m.id==='$SMALL')" | grep -q true || $GP register "$SMALL" --host 127.0.0.1 --port 2222 --user renter --price 0.01
echo "$LISTED" | json "v.some(m=>m.id==='$BIG')" | grep -q true || $GP register "$BIG" --host 127.0.0.1 --port 2223 --user renter --price 0.05
docker compose up -d --build --quiet-pull >/dev/null 2>&1 || docker compose up -d --build
$GP host-setup "$SMALL" --write host/ca/gatepass_ca.pub
$GP host-setup "$BIG" --write host/ca-b/gatepass_ca.pub
$GP machines | grep -E "^(MACHINE|$SMALL|$BIG) "

step "2. The agent takes the task"
if grep -q '^AGENT_LLM_API_KEY=..' .env 2>/dev/null || [ -n "${AGENT_LLM_API_KEY:-}" ]; then
  as_renter node agent/agent.ts "$TASK" --machines "$SMALL,$BIG" --budget 0.1
else
  as_renter node agent/agent.ts "$TASK" --machines "$SMALL,$BIG" --budget 0.1 --command 'echo "cores: $(nproc)"; grep MemTotal /proc/meminfo; echo "kernel: $(uname -r)"'
fi

step "3. What the chain recorded"
$GP passes | head -3
