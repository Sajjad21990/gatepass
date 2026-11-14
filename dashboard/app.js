import defaults from './config.js';
import { formatAgo, formatClock, formatCountdown, formatNear, machineAvailability, passState, splitKey, sumYocto } from './format.js';

const REFRESH_MS = 5000;
const TICK_MS = 250;
const TIMEOUT_MS = 8000;
const PAGE = 50;
const ENDING_SECONDS = 30;

// ---------- config ----------

function readConfig() {
  const cfg = { ...defaults };
  const params = new URLSearchParams(location.search);
  const contract = params.get('contract');
  if (contract && /^[a-z0-9._-]{2,64}$/.test(contract)) cfg.contract = contract;
  const rpc = params.get('rpc');
  if (rpc) {
    try {
      const url = new URL(rpc);
      if (url.protocol === 'https:' || url.protocol === 'http:') cfg.rpc = [url.href];
    } catch { /* keep the default */ }
  }
  cfg.explorer = String(cfg.explorer).replace(/\/+$/, '');
  return cfg;
}

const cfg = readConfig();
const $ = (id) => document.getElementById(id);

// ---------- RPC ----------

// Several endpoints: when one fails or rate-limits, move to the next and stay there.
const rpcUrls = [cfg.rpc].flat();
let rpcIndex = 0;

async function view(method, args = {}) {
  let lastError;
  for (let attempt = 0; attempt < rpcUrls.length; attempt++) {
    try {
      return await viewOnce(rpcUrls[rpcIndex], method, args);
    } catch (err) {
      lastError = err;
      if (err.fromContract) throw err; // the contract answered; another endpoint would say the same
      rpcIndex = (rpcIndex + 1) % rpcUrls.length;
    }
  }
  throw lastError;
}

