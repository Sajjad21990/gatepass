#!/usr/bin/env node
// Gatepass CLI: rent time on a machine with a pass signed by NEAR Chain Signatures.
//
//   gatepass machines
//   gatepass rent <machine> --minutes N [--no-ssh] [-- command ...]
//   gatepass ssh <serial> [-- command ...]
//   gatepass passes [machine]
//   gatepass host-setup <machine> [--write <file>]
//   gatepass register <id> --host H --port P --user U --price <NEAR per minute>
//   gatepass withdraw <machine>
//   gatepass set-host-key <machine> "<ssh-ed25519 AAAA...>"

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ROOT, TGAS, call, contractId, explain, fromYocto, settings, signer, toYocto, view } from './near.ts';

const PASS_DIR = process.env.GATEPASS_HOME || path.join(ROOT, 'passes');

interface Machine {
  id: string; owner: string; host: string; port: number; login_user: string;
  price_per_minute: string; earnings: string; total_earned: string; passes_issued: number; active: boolean;
  ca_public_key: string | null;
  busy_until: number; host_key: string | null;
}
interface Pass {
  serial: number; machine_id: string; buyer: string; key_id: string; ssh_pubkey: string;
  login_user: string; host: string; port: number; minutes: number;
  valid_after: number; valid_before: number; paid: string; status: 'Pending' | 'Signed' | 'Failed';
  certificate: string | null;
}

// Split "gatepass rent gpu-1 --minutes 2 -- uname -a" at the first "--".
const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const ownArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
const remoteCommand = dashDash === -1 ? [] : argv.slice(dashDash + 1);

