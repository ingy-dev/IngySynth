// Param store facade (CP4–8). Keys are canonical IDs (`cutoff`, `osc-tune-0`, …).
// get/set still read and write the hidden classic controls so existing
// controls.js AudioParam rides keep working. Widgets write via set/toggle;
// they must not click kb* mirrors as the engine source.

const subscribers = new Map();
const lastNotified = new Map();

function prefixedIndex(key, prefix) {
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length);
    return rest === '' ? null : rest;
}

/** Canonical input/select/button for a param key. Never a kb* mirror. */
export function elementFor(key) {
    if (!key || typeof key !== 'string') return null;
    const oscTune = prefixedIndex(key, 'osc-tune-');
    if (oscTune != null) return document.querySelector(`.osc-tune[data-osc="${oscTune}"]`);
    const oscVol = prefixedIndex(key, 'osc-vol-');
    if (oscVol != null) return document.querySelector(`.osc-vol[data-osc="${oscVol}"]`);
    const oscPan = prefixedIndex(key, 'osc-pan-');
    if (oscPan != null) return document.querySelector(`.osc-pan[data-osc="${oscPan}"]`);
    const oscType = prefixedIndex(key, 'osc-type-');
    if (oscType != null) return document.querySelector(`.osc-type[data-osc="${oscType}"]`);
    const oscToggle = prefixedIndex(key, 'osc-toggle-');
    if (oscToggle != null) return document.querySelector(`.osc-toggle[data-osc="${oscToggle}"]`);
    const stepSlider = prefixedIndex(key, 'step-slider-');
    if (stepSlider != null) return document.querySelector(`.step-tune[data-step="${stepSlider}"]`);
    const stepFine = prefixedIndex(key, 'step-fine-');
    if (stepFine != null) return document.querySelector(`.step-fine[data-step="${stepFine}"]`);
    const stepSlide = prefixedIndex(key, 'step-slide-');
    if (stepSlide != null) return document.querySelector(`.step-slide[data-step="${stepSlide}"]`);
    const stepAccent = prefixedIndex(key, 'step-accent-');
    if (stepAccent != null) return document.querySelector(`.step-accent[data-step="${stepAccent}"]`);
    const stepRatch = prefixedIndex(key, 'step-ratch-');
    if (stepRatch != null) return document.querySelector(`.step-ratch[data-step="${stepRatch}"]`);
    const stepToggle = prefixedIndex(key, 'step-toggle-');
    if (stepToggle != null) return document.querySelector(`.step-toggle[data-step="${stepToggle}"]`);
    return document.getElementById(key);
}

export function keyFromElement(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.classList.contains('osc-tune') && el.dataset.osc != null) return `osc-tune-${el.dataset.osc}`;
    if (el.classList.contains('osc-vol') && el.dataset.osc != null) return `osc-vol-${el.dataset.osc}`;
    if (el.classList.contains('osc-pan') && el.dataset.osc != null) return `osc-pan-${el.dataset.osc}`;
    if (el.classList.contains('osc-type') && el.dataset.osc != null) return `osc-type-${el.dataset.osc}`;
    if (el.classList.contains('osc-toggle') && el.dataset.osc != null) return `osc-toggle-${el.dataset.osc}`;
    if (el.classList.contains('step-tune') && el.dataset.step != null) return `step-slider-${el.dataset.step}`;
    if (el.classList.contains('step-fine') && el.dataset.step != null) return `step-fine-${el.dataset.step}`;
    if (el.classList.contains('step-slide') && el.dataset.step != null) return `step-slide-${el.dataset.step}`;
    if (el.classList.contains('step-accent') && el.dataset.step != null) return `step-accent-${el.dataset.step}`;
    if (el.classList.contains('step-ratch') && el.dataset.step != null) return `step-ratch-${el.dataset.step}`;
    if (el.classList.contains('step-toggle') && el.dataset.step != null) return `step-toggle-${el.dataset.step}`;
    if (el.id) return el.id;
    return null;
}

function readValue(el) {
    if (!el) return undefined;
    if (el.tagName === 'SELECT') return el.value;
    if (el.tagName === 'INPUT') {
        if (el.type === 'checkbox') return !!el.checked;
        if (el.type === 'range' || el.type === 'number') {
            const n = parseFloat(el.value);
            return Number.isFinite(n) ? n : undefined;
        }
        return el.value;
    }
    if (el.tagName === 'BUTTON') return !el.classList.contains('off');
    return undefined;
}

