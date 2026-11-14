#!/usr/bin/env node
// Gatepass agent: an AI agent with a NEAR wallet and a budget, and no machine.
//
// Give it a task. It looks at the machines for rent, decides whether and what
// to rent and for how long, pays, logs in with the pass it receives, runs the
// commands it needs, and reports back with what it spent. Nobody creates an
// account for it or hands it a key.
//
//   node agent/agent.ts "How many CPU cores and how much memory does a rented box have?"
//        [--budget 0.1] [--machines id1,id2] [--owners a.testnet] [--max-steps 12]
//
// --machines and --owners are allow-lists: the agent only sees machines it has
// reason to trust. (The public testnet registry also lists other people's
// localhost demo machines, which nobody else can reach.)
//
// The model is reached through any OpenAI-compatible chat API with tool
// calling. Set in .env (or the environment):
//
//   AGENT_LLM_API_KEY    key for the endpoint
//   AGENT_LLM_BASE_URL   default https://cloud-api.near.ai/v1 (NEAR AI Cloud)
//   AGENT_LLM_MODEL      a model that supports tool calling
//                        (default z-ai/glm-5.3-flash, which runs in a TEE there)
//
// With no key set it falls back to a fixed rule (cheapest open machine within
// budget, one minute, run --command), so the flow can be reproduced without
// any model. The fallback makes no decisions of its own and says so.
//
// The budget is enforced here in code, not by the model: a rent that would
// exceed it is refused before any transaction is sent.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { ROOT, fromYocto, loadEnv, settings, toYocto, view } from '../cli/near.ts';

const run = promisify(execFile);
const CLI = path.join(ROOT, 'cli', 'gatepass.ts');

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    budget: { type: 'string', default: '0.1' },
    owners: { type: 'string' },
    machines: { type: 'string' },
    command: { type: 'string' },
    'max-steps': { type: 'string', default: '12' },
  },
});
loadEnv();
const task = positionals.join(' ').trim();
const budget = toYocto(opt.budget!);
const owners = opt.owners ? opt.owners.split(',').map((s) => s.trim()) : null;
const allowed = opt.machines ? opt.machines.split(',').map((s) => s.trim()) : null;
let spent = 0n;
const passes = new Map<number, { machine_id: string; valid_before: number; total: string; tx: string | null }>();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const clip = (s: string, n = 3000) => (s.length > n ? `${s.slice(0, n)}\n...[${s.length - n} more characters cut]` : s);

async function cli(args: string[], timeoutMs = 180_000) {
  try {
    const r = await run(process.execPath, [CLI, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err: any) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message) };
  }
}

// ---------- tools: what the agent can do ----------

interface Machine { id: string; owner: string; host: string; port: number; login_user: string; price_per_minute: string; active: boolean; ca_public_key: string | null; }

