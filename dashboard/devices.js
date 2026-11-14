// Gatepass hero devices and logo.
// The drawings are static SVG strings; every state change is CSS, driven by
// data-state ("free" | "signing" | "active" | "ended") on the root element.
// Styles live in devices.css.

export function deviceKind(machineId) {
  const id = String(machineId ?? '').toLowerCase();
  if (id.includes('gpu') || id.endsWith('-big')) return 'tower';
  if (id.includes('arm') || id.includes('pi') || id.includes('tiny')) return 'board';
  return 'laptop';
}

export function deviceMarkup(kind) {
  if (kind === 'tower') return wrap('tower', TOWER);
  if (kind === 'board') return wrap('board', BOARD);
  return null; // the page keeps its own laptop
}

export const wordmark = 'Gatepass';

// The mark: a G drawn as a pass timer. The ring is the time left, the bar is
// the hand, the gap is the open gate.
export const logoMarkup =
  '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">' +
  '<path d="M21.75 6.04A11.5 11.5 0 1 0 27.5 16H16" stroke="currentColor" stroke-width="5"/>' +
  '<circle cx="16" cy="16" r="4.4" fill="currentColor"/></svg>';

function wrap(kind, svg) {
  return `<div class="gp-device gp-device--${kind}" data-state="free">${svg}</div>`;
}

const n = (x) => +x.toFixed(1);

/* ------------------------------------------------------------------ tower */

function fan(cx, cy, r) {
  const pol = (rr, d) => {
    const a = (d * Math.PI) / 180;
    return `${n(rr * Math.cos(a))} ${n(rr * Math.sin(a))}`;
  };
  const ri = r * 0.27;
  const ro = r * 0.9;
  let blades = '';
  for (let i = 0; i < 7; i++) {
    const o = (i * 360) / 7;
    blades +=
      `<path d="M${pol(ri, o - 28)}Q${pol(r * 0.6, o - 54)} ${pol(ro, o - 46)}` +
      `A${n(ro)} ${n(ro)} 0 0 1 ${pol(ro, o - 6)}Q${pol(r * 0.62, o - 2)} ${pol(ri, o + 22)}Z"/>`;
  }
  return (
    `<g transform="translate(${cx} ${cy})"><circle class="gp-fan-well" r="${r}"/>` +
    `<g class="gp-fan"><circle r="${r}" fill="none"/>${blades}</g>` +
    `<circle class="gp-fan-hub" r="${n(r * 0.3)}"/><circle class="gp-fan-ring" r="${r}"/></g>`
  );
}

function slats(x, y0, y1, w, step, h, fill) {
  let s = '';
  for (let y = y0; y <= y1; y += step) s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
  return s;
}

