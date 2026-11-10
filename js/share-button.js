// Share button under the oscilloscope. Same file in the web app and Bare Metal. Press: the pad
// flashes green and the arrow rises out of the box while hex rings in the button's outline ripple
// outward. The share itself is done by whoever answers ingysynth:share-request (Bare Metal:
// juce-bridge.js, native save + link; web: save-ui.js, link / share sheet / .ingy download). When it
// answers, the arrow drops back, the rings turn cyan and rewind into the button, and the pad flashes
// cyan. Answer shape: { link?, path?, message?, cancelled?, error?, settleMs? } (settleMs: wait this
// long before landing, e.g. while a system share sheet animates away over the page).

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A new ring this often while the arrow is up. */
const RING_EVERY_MS = 700;
/** Centre-to-fade travel time of one ring. */
const RING_MS = 1600;
/** On landing, rings in flight play backwards this fast. */
const REWIND_RATE = -2.2;
/** The arrow stays up at least this long, so a fast save still shows the rings. */
const MIN_UP_MS = 1400;
const ARROW_LIFT = 'translateY(-6px)';
/** Bare Metal only: ask the native side once the press flash has painted (see share()). */
const NATIVE_REQUEST_DELAY_MS = 260;

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const still = () => !!reducedMotion?.matches;

let dock = null;
let btn = null;
let waves = null;
let arrow = null;
let status = null;
let busy = false;
let ringTimer = null;
let statusTimer = null;
const liveRings = new Set();

function flashPad(color, ms) {
    btn.style.setProperty('--share-flash', color);
    btn.style.setProperty('--share-flash-ms', `${ms}ms`);
    btn.classList.remove('is-flash');
    void btn.offsetWidth;
    btn.classList.add('is-flash');
}

/** The button's hex outline about its centre (ring-layer coordinates), as offsets to scale. */
function ringShape() {
    const d = waves.getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const cx = b.left - d.left + b.width / 2;
    const cy = b.top - d.top + b.height / 2;
    const hw = b.width / 2;
    const hh = b.height / 2;
    const cut = parseFloat(getComputedStyle(btn).getPropertyValue('--cut')) || b.height * 0.3;
    return { cx, cy, pts: [[-hw + cut, -hh], [hw - cut, -hh], [hw, 0], [hw - cut, hh], [-hw + cut, hh], [-hw, 0]] };
}

/** [progress, scale, opacity] keyframes of one ring's trip out (linear between them). */
// Sized so the rings travel as far as on the 92px mock button (this one is 64px).
const RING_KEYS = [[0, 1, 1], [0.5, 1.9, 0.85], [0.8, 2.5, 0.4], [1, 2.8, 0]];
function ringAt(p) {
    for (let i = 1; i < RING_KEYS.length; i++) {
        const [p0, s0, o0] = RING_KEYS[i - 1];
        const [p1, s1, o1] = RING_KEYS[i];
        if (p <= p1) {
            const k = (p - p0) / (p1 - p0);
            return [s0 + (s1 - s0) * k, o0 + (o1 - o0) * k];
        }
    }
    return [2.8, 0];
}

// Rings are redrawn by hand each frame: WebKit (the app's WebView) does not paint CSS transforms
// animated on SVG polygons, and this keeps the line width fixed as the ring grows.
let rafId = 0;
let lastFrame = 0;
function drawRing(r) {
    const [s, o] = ringAt(Math.min(1, Math.max(0, r.t / RING_MS)));
    r.el.setAttribute('points', r.shape.pts.map(([x, y]) => `${(r.shape.cx + x * s).toFixed(1)},${(r.shape.cy + y * s).toFixed(1)}`).join(' '));
    r.el.setAttribute('opacity', (o * (r.lead ? 1 : 0.85)).toFixed(3));
}
function tick(now) {
    const dt = Math.min(64, now - lastFrame);
    lastFrame = now;
    for (const r of liveRings) {
        r.t += dt * r.rate;
        if (r.t <= 0 || r.t >= RING_MS) {
            r.el.remove();
            liveRings.delete(r);
        } else drawRing(r);
    }
    rafId = liveRings.size ? requestAnimationFrame(tick) : 0;
}

