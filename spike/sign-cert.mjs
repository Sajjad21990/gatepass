#!/usr/bin/env node
// Milestone 1 spike: build an OpenSSH user certificate by hand and have it
// signed either by a local stand-in CA key (--ca local) or by NEAR Chain
// Signatures on testnet (--ca mpc).
//
// Layout follows OpenSSH PROTOCOL.certkeys (ssh-ed25519-cert-v01@openssh.com).
// The CA signature is plain Ed25519 over fields 1..13 as serialised.
//
// Usage:
//   node sign-cert.mjs --ca local [--minutes 5] [--user renter]
//   node sign-cert.mjs --ca mpc   [--minutes 5] [--user renter]
//
// Writes (all git-ignored):
//   out/key, out/key.pub      throwaway renter key
//   out/key-cert.pub          the certificate
//   ../host/ca/gatepass_ca.pub  CA public key that the Docker sshd trusts

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const CA_PUB_FILE = path.join(HERE, '..', 'host', 'ca', 'gatepass_ca.pub');
const CERT_TYPE = 'ssh-ed25519-cert-v01@openssh.com';

// ---------- args and env ----------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function loadEnv() {
  for (const file of [path.join(HERE, '..', '.env'), path.join(HERE, '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ---------- SSH wire encoding ----------

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = (v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'); return Buffer.concat([u32(b.length), b]); };

/** Name/data pairs, sorted by name. Non-empty data is itself wrapped as a string. */
function packOptions(options) {
  return Buffer.concat(
    Object.keys(options).sort().map((name) => {
      const value = options[name];
      const data = value === '' ? Buffer.alloc(0) : str(value);
      return Buffer.concat([str(name), str(data)]);
    }),
  );
}

/** Fields 1..13: exactly the bytes the CA signs. */
export function buildCertBody({ nonce, renterPk, serial, keyId, principals, validAfter, validBefore, criticalOptions = {}, extensions = {}, caPk }) {
  if (renterPk.length !== 32 || caPk.length !== 32) throw new Error('Ed25519 public keys must be 32 bytes');
  return Buffer.concat([
    str(CERT_TYPE),                                      // 1  type string
    str(nonce),                                          // 2  nonce
    str(renterPk),                                       // 3  renter public key
    u64(serial),                                         // 4  serial
    u32(1),                                              // 5  type: 1 = user cert
    str(keyId),                                          // 6  key id
    str(Buffer.concat(principals.map((p) => str(p)))),   // 7  valid principals
    u64(validAfter),                                     // 8  valid after
    u64(validBefore),                                    // 9  valid before
    str(packOptions(criticalOptions)),                   // 10 critical options
    str(packOptions(extensions)),                        // 11 extensions
    str(Buffer.alloc(0)),                                // 12 reserved
    str(Buffer.concat([str('ssh-ed25519'), str(caPk)])), // 13 signature key
  ]);
}

/** Field 14 appended, as a one-line OpenSSH certificate file. */
export function finishCert(body, signature, comment) {
  if (signature.length !== 64) throw new Error(`Ed25519 signature must be 64 bytes, got ${signature.length}`);
  const sigBlob = Buffer.concat([str('ssh-ed25519'), str(signature)]);
  return `${CERT_TYPE} ${Buffer.concat([body, str(sigBlob)]).toString('base64')} ${comment}\n`;
}

const sshPubLine = (pk, comment) =>
  `ssh-ed25519 ${Buffer.concat([str('ssh-ed25519'), str(pk)]).toString('base64')} ${comment}\n`;

/** Pull the raw 32-byte key out of an "ssh-ed25519 AAAA..." line. */
function parseSshEd25519(line) {
  const blob = Buffer.from(line.trim().split(/\s+/)[1], 'base64');
  const typeLen = blob.readUInt32BE(0);
  if (blob.subarray(4, 4 + typeLen).toString() !== 'ssh-ed25519') throw new Error('not an ssh-ed25519 key');
  const pkLen = blob.readUInt32BE(4 + typeLen);
  return blob.subarray(8 + typeLen, 8 + typeLen + pkLen);
}

// ---------- Ed25519 helpers ----------

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const rawToPublicKey = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
const publicKeyToRaw = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32);
const verifyEd25519 = (msg, sig, rawPk) => crypto.verify(null, msg, rawToPublicKey(rawPk), sig);

function base58Decode(s) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`bad base58 character ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const leadingZeros = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, 'hex')]);
}

// ---------- CA backends ----------

/** Stand-in CA: an Ed25519 key on disk. Proves the certificate bytes are right. */
function localCa() {
  const file = path.join(OUT, 'local_ca.pem');
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  return {
    name: 'local stand-in CA',
    publicKey: async () => publicKeyToRaw(crypto.createPublicKey(privateKey)),
    sign: async (body) => crypto.sign(null, body, privateKey),
  };
}

/** Real CA: NEAR Chain Signatures. The key is derived from (calling account, path). */
async function mpcCa() {
  const { connect, keyStores, KeyPair, providers } = await import('near-api-js');
  const accountId = process.env.NEAR_ACCOUNT_ID;
  const privateKey = process.env.NEAR_PRIVATE_KEY;
  const networkId = process.env.NEAR_NETWORK || 'testnet';
  const nodeUrl = process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com';
  const mpcContract = process.env.MPC_CONTRACT || 'v1.signer-prod.testnet';
  const caPath = process.env.CA_PATH || 'gatepass-ca-v1';
  const domainId = Number(process.env.MPC_ED25519_DOMAIN_ID || 1);
  if (networkId !== 'testnet') throw new Error('This spike only runs on testnet.');
  if (!accountId || !privateKey) throw new Error('Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in .env (see .env.example).');

  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(networkId, accountId, KeyPair.fromString(privateKey));
  const near = await connect({ networkId, nodeUrl, keyStore });
  const account = await near.account(accountId);

  return {
    name: `${mpcContract} (caller ${accountId}, path ${caPath})`,
    publicKey: async () => {
      const key = await account.viewFunction({
        contractId: mpcContract,
        methodName: 'derived_public_key',
        args: { path: caPath, predecessor: accountId, domain_id: domainId },
      });
      if (typeof key !== 'string' || !key.startsWith('ed25519:')) throw new Error(`unexpected derived key: ${JSON.stringify(key)}`);
      return base58Decode(key.slice('ed25519:'.length));
    },
    sign: async (body) => {
      const started = Date.now();
      const outcome = await account.functionCall({
        contractId: mpcContract,
        methodName: 'sign',
        args: { request: { path: caPath, domain_id: domainId, payload_v2: { Eddsa: body.toString('hex') } } },
        gas: 300_000_000_000_000n,
        attachedDeposit: 1n,
      });
      const txHash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id;
      const gasBurnt = [outcome.transaction_outcome, ...outcome.receipts_outcome]
        .reduce((sum, o) => sum + BigInt(o.outcome.gas_burnt), 0n);
      console.log(`  sign tx:     ${txHash}`);
      console.log(`  explorer:    https://testnet.nearblocks.io/txns/${txHash}`);
      console.log(`  took:        ${((Date.now() - started) / 1000).toFixed(1)} s, gas burnt ${(Number(gasBurnt) / 1e12).toFixed(1)} Tgas`);
      const result = providers.getTransactionLastResult(outcome);
      if (result?.scheme !== 'Ed25519' || !Array.isArray(result.signature)) {
        throw new Error(`unexpected sign result: ${JSON.stringify(result)}`);
      }
      return Buffer.from(result.signature);
    },
  };
}

