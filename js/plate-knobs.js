// Plate pointer knob — the default IngySynth knob (Design Lab knob-plate.html, settings locked 2026-11-11).
// Same file in the web app and Bare Metal.
//
// Every main .synth-knob-dial gets the class .pk and an SVG drawn over its outline: a ring and a plate that
// starts on the ring's outer edge (clipped to the circle) and fades towards the centre, so the two read as
// one shape. Styles live at the end of styles.css. The app keeps driving --knob-angle on the dial; the plate
// follows it through the SVG transform *attribute* (Bare Metal's WKWebView does not paint CSS transforms on
// SVG), and the glow is a CSS filter on the <svg> element itself (WKWebView clips SVG overflow).
//
// Sizing follows the original knob: the design is set for the standard 46px dial (44px + 1px border).
// Larger knobs (cutoff, volume) keep the same line weights and only grow the plate's length the way the
// old indicator grew (12px → 18px at twice the size); smaller knobs scale everything down in proportion.
// The SVG is drawn in real pixels for each dial's size and redrawn if that size changes.

const STD = 46;                                        // standard dial, border box
const K = { ring: 2, plateW: 6, plateL: 15, fade: 0.25, fadeAt: 0.25, end: 0, corner: 1 };
const END_OPACITY = 1 - K.fade * (1 - K.end);

function geometry(d) {
  const s = Math.min(1, d / STD);                     // shrink below standard, never grow line weights
  const grow = d > STD ? Math.pow(d / STD, 0.6) : s;   // plate length: 2× size → ~1.5×, like the old tick
  return { s, ring: K.ring * s, plateW: K.plateW * s, plateL: K.plateL * grow, corner: K.corner * s };
}

// Knobs that keep their own look: Plaits / OSC 4 (incl. the Mutable skirts), acid, NG-101.
// Multitudes / Sequins use .mi-knob, not .synth-knob-dial, so they are never picked up.
const EXCLUDE = [
  '.acid-303-knob .synth-knob-dial', '.acid-303-dial',
  '.osc4-tone-knob .synth-knob-dial', '.osc4-env-knob .synth-knob-dial', '.mi-skirted',
  '.ng101-dial', '#ng101Panel .synth-knob-dial',
].join(', ');

const SVG_NS = 'http://www.w3.org/2000/svg';
let uid = 0;

function draw(dial, d) {
  const pk = dial.__pk;
  const g = geometry(d), c = d / 2, id = pk.id;
  const f = (n) => +n.toFixed(2);
  pk.svg.setAttribute('viewBox', `0 0 ${f(d)} ${f(d)}`);
  pk.svg.innerHTML =
    `<defs>
      <linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${f(g.plateL)}">
        <stop offset="0" stop-opacity="1"/><stop offset="${K.fadeAt}" stop-opacity="1"/><stop offset="1" stop-opacity="${END_OPACITY}"/>
      </linearGradient>
      <clipPath id="${id}c"><circle cx="${f(c)}" cy="${f(c)}" r="${f(c)}"/></clipPath>
    </defs>
    <circle class="pk-face" cx="${f(c)}" cy="${f(c)}" r="${f(c)}"/>
    <circle class="pk-ring" cx="${f(c)}" cy="${f(c)}" r="${f(c - g.ring / 2)}" stroke-width="${f(g.ring)}"/>
    <g class="pk-p"><rect x="${f(c - g.plateW / 2)}" y="0" width="${f(g.plateW)}" height="${f(g.plateL)}" rx="${f(g.corner)}"
      fill="url(#${id})" clip-path="url(#${id}c)"/></g>`;
  pk.p = pk.svg.querySelector('.pk-p');
  pk.d = d;
  pk.deg = null;
  dial.style.setProperty('--u', g.s.toFixed(3));        // glow scale (1 = standard and up)
  syncAngle(dial);
}

function syncAngle(dial) {
  const pk = dial.__pk;
  if (!pk?.p) return;
  const a = parseFloat(dial.style.getPropertyValue('--knob-angle'));
  const deg = Number.isFinite(a) ? a : -135;
  if (deg === pk.deg) return;
  pk.deg = deg;
  pk.p.setAttribute('transform', `rotate(${deg} ${pk.d / 2} ${pk.d / 2})`);
}

const styleObserver = new MutationObserver((records) => {
  for (const r of records) syncAngle(r.target);
});

function measure(dial) {
  const pk = dial.__pk;
  const d = Math.round((dial.clientWidth + 2 * pk.bw) * 2) / 2;   // border box, to the half pixel
  if (d > 0 && d !== pk.d) draw(dial, d);
}

const sizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => { for (const e of entries) measure(e.target); })
  : null;

function attach(dial) {
  if (dial.__pk || dial.matches(EXCLUDE)) return;
  const bw = parseFloat(getComputedStyle(dial).borderTopWidth) || 1;   // keep the old outline's footprint
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'plate-knob');
  svg.setAttribute('aria-hidden', 'true');
  dial.__pk = { svg, p: null, d: 0, deg: null, bw, id: 'pk' + (uid++) };
  dial.style.setProperty('--pk-bw', bw + 'px');
  dial.classList.add('pk');
  dial.appendChild(svg);
  measure(dial);                                       // hidden dials (0px) draw once they are shown
  styleObserver.observe(dial, { attributes: true, attributeFilter: ['style'] });
  sizeObserver?.observe(dial);
}

function scan(root) {
  if (root.matches?.('.synth-knob-dial')) attach(root);
  root.querySelectorAll?.('.synth-knob-dial').forEach(attach);
}

export function initPlateKnobs() {
  scan(document);
  // knobs built later (Berlin rows, mixer sends, drum dock…)
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.body, { childList: true, subtree: true });

  // lit while touched (dials whose code doesn't set .active themselves)
  let lit = null;
  const off = () => { lit?.classList.remove('pk-on'); lit = null; };
  document.addEventListener('pointerdown', (e) => {
    const d = e.target.closest?.('.synth-knob-dial.pk');
    if (d) { off(); lit = d; d.classList.add('pk-on'); }
  }, true);
  addEventListener('pointerup', off, true);
  addEventListener('pointercancel', off, true);
  addEventListener('blur', off);
}

initPlateKnobs();
