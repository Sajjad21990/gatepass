#!/usr/bin/env node
// Create a throwaway, faucet-funded NEAR TESTNET account and write it to ../.env
// (git-ignored). Refuses to touch an existing .env. The private key is never printed.
//
// Usage: node create-testnet-account.mjs [account-name.testnet]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(HERE, '..', '.env');
const HELPER = 'https://helper.testnet.near.org/account';
const RPC = 'https://test.rpc.fastnear.com';

if (fs.existsSync(ENV_FILE)) {
  console.error('.env already exists; not overwriting it.');
  process.exit(1);
}

const accountId = process.argv[2] || `gp-spike-${crypto.randomBytes(4).toString('hex')}.testnet`;
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
for (let i = 0; i < 10; i++) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: accountId } }),
  }).then((x) => x.json());
  if (r.result) {
    console.log(`created ${accountId} with ${(Number(BigInt(r.result.amount) / 10n ** 21n) / 1000).toFixed(3)} NEAR; key written to .env`);
    process.exit(0);
  }
  await new Promise((ok) => setTimeout(ok, 1500));
}
console.error(`Faucet said OK but ${accountId} is not visible on ${RPC} yet. .env was written.`);
process.exit(1);