async function viewOnce(rpcUrl, method, args = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query',
        params: {
          request_type: 'call_function',
          finality: 'final',
          account_id: cfg.contract,
          method_name: method,
          args_base64: btoa(JSON.stringify(args)),
        },
      }),
    });
  } catch (err) {
    throw new Error(ctl.signal.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : `request blocked or network down (${err.message})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from the RPC`);
  const body = await res.json();
  if (body.error) {
    const e = body.error;
    const detail = typeof e.data === 'string' ? e.data : e.cause?.name || e.message || JSON.stringify(e);
    throw new Error(`${method}: ${detail}`);
  }
  if (body.result?.error) {
    const err = new Error(`${method}: ${body.result.error}`);
    err.fromContract = true;
    throw err;
  }
  if (!Array.isArray(body.result?.result)) throw new Error(`${method}: unexpected RPC response`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
}

async function allMachines() {
  const out = [];
  for (let from = 0; from < PAGE * 10; from += PAGE) {
    const page = await view('list_machines', { from_index: from, limit: PAGE });
    if (!Array.isArray(page)) break;
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

// ---------- DOM helpers (chain strings only ever go in through textContent) ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setAccountLink(a, account) {
  a.textContent = String(account);
  a.href = `${cfg.explorer}/address/${encodeURIComponent(String(account))}`;
}

function accountLink(account) {
  const a = el('a', 'account');
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  setAccountLink(a, account);
  return a;
}

function field(label, value) {
  const wrap = el('div', 'field');
  wrap.append(el('dt', '', label));
  const dd = el('dd');
  dd.append(value instanceof Node ? value : document.createTextNode(String(value)));
  wrap.append(dd);
  return wrap;
}

// ---------- state ----------

const state = {
  data: null, // { config, machines, passes }
  error: null,
  lastOk: 0,
  rendered: { config: '', machines: '', passes: '' },
  machineViews: [], // [{ m, node, badge, word, time, shown }]
  passViews: [], // [{ pass, node, word, time, unit, fill, kind, text }]
  lastKind: new Map(), // serial -> kind, survives re-renders so the expiry flip can be marked
};

// ---------- render: header + CA ----------

function renderConfig(config, machines) {
  $('total-machines').textContent = String(config.machine_count ?? machines.length);
  $('total-passes').textContent = String(config.pass_count ?? '–');
  $('total-earned').textContent = formatNear(sumYocto(machines.map((m) => m.total_earned)));

  $('fee-machine').textContent = formatNear(config.machine_storage_fee);
  $('fee-pass').textContent = formatNear(config.pass_storage_fee);
  $('fees').hidden = false;

  setAccountLink($('ca-mpc'), config.mpc_contract ?? '–');
  $('ca-path').textContent = `${config.ca_path ?? '–'}/<machine id>`;
  $('ca-domain').textContent = String(config.ca_domain_id ?? '–');
}

// ---------- render: machines ----------

/** A labelled public key line: middle-truncated on screen, copied in full. */
function keyBlock({ name, gloss, line, missing, copyLabel, footer }) {
  const wrap = el('div', 'machine-key');
  const top = el('div', 'machine-key-top');
  const label = el('p', 'machine-key-label');
  label.append(el('strong', '', name), document.createTextNode(` ${gloss}`));
  top.append(label);
  wrap.append(top);

  if (typeof line === 'string' && line.length > 0) {
    const [head, tail] = splitKey(line);
    const key = el('code', 'key');
    key.title = line;
    key.append(el('span', 'key-head', head), el('span', 'key-tail', tail));
    const button = el('button', 'copy', 'Copy key');
    button.type = 'button';
    button.setAttribute('aria-label', copyLabel);
    button.addEventListener('click', () => copyText(button, line));
    top.append(button);
    wrap.append(key);
  } else {
    wrap.append(el('p', 'key is-missing', missing));
  }
  if (footer) wrap.append(footer);
  return wrap;
}

function renderMachines(machines, caPath) {
  const list = $('machines');
  const note = $('machines-note');
  list.replaceChildren();
  state.machineViews = [];
  if (machines.length === 0) {
    note.textContent = 'No machines listed yet. When an owner lists one with a price per minute, it shows up here.';
    note.hidden = false;
    return;
  }
  note.hidden = true;

  // Machines in use go first so the one being rented sits beside its pass.
  // Decided once per data change, so a card never jumps when its timer ends.
  const now = Date.now();
  const inUse = (m) => (machineAvailability(m, now).kind === 'busy' ? 0 : 1);
  const ordered = [...machines].sort((a, b) => inUse(a) - inUse(b));

  for (const m of ordered) {
    const li = el('li', 'machine');

    const badge = el('span', 'badge');
    const word = el('span', 'badge-word');
    const time = el('span', 'badge-time');
    badge.append(word, time);
    const head = el('div', 'machine-head');
    head.append(el('h3', 'machine-id', m.id), badge);

    const price = el('p', 'price');
    price.append(el('strong', 'figure', formatNear(m.price_per_minute)), document.createTextNode(' NEAR per minute'));
    const top = el('div', 'machine-top');
    top.append(el('code', 'connect', `${m.login_user}@${m.host}:${m.port}`), price);

    const path = el('p', 'machine-key-path');
    path.append(document.createTextNode('MPC path '), el('strong', '', `${caPath ?? '–'}/${m.id}`));
    const caKey = keyBlock({
      name: 'CA key',
      gloss: 'trusted by the machine: who may log in',
      line: m.ca_public_key,
      missing: 'Waiting for the MPC to return this key.',
      copyLabel: `Copy the CA key of ${m.id}`,
      footer: path,
    });
    const hostKey = keyBlock({
      name: 'Host key',
      gloss: 'trusted by the renter: the right machine',
      line: m.host_key,
      missing: 'Not published (renter trusts the first key it sees)',
      copyLabel: `Copy the host key of ${m.id}`,
    });

    const facts = el('dl', 'facts');
    facts.append(
      field('Passes issued', el('strong', 'figure', m.passes_issued)),
      field('Total earned', nearFigure(m.total_earned)),
      field('Not withdrawn', nearFigure(m.earnings)),
      field('Owner', accountLink(m.owner)),
    );

    li.append(head, top, caKey, hostKey, facts);
    list.append(li);
    state.machineViews.push({ m, node: li, badge, word, time, shown: '' });
  }
  tickMachines();
}

const AVAILABILITY = { free: 'Free', busy: 'In use', paused: 'Paused' };

/** Availability ticks on the local clock, so "In use" turns "Free" without waiting for a poll. */
function tickMachines() {
  const now = Date.now();
  for (const v of state.machineViews) {
    const a = machineAvailability(v.m, now);
    const countdown = a.secondsLeft > 0 ? formatCountdown(a.secondsLeft) : '';
    const shown = `${a.kind} ${countdown}`;
    if (shown === v.shown) continue;
    v.shown = shown;
    v.node.className = `machine is-${a.kind}`;
    v.badge.className = `badge is-${a.kind}`;
    v.word.textContent = AVAILABILITY[a.kind];
    v.time.textContent = countdown ? (a.kind === 'paused' ? `last pass ends in ${countdown}` : `free in ${countdown}`) : '';
    v.time.hidden = !countdown;
  }
}

function nearFigure(yocto) {
  const span = el('span');
  span.append(el('strong', 'figure', formatNear(yocto)), document.createTextNode(' NEAR'));
  return span;
}

// ---------- render: passes ----------

function renderPasses(passes) {
  const list = $('passes');
  const note = $('passes-note');
  list.replaceChildren();
  state.passViews = [];
  if (passes.length === 0) {
    note.textContent = 'No passes bought yet. The first purchase shows up here within about five seconds.';
    note.hidden = false;
    return;
  }
  note.hidden = true;
  for (const pass of passes) {
    const li = el('li', 'pass');

    const stub = el('div', 'pass-stub');
    stub.append(el('span', 'pass-label', 'Pass'), el('span', 'pass-serial', pass.serial));

    const body = el('div', 'pass-body');
    const facts = el('dl', 'facts');
    facts.append(
      field('Buyer', accountLink(pass.buyer)),
      field('Minutes', pass.minutes),
      field('Paid', `${formatNear(pass.paid)} NEAR`),
      field('Valid until', formatClock(pass.valid_before)),
    );
    body.append(el('h3', 'pass-machine', pass.machine_id), facts);

    const status = el('div', 'pass-state');
    const word = el('span', 'state-word');
    const clock = el('span', 'state-clock');
    const time = el('span', 'state-time');
    const unit = el('span', 'state-unit');
    clock.append(time, unit);
    status.append(word, clock);

    const meter = el('div', 'pass-meter');
    const fill = el('div', 'pass-meter-fill');
    meter.append(fill);

    li.append(stub, body, status, meter);
    list.append(li);
    state.passViews.push({ pass, node: li, word, time, unit, fill, kind: '', text: '' });
  }
  tickPasses(true);
}

const WORDS = { active: 'Active', expired: 'Expired', pending: 'Pending', failed: 'Failed' };
const DETAILS = { expired: '', pending: 'waiting for the signature', failed: 'payment refunded' };

function tickPasses(fresh = false) {
  const now = Date.now();
  for (const v of state.passViews) {
    const s = passState(v.pass, now);
    const ending = s.kind === 'active' && s.secondsLeft <= ENDING_SECONDS;

    if (s.kind !== v.kind || ending !== v.ending) {
      const before = state.lastKind.get(v.pass.serial);
      v.node.className = `pass is-${s.kind}${ending ? ' is-ending' : ''}`;
      if (before === 'active' && s.kind === 'expired') v.node.classList.add('just-expired');
      v.word.textContent = WORDS[s.kind] ?? String(v.pass.status);
      v.unit.textContent = s.kind === 'active' ? 'left' : DETAILS[s.kind] ?? '';
      if (s.kind !== 'active') v.time.textContent = '';
      v.kind = s.kind;
      v.ending = ending;
      state.lastKind.set(v.pass.serial, s.kind);
    }

    if (s.kind === 'active') {
      const text = formatCountdown(s.secondsLeft);
      if (text !== v.text) {
        v.time.textContent = text;
        v.text = text;
      }
    }
    // A freshly built row jumps straight to its width; after that it glides.
    if (fresh) v.fill.style.transition = 'none';
    v.fill.style.width = `${(s.fraction * 100).toFixed(2)}%`;
    if (fresh) {
      void v.fill.offsetWidth;
      v.fill.style.transition = '';
    }
  }
}

// ---------- render: status + errors ----------

function renderStatus() {
  const sync = $('sync');
  const error = $('error');
  if (state.error) {
    sync.dataset.state = 'error';
    sync.textContent = 'RPC error, retrying';
    const stale = state.lastOk ? ` Showing what the contract said at ${formatClock(state.lastOk / 1000)}.` : '';
    error.textContent = `Can't read ${cfg.contract} from ${rpcUrls[rpcIndex]}: ${state.error}. Trying again every ${REFRESH_MS / 1000} seconds.${stale}`;
    error.hidden = false;
    if (!state.data) {
      for (const id of ['passes-note', 'machines-note']) $(id).textContent = 'Nothing to show until the RPC answers.';
    }
  } else {
    error.hidden = true;
    if (state.lastOk) {
      sync.dataset.state = 'live';
      sync.textContent = `Live, read ${formatAgo(Date.now() - state.lastOk)}`;
    }
  }
}

function render() {
  if (state.data) {
    const { config, machines, passes } = state.data;
    const cJson = JSON.stringify([config, machines.map((m) => m.total_earned)]);
    const mJson = JSON.stringify([machines, config.ca_path]);
    const pJson = JSON.stringify(passes);
    if (cJson !== state.rendered.config) renderConfig(config, machines);
    if (mJson !== state.rendered.machines) renderMachines(machines, config.ca_path);
    if (pJson !== state.rendered.passes) renderPasses(passes);
    state.rendered = { config: cJson, machines: mJson, passes: pJson };
  }
  renderStatus();
}

// ---------- loop ----------

async function refresh() {
  try {
    const [config, machines, passes] = await Promise.all([
      view('get_config'),
      allMachines(),
      view('list_recent_passes', { limit: PAGE }),
    ]);
    if (!config || typeof config !== 'object' || !Array.isArray(passes)) throw new Error('the contract returned an unexpected shape');
    state.data = { config, machines, passes };
    state.error = null;
    state.lastOk = Date.now();
  } catch (err) {
    state.error = err?.message || String(err);
  }
  render();
  setTimeout(refresh, REFRESH_MS);
}

async function copyText(button, text) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // No clipboard permission (or not a secure context): copy through a throwaway field.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    button.focus();
  }
  button.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { button.textContent = 'Copy key'; }, 1600);
}

setAccountLink($('contract-link'), cfg.contract);
setInterval(() => {
  tickPasses();
  tickMachines();
  if (!state.error && state.lastOk) $('sync').textContent = `Live, read ${formatAgo(Date.now() - state.lastOk)}`;
}, TICK_MS);
refresh();