function parseCli() {
  try {
    return parseArgs({
  args: ownArgs,
  allowPositionals: true,
  options: {
    minutes: { type: 'string', short: 'm' },
    'no-ssh': { type: 'boolean' },
    json: { type: 'boolean' },
    write: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    user: { type: 'string' },
    price: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
  } catch (err: any) {
    console.error(`gatepass: ${String(err?.message ?? err).split('\n')[0]}`);
    console.error('run "gatepass help" for usage');
    process.exit(2);
  }
}
const { values: opt, positionals } = parseCli();
const [command, ...rest] = positionals;

// GATEPASS_QUIET=1 drops the CLI's own narration (used by the agent, which wants only the remote output).
const say = (...a: unknown[]) => { if (!opt.json && !process.env.GATEPASS_QUIET) console.error(...a); };
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');
const secondsLeft = (p: Pass) => p.valid_before - Math.floor(Date.now() / 1000);

function passState(p: Pass): string {
  if (p.status !== 'Signed') return p.status.toLowerCase();
  const left = secondsLeft(p);
  return left > 0 ? `active, ${left}s left` : 'expired';
}

function machineState(m: Machine): string {
  if (!m.active) return 'paused';
  const left = m.busy_until - Math.floor(Date.now() / 1000);
  return left > 0 ? `in use, free in ${left}s` : 'free';
}

function table(rows: string[][]) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

type Target = Pick<Pass, 'host' | 'port' | 'login_user'> & { host_key?: string | null };

function sshArgs(dir: string, pass: Target, cmd: string[]): string[] {
  const knownHosts = path.join(dir, 'known_hosts');
  if (pass.host_key) {
    // The owner published this machine's host key on-chain: accept only that key.
    const name = pass.port === 22 ? pass.host : `[${pass.host}]:${pass.port}`;
    fs.writeFileSync(knownHosts, `${name} ${pass.host_key.split(/\s+/).slice(0, 2).join(' ')}\n`);
  }
  return [
    '-F', 'none', // ignore ~/.ssh/config: only this pass's key and options apply
    '-i', path.join(dir, 'key'),
    '-o', `CertificateFile=${path.join(dir, 'key-cert.pub')}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    // With a pinned host key, anything else is refused. Without one, trust on
    // first use, kept per pass so the user's own known_hosts is untouched.
    '-o', `StrictHostKeyChecking=${pass.host_key ? 'yes' : 'accept-new'}`,
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=10',
    '-p', String(pass.port),
    ...(cmd.length === 0 && process.stdin.isTTY ? ['-t'] : []),
    `${pass.login_user}@${pass.host}`,
    ...cmd,
  ];
}

function runSsh(dir: string, pass: Target, cmd: string[]): number {
  const args = sshArgs(dir, pass, cmd);
  say(`$ ssh ${pass.login_user}@${pass.host} -p ${pass.port}${cmd.length ? ` ${cmd.join(' ')}` : ''}${pass.host_key ? '   (host key pinned from the contract)' : ''}`);
  // With --json, stdout carries only the JSON result; the remote output goes to stderr.
  const r = spawnSync('ssh', args, { stdio: opt.json ? ['inherit', 2, 'inherit'] : 'inherit' });
  return r.status ?? 255;
}

// ---------- commands ----------

async function machines() {
  const list = await view<Machine[]>('list_machines', {});
  if (opt.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log('no machines registered yet');
  table([
    ['MACHINE', 'PRICE/MIN', 'CONNECT', 'OWNER', 'PASSES', 'EARNED', 'STATE'],
    ...list.map((m) => [m.id, `${fromYocto(m.price_per_minute)} NEAR`, `${m.login_user}@${m.host}:${m.port}`, m.owner, String(m.passes_issued), `${fromYocto(m.total_earned)} NEAR`, machineState(m)]),
  ]);
}

interface Quote { price: string; storage_fee: string; total: string; }

/** After a failed or timed-out call, look for the pass on-chain by its public key. */
async function recoverPass(sshPubkey: string): Promise<Pass | null> {
  const key = sshPubkey.split(/\s+/)[1];
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const mine = (await view<Pass[]>('list_recent_passes', {})).find((p) => p.ssh_pubkey.split(/\s+/)[1] === key);
      if (mine && mine.status !== 'Pending') return mine;
      if (!mine && attempt >= 3) return null;
    } catch { /* RPC hiccup: try again */ }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  return null;
}

async function rent() {
  const machineId = rest[0];
  const minutes = Number(opt.minutes ?? '1');
  if (!machineId) throw new Error('usage: gatepass rent <machine> --minutes N [--no-ssh] [-- command ...]');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('--minutes must be a whole number from 1 to 240');

  const machine = await view<Machine | null>('get_machine', { machine_id: machineId });
  if (!machine) throw new Error(`no machine called ${machineId}; try: gatepass machines`);
  const busyFor = machine.busy_until - Math.floor(Date.now() / 1000);
  if (busyFor > 0) throw new Error(`${machineId} is in use for ${busyFor} more seconds (a machine has one pass at a time). If that pass is yours, use: gatepass ssh <serial>`);
  const quote = await view<Quote>('quote', { machine_id: machineId, minutes });
  const account = await signer();
  say(`renting ${machineId} for ${minutes} min: ${fromYocto(quote.price)} NEAR + ${fromYocto(quote.storage_fee)} NEAR storage fee = ${fromYocto(quote.total)} NEAR, paid by ${account.accountId}`);

  // A throwaway key for this pass only. The private key never leaves this machine.
  fs.mkdirSync(PASS_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(PASS_DIR, '.new-'));
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gatepass-renter', '-f', path.join(tmp, 'key')]);
  const sshPubkey = fs.readFileSync(path.join(tmp, 'key.pub'), 'utf8').trim();

  say('paying and waiting for NEAR Chain Signatures to sign the pass ...');
  const started = Date.now();
  let pass: Pass | null = null;
  let txHash: string | undefined;
  try {
    const result = await call<Pass>(account, contractId(), 'buy_pass', { machine_id: machineId, ssh_pubkey: sshPubkey, minutes }, { deposit: BigInt(quote.total), gas: 300n * TGAS });
    pass = result.value;
    txHash = result.txHash;
  } catch (err) {
    // The call may have gone through even though we did not get its result
    // (for example an RPC timeout). Keep the key and look for the pass.
    say(`did not get the result (${explain(err)}); checking the chain for the pass ...`);
    pass = await recoverPass(sshPubkey);
    if (!pass) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  }
  const explorerUrl = txHash ? `${settings().explorer}/txns/${txHash}` : `${settings().explorer}/address/${contractId()}`;
  if (pass?.status !== 'Signed' || !pass.certificate) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`the pass was not signed (status ${pass?.status}); your payment was refunded. ${explorerUrl}`);
  }

  const dir = path.join(PASS_DIR, String(pass.serial));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  fs.writeFileSync(path.join(dir, 'key-cert.pub'), `${pass.certificate}\n`);
  const saved = { ...pass, host_key: machine.host_key, tx: txHash ?? null };
  fs.writeFileSync(path.join(dir, 'pass.json'), `${JSON.stringify(saved, null, 2)}\n`);

  say(`pass #${pass.serial} signed in ${((Date.now() - started) / 1000).toFixed(1)}s, valid until ${iso(pass.valid_before)} (${secondsLeft(pass)}s from now)`);
  say(`  tx:   ${explorerUrl}`);
  say(`  cert: ${path.relative(process.cwd(), path.join(dir, 'key-cert.pub'))}`);

  let exitCode = 0;
  if (!opt['no-ssh']) exitCode = runSsh(dir, saved, remoteCommand);
  if (opt.json) console.log(JSON.stringify({ ...saved, explorer: explorerUrl, dir, ssh_exit_code: opt['no-ssh'] ? null : exitCode }, null, 2));
  process.exitCode = exitCode;
}

/** Log in again with a pass bought earlier. After it expires, sshd refuses it. */
async function ssh() {
  const serial = rest[0];
  const dir = path.join(PASS_DIR, String(serial));
  if (!serial || !fs.existsSync(path.join(dir, 'pass.json'))) throw new Error(`usage: gatepass ssh <serial> [-- command ...]  (no saved pass ${serial ?? ''} in ${PASS_DIR})`);
  const pass: Pass & { host_key?: string | null } = JSON.parse(fs.readFileSync(path.join(dir, 'pass.json'), 'utf8'));
  const left = secondsLeft(pass);
  say(left > 0 ? `pass #${pass.serial}: ${left}s left` : `pass #${pass.serial} expired ${-left}s ago; the host should refuse it`);
  process.exitCode = runSsh(dir, pass, remoteCommand);
}

async function passes() {
  if (rest[0] && !(await view<Machine | null>('get_machine', { machine_id: rest[0] }))) throw new Error(`no machine called ${rest[0]}; try: gatepass machines`);
  const list = rest[0]
    ? await view<Pass[]>('list_passes', { machine_id: rest[0] })
    : await view<Pass[]>('list_recent_passes', {});
  if (opt.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.log('no passes yet');
  table([
    ['SERIAL', 'MACHINE', 'BUYER', 'MIN', 'PRICE', 'VALID UNTIL (UTC)', 'STATE'],
    ...list.map((p) => [String(p.serial), p.machine_id, p.buyer, String(p.minutes), `${fromYocto(p.paid)} NEAR`, iso(p.valid_before), passState(p)]),
  ]);
}

async function hostSetup() {
  const id = rest[0];
  if (!id) throw new Error('usage: gatepass host-setup <machine> [--write <file>]');
  const machine = await view<Machine | null>('get_machine', { machine_id: id });
  if (!machine) throw new Error(`no machine called ${id}; try: gatepass machines`);
  const ca = machine.ca_public_key;
  if (!ca) throw new Error(`${id} has no CA key yet; call refresh_ca_key for it on the contract`);
  if (opt.write) {
    fs.mkdirSync(path.dirname(path.resolve(opt.write)), { recursive: true });
    fs.writeFileSync(opt.write, `${ca}\n`);
    say(`wrote the CA public key of ${id} to ${opt.write}`);
    return;
  }
  console.log(`# Gatepass host setup for machine ${id} on contract ${contractId()}
#
# 1. Save this line as /etc/ssh/gatepass_ca.pub. It is this machine's own
#    certificate authority key. Nobody holds its private half: NEAR Chain
#    Signatures signs with it only when the contract asks, and the contract
#    asks only after someone has paid for a pass on ${id}.
${ca}

# 2. Use host/sshd_config from this repo as your sshd configuration (or merge
#    its lines into yours), pointing TrustedUserCAKeys at the file from step 1.
#    The lines that matter:
TrustedUserCAKeys /etc/ssh/gatepass_ca.pub
AuthorizedKeysFile none
PasswordAuthentication no
DisableForwarding yes
AuthorizedPrincipalsCommand /usr/local/bin/gatepass-principals %u %t %k
AuthorizedPrincipalsCommandUser root

# 3. Install these scripts from host/ into /usr/local/bin, owned by root,
#    mode 0755:
#      gatepass-session     forced as the login command of every pass; ends
#                           the session when the paid time is up
#      gatepass-principals  run by sshd as root at login; records the deadline
#      gatepass-reaper      run it as a root service (GATEPASS_USER=${machine.login_user});
#                           it enforces the deadline even if the renter stops
#                           the session wrapper
#      gatepass-wipe        erases the renter's files and processes between passes
#
# 4. Create the login user "${machine.login_user}" (the one registered for ${id}), then
#    reload sshd. host/Dockerfile, host/entrypoint.sh and docker-compose.yml
#    show a complete, sandboxed setup (read-only system, resource limits).
#
# 5. Publish the machine's SSH host key so renters accept only this machine:
#      gatepass set-host-key ${id} /etc/ssh/ssh_host_ed25519_key.pub`);
}

async function register() {
  const id = rest[0];
  if (!id || !opt.host || !opt.user || !opt.price) throw new Error('usage: gatepass register <id> --host H --port P --user U --price <NEAR per minute>');
  const account = await signer();
  const fee = (await view<{ machine_storage_fee: string }>('get_config', {})).machine_storage_fee;
  const r = await call<Machine>(account, contractId(), 'register_machine', {
    id, host: opt.host, port: Number(opt.port ?? '22'), login_user: opt.user, price_per_minute: toYocto(opt.price).toString(),
  }, { deposit: BigInt(fee) });
  if (opt.json) return console.log(JSON.stringify({ ...r.value, tx: r.txHash }, null, 2));
  console.log(`registered ${r.value.id}, owned by ${r.value.owner}, at ${fromYocto(r.value.price_per_minute)} NEAR/min (storage fee ${fromYocto(fee)} NEAR)`);
  console.log(`  CA key: ${r.value.ca_public_key}`);
  console.log(`  tx:     ${r.explorerUrl}`);
}

async function withdraw() {
  const id = rest[0];
  if (!id) throw new Error('usage: gatepass withdraw <machine>');
  const before = await view<Machine | null>('get_machine', { machine_id: id });
  if (!before) throw new Error(`no machine called ${id}`);
  const account = await signer();
  const r = await call(account, contractId(), 'withdraw', { machine_id: id });
  if (opt.json) return console.log(JSON.stringify({ machine_id: id, withdrawn: before.earnings, to: account.accountId, tx: r.txHash }, null, 2));
  console.log(`withdrew ${fromYocto(before.earnings)} NEAR from ${id} to ${account.accountId}`);
  console.log(`  tx: ${r.explorerUrl}`);
}

/** Owner: publish the machine's SSH host key so renters can pin it. */
async function setHostKey() {
  const [id, ...keyParts] = rest;
  let key = keyParts.join(' ');
  if (key && fs.existsSync(key)) key = fs.readFileSync(key, 'utf8').trim();
  if (!id || !key) throw new Error('usage: gatepass set-host-key <machine> "<ssh-ed25519 AAAA...>"  (or a path to the .pub file)');
  const r = await call(await signer(), contractId(), 'set_host_key', { machine_id: id, host_key: key });
  if (opt.json) return console.log(JSON.stringify({ machine_id: id, host_key: key, tx: r.txHash }, null, 2));
  console.log(`host key of ${id} published; renters will accept only this key`);
  console.log(`  tx: ${r.explorerUrl}`);
}

/** Re-read a machine's CA key from the MPC contract (needed only if registration could not fetch it). */
async function refreshCa() {
  const id = rest[0];
  if (!id) throw new Error('usage: gatepass refresh-ca <machine>');
  const r = await call<Machine>(await signer(), contractId(), 'refresh_ca_key', { machine_id: id });
  console.log(`CA key of ${id}: ${r.value.ca_public_key}`);
  console.log(`  tx: ${r.explorerUrl}`);
}

function help() {
  const s = settings();
  console.log(`gatepass: pay on NEAR, get an SSH pass for exactly the minutes you paid for

  gatepass machines                         list machines and prices
  gatepass rent <machine> --minutes N       pay, receive a pass, and log in
           [--no-ssh] [--json] [-- command]   (or run one command)
  gatepass ssh <serial> [-- command]        log in again with a saved pass
  gatepass passes [machine]                 passes issued, newest first
  gatepass host-setup <machine> [--write F] the machine's CA key and sshd lines
  gatepass register <id> --host H --port P --user U --price <NEAR/min>
  gatepass withdraw <machine>               owner: collect earnings
  gatepass set-host-key <machine> <key>     owner: publish the machine's SSH host key
  gatepass refresh-ca <machine>             re-read a machine's CA key from the MPC

contract: ${s.contractId ?? '(set GATEPASS_CONTRACT in .env)'}   network: ${s.networkId}   account: ${s.accountId ?? '(none)'}`);
}

const commands: Record<string, () => Promise<void> | void> = {
  machines, rent, ssh, passes, 'host-setup': hostSetup, register, withdraw, 'set-host-key': setHostKey, 'refresh-ca': refreshCa, help,
};

try {
  if (!command || opt.help || !commands[command]) {
    help();
    if (command && !commands[command] && !opt.help) process.exitCode = 2;
  } else {
    await commands[command]();
  }
} catch (err) {
  console.error(`gatepass: ${explain(err)}`);
  process.exitCode = 1;
}
