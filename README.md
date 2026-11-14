# Gatepass

**Pay, and get a pass that lets you into a machine for exactly the minutes you paid for.**
No sign-up with the machine's owner, no shared passwords, and no person holds the signing key.

Built at NEAR Hackathon. Runs on NEAR testnet.

Demo video (2 minutes 17 seconds): https://x.com/Sajjad21990/status/2121579037571371429
The same file is in this repository at [docs/gatepass-demo.mp4](docs/gatepass-demo.mp4), with every
narration line burned in as captions.

## The problem

Giving someone access to a server means sharing a key or a password. Keys get
copied, never expire, and are not tied to payment. Renting out an idle GPU for
20 minutes needs sign-ups, billing and trust in an operator. AI agents cannot
sign up for any of that.

## What Gatepass does

SSH servers already accept *certificates*: signed notes saying "this key may
log in as user X until time T". The server trusts one certificate authority
(CA) key.

In Gatepass that CA key is held by no one. Every machine has its own CA key,
and each one belongs to a NEAR smart contract. NEAR Chain Signatures (a
threshold signing network) signs with it only when the contract asks, and the
contract asks only after someone has paid for time on that machine.

```
renter (human or agent)
   |  1. buy_pass(machine, my_ssh_pubkey, minutes) + payment
   v
Gatepass contract (NEAR testnet)
   |  2. builds the SSH certificate bytes itself (login user, expiry, serial)
   |  3. asks the Chain Signatures contract to sign those bytes (Ed25519)
   |     with that machine's own key
   v
Chain Signatures MPC (v1.signer-prod.testnet)
   |  4. returns the signature to the contract's callback
   v
Gatepass contract checks the signature, stores the pass, credits the machine
   |  5. the CLI receives the certificate and writes key-cert.pub
   v
ssh -> machine (its sshd trusts only that machine's CA public key)
```

The renter supplies only a public key and a number of minutes. The contract
alone decides the login user, the expiry and the serial number. Each
certificate forces a wrapper command on the host that ends the session at the
expiry time, so an open session cannot outlive the paid minutes. A pass bought
for one machine is signed with that machine's key only, so it is worthless on
any other machine.

A machine has one renter at a time: while a pass is live, the contract refuses
to sell another for that machine. Owners can publish the machine's SSH host key
on-chain, and the renter's CLI then accepts only that key.

## Run the demo

You need Docker (running), Node 22.18 or newer, and the OpenSSH client
(`ssh`, `ssh-keygen`). You do **not** need Rust: the contract is already
deployed on testnet at `gatepass.testnet`.

1. Get the code and install dependencies.

   ```bash
   git clone https://github.com/Sajjad21990/gatepass.git && cd gatepass && npm install
   ```

2. Create a throwaway testnet account. This asks the NEAR testnet faucet for a
   new funded account and writes it to `.env` (git-ignored).

   ```bash
   node scripts/create-testnet-account.mjs
   ```

   You should see: `created gp-xxxxxxxxxx.testnet with 10.000 NEAR; key written to .env`

   Optional: create a second account so the renter and the machine owner are
   different accounts. The demos use it for paying when it exists.

   ```bash
   node scripts/create-testnet-account.mjs --env .env.renter
   ```

