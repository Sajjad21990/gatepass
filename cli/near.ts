// Shared NEAR plumbing for the CLI and scripts. Testnet only.
// Configuration comes from the environment or from .env in the repo root.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, keyStores, KeyPair, providers, utils } from 'near-api-js';

// Keep near-api-js from dumping every receipt log to the console.
if (!process.env.GATEPASS_DEBUG) utils.Logger.overrideLogger(undefined as any);

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TGAS = 1_000_000_000_000n;

export function loadEnv(): void {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export interface Settings {
  networkId: string;
  nodeUrl: string;
  accountId?: string;
  privateKey?: string;
  contractId?: string;
  mpcContract: string;
  explorer: string;
}

export function settings(): Settings {
  loadEnv();
  const networkId = process.env.NEAR_NETWORK || 'testnet';
  if (networkId !== 'testnet') throw new Error('Gatepass is testnet only. Set NEAR_NETWORK=testnet.');
  return {
    networkId,
    nodeUrl: process.env.NEAR_RPC_URL || 'https://test.rpc.fastnear.com',
    accountId: process.env.NEAR_ACCOUNT_ID,
    privateKey: process.env.NEAR_PRIVATE_KEY,
    contractId: process.env.GATEPASS_CONTRACT,
    mpcContract: process.env.MPC_CONTRACT || 'v1.signer-prod.testnet',
    explorer: 'https://testnet.nearblocks.io',
  };
}

/** A read-only connection: enough for views, needs no key. */
export async function viewer(s = settings()) {
  const near = await connect({ networkId: s.networkId, nodeUrl: s.nodeUrl, keyStore: new keyStores.InMemoryKeyStore() });
  return near.account(s.accountId || 'anyone.testnet');
}

/** A signing connection for `accountId` (defaults to NEAR_ACCOUNT_ID), using NEAR_PRIVATE_KEY. */
export async function signer(accountId?: string, s = settings()) {
  const id = accountId || s.accountId;
  if (!id || !s.privateKey) throw new Error('Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in .env (see .env.example).');
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(s.networkId, id, KeyPair.fromString(s.privateKey as any));
  const near = await connect({ networkId: s.networkId, nodeUrl: s.nodeUrl, keyStore });
  return near.account(id);
}

export function contractId(s = settings()): string {
  if (!s.contractId) throw new Error('Set GATEPASS_CONTRACT in .env (the deployed Gatepass contract account).');
  return s.contractId;
}

export async function view<T = any>(method: string, args: object = {}, s = settings()): Promise<T> {
  const account = await viewer(s);
  return account.viewFunction({ contractId: contractId(s), methodName: method, args });
}

export interface CallResult<T> {
  value: T;
  txHash: string;
  explorerUrl: string;
  logs: string[];
}

export async function call<T = any>(
  account: Awaited<ReturnType<typeof signer>>,
  target: string,
  method: string,
  args: object,
  opts: { deposit?: bigint; gas?: bigint } = {},
): Promise<CallResult<T>> {
  const outcome: any = await account.functionCall({
    contractId: target,
    methodName: method,
    args,
    gas: opts.gas ?? 100n * TGAS,
    attachedDeposit: opts.deposit ?? 0n,
  });
  const txHash: string = outcome.transaction?.hash ?? outcome.transaction_outcome?.id;
  return {
    value: providers.getTransactionLastResult(outcome) as T,
    txHash,
    explorerUrl: `${settings().explorer}/txns/${txHash}`,
    logs: outcome.receipts_outcome.flatMap((r: any) => r.outcome.logs as string[]),
  };
}

export const toYocto = (near: string): bigint => {
  const y = utils.format.parseNearAmount(near);
  if (!y) throw new Error(`not a NEAR amount: ${near}`);
  return BigInt(y);
};

export const fromYocto = (yocto: string | bigint): string => utils.format.formatNearAmount(yocto.toString(), 5);

/** Turn a near-api-js failure into the contract's own message where there is one. */
export function explain(err: any): string {
  const text = String(err?.message ?? err);
  const panic = text.match(/Smart contract panicked: (.*?)("|$)/s);
  if (panic) return panic[1];
  try {
    const kind = err?.kind ?? JSON.parse(text);
    const msg = JSON.stringify(kind).match(/Smart contract panicked: ([^"\\]+)/);
    if (msg) return msg[1];
  } catch { /* not JSON */ }
  return text;
}
