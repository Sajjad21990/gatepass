#!/usr/bin/env node
// Deploy (or upgrade) the Gatepass contract on testnet.
//
//   cd contract && cargo near build non-reproducible-wasm && cd ..
//   node scripts/deploy.ts
//
// The contract account defaults to gatepass.<NEAR_ACCOUNT_ID> and is created
// on first run, controlled by the same key as NEAR_ACCOUNT_ID. Safe to re-run:
// it redeploys the code and leaves existing state alone.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, call, explain, settings, signer, toYocto } from '../cli/near.ts';

const WASM = path.join(ROOT, 'contract', 'target', 'near', 'gatepass.wasm');
const INITIAL_BALANCE = process.env.GATEPASS_INITIAL_BALANCE || '3.5'; // NEAR; covers storage for the code and state

async function main() {
  const s = settings();
  if (!s.accountId) throw new Error('Set NEAR_ACCOUNT_ID in .env');
  if (!fs.existsSync(WASM)) throw new Error(`Build the contract first: ${path.relative(ROOT, WASM)} is missing`);
  const target = s.contractId || `gatepass.${s.accountId}`;
  const parent = await signer(s.accountId, s);
  const contract = await signer(target, s);

  let exists = true;
  try { await contract.state(); } catch { exists = false; }
  if (!exists) {
    console.log(`creating ${target} with ${INITIAL_BALANCE} NEAR`);
    const publicKey = (await parent.connection.signer.getPublicKey(s.accountId, s.networkId)).toString();
    await parent.createAccount(target, publicKey, toYocto(INITIAL_BALANCE));
  }

  console.log(`deploying ${path.relative(ROOT, WASM)} to ${target}`);
  const deployed: any = await contract.deployContract(fs.readFileSync(WASM));
  console.log(`  deploy tx: ${s.explorer}/txns/${deployed.transaction.hash}`);

  let initialised = true;
  try { await contract.viewFunction({ contractId: target, methodName: 'get_config', args: {} }); } catch { initialised = false; }
  if (!initialised) {
    const init = await call(contract, target, 'new', { mpc_contract: s.mpcContract, ca_path: process.env.CA_PATH || 'gatepass-ca-v1', ca_domain_id: Number(process.env.MPC_ED25519_DOMAIN_ID || 1) });
    console.log(`  init tx:   ${init.explorerUrl}`);
  }

  console.log(`\ncontract: ${target}`);
  console.log('next: bin/gatepass register <id> --host H --port P --user U --price <NEAR per minute>');

  const envFile = path.join(ROOT, '.env');
  const env = fs.readFileSync(envFile, 'utf8');
  if (/^GATEPASS_CONTRACT=\s*$/m.test(env)) {
    fs.writeFileSync(envFile, env.replace(/^GATEPASS_CONTRACT=\s*$/m, `GATEPASS_CONTRACT=${target}`));
    console.log('wrote GATEPASS_CONTRACT to .env');
  } else if (!/^GATEPASS_CONTRACT=/m.test(env)) {
    fs.appendFileSync(envFile, `${env.endsWith('\n') ? '' : '\n'}GATEPASS_CONTRACT=${target}\n`);
    console.log('wrote GATEPASS_CONTRACT to .env');
  }
}

main().catch((err) => {
  console.error(`FAILED: ${explain(err)}`);
  process.exit(1);
});