3. Run the demo. It takes about 90 seconds.

   ```bash
   scripts/demo.sh
   ```

   You should see these steps, each with real output:

   | Step | What happens | What you see |
   | --- | --- | --- |
   | 1 | Your account registers its own demo machine at 0.01 NEAR per minute (first run only) | `registered demo-xxxxxxxx ...`, its `CA key: ssh-ed25519 ...`, and a table of machines |
   | 2 | A sandboxed Docker sshd starts, is given that machine's CA key, and its SSH host key is published on-chain (first run only) | `wrote the CA public key of demo-xxxxxxxx ...`, `256 SHA256:... gatepass-ca:demo-xxxxxxxx (ED25519)`, and on a first run `host key of demo-xxxxxxxx published` |
   | 3 | You pay for 1 minute; Chain Signatures signs the pass | `pass #N`, then the certificate with `Principals: renter` and `force-command /usr/local/bin/gatepass-session <expiry>` |
   | 4 | The pass logs in and runs a command | `(host key pinned from the contract)`, `gatepass: session ends in 5Xs` and `hello from renter@<container id>` |
   | 5 | A long job is started and cut off when the minute is up | a `job running, Ns` line every 5 seconds, then `gatepass: time is up, session closed` and `session exit code: 124` |
   | 6 | The same pass is tried again | `Permission denied (publickey).` then `refused, as expected` |
   | 7 | The pass is listed from the chain and the owner withdraws | `withdrew 0.0N NEAR from demo-xxxxxxxx to <your account>` (0.01 on a first run) and an explorer link |

   The script ends with `Demo complete.` and exit code 0.

   A machine has one renter at a time, so if you run the demo again within a
   minute it first prints
   `demo-xxxxxxxx is in use for N more seconds (one renter at a time); waiting ...`.

4. Watch it in the web page while the demo runs. Start this first, in a
   second terminal:

   ```bash
   node scripts/dashboard.ts
   ```

   Open http://127.0.0.1:4173. The page reads the contract every 2 seconds, so
   it follows a rental as it happens:

   | When | What the page shows |
   | --- | --- |
   | The machine is free | A laptop with its lid shut and a breathing green light, a timer dial to set minutes, the price, and the exact `bin/gatepass rent ...` command to copy |
   | The demo pays (step 3) | "demo-xxxxxxxx is opening": the lid lifts in stages while three lines say what the contract and NEAR Chain Signatures are doing |
   | The pass is live (steps 4 and 5) | The lid is open and the screen counts down to the paid deadline; the dial runs down with it |
   | Time is up (step 6) | "demo-xxxxxxxx is shut again": the lid closes, the light goes off, "Files wiped. Free for the next renter." |

   Machines whose name contains `gpu` (or ends in `-big`) are drawn as a GPU
   tower whose fans spin while rented, and names containing `arm`, `pi` or
   `tiny` as a small single-board computer whose lights come on. Below the
   stage are all machines with live availability, every pass, and pages for
   owners and agents. Paying from the browser is not built: renting is done
   with the CLI or by the agent, and the page shows it live. Add `?preview=1`
   to the address to step through every state without renting, and
   `/board.html` is the earlier plain table view.

### Let an AI agent rent by itself

```bash
scripts/agent-demo.sh
```

This lists two machines owned by your account (0.01 and 0.05 NEAR per minute,
two separate sandboxed sshd containers, each with its own CA key) and hands a
task to `agent/agent.ts`. The default task is "How many prime numbers are there
below 50000? Work it out by actually running code, not from memory." Pass your
own task in quotes to change it.

The agent has a wallet, a budget of 0.1 NEAR and four tools: list machines, get
a quote, rent, run a command. It decides whether a machine is needed at all,
which one, for how long and what to run, and reports what it spent.

You should see lines like these, ending with an answer and the cost:

```
tool   list_machines({})
tool   rent_machine({"machine_id":"demo-xxxxxxxx","minutes":1})
tool   run_command({"pass_serial":14,"command":"python3 - << 'PY'\n# Count primes below 50000 using a simple sieve ..."})
       -> {"exit_code":0,"stdout":"5133","stderr":"","seconds_left":50}

answer
There are 5133 primes below 50,000.
I rented machine demo-xxxxxxxx for 1 minute. Cost: 0.02 NEAR.

spent
  pass #14 on demo-xxxxxxxx: 0.02 NEAR   https://testnet.nearblocks.io/txns/...
  total 0.02 of 0.1 NEAR budget (plus network fees)
  model: 4 calls, 3371 input + 895 output tokens (gpt-5-mini)
```

(5133 is the right answer.) If the cheap machine is still in use from a run
less than a minute ago, the agent sees that and waits or picks the other one.

Which model decides is up to you. Set these in `.env` (any OpenAI-compatible
chat API with tool calling works):