const TOWER = `<svg viewBox="0 0 520 380" aria-hidden="true" focusable="false">
<defs>
  <radialGradient id="gpT-shadow"><stop offset="0" stop-color="#02161C" stop-opacity=".72"/><stop offset=".6" stop-color="#02161C" stop-opacity=".4"/><stop offset="1" stop-color="#02161C" stop-opacity="0"/></radialGradient>
  <radialGradient id="gpT-spill"><stop offset="0" stop-color="#FFF1C7" stop-opacity=".55"/><stop offset="1" stop-color="#FFF1C7" stop-opacity="0"/></radialGradient>
  <linearGradient id="gpT-top" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F3F5F6"/><stop offset="1" stop-color="#D3D9DC"/></linearGradient>
  <linearGradient id="gpT-front" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E6EAEB"/><stop offset=".55" stop-color="#CBD2D5"/><stop offset="1" stop-color="#BBC4C8"/></linearGradient>
  <linearGradient id="gpT-side" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#BFC8CB"/><stop offset=".6" stop-color="#A5B0B5"/><stop offset="1" stop-color="#8D999E"/></linearGradient>
  <radialGradient id="gpT-glow" cx=".45" cy=".4" r=".8"><stop offset="0" stop-color="#FFF9E6"/><stop offset=".6" stop-color="#FFEDB8"/><stop offset="1" stop-color="#E9CB80"/></radialGradient>
  <linearGradient id="gpT-glowF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFEDB8"/><stop offset="1" stop-color="#FFF7DE"/></linearGradient>
  <clipPath id="gpT-win"><rect x="14" y="14" width="202" height="190" rx="10"/></clipPath>
</defs>
<ellipse cx="262" cy="320" rx="222" ry="44" fill="url(#gpT-shadow)"/>
<ellipse class="gp-t-spill" cx="330" cy="328" rx="196" ry="40" fill="url(#gpT-spill)"/>
<g class="gp-body">
  <polygon points="100,300 200,332 422,287 422,274 200,318 100,288" fill="#17232A"/>
  <polygon points="92,66 322,20 430,50 430,280 200,326 92,296" fill="#EEF1F2" stroke="#EEF1F2" stroke-width="4" stroke-linejoin="round"/>
  <g transform="matrix(1 -.2 1 .278 92 66)">
    <rect width="230" height="108" rx="5" fill="url(#gpT-top)"/>
    <rect x="112" y="22" width="96" height="64" rx="7" fill="#22323A"/>
    ${slats(119, 29, 77, 82, 8, 3.4, '#4A5C63')}
  </g>
  <g transform="matrix(1 .278 0 1 92 66)">
    <rect width="108" height="230" rx="5" fill="url(#gpT-front)"/>
    <rect class="gp-lamp gp-lamp--dark" x="39" y="26" width="30" height="5" rx="2.5"/>
    <rect class="gp-on gp-on--pwr" x="39" y="26" width="30" height="5" rx="2.5" fill="#3FD98A"/>
    <rect x="16" y="52" width="76" height="156" rx="9" fill="#17232A"/>
    <rect class="gp-t-glow gp-t-glow--front" x="16" y="52" width="76" height="156" rx="9" fill="url(#gpT-glowF)"/>
    ${slats(23, 60, 198, 62, 8, 3.6, '#3A4B52')}
    <rect x="16" y="52" width="76" height="156" rx="9" fill="none" stroke="#8D999E" stroke-width="1.5"/>
  </g>
  <g transform="matrix(1 -.2 0 1 200 96)">
    <rect width="230" height="230" rx="5" fill="url(#gpT-side)"/>
    <rect x="14" y="14" width="202" height="190" rx="10" fill="#0C171B"/>
    <g clip-path="url(#gpT-win)">
      <rect x="64" y="24" width="142" height="90" rx="4" fill="#122028"/>
      <rect class="gp-t-glow" x="14" y="14" width="202" height="190" fill="url(#gpT-glow)"/>
      <rect class="gp-t-part" x="24" y="26" width="13" height="168" rx="4"/>
      <rect class="gp-t-part--2" x="76" y="34" width="6" height="68" rx="2"/>
      <rect class="gp-t-part--2" x="86" y="34" width="6" height="68" rx="2"/>
      <rect class="gp-t-part" x="106" y="36" width="64" height="64" rx="8"/>
      ${fan(138, 68, 26)}
      <rect class="gp-t-part--2" x="182" y="30" width="20" height="74" rx="3"/>
      <rect class="gp-t-part" x="44" y="118" width="164" height="76" rx="10"/>
      <rect class="gp-t-strip" x="56" y="122.5" width="140" height="4.5" rx="2.2"/>
      ${fan(86, 160, 27)}
      ${fan(166, 160, 27)}
      <polygon points="118,14 216,14 216,204 176,204" fill="#fff" opacity=".055"/>
    </g>
    <rect x="14" y="14" width="202" height="190" rx="10" fill="none" stroke="#7F8E93" stroke-width="1.5"/>
  </g>
</g>
</svg>`;

/* ------------------------------------------------------------------ board */

