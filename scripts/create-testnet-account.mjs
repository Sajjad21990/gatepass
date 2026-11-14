#!/usr/bin/env node
// Create a throwaway, faucet-funded NEAR TESTNET account and write it to an env
// file (git-ignored). Refuses to overwrite an existing file. The private key is
// never printed.
//
// Usage: node scripts/create-testnet-account.mjs [--env .env.renter] [account-name.testnet]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const envFlag = args.indexOf('--env');
const envName = envFlag > -1 ? args.splice(envFlag, 2)[1] : '.env';
if (!/^\.env(\.[a-z0-9_-]+)?$/.test(envName) || envName === '.env.example') throw new Error('--env must be .env or .env.<name>');
const ENV_FILE = path.join(HERE, '..', envName);
const HELPER = 'https://helper.testnet.near.org/account';
const RPCS = ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'];

if (fs.existsSync(ENV_FILE)) {
  console.error(`${envName} already exists; not overwriting it.`);
  process.exit(1);
}

const accountId = args[0] || `gp-${crypto.randomBytes(5).toString('hex')}.testnet`;
if (!accountId.endsWith('.testnet')) throw new Error('testnet accounts only');

const keyPair = KeyPair.fromRandom('ed25519');
const res = await fetch(HELPER, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Faucet refused (${res.status}): ${text.slice(0, 400)}`);
  process.exit(1);
}

const example = fs.readFileSync(path.join(HERE, '..', '.env.example'), 'utf8');
fs.writeFileSync(
  ENV_FILE,
  example
    .replace(/^NEAR_ACCOUNT_ID=.*$/m, `NEAR_ACCOUNT_ID=${accountId}`)
    .replace(/^NEAR_PRIVATE_KEY=.*$/m, `NEAR_PRIVATE_KEY=${keyPair.toString()}`),
  { mode: 0o600 },
);

// Confirm the account is really there and funded.
for (let i = 0; i < 12; i++) {
  const r = await fetch(RPCS[i % RPCS.length], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: accountId } }),
  }).then((x) => x.json()).catch(() => ({}));
  if (r.result) {
    console.log(`created ${accountId} with ${(Number(BigInt(r.result.amount) / 10n ** 21n) / 1000).toFixed(3)} NEAR; key written to ${envName}`);
    process.exit(0);
  }
  await new Promise((ok) => setTimeout(ok, 1500));
}
console.error(`Faucet said OK but ${accountId} is not visible on the RPC yet. ${envName} was written.`);
process.exit(1);