const tools = {
  async list_machines() {
    const all = await view<Machine[]>('list_machines', {});
    return all
      .filter((m) => m.active && m.ca_public_key && (!owners || owners.includes(m.owner)) && (!allowed || allowed.includes(m.id)))
      .map((m) => ({ machine_id: m.id, owner: m.owner, price_per_minute_near: fromYocto(m.price_per_minute), connect: `${m.login_user}@${m.host}:${m.port}` }));
  },

  async get_quote({ machine_id, minutes }: { machine_id: string; minutes: number }) {
    const q = await view<{ price: string; storage_fee: string; total: string }>('quote', { machine_id, minutes });
    return { machine_id, minutes, total_near: fromYocto(q.total), price_near: fromYocto(q.price), storage_fee_near: fromYocto(q.storage_fee), budget_left_near: fromYocto(budget - spent), within_budget: spent + BigInt(q.total) <= budget };
  },

  async rent_machine({ machine_id, minutes }: { machine_id: string; minutes: number }) {
    if (!/^[a-z0-9_-]{1,32}$/.test(String(machine_id)) || !Number.isInteger(minutes) || minutes < 1) return { error: 'machine_id must be a listed machine and minutes a whole number of at least 1' };
    if ((owners || allowed) && !(await tools.list_machines()).some((m) => m.machine_id === machine_id)) return { error: `${machine_id} is not on the allowed list; call list_machines` };
    const q = await view<{ total: string }>('quote', { machine_id, minutes });
    if (spent + BigInt(q.total) > budget) return { error: `refused: this costs ${fromYocto(q.total)} NEAR but only ${fromYocto(budget - spent)} NEAR of the budget is left` };
    const r = await cli(['rent', machine_id, '--minutes', String(minutes), '--no-ssh', '--json']);
    if (r.code !== 0) return { error: clip(r.stderr.trim(), 600) };
    const pass = JSON.parse(r.stdout);
    spent += BigInt(q.total);
    passes.set(pass.serial, { machine_id, valid_before: pass.valid_before, total: q.total, tx: pass.tx });
    return { pass_serial: pass.serial, machine_id, valid_until_unix: pass.valid_before, seconds_left: pass.valid_before - Math.floor(Date.now() / 1000), paid_near: fromYocto(q.total), budget_left_near: fromYocto(budget - spent), note: 'The session is cut off at valid_until. Use run_command with this pass_serial.' };
  },

  async run_command({ pass_serial, command }: { pass_serial: number; command: string }) {
    const pass = passes.get(Number(pass_serial));
    if (!pass) return { error: 'unknown pass_serial; rent a machine first' };
    const left = pass.valid_before - Math.floor(Date.now() / 1000);
    if (left <= 0) return { error: 'this pass has expired; rent again if more time is needed' };
    const r = await cli(['ssh', String(pass_serial), '--', String(command)], (left + 15) * 1000);
    // The CLI and the host wrapper narrate on stderr; keep only what the command itself printed there.
    const stderr = r.stderr.split('\n').filter((l) => !/^(pass #\d+|\$ ssh |gatepass: session ends in)/.test(l)).join('\n').trim();
    return { exit_code: r.code, stdout: clip(r.stdout.trim()), stderr: clip(stderr, 1000), seconds_left: Math.max(0, pass.valid_before - Math.floor(Date.now() / 1000)), ...(r.code === 124 ? { note: 'exit code 124: the paid time ran out and the host ended the session' } : {}) };
  },
};

const toolSpecs = [
  { name: 'list_machines', description: 'List machines that can be rented right now, with their price per minute in NEAR.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_quote', description: 'Get the total cost in NEAR of renting a machine for a number of minutes, and whether it fits the remaining budget.', parameters: { type: 'object', properties: { machine_id: { type: 'string' }, minutes: { type: 'integer', minimum: 1, maximum: 240 } }, required: ['machine_id', 'minutes'], additionalProperties: false } },
  { name: 'rent_machine', description: 'Pay from your NEAR wallet for a number of minutes on a machine. Returns a pass_serial. The paid time starts immediately and the session is cut off when it ends.', parameters: { type: 'object', properties: { machine_id: { type: 'string' }, minutes: { type: 'integer', minimum: 1, maximum: 240 } }, required: ['machine_id', 'minutes'], additionalProperties: false } },
  { name: 'run_command', description: 'Run one shell command (sh) on a machine you have rented, using its pass_serial. Returns exit code, stdout and stderr. The machine is a minimal Linux box.', parameters: { type: 'object', properties: { pass_serial: { type: 'integer' }, command: { type: 'string' } }, required: ['pass_serial', 'command'], additionalProperties: false } },
].map((f) => ({ type: 'function' as const, function: f }));

async function callTool(name: string, args: any) {
  console.log(`${bold('tool')}   ${name}(${JSON.stringify(args)})`);
  let result: unknown;
  try {
    result = (tools as any)[name] ? await (tools as any)[name](args ?? {}) : { error: `no such tool: ${name}` };
  } catch (err: any) {
    result = { error: String(err?.message ?? err).slice(0, 400) };
  }
  console.log(dim(`       -> ${clip(JSON.stringify(result), 700)}`));
  return result;
}

// ---------- the model loop ----------

const SYSTEM = `You are an autonomous agent with your own NEAR wallet. You have no computer of your own to run commands on.
You can rent time on remote Linux machines by the minute with the tools provided: you pay, you get a pass, and the pass lets you run shell commands on that machine until the paid minutes run out. Nobody has to approve you or give you an account.

Rules you set for yourself:
- First decide whether the task needs a machine at all. If it does not, answer directly and spend nothing.
- Your budget is ${fromYocto(budget)} NEAR in total. Spend as little as the task needs: prefer the cheapest suitable machine and the fewest minutes. A rent that would exceed the budget is refused.
- Paid time starts when you rent and the session is cut off when it ends, so rent only when you know what you will run, and run it promptly. Chain related commands into one run_command call.
- Do not rent a second time unless the first pass really was not enough.
- When the task is done, reply with a short plain-text answer: the result, which machine you rented and for how long, and what it cost. Do not call a tool in that final reply.`;

const LLM_BASE = (process.env.AGENT_LLM_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
const LLM_MODEL = process.env.AGENT_LLM_MODEL || 'z-ai/glm-5.3-flash';

/** Tokens the model endpoint reported, so a run's model cost can be worked out. */
const usage = { calls: 0, input: 0, output: 0 };

async function chat(messages: any[]): Promise<any> {
  const base = LLM_BASE;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.AGENT_LLM_API_KEY}` },
    // No temperature or token limits: some hosted reasoning models reject them.
    body: JSON.stringify({ model: LLM_MODEL, messages, tools: toolSpecs, tool_choice: 'auto' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`model endpoint answered ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  usage.calls += 1;
  usage.input += body.usage?.prompt_tokens ?? 0;
  usage.output += body.usage?.completion_tokens ?? 0;
  return body.choices[0].message;
}

async function withModel(): Promise<string> {
  console.log(dim(`model: ${LLM_MODEL} at ${LLM_BASE}`));
  const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }];
  for (let step = 0; step < Number(opt['max-steps']); step++) {
    const reply = await chat(messages);
    messages.push(reply);
    const said = String(reply.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!reply.tool_calls?.length) return said;
    if (said) console.log(`${bold('agent')}  ${said}`);
    for (const tc of reply.tool_calls) {
      let args: any = {};
      try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function.arguments; } catch { /* leave empty; the tool reports the problem */ }
      const result = await callTool(tc.function.name, args);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return '(stopped: step limit reached before the agent finished)';
}

// ---------- no model: a fixed rule, clearly labelled ----------

async function withoutModel(): Promise<string> {
  console.log(dim('no AGENT_LLM_API_KEY set: using the fixed rule (cheapest open machine within budget, 1 minute). No model is deciding anything.'));
  const command = opt.command;
  if (!command) throw new Error('Without a model, say what to run: --command "nproc; free -m"');
  const machines = (await callTool('list_machines', {})) as any[];
  if (!machines.length) return 'No machine is open for rent.';
  const cheapest = machines.sort((a, b) => Number(a.price_per_minute_near) - Number(b.price_per_minute_near))[0];
  const rented: any = await callTool('rent_machine', { machine_id: cheapest.machine_id, minutes: 1 });
  if (rented.error) return `Could not rent: ${rented.error}`;
  const out: any = await callTool('run_command', { pass_serial: rented.pass_serial, command });
  return `Ran on ${cheapest.machine_id} for 1 minute (exit code ${out.exit_code}):\n${out.stdout || out.stderr || out.error}`;
}

// ---------- main ----------

try {
  if (!task && !opt.command) throw new Error('usage: node agent/agent.ts "<task>" [--budget 0.1] [--machines id1,id2] [--owners a.testnet] [--command "..."]');
  const s = settings();
  console.log(`${bold('task')}   ${task || `(run) ${opt.command}`}`);
  console.log(dim(`wallet: ${s.accountId}   budget: ${fromYocto(budget)} NEAR   contract: ${s.contractId}${owners ? `   owners allowed: ${owners.join(', ')}` : ''}${allowed ? `   machines allowed: ${allowed.join(', ')}` : ''}`));

  const answer = process.env.AGENT_LLM_API_KEY ? await withModel() : await withoutModel();

  console.log(`\n${bold('answer')}\n${answer}\n`);
  console.log(bold('spent'));
  if (passes.size === 0) console.log('  nothing: no machine was rented');
  for (const [serial, p] of passes) {
    console.log(`  pass #${serial} on ${p.machine_id}: ${fromYocto(p.total)} NEAR${p.tx ? `   ${s.explorer}/txns/${p.tx}` : ''}`);
  }
  console.log(`  total ${fromYocto(spent)} of ${fromYocto(budget)} NEAR budget (plus network fees)`);
  if (usage.calls) console.log(dim(`  model: ${usage.calls} calls, ${usage.input} input + ${usage.output} output tokens (${LLM_MODEL})`));
} catch (err: any) {
  console.error(`agent: ${err?.message ?? err}`);
  process.exitCode = 1;
}