| Setting | Meaning |
| --- | --- |
| `AGENT_LLM_API_KEY` | Key for the endpoint. If empty, no model is used (see below). |
| `AGENT_LLM_BASE_URL` | Default `https://cloud-api.near.ai/v1` (NEAR AI Cloud). |
| `AGENT_LLM_MODEL` | Default `z-ai/glm-5.3-flash`. |

- **Tested with OpenAI:** `AGENT_LLM_BASE_URL=https://api.openai.com/v1` and
  `AGENT_LLM_MODEL=gpt-5-mini`. The output above is from that run: 4 model
  calls, 3,371 input and 895 output tokens, about a quarter of a US cent at
  list prices. On an earlier run, before Python was in the image, the same
  model found `python3` and `perl` missing, listed the available tools and
  got the same answer with `seq | factor | awk`.
- **Tested with a local model:** `qwen3:8b` served by Ollama
  (`AGENT_LLM_BASE_URL=http://127.0.0.1:11434/v1`, any non-empty key). Asked
  "What is 17 times 23?", it answered without renting anything and spent
  nothing.
- **Model cost:** the script prints the token counts at the end of every run,
  so the cost of a run can be worked out for any provider.
- **Not tested:** the NEAR AI Cloud default. The request format follows its
  documentation, but no API key was available while building this.
- **No key (what you see with a fresh `.env`):** the run ends with
  `Ran on demo-xxxxxxxx for 1 minute (exit code 0):` and `5133 primes below 50000`,
  with no `model:` line. The script falls back to a fixed rule (cheapest free machine, one
  minute, one preset command) and says so in its output. That reproduces the
  payment and login flow, but no model is deciding anything.

The budget is enforced in the script, not by the model: a rent that would
exceed it is refused before any transaction is sent. Commands chosen by the
model run only on the rented machine, never on yours.

### Use the CLI by hand

Use the machine your own demo host trusts: the `demo-xxxxxxxx` id that
`scripts/demo.sh` printed. Other machines in the list belong to other accounts
and point at their owners' computers, so renting one of those pays its owner
and then cannot connect.

```bash
bin/gatepass machines                              # list machines, prices and availability
bin/gatepass rent demo-xxxxxxxx --minutes 2        # pay, get a pass, open a shell
bin/gatepass rent demo-xxxxxxxx --minutes 1 -- uname -a   # or run one command
bin/gatepass ssh <serial> -- whoami                # log in again with a saved pass
bin/gatepass passes demo-xxxxxxxx                  # passes issued, read from the chain
bin/gatepass host-setup demo-xxxxxxxx              # that machine's CA key and sshd setup
bin/gatepass register my-box --host 203.0.113.7 --port 22 --user renter --price 0.05
bin/gatepass withdraw my-box                       # owner only
bin/gatepass set-host-key my-box /etc/ssh/ssh_host_ed25519_key.pub   # owner only
bin/gatepass pause my-box                          # owner only; "resume" reopens it
bin/gatepass refresh-ca my-box                     # re-read a machine's CA key from the MPC
```

Add `--json` to `machines`, `passes`, `rent`, `register`, `withdraw` or
`set-host-key` for machine-readable output, which is what an agent would use.
With `--json`, stdout carries only the JSON; a remote command's output goes to
stderr.

If a command reports that every RPC endpoint is rate-limiting, wait a minute or
set `NEAR_RPC_URL` in `.env` to another testnet endpoint. Three public
endpoints are tried in order by default.

Passes are saved under `passes/<serial>/` (git-ignored): the throwaway private
key, the certificate and a `pass.json`. Check any certificate with
`ssh-keygen -L -f passes/<serial>/key-cert.pub`.

## Put a machine on the internet

The demos above run the rented machine on your own computer. To list a machine
that anyone can rent from anywhere, run this on the machine itself (a small
Linux VPS is enough), from a checkout of this repo with Docker running and a
`.env` holding the owner's testnet account:

```bash
scripts/host-up.sh my-box 203.0.113.7 0.01 2222   # id, public address, NEAR per minute, port
```

It registers the machine, starts the sandboxed sshd listening on all
interfaces, gives it the machine's CA key and publishes its SSH host key
on-chain. You should see `my-box is listed at renter@203.0.113.7:2222`. Open
that TCP port in the firewall. Then, from any other computer with this repo
and a testnet account:

```bash
bin/gatepass rent my-box --minutes 1 -- uname -a
```

Status: the script and the network isolation were tested on Docker Desktop
with the machine published on all interfaces. No public machine is running at
the moment, and the setup has not been run on a Linux VPS yet. Before listing
one publicly, check from a rented session that the VPS's own services are not
reachable through the Docker gateway address; older Docker Engine versions
allow that even on an internal network.

## Run the tests

Needs Rust 1.95 or newer.

```bash
cd contract && cargo test
```

You should see `test result: ok. 35 passed`. The tests cover:

- the certificate bytes built by the contract match, byte for byte, a
  certificate made by `ssh-keygen` (`body_matches_ssh_keygen_vector`);
- a signed pass yields a certificate and credits the owner (a test key stands
  in for the MPC network);
- every machine gets its own CA key path, and a pass for one machine is signed
  with that machine's key only;
- a machine has one renter at a time, and is free again the moment a pass
  expires or fails;
- only the owner can publish a machine's host key;
- underpayment is rejected;
- a failed signature, one that does not verify, or an unexpected MPC answer
  refunds the buyer;
- only the owner withdraws, and only what has been earned;
- the storage fees cover the storage a machine and a pass actually use;
- the login user and host name cannot be used to smuggle extra principals or
  ssh options.

## Deploy your own contract

