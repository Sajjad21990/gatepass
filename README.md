# Gatepass

**Pay, and get a pass that lets you into a machine for exactly the minutes you paid for.**
No accounts, no shared passwords, and no person holds the signing key.

Built at NEAR Hackathon. Runs on NEAR testnet.

## The problem

Giving someone access to a server means sharing a key or a password. Keys get
copied, never expire, and are not tied to payment. Renting out an idle GPU for
20 minutes needs sign-ups, billing and trust in an operator. AI agents cannot
sign up for any of that.

## What Gatepass does

SSH servers already accept *certificates*: signed notes saying "this key may
log in as user X until time T". The server trusts one certificate authority
(CA) key.

In Gatepass that CA key is held by no one. It belongs to a NEAR smart contract.
NEAR Chain Signatures (a threshold signing network) signs with it only when the
contract asks, and the contract asks only after it has been paid.

```
renter (human or agent)
   |  1. buy_pass(machine, my_ssh_pubkey, minutes) + payment
   v
Gatepass contract (NEAR testnet)
   |  2. builds the SSH certificate bytes itself (login user, expiry, serial)
   |  3. asks the Chain Signatures contract to sign those bytes (Ed25519)
   v
Chain Signatures MPC (v1.signer-prod.testnet)
   |  4. returns the signature to the contract's callback
   v
Gatepass contract checks the signature, stores the pass, credits the machine
   |  5. the CLI receives the certificate and writes key-cert.pub
   v
ssh -> machine (its sshd trusts only the Gatepass CA public key)
```

The renter supplies only a public key and a number of minutes. The contract
alone decides the login user, the expiry and the serial number. Each
certificate forces a wrapper command on the host that ends the session at the
expiry time, so an open session cannot outlive the paid minutes.

## Run the demo

You need Docker (running), Node 22.18 or newer, and the OpenSSH client
(`ssh`, `ssh-keygen`). You do **not** need Rust: the contract is already
deployed on testnet at `gatepass.gp-spike-47008742.testnet`.

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create a throwaway testnet account. This asks the NEAR testnet faucet for a
   new funded account and writes it to `.env` (git-ignored).

   ```bash
   node scripts/create-testnet-account.mjs
   ```

   You should see: `created gp-xxxxxxxxxx.testnet with 10.000 NEAR; key written to .env`

3. Run the demo. It takes about 90 seconds.

   ```bash
   scripts/demo.sh
   ```

   You should see these steps, each with real output:

   | Step | What happens | What you see |
   | --- | --- | --- |
   | 1 | A Docker sshd starts and is given the contract's CA key | `256 SHA256:TDg5HQjj... gatepass-ca (ED25519)` |
   | 2 | Your account registers its own demo machine at 0.01 NEAR per minute | a table listing `demo-xxxxxxxx` |
   | 3 | You pay for 1 minute; Chain Signatures signs the pass | `pass #N`, then the certificate with `Principals: renter` and `force-command /usr/local/bin/gatepass-session <expiry>` |
   | 4 | The pass logs in and runs a command | `hello from renter@<container id>` |
   | 5 | A long job is started and cut off when the minute is up | `job running, 0s` ... then `gatepass: time is up, session closed` and `session exit code: 124` |
   | 6 | The same pass is tried again | `Permission denied (publickey).` then `refused, as expected` |
   | 7 | The pass is listed from the chain and the owner withdraws | `withdrew 0.01 NEAR from demo-xxxxxxxx to <your account>` and an explorer link |

   The script ends with `Demo complete.` and exit code 0.

4. Optional: watch it in the dashboard while the demo runs.

   ```bash
   node scripts/dashboard.ts
   ```

   Open http://127.0.0.1:4173. You should see the machines, the CA key, and
   each pass counting down and flipping to "Expired".

### Use the CLI by hand

```bash
bin/gatepass machines                         # list machines and prices
bin/gatepass rent gpu-1 --minutes 2           # pay, get a pass, open a shell
bin/gatepass rent gpu-1 --minutes 1 -- uname -a   # or run one command
bin/gatepass ssh <serial> -- whoami           # log in again with a saved pass
bin/gatepass passes gpu-1                     # passes issued, read from the chain
bin/gatepass host-setup                       # CA key and sshd lines for a real host
bin/gatepass register my-box --host 203.0.113.7 --port 22 --user renter --price 0.05
bin/gatepass withdraw my-box                  # owner only
```

