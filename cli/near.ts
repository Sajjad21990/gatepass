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

/** Load GATEPASS_ENV_FILE (if set) and then .env; values already set win. */
export function loadEnv(): void {
  const files = [process.env.GATEPASS_ENV_FILE && path.resolve(ROOT, process.env.GATEPASS_ENV_FILE), path.join(ROOT, '.env')];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] !== '' && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// Public testnet RPC endpoints rate-limit freely, so there are several and the
// client moves on to the next when one refuses. Set NEAR_RPC_URL (one URL or a
// comma-separated list) to use your own.
const DEFAULT_RPC_URLS = 'https://test.rpc.fastnear.com,https://near-testnet.drpc.org,https://rpc.testnet.near.org';

/** A provider that moves to the next endpoint when one is rate-limited or
 *  unreachable. Errors from the chain itself (a contract panic, a bad
 *  transaction) are passed straight through. A transaction is signed once and
 *  the same signed bytes are re-sent, so trying another endpoint cannot pay twice. */
function rpcProvider(s: Settings) {
  const list = s.rpcUrls.map((url) => new providers.JsonRpcProvider({ url }, { retries: 2, backoff: 2, wait: 300 }));
  let current = 0;
  const unavailable = (e: any) => /\b429\b|rate limit|too many requests|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|\b50[234]\b/i.test(`${e?.cause ?? ''} ${e?.message ?? e}`);
  return new Proxy(list[0], {
    get(_target, prop) {
      const member = (list[current] as any)[prop];
      if (typeof member !== 'function') return member;
      return async (...args: unknown[]) => {
        let lastError: unknown;
        for (let attempt = 0; attempt < list.length; attempt++) {
          try {
            return await (list[current] as any)[prop](...args);
          } catch (err) {
            if (!unavailable(err)) throw err;
            lastError = err;
            current = (current + 1) % list.length;
          }
        }
        throw lastError;
      };
    },
  });
}

export interface Settings {
  networkId: string;
  /** RPC endpoints, tried in order; a failing one is skipped. */
  rpcUrls: string[];
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
    rpcUrls: (process.env.NEAR_RPC_URL || DEFAULT_RPC_URLS).split(',').map((u) => u.trim()).filter(Boolean),
    accountId: process.env.NEAR_ACCOUNT_ID,
    privateKey: process.env.NEAR_PRIVATE_KEY,
    contractId: process.env.GATEPASS_CONTRACT,
    mpcContract: process.env.MPC_CONTRACT || 'v1.signer-prod.testnet',
    explorer: 'https://testnet.nearblocks.io',
  };
}

/** A read-only connection: enough for views, needs no key. */
export async function viewer(s = settings()) {
  const near = await connect({ networkId: s.networkId, nodeUrl: s.rpcUrls[0], provider: rpcProvider(s), keyStore: new keyStores.InMemoryKeyStore() } as any);
  return near.account(s.accountId || 'anyone.testnet');
}

/** A signing connection for `accountId` (defaults to NEAR_ACCOUNT_ID), using NEAR_PRIVATE_KEY. */
export async function signer(accountId?: string, s = settings()) {
  const id = accountId || s.accountId;
  if (!id || !s.privateKey) throw new Error('Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in .env (see .env.example).');
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(s.networkId, id, KeyPair.fromString(s.privateKey as any));
  const near = await connect({ networkId: s.networkId, nodeUrl: s.rpcUrls[0], provider: rpcProvider(s), keyStore } as any);
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
  let outcome: any;
  try {
    outcome = await account.functionCall({
      contractId: target,
      methodName: method,
      args,
      gas: opts.gas ?? 100n * TGAS,
      attachedDeposit: opts.deposit ?? 0n,
    });
  } catch (err: any) {
    // Some endpoints give up waiting before a slow call (a Chain Signatures
    // request takes several seconds) has finished. The transaction was sent;
    // ask for its outcome instead of sending anything again.
    const sentHash: string | undefined = err?.context?.transactionHash;
    if (!sentHash || !/timeout/i.test(`${err?.type ?? ''} ${err?.message ?? ''}`)) throw err;
    outcome = await waitForOutcome(account, sentHash);
    if (!outcome) throw err;
  }
  const txHash: string = outcome.transaction?.hash ?? outcome.transaction_outcome?.id;
  return {
    value: providers.getTransactionLastResult(outcome) as T,
    txHash,
    explorerUrl: `${settings().explorer}/txns/${txHash}`,
    logs: outcome.receipts_outcome.flatMap((r: any) => r.outcome.logs as string[]),
  };
}

/** Poll for the final outcome of a transaction that has already been sent. */
async function waitForOutcome(account: Awaited<ReturnType<typeof signer>>, txHash: string): Promise<any | null> {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    try {
      const outcome: any = await (account.connection.provider as any).txStatus(txHash, account.accountId, 'EXECUTED_OPTIMISTIC');
      if (outcome?.status?.SuccessValue !== undefined || outcome?.status?.Failure) {
        if (outcome.status.Failure) throw Object.assign(new Error(JSON.stringify(outcome.status.Failure)), { final: true });
        return outcome;
      }
    } catch (err: any) {
      if (err?.final) throw err;
      // not there yet, or this endpoint timed out again: keep asking
    }
  }
  return null;
}

export const toYocto = (near: string): bigint => {
  const y = utils.format.parseNearAmount(near);
  if (!y) throw new Error(`not a NEAR amount: ${near}`);
  return BigInt(y);
};

export const fromYocto = (yocto: string | bigint): string => utils.format.formatNearAmount(yocto.toString(), 5);

/** Turn a near-api-js failure into the contract's own message where there is one. */
export function explain(err: any): string {
  const text = [String(err?.message ?? err), JSON.stringify(err?.kind ?? ''), JSON.stringify(err?.context ?? '')].join(' ');
  // Calls report "Smart contract panicked: <msg>"; views report GuestPanic { panic_msg: "<msg>" }.
  const panic = text.match(/Smart contract panicked: ((?:[^"\\]|\\.)*)/) ?? text.match(/panic_msg:? \\?"((?:[^"\\]|\\[^"])*)/);
  if (panic) return panic[1].replace(/\\+"/g, '"').replace(/\\n/g, ' ').trim();
  if (/\b429\b|rate limit/i.test(text)) return 'every configured RPC endpoint is rate-limiting right now; wait a minute, or set NEAR_RPC_URL to another testnet endpoint';
  return String(err?.message ?? err).split('\n')[0].slice(0, 400);
}