function sendRing(lead) {
    if (still()) return;
    const el = document.createElementNS(SVG_NS, 'polygon');
    el.setAttribute('class', `share-ring${lead ? '' : ' is-trail'}`);
    waves.append(el);
    const r = { el, lead, t: 1, rate: 1, shape: ringShape() };
    drawRing(r);
    liveRings.add(r);
    if (!rafId) {
        lastFrame = performance.now();
        rafId = requestAnimationFrame(tick);
    }
}

function showStatus(text, ok, title = '') {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.title = title;
    status.classList.toggle('is-ok', ok);
    status.classList.add('is-on');
    statusTimer = setTimeout(() => status.classList.remove('is-on'), 2600);
}

/** The handler sets accepted and later calls reply(result). No handler: fail at once. */
function requestShare() {
    return new Promise((resolve) => {
        const detail = { accepted: false, reply: (result) => resolve(result || { error: 'share failed' }) };
        document.dispatchEvent(new CustomEvent('ingysynth:share-request', { detail }));
        if (!detail.accepted) resolve({ error: 'share unavailable' });
    });
}

function land(result) {
    clearInterval(ringTimer);
    ringTimer = null;
    const ok = !!result && !result.error;
    for (const r of liveRings) {
        r.el.classList.add('is-back');
        r.rate = REWIND_RATE;
    }
    arrow.getAnimations().forEach((a) => a.cancel());
    arrow.animate([{ transform: ARROW_LIFT }, { transform: 'translateY(1px)', offset: 0.7 }, { transform: 'translateY(0)' }],
        { duration: still() ? 1 : 360, easing: 'ease-in' });
    setTimeout(() => {
        if (result?.cancelled) {
            // Share sheet dismissed: nothing was shared, so no confirmation.
        } else if (ok) {
            flashPad('#00eeee', 420);
            if (result.message) showStatus(result.message, true, result.link || '');
            else if (result.link) showStatus('LINK COPIED', true, result.link);
            else showStatus('SAVED · SHOWN IN FINDER', true, result.path || '');
        } else {
            showStatus('SHARE FAILED', false, result?.error || '');
        }
    }, still() ? 0 : 330);
    setTimeout(() => { busy = false; }, 700);
}

async function share() {
    if (busy) return;
    busy = true;
    flashPad('#00ee00', 240);
    arrow.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(2px)', offset: 0.25 }, { transform: ARROW_LIFT }],
        { duration: still() ? 1 : 520, easing: 'ease-out', fill: 'forwards' });
    const started = performance.now();
    setTimeout(() => {
        if (!busy || ringTimer) return;
        sendRing(true);
        ringTimer = setInterval(() => sendRing(false), RING_EVERY_MS);
    }, 350);
    // Bare Metal: applying the pattern natively holds the message thread briefly (the WebView cannot
    // repaint meanwhile), so let the press flash land first. Web: ask at once, because the share
    // sheet needs the click's user activation.
    if (document.documentElement.dataset.ingyNative && !still()) {
        await new Promise((r) => setTimeout(r, NATIVE_REQUEST_DELAY_MS));
    }
    const result = await requestShare();
    const wait = Math.max(MIN_UP_MS - (performance.now() - started), result?.settleMs || 0, 0);
    setTimeout(() => land(result), still() ? 0 : wait);
}

export function initShareButton() {
    dock = document.getElementById('shareDock');
    btn = document.getElementById('shareBtn');
    waves = document.getElementById('shareWaves');
    status = document.getElementById('shareStatus');
    arrow = btn?.querySelector('.share-arrow');
    if (!dock || !btn || !waves || !status || !arrow) return;
    btn.addEventListener('click', share);
}