Add `--json` to `machines`, `passes`, `rent`, `register` or `withdraw` for
machine-readable output, which is what an agent would use.

Passes are saved under `passes/<serial>/` (git-ignored): the throwaway private
key, the certificate and a `pass.json`. Check any certificate with
`ssh-keygen -L -f passes/<serial>/key-cert.pub`.

## Run the tests

Needs Rust 1.95 or newer.

```bash
cd contract && cargo test
```

You should see `test result: ok. 19 passed`. The tests cover:

- the certificate bytes built by the contract match, byte for byte, a
  certificate made by `ssh-keygen` (`body_matches_ssh_keygen_vector`);
- underpayment is rejected;
- a failed signature, or one that does not verify, refunds the buyer;
- only the owner withdraws, and only what has been earned;
- the login user cannot be used to smuggle extra principals into a certificate.

## Deploy your own contract

Needs Rust and [cargo-near](https://github.com/near/cargo-near).

```bash
cd contract && cargo near build non-reproducible-wasm && cd ..
# remove the GATEPASS_CONTRACT line from .env to deploy a fresh contract
node scripts/deploy.ts
```

You should see the new contract account (`gatepass.<your account>`), three
explorer links and a `CA public key: ssh-ed25519 ...` line. The script writes
`GATEPASS_CONTRACT` to `.env`. The CA key is derived from the contract's
account id, so a new deployment has a new CA key; run
`bin/gatepass host-setup --write host/ca/gatepass_ca.pub` to give it to the
demo host.

## How NEAR is used

| NEAR piece | Its job here |
| --- | --- |
| Chain Signatures (Ed25519) | Signs every SSH certificate. The CA key is derived by the MPC network from the contract's account id and a fixed path, so nobody can mint free access. The contract verifies each signature on-chain before accepting it. |
| Smart contract (Rust, near-sdk) | Checks payment, builds the certificate bytes on-chain, fixes the login user, expiry and serial, refunds if signing fails, records every pass, holds earnings until the owner withdraws. |
| Named accounts | Machine owners and renters are readable account names; each certificate's key id names the buyer, so the host's sshd log says who paid for each login. |

Not built (they were stretch goals): per-machine sub-accounts, payment in other
tokens through NEAR Intents, and NFT ownership shares.

### On-chain evidence (testnet)

| What | Link |
| --- | --- |
| Contract | [gatepass.gp-spike-47008742.testnet](https://testnet.nearblocks.io/address/gatepass.gp-spike-47008742.testnet) |
| Contract fetches its CA key from the MPC | [BcyLJvCL...](https://testnet.nearblocks.io/txns/BcyLJvCL5f25QZoticoFpN6EfZptEMChkKUVCw47TAXg) |
| Machine registered | [EVpVVjAs...](https://testnet.nearblocks.io/txns/EVpVVjAsvgJRCnW5g9dqQ3BZgyxhxSUyCAe9QxHb3f2F) |
| Pass #1 bought and signed | [8ejuPj1v...](https://testnet.nearblocks.io/txns/8ejuPj1vpwVTm4nUW1DtnSnafWEVJsFTc7KpN37TKzqS) |
| Pass #2 bought and signed | [3EewrPRE...](https://testnet.nearblocks.io/txns/3EewrPRE6hMxGwTLHbHU6Z511fhkFTAiqb6JA6UcV7YT) |
| Owner withdraws earnings | [9fKyzHaa...](https://testnet.nearblocks.io/txns/9fKyzHaa8s3N91TimGGDuEaRCPdTF2jQqJFnGkUZK1ey) |
| First spike: MPC signs a hand-built certificate | [Dtkpbaa8...](https://testnet.nearblocks.io/txns/Dtkpbaa811vUcG7ejyQ2XgELraxBEKpeAB4zjXeBgPmx) |

Chain Signatures details that this project depends on, checked against the
[MPC contract source](https://github.com/near/mpc) and the live contract:
`sign({"request":{"path","domain_id":1,"payload_v2":{"Eddsa":"<hex>"}}})` with
a 1 yoctoNEAR deposit; the payload is signed as raw bytes (no pre-hash) and may
be up to 1232 bytes. A Gatepass certificate body is about 360 bytes.

## Contract interface

| Method | Who | What |
| --- | --- | --- |
| `register_machine(id, host, port, login_user, price_per_minute)` | anyone | Caller becomes the owner. `host` and `port` are display only. |
| `buy_pass(machine_id, ssh_pubkey, minutes)` payable | anyone | 1 to 240 minutes. Attach at least `price * minutes` (extra is returned) and 300 Tgas. Resolves to the signed pass. |
| `withdraw(machine_id)` | owner | Pays out the machine's earnings. |
| `set_machine_active(machine_id, active)` | owner | Pause or resume sales. |
| `refund_stuck_pass(serial)` | buyer | Refund if a pass is still unsigned 10 minutes after its expiry. |
| `refresh_ca_key()` | anyone | Re-reads the CA key from the MPC contract. |
| `get_machine`, `list_machines`, `get_pass`, `list_passes`, `list_recent_passes`, `ca_public_key`, `get_config`, `get_pass_signed_bytes` | views | |

Events are logged as NEP-297 `EVENT_JSON` with standard `gatepass`:
`ca_key_set`, `machine_registered`, `pass_issued`, `pass_failed`, `withdrawn`.

## Trust model and limits

Stated plainly, so nobody has to find these out the hard way.

- **Testnet only.** Payment is testnet NEAR. Nothing here has been audited.
- **The contract's own key.** The CA key is controlled by whoever can change
  the contract's code. This deployment still has a full-access key held by the
  deployer, so the deployer could replace the code and mint passes. A real
  deployment would delete that key or put upgrades behind a DAO.
- **The MPC network.** The CA key is as safe as the Chain Signatures threshold
  network.
- **A host can take payment and refuse service.** The contract cannot see
  whether the machine let you in. There are no disputes or refunds for a host
  that is down, and `host` and `port` are whatever the owner typed.
- **The host is not authenticated.** The CLI trusts the host key on first use.
- **Time starts at purchase, not at login.** Signing takes about 7 seconds of
  the first minute. The certificate is valid from 60 seconds before purchase to
  absorb clock skew, and the host's clock must be right.
- **What ends a live session is the host's wrapper.** sshd checks a
  certificate only at login. Each certificate carries a `force-command` that
  runs `host/gatepass-session <expiry>`, which kills the session's processes at
  the deadline. A host that removes the wrapper only gives away its own time.
  See "Session deadline" below for what a renter can and cannot get around.
- **Renters share one unix user** on a machine. Two renters with overlapping
  passes can see and signal each other's processes, and files left on disk
  stay there. Port forwarding, agent forwarding and tunnels are disabled; sftp
  and scp are not available on the demo host.
- **No revocation.** A pass cannot be cancelled before it expires.
- **Certificates are public.** They are stored on-chain. That is safe: a
  certificate is useless without the renter's private key, which never leaves
  the renter's machine.
- **Storage is paid by the contract.** Registering machines and buying passes
  uses the contract's own balance for storage; there is no storage deposit, so
  the contract could be spammed.

### Session deadline

<!-- SESSION-LIMITS -->

## Repository layout

| Path | What |
| --- | --- |
| `contract/` | The Rust contract. `src/cert.rs` is the OpenSSH certificate encoder; `src/lib.rs` is machines, passes, signing and earnings; `src/tests.rs` is the unit tests. |
| `cli/` | The `gatepass` CLI (TypeScript, run directly by Node). |
| `host/` | The demo host: Dockerfile, `sshd_config`, and the `gatepass-session` deadline wrapper. |
| `dashboard/` | Read-only web page: machines, passes with live countdown, earnings. No wallet needed. |
| `scripts/` | `demo.sh`, `deploy.ts`, `dashboard.ts`, `create-testnet-account.mjs`. |
| `spike/` | The first go/no-go experiment: a hand-built certificate signed by Chain Signatures directly from an account, before the contract existed. |
| `GATEPASS_BRIEF.md` | The project brief this was built from. |

## Built with

- [near-sdk-rs](https://github.com/near/near-sdk-rs) 5.30 and
  [cargo-near](https://github.com/near/cargo-near) 0.23 for the contract.
- [near-api-js](https://github.com/near/near-api-js) 5.1 for the CLI and scripts.
- [NEAR Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
  (`v1.signer-prod.testnet`) for signing.
- OpenSSH (certificate format from `PROTOCOL.certkeys`) and Alpine Linux in
  Docker for the demo host.
- No templates were used.
- **AI assistance:** the code, tests and this README were written with Claude
  Code (Anthropic's Claude) working from the brief in `GATEPASS_BRIEF.md`,
  directed by the author.

## License

MIT. See [LICENSE](LICENSE).