Needs Rust and [cargo-near](https://github.com/near/cargo-near).

```bash
cd contract && cargo near build non-reproducible-wasm && cd ..
# remove the GATEPASS_CONTRACT line from .env to deploy a fresh contract
node scripts/deploy.ts
```

You should see the new contract account (`gatepass.<your account>`) and two
explorer links. The script writes `GATEPASS_CONTRACT` to `.env`; open the
dashboard with `?contract=<your contract account>` to point it there. CA keys are
derived from the contract's account id, so machines on a new deployment have
new CA keys; `scripts/demo.sh` registers a machine and gives its key to the
demo host.

## How NEAR is used

| NEAR piece | Its job here |
| --- | --- |
| Chain Signatures (Ed25519) | Signs every SSH certificate. Each machine's CA key is derived by the MPC network from the contract's account id and the path `gatepass-ca-v1/<machine id>`, so nobody holds a key and nobody can mint free access. The contract reads each key from the MPC contract and verifies every signature on-chain before accepting it. |
| Smart contract (Rust, near-sdk) | Checks payment, builds the certificate bytes on-chain, fixes the login user, expiry and serial, refunds if signing fails, records every pass, holds earnings until the owner withdraws. |
| Named accounts | Machine owners and renters are readable account names; each certificate's key id names the buyer, so the host's sshd log says who paid for each login. |

Not built (they were stretch goals): per-machine sub-accounts, payment in other
tokens through NEAR Intents, and NFT ownership shares.

### Hackathon tracks

| Track | Why it fits |
| --- | --- |
| Agent Economy (`agents`) | An agent with its own wallet finds a machine, pays for compute by the minute and reports what it spent (`agent/agent.ts`). The pass is signed with Chain Signatures. |
| Autonomous Business (`business`) | A machine earns by itself: the contract sells its time, holds the earnings and pays the owner on withdrawal. No operator approves anything. |
| AI Security & Defense (`security`) | An agent gets a spending budget enforced in code and time-limited, sandboxed access to one machine, never a long-lived key. |
| Open Innovation (`open`) | Chain Signatures used as a certificate authority for SSH, which is not what it was built for. |

### On-chain evidence (testnet)

| What | Link |
| --- | --- |
| Contract | [gatepass.testnet](https://testnet.nearblocks.io/address/gatepass.testnet) |
| Machine `gpu-1` registered; contract fetches its CA key from the MPC | [68bXEUTo...](https://testnet.nearblocks.io/txns/68bXEUTod6tbMTisrBkz5ADpdAy65b2c7kt8K9kotSyr) |
| Pass #1 bought by a renter account and signed by Chain Signatures | [3q1EM367...](https://testnet.nearblocks.io/txns/3q1EM367jXYyK3BMtR14BDroa6XwhwWthP9CPFTLzTm2) |
| Owner withdraws earnings | [AYw2aFMn...](https://testnet.nearblocks.io/txns/AYw2aFMnseVoWFRHqcqszEJf4nRsuM35VuZcaHzt7Gxi) |
| Pass #2 bought by `agent/agent.ts`, running as the renter account | [8y63yUb6...](https://testnet.nearblocks.io/txns/8y63yUb6u69PCE8EZVC7qbBBJLmjb9vzkJmnNQTm6CY6) |
| First experiment, before the contract existed: the MPC signs a hand-built certificate, called directly from an account (script in the git history under `spike/`) | [Dtkpbaa8...](https://testnet.nearblocks.io/txns/Dtkpbaa811vUcG7ejyQ2XgELraxBEKpeAB4zjXeBgPmx) |

Chain Signatures details that this project depends on, checked against the
[MPC contract source](https://github.com/near/mpc) and the live contract:
`sign({"request":{"path","domain_id":1,"payload_v2":{"Eddsa":"<hex>"}}})` with
a 1 yoctoNEAR deposit; the payload is signed as raw bytes (no pre-hash) and may
be up to 1232 bytes. A Gatepass certificate body is about 350 bytes.

## Contract interface

| Method | Who | What |
| --- | --- | --- |
| `register_machine(id, host, port, login_user, price_per_minute)` payable | anyone | Caller becomes the owner. Costs a 0.02 NEAR storage fee. Fetches the machine's own CA key from the MPC. `host` and `port` are display only. |
| `quote(machine_id, minutes)` view | anyone | Price, storage fee and total for a pass, and until when the machine is in use. |
| `buy_pass(machine_id, ssh_pubkey, minutes)` payable | anyone | 1 to 240 minutes. Refused while another pass on the machine is live. Attach the quoted total (`price * minutes` plus a 0.01 NEAR storage fee; extra is returned) and at least 100 Tgas (the CLI attaches 300). Resolves to the signed pass, or refunds everything. |
| `set_host_key(machine_id, host_key)` | owner | Publishes the machine's SSH host key so renters can pin it. |
| `withdraw(machine_id)` | owner | Pays out the machine's earnings. |
| `set_machine_active(machine_id, active)` | owner | Pause or resume sales. |
| `settle_pass(serial, signature)` | anyone | Finish a pending pass by hand with the MPC's signature (which is public), if the contract's callback ever failed. Accepted only if it verifies. |
| `refund_stuck_pass(serial)` | buyer | Refund if a pass is still unsigned 10 minutes after its expiry. |
| `refresh_ca_key(machine_id)` | anyone | Re-reads a machine's CA key from the MPC contract. |
| `get_machine`, `list_machines`, `get_pass`, `list_passes`, `list_recent_passes`, `ca_public_key`, `get_config`, `get_pass_signed_bytes` | views | |

Events are logged as NEP-297 `EVENT_JSON` with standard `gatepass`:
`ca_key_set`, `machine_registered`, `host_key_set`, `pass_issued`, `pass_failed`,
`withdrawn`.

## Security: what each side gets

Both sides are strangers to each other, so access is restricted in both
directions. Everything in this section is implemented in `host/` and
`docker-compose.yml` and was tested on the demo host.

### For the machine owner (what a renter cannot do)

| Protection | How |
| --- | --- |
| Only paying renters get in | sshd accepts nothing but certificates signed by this machine's own CA key. No passwords, no `authorized_keys`. A certificate without a deadline is refused. |
| Nobody gets in as root | The renter is an unprivileged user with zero Linux capabilities. `no-new-privileges` is set and the image has no setuid programs. |
| The system cannot be changed | The root filesystem is read-only. The only writable places are size-capped, non-executable scratch areas (64 MB home, 32 MB `/tmp`). |
| The machine cannot be taken down | Limits of 1 CPU, 256 MB memory and 128 processes per session. A fork bomb and a memory hog were both tested: sshd stayed up and the next login worked. |
| Nobody overstays | The session is cut at the paid deadline, and a root-owned reaper enforces it even if the renter freezes the in-session timer. |
| No network abuse from the owner's address | The machine has no outbound network at all: no internet, no DNS, no access to the owner's computer, LAN or other machines. It sits on an internal Docker network behind a small forwarder that only passes SSH in. Port, agent and X11 forwarding and tunnels are disabled too. |
| Nothing is left behind | When a pass ends, every process is killed and every file the renter wrote is erased before the next renter can log in. |

What a renter can still do, which an owner must plan for:

- **Nothing on the network, unless the owner opens it.** A job that needs to
  download something will not work on the demo host. `docker-compose.yml`
  says how an owner can attach a machine to an outside network on purpose,
  and what that exposes.
- **Use the resources paid for**, up to the limits above, for any purpose.
- **Read what is world-readable** in the image: the Gatepass scripts, the sshd
  configuration, hardware and kernel details.
- **This is a container, not a virtual machine.** It shares the host's kernel,
  so a kernel vulnerability is the remaining way out.

### For the renter (what an owner or another renter cannot do)

| Protection | How |
| --- | --- |
| The machine is yours alone | The contract sells one pass per machine at a time, and the host refuses any other pass until yours is over. |
| Nobody inherits your files | Your files last for your whole pass, across reconnects, and are erased within seconds of it ending. The previous renter's files were erased before you arrived. |
| You reach the right machine | If the owner published the machine's SSH host key on-chain, the CLI accepts only that key. |
| Your key stays yours | The CLI makes a throwaway key pair for each pass. Only the public half goes on-chain; a certificate is useless without the private half. |
| You pay for what the contract promised | The login user, expiry and price are fixed by the contract. If Chain Signatures does not sign, the whole payment is refunded. |

What a renter must accept:

- **The owner is root on the machine** and can see everything you run, type
  and store there. Do not put secrets on a rented machine.
- **An owner can take payment and not provide the service.** The contract
  cannot see whether the machine let you in.
- **Programs do not survive a disconnect.** Anything still running when your
  connection closes is killed, including `nohup` and background jobs.
- **The demo machine is small and closed.** It has a shell, the usual Unix
  tools and Python 3, 1 CPU and 256 MB of memory, and no network. Uploaded
  binaries cannot be run (`sh script.sh` and `python3 script.py` work,
  `./binary` does not), and there is no sftp or scp.

## Trust model and limits

Stated plainly, so nobody has to find these out the hard way.

- **Testnet only.** Payment is testnet NEAR. Nothing here has been audited.
- **The contract's own key.** The CA keys are controlled by whoever can change
  the contract's code. This deployment still has a full-access key held by the
  deployer, so the deployer could replace the code and mint passes. A real
  deployment would delete that key or put upgrades behind a DAO.
- **The MPC network.** The CA keys are as safe as the Chain Signatures
  threshold network.
- **A host can take payment and refuse service.** The contract cannot see
  whether the machine let you in. There are no disputes or refunds for a host
  that is down, and `host` and `port` are whatever the owner typed.
- **The host is authenticated only if its owner published its host key.** When
  a machine has a host key on-chain, the CLI accepts only that key. Otherwise
  it trusts the first key it sees.
- **A long pass blocks everyone else.** One renter at a time means a 240-minute
  pass keeps the machine for 240 minutes, used or not. There is no early
  release and no refund for unused time.
- **Time starts at purchase, not at login.** Signing takes about 7 seconds of
  the first minute. The certificate is valid from 60 seconds before purchase to
  absorb clock skew, and the host's clock must be right.
- **What ends a live session is software on the host.** sshd checks a
  certificate only at login. See "Session deadline" below for how the deadline
  is enforced and what a renter can and cannot get around. A host that removes
  that software only gives away its own time.
- **No revocation.** A pass cannot be cancelled before it expires.
- **Certificates are public.** They are stored on-chain. That is safe: a
  certificate is useless without the renter's private key, which never leaves
  the renter's machine.
- **Storage fees are flat.** A machine costs 0.02 NEAR and a pass 0.01 NEAR on
  top of its price, sized to cover the storage they use. The fees stay with the
  contract and are not returned.
- **Failed payouts are not retried.** If a withdrawal or refund is sent to an
  account that no longer exists, the contract does not notice and the amount
  stays in the contract.

### Session deadline

Two things on the host enforce the paid time, and neither trusts the renter:

1. `gatepass-session` is the `force-command` in every certificate, so sshd runs
   it instead of the renter's command. It runs the command and, at the expiry
   time, prints `gatepass: time is up, session closed` and kills everything in
   the session (exit code 124).
2. `gatepass-reaper` runs as root next to sshd. At login, sshd (as root) reads
   the deadline out of the certificate itself and records it where the renter
   cannot write. Three seconds after a deadline the reaper kills that whole
   connection. This covers a renter who stops or kills the wrapper, which runs
   under their own user. A certificate with no deadline is refused at login.

Tested on the demo host (OpenSSH 10.0 on Alpine): a command, an interactive
shell, child processes, `nohup`, `setsid`, a frozen wrapper and a killed
wrapper are all cut off, and port forwards are refused.

What can still get around it:

- A process that forks and exits faster than the reaper scans (about once a
  second) could dodge the kill. Closing that needs one cgroup per connection.
- With the wrapper disabled, a session runs about 3 seconds past its deadline.
- The reaper watches one login user and has been tested on one OpenSSH version.
- The deadline follows the host's clock.

## Repository layout

| Path | What |
| --- | --- |
| `contract/` | The Rust contract. `src/cert.rs` is the OpenSSH certificate encoder; `src/lib.rs` is machines, passes, signing and earnings; `src/tests.rs` is the unit tests. |
| `cli/` | The `gatepass` CLI (TypeScript, run directly by Node). |
| `agent/` | `agent.ts`: an agent with a wallet and a budget that rents machines by itself. |
| `host/` | The demo host (two sandboxed machines in `docker-compose.yml`, each behind a `host/gate` forwarder): Dockerfile, `sshd_config`, the `gatepass-session` deadline wrapper, and the root-side `gatepass-principals`, `gatepass-reaper` and `gatepass-wipe`. |
| `dashboard/` | The web page: a live view of the contract where the rented machine opens and shuts with its pass. `index.html` is the page, `devices.js` and `devices.css` draw the GPU tower and the small board, `board.html` is the earlier table view. No wallet needed. |
| `bin/gatepass` | The launcher every CLI command in this README uses. |
| `docker-compose.yml` | The two sandboxed demo machines and their forwarders, with the resource limits. |
| `scripts/` | `demo.sh`, `agent-demo.sh`, `host-up.sh` (list a real machine), `deploy.ts`, `dashboard.ts`, `create-testnet-account.mjs`. |

## Built with

- [near-sdk-rs](https://github.com/near/near-sdk-rs) 5.30 and
  [cargo-near](https://github.com/near/cargo-near) 0.23 for the contract.
- [near-api-js](https://github.com/near/near-api-js) 5.1 for the CLI and scripts;
  [ed25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) in the
  contract's tests only.
- [NEAR Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
  (`v1.signer-prod.testnet`) for signing.
- OpenSSH (certificate format from `PROTOCOL.certkeys`) and Alpine Linux in
  Docker for the demo host.
- No templates were used.
- **AI assistance:** the code, tests and this README were written with Claude
  Code (Anthropic's Claude), directed by the author.

## License

MIT. See [LICENSE](LICENSE).