// Axonometric projection of board space (u along the long edge, v toward the
// viewer, z up) onto the 520x380 canvas.
const A = 0.934, B = -0.205, C = 0.358, D = 0.536, E = 44, F = 172, K = 0.82;
const P = (u, v, z = 0) => `${n(E + A * u + C * v)},${n(F + B * u + D * v - K * z)}`;
const flat = (z) => `translate(0 ${n(-K * z)}) matrix(${A} ${B} ${C} ${D} ${E} ${F})`;
const poly = (pts, attrs) => `<polygon points="${pts.join(' ')}" ${attrs}/>`;

function box(u, v, w, h, z0, z1, cls) {
  return (
    `<g class="gp-box ${cls}">` +
    poly([P(u, v, z1), P(u, v + h, z1), P(u, v + h, z0), P(u, v, z0)], 'class="gp-l"') +
    poly([P(u, v + h, z1), P(u + w, v + h, z1), P(u + w, v + h, z0), P(u, v + h, z0)], 'class="gp-f"') +
    poly([P(u, v, z1), P(u + w, v, z1), P(u + w, v + h, z1), P(u, v + h, z1)], 'class="gp-t"') +
    '</g>'
  );
}
// a patch on a left-facing side (constant u) or a front-facing side (constant v)
const onLeft = (u, v0, v1, z0, z1, attrs) => poly([P(u, v0, z1), P(u, v1, z1), P(u, v1, z0), P(u, v0, z0)], attrs);
const onFront = (v, u0, u1, z0, z1, attrs) => poly([P(u0, v, z1), P(u1, v, z1), P(u1, v, z0), P(u0, v, z0)], attrs);