function valueToken(key, el, value) {
    if (el?.dataset?.ratch != null) return `r:${el.dataset.ratch}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `n:${value}`;
    return `s:${String(value)}`;
}

function notify(key, value) {
    const el = elementFor(key);
    const token = valueToken(key, el, value);
    // Buttons skip the equality gate: hydrate / acid / poly can write `.off`
    // without a click, which would leave lastNotified stale.
    if (el?.tagName !== 'BUTTON' && lastNotified.get(key) === token) return;
    lastNotified.set(key, token);
    const set = subscribers.get(key);
    if (!set || set.size === 0) return;
    set.forEach((fn) => {
        try { fn(value, key); } catch (err) { console.error(err); }
    });
}

/** Push the current DOM value to subscribers (class writes that skip click). */
export function notifyKey(key) {
    if (!key) return;
    notify(key, get(key));
}

function onDomCommit(event) {
    const el = event.target;
    if (!(el instanceof Element)) return;
    const key = keyFromElement(el);
    if (!key) return;
    if (elementFor(key) !== el) return;
    notify(key, readValue(el));
}

function onButtonCommit(event) {
    const btn = event.target instanceof Element ? event.target.closest('button') : null;
    if (!btn) return;
    const key = keyFromElement(btn);
    if (!key) return;
    if (elementFor(key) !== btn) return;
    notify(key, readValue(btn));
}

document.addEventListener('input', onDomCommit, true);
document.addEventListener('change', onDomCommit, true);
// Bubble: canonical click handlers toggle `.off` before this runs.
document.addEventListener('click', onButtonCommit);

export function get(key) {
    return readValue(elementFor(key));
}

/** Numeric param; `fallback` when missing or NaN. */
export function getNumber(key, fallback = 0) {
    const v = get(key);
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
}

/** String param (selects); `fallback` when missing. */
export function getString(key, fallback = '') {
    const v = get(key);
    if (v == null) return fallback;
    return String(v);
}

export function getOscType(index, fallback = 'sawtooth') {
    return getString(`osc-type-${index}`, fallback);
}

export function getOscVol(index, fallback = 0.33) {
    return getNumber(`osc-vol-${index}`, fallback);
}

export function getOscPan(index, fallback = 0) {
    const pan = getNumber(`osc-pan-${index}`, fallback);
    if (!Number.isFinite(pan)) return fallback;
    return Math.max(-1, Math.min(1, pan));
}

/**
 * Write the canonical control. No-ops when the value is already equal so
 * input → set → input cannot loop. Dispatches `input` (and `change` on
 * selects) so controls.js AudioParam listeners still run.
 * Buttons click the canonical node so existing side effects still run.
 */
export function set(key, value) {
    const el = elementFor(key);
    if (!el) return false;

    if (el.tagName === 'BUTTON') {
        const next = !!value;
        const cur = !!readValue(el);
        if (cur === next) return false;
        el.click();
        notify(key, readValue(el));
        return true;
    }

    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
        const next = !!value;
        if (el.checked === next) return false;
        el.checked = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return false;

    if (el.type === 'range' || el.type === 'number') {
        const n = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(n)) return false;
        if (parseFloat(el.value) === n) return false;
        el.value = String(n);
    } else {
        const next = String(value);
        if (el.value === next) return false;
        el.value = next;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (el.tagName === 'SELECT') {
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
}

export function toggle(key) {
    return set(key, !get(key));
}

/** Cycle a non-boolean button (ratch). */
export function click(key) {
    const el = elementFor(key);
    if (!el || el.tagName !== 'BUTTON') return false;
    el.click();
    notify(key, readValue(el));
    return true;
}

/**
 * Stage / MI / acid toggle → params.toggle(key).
 * @returns {() => void} sync
 */
export function wireToggle(kbBtn, key, opts = {}) {
    if (!kbBtn || !key) return () => {};
    const syncLabel = opts.syncLabel === true;
    const onLabel = opts.onLabel ?? 'On';
    const offLabel = opts.offLabel ?? 'Off';

    const sync = () => {
        const on = !!get(key);
        kbBtn.classList.toggle('off', !on);
        kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (syncLabel) kbBtn.textContent = on ? onLabel : offLabel;
        opts.onSync?.(on, kbBtn);
    };

    kbBtn.addEventListener('click', () => {
        if (kbBtn.disabled || kbBtn.getAttribute('aria-disabled') === 'true') return;
        if (opts.beforeToggle && opts.beforeToggle() === false) return;
        toggle(key);
    });
    subscribe(key, sync);
    sync();
    return sync;
}

/** Mirror select → params.set(key). */
export function wireSelect(mirrorEl, key) {
    if (!mirrorEl || !key) return () => {};
    const sync = () => {
        const v = getString(key);
        if (mirrorEl.value !== v) mirrorEl.value = v;
    };
    mirrorEl.addEventListener('change', () => {
        set(key, mirrorEl.value);
    });
    subscribe(key, sync);
    sync();
    return sync;
}

/** @returns {() => void} unsubscribe */
export function subscribe(key, fn) {
    if (!key || typeof fn !== 'function') return () => {};
    let set = subscribers.get(key);
    if (!set) {
        set = new Set();
        subscribers.set(key, set);
    }
    set.add(fn);
    return () => {
        set.delete(fn);
        if (set.size === 0) subscribers.delete(key);
    };
}

export const params = {
    get, getNumber, getString, getOscType, getOscVol, getOscPan,
    set, toggle, click, notifyKey, subscribe, wireToggle, wireSelect,
    elementFor, keyFromElement,
};

if (typeof window !== 'undefined') {
    window.params = params;
}
