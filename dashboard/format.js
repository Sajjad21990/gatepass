// Pure helpers: no DOM, no network, so they can be checked from node.

const YOCTO_DECIMALS = 24;

/** Parse a yoctoNEAR decimal string into a BigInt, or null if it is not one. */
export function parseYocto(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== 'string' || !/^\d{1,60}$/.test(value)) return null;
  return BigInt(value);
}

/** yoctoNEAR -> "0.02", "1,250.5", "<0.0001". Truncates, never rounds up. */
export function formatNear(value, decimals = 4) {
  const yocto = typeof value === 'bigint' ? value : parseYocto(value);
  if (yocto === null) return '?';
  const scale = 10n ** BigInt(decimals);
  const scaled = yocto / 10n ** BigInt(YOCTO_DECIMALS - decimals);
  if (scaled === 0n) return yocto === 0n ? '0' : `<0.${'0'.repeat(decimals - 1)}1`;
  const whole = (scaled / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (scaled % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Sum yoctoNEAR strings, skipping anything malformed. */
export function sumYocto(values) {
  let total = 0n;
  for (const v of values) total += parseYocto(v) ?? 0n;
  return total;
}

/** Whole seconds -> "1:23", "0:07", "1:02:03". */
export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Live state of a pass at `nowMs`.
 *   kind       'active' | 'expired' | 'pending' | 'failed' | 'unknown'
 *   secondsLeft whole seconds shown on the countdown (active only, else 0)
 *   fraction    share of the paid window still left, 0..1 (active only, else 0)
 * The paid window is minutes * 60 seconds ending at valid_before; valid_after
 * sits 60 s earlier than the purchase to allow for clock skew, so it is not used.
 */
export function passState(pass, nowMs) {
  const idle = { secondsLeft: 0, fraction: 0 };
  if (pass.status === 'Pending') return { kind: 'pending', ...idle };
  if (pass.status === 'Failed') return { kind: 'failed', ...idle };
  if (pass.status !== 'Signed') return { kind: 'unknown', ...idle };
  const end = Number(pass.valid_before) * 1000;
  const leftMs = end - nowMs;
  if (!Number.isFinite(leftMs) || leftMs <= 0) return { kind: 'expired', ...idle };
  const windowMs = Math.max(1, Number(pass.minutes) || 0) * 60_000;
  return {
    kind: 'active',
    secondsLeft: Math.ceil(leftMs / 1000),
    fraction: Math.min(1, leftMs / windowMs),
  };
}

/**
 * Whether a machine can be rented at `nowMs`. A machine has one renter at a
 * time: it is held until busy_until (unix seconds, 0 when free).
 *   kind        'paused' | 'busy' | 'free'
 *   secondsLeft whole seconds until the current pass lets go (0 when not held)
 */
export function machineAvailability(machine, nowMs) {
  const leftMs = Number(machine.busy_until) * 1000 - nowMs;
  const held = Number.isFinite(leftMs) && leftMs > 0;
  const secondsLeft = held ? Math.ceil(leftMs / 1000) : 0;
  if (!machine.active) return { kind: 'paused', secondsLeft };
  return { kind: held ? 'busy' : 'free', secondsLeft };
}

/**
 * Split an OpenSSH public key line into [head, tail] so the middle can be
 * elided on screen: the tail keeps the end of the key and its comment.
 */
export function splitKey(line) {
  const text = String(line);
  const lastSpace = text.lastIndexOf(' ');
  const comment = lastSpace > 0 ? text.length - lastSpace : 0;
  const tail = Math.min(Math.floor(text.length / 2), comment + 6);
  return [text.slice(0, text.length - tail), text.slice(text.length - tail)];
}

/** Unix seconds -> local "11:42:09", with the date in front when it is not today. */
export function formatClock(unixSeconds, nowMs = Date.now()) {
  const d = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(d.getTime())) return '?';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (d.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

/** "3 s ago", "2 min ago". */
export function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
}