function usb(v) {
  return (
    box(-8, v, 66, 52, 6, 60, 'gp-metal') +
    onLeft(-8, v + 6, v + 46, 37, 53, 'fill="#17232A"') +
    onLeft(-8, v + 6, v + 46, 13, 29, 'fill="#17232A"') +
    onLeft(-8, v + 10, v + 42, 46, 49, 'fill="#9FB0B4"') +
    onLeft(-8, v + 10, v + 42, 22, 25, 'fill="#9FB0B4"')
  );
}
function port(u, w, z1) {
  return box(u, 232, w, 22, 6, z1, 'gp-metal') + onFront(254, u + 4, u + w - 4, 9.5, z1 - 3.5, 'fill="#17232A"');
}
function pins() {
  let s = '';
  for (const v of [15, 27]) for (let i = 0; i < 20; i++) {
    const u = 120 + i * 12.4;
    const [a, b] = [P(u, v, 17).split(','), P(u, v, 35).split(',')];
    s += `<line class="gp-pin" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  }
  return s;
}
function led(v, kind, color) {
  return (
    `<rect class="gp-lamp" x="322" y="${v}" width="18" height="11" rx="2.5"/>` +
    `<g class="gp-on gp-on--${kind}"><circle cx="331" cy="${v + 5.5}" r="26" fill="url(#gpB-halo-${kind})"/>` +
    `<rect x="322" y="${v}" width="18" height="11" rx="2.5" fill="${color}"/></g>`
  );
}
const smd = (u, v, w, h, fill) => `<rect x="${u}" y="${v}" width="${w}" height="${h}" rx="1.2" fill="${fill}"/>`;
const hole = (u, v) => `<circle cx="${u}" cy="${v}" r="9.5" fill="#E3B757"/><circle class="gp-hole" cx="${u}" cy="${v}" r="5.2"/>`;

const BOARD = `<svg viewBox="0 0 520 380" aria-hidden="true" focusable="false">
<defs>
  <linearGradient id="gpB-pcb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#229079"/><stop offset=".55" stop-color="#18786A"/><stop offset="1" stop-color="#126459"/></linearGradient>
  <linearGradient id="gpB-chip" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EDF0F1"/><stop offset=".5" stop-color="#CBD2D5"/><stop offset="1" stop-color="#DDE2E4"/></linearGradient>
  <radialGradient id="gpB-halo-pwr"><stop offset="0" stop-color="#3FD98A" stop-opacity=".75"/><stop offset="1" stop-color="#3FD98A" stop-opacity="0"/></radialGradient>
  <radialGradient id="gpB-halo-act"><stop offset="0" stop-color="#FFB23E" stop-opacity=".75"/><stop offset="1" stop-color="#FFB23E" stop-opacity="0"/></radialGradient>
</defs>
<g transform="${flat(-16)}">
  <rect class="gp-b-glow" x="-34" y="-26" width="448" height="302" rx="70"/>
  <rect class="gp-b-shadow" x="-2" y="2" width="392" height="256" rx="26"/>
</g>
<g class="gp-body">
  <g transform="${flat(0)}"><rect width="380" height="250" rx="15" fill="#0A433B"/></g>
  <g transform="${flat(2)}"><rect width="380" height="250" rx="15" fill="#0B4A40"/></g>
  <g transform="${flat(4)}"><rect width="380" height="250" rx="15" fill="#0D5247"/></g>
  <g transform="${flat(6)}">
    <rect width="380" height="250" rx="15" fill="url(#gpB-pcb)" stroke="#5CC2A8" stroke-opacity=".5" stroke-width="1.2"/>
    <rect class="gp-b-wash" width="380" height="250" rx="15"/>
    <path class="gp-trace" d="M170 92V62l20-20v-9M186 92V72l28-28v-11M202 92V78l38-38v-7M150 104h-30L86 70H64M150 132h-22l-14 18M90 164H70l-12-12M224 112h20M224 124h20M224 136h20M224 148h20M180 166v38l-13 13v15M205 166v38l16 16v12M280 156v76M322 206h-22l-10-10v-40M322 223h-34"/>
    ${hole(16, 16)}${hole(364, 16)}${hole(16, 234)}${hole(364, 234)}
    ${smd(132, 62, 9, 6, '#C9A46A')}${smd(132, 74, 9, 6, '#C9A46A')}${smd(236, 176, 6, 9, '#C9A46A')}${smd(250, 176, 6, 9, '#C9A46A')}
    ${smd(300, 96, 9, 6, '#17232A')}${smd(300, 108, 9, 6, '#17232A')}${smd(300, 120, 9, 6, '#C9A46A')}${smd(136, 196, 9, 6, '#17232A')}
    ${smd(318, 56, 30, 24, '#17232A')}${smd(74, 196, 6, 9, '#C9A46A')}
  </g>
  ${box(112, 9, 252, 24, 6, 17, 'gp-black')}
  ${pins()}
  ${box(-8, 30, 72, 58, 6, 56, 'gp-metal')}
  ${onLeft(-8, 37, 81, 12, 41, 'fill="#17232A"')}
  ${onLeft(-8, 39, 49, 45, 51, 'class="gp-lamp"')}
  ${onLeft(-8, 39, 49, 45, 51, 'class="gp-on gp-on--pwr gp-on--link" fill="#3FD98A"')}
  ${onLeft(-8, 69, 79, 45, 51, 'class="gp-lamp"')}
  ${onLeft(-8, 69, 79, 45, 51, 'class="gp-on gp-on--act gp-on--link gp-on--link2" fill="#FFB23E"')}
  ${box(246, 98, 52, 60, 6, 11, 'gp-black')}
  ${box(150, 92, 74, 74, 6, 13, 'gp-chip')}
  ${box(90, 150, 30, 30, 6, 10, 'gp-black')}
  ${usb(100)}
  ${usb(164)}
  ${box(96, 230, 26, 24, 6, 26, 'gp-black')}
  ${port(150, 34, 19)}
  ${port(204, 34, 19)}
  ${port(262, 36, 20)}
  <g transform="${flat(6)}">
    ${led(196, 'pwr', '#3FD98A')}
    ${led(214, 'act', '#FFB23E')}
  </g>
</g>
</svg>`;