// ---------- main ----------

async function main() {
  loadEnv();
  const mode = arg('ca', 'local');
  const minutes = Number(arg('minutes', '5'));
  const user = arg('user', 'renter');
  fs.mkdirSync(OUT, { recursive: true });

  const ca = mode === 'mpc' ? await mpcCa() : localCa();
  console.log(`CA: ${ca.name}`);

  // Throwaway renter key, made by ssh-keygen so ssh can use it directly.
  const keyFile = path.join(OUT, 'key');
  for (const f of [keyFile, `${keyFile}.pub`, `${keyFile}-cert.pub`]) fs.rmSync(f, { force: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'gatepass-renter', '-f', keyFile]);
  const renterPk = parseSshEd25519(fs.readFileSync(`${keyFile}.pub`, 'utf8'));

  const caPk = await ca.publicKey();
  const caLine = sshPubLine(caPk, 'gatepass-ca');
  fs.mkdirSync(path.dirname(CA_PUB_FILE), { recursive: true });
  fs.writeFileSync(CA_PUB_FILE, caLine);
  console.log(`  CA key:      ${caLine.trim()}`);

  const now = Math.floor(Date.now() / 1000);
  const serial = now; // the contract will own this counter later
  const body = buildCertBody({
    nonce: crypto.randomBytes(32),
    renterPk,
    serial,
    keyId: `gatepass:spike:${process.env.NEAR_ACCOUNT_ID || 'local'}:${serial}`,
    principals: [user],
    validAfter: now - 60,
    validBefore: now + minutes * 60,
    extensions: { 'permit-pty': '' },
    caPk,
  });
  console.log(`  body:        ${body.length} bytes to sign`);

  const signature = await ca.sign(body);
  if (!verifyEd25519(body, signature, caPk)) {
    throw new Error('Signature does NOT verify as plain Ed25519 against the CA public key. sshd would reject this certificate.');
  }
  console.log('  signature:   verifies as plain Ed25519 against the CA key');

  fs.writeFileSync(`${keyFile}-cert.pub`, finishCert(body, signature, 'gatepass-renter'));
  console.log(`  wrote:       ${path.relative(process.cwd(), `${keyFile}-cert.pub`)}`);
  console.log(`  wrote:       ${path.relative(process.cwd(), CA_PUB_FILE)}`);
  console.log('\nNext: ./check-and-login.sh');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    if (err.type || err.context) console.error(JSON.stringify({ type: err.type, context: err.context }, null, 2));
    process.exit(1);
  });
}
