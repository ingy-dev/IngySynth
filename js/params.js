// Param store (CP9). get/set are a JS Map. Hidden classic nodes are a mirror
// when connected. Step keys are views of pattern.steps[] (getLiveStep), not Map copies.
// Widgets must not use kb* mirrors as the engine source.

import { getLiveStep } from './pattern-bank.js?v=31';
import { clampRatch, nextRatch, syncRatchButton } from './step-ratch.js?v=1';
import {
    PARAMS,
    catalogDefault,
    clampToCatalog,
    getParam,
    isCatalogKey,
    isStepKey,
} from './param-catalog.js?v=4';

const subscribers = new Map();
const lastNotified = new Map();
const store = new Map();

/** True while set() is mirroring to the DOM so onDomCommit does not re-enter. */
let applyingSet = false;

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

/** elementFor, but disconnected nodes count as absent. */
export function connectedElementFor(key) {
    const el = elementFor(key);
    return el && el.isConnected ? el : null;
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
    if (el.tagName === 'BUTTON') {
        if (el.dataset?.ratch != null) return parseInt(el.dataset.ratch, 10) || 1;
        return !el.classList.contains('off');
    }
    return undefined;
}

function valuesEqual(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
    return String(a) === String(b);
}

function coerceForKey(key, value) {
    const spec = getParam(key);
    if (!spec) return value;
    if (spec.type === 'range') {
        const n = typeof value === 'number' ? value : parseFloat(value);
        if (!Number.isFinite(n)) return undefined;
        return clampToCatalog(key, n);
    }
    if (spec.type === 'button') return !!value;
    if (spec.type === 'ratch') {
        const n = typeof value === 'number' ? value : parseInt(value, 10);
        return Number.isFinite(n) ? clampRatch(n) : spec.default;
    }
    return String(value);
}

function valueToken(key, value) {
    if (typeof value === 'number' && Number.isFinite(value)) return `n:${value}`;
    if (typeof value === 'boolean') return `b:${value ? 1 : 0}`;
    return `s:${String(value)}`;
}

function notify(key, value) {
    const spec = getParam(key);
    const token = valueToken(key, value);
    if (spec?.type !== 'ratch' && lastNotified.get(key) === token) return;
    lastNotified.set(key, token);
    const fns = subscribers.get(key);
    if (!fns || fns.size === 0) return;
    fns.forEach((fn) => {
        try { fn(value, key); } catch (err) { console.error(err); }
    });
}

function readStepValue(key) {
    const spec = getParam(key);
    if (!spec?.stepField) return undefined;
    const live = getLiveStep(spec.stepIndex);
    const field = spec.stepField;
    if (field === 'on') return live.on !== false;
    if (field === 'accent' || field === 'slide') return !!live[field];
    if (field === 'ratch') return live.ratch;
    return live[field];
}

function writeStepValue(key, value) {
    const spec = getParam(key);
    if (!spec?.stepField) return false;
    const live = getLiveStep(spec.stepIndex);
    const field = spec.stepField;
    const next = coerceForKey(key, value);
    if (next === undefined) return false;
    const cur = readStepValue(key);
    if (valuesEqual(cur, next)) return false;
    if (field === 'on') live.on = !!next;
    else if (field === 'accent' || field === 'slide') live[field] = !!next;
    else if (field === 'ratch') live.ratch = next;
    else live[field] = next;
    return true;
}

/** Inspector mirror only — never the engine (no input/change/click). */
function silentMirror(el, value) {
    if (!el || !el.isConnected) return;
    if (el.tagName === 'BUTTON') {
        if (el.dataset?.ratch != null) {
            syncRatchButton(el, value);
            return;
        }
        el.classList.toggle('off', !value);
        el.setAttribute('aria-pressed', value ? 'true' : 'false');
        const front = el.querySelector('.front');
        if (front) {
            const label = front.textContent.trim();
            if (label === 'On' || label === 'Off') front.textContent = value ? 'On' : 'Off';
        }
        return;
    }
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
        el.checked = !!value;
        return;
    }
    if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return;
    if (String(el.value) !== String(value)) el.value = String(value);
}

function onDomCommit(event) {
    if (applyingSet) return;
    const el = event.target;
    if (!(el instanceof Element)) return;
    const key = keyFromElement(el);
    if (!key || !isCatalogKey(key)) return;
    if (connectedElementFor(key) !== el) return;
    const value = readValue(el);
    if (value === undefined) return;
    if (isStepKey(key)) {
        notify(key, readStepValue(key));
        return;
    }
    const spec = getParam(key);
    if (spec?.type === 'button' || spec?.type === 'ratch') return;
    const next = coerceForKey(key, value);
    if (next === undefined) return;
    if (valuesEqual(store.get(key), next)) return;
    store.set(key, next);
    notify(key, next);
}

function onButtonCommit(event) {
    if (applyingSet) return;
    const btn = event.target instanceof Element ? event.target.closest('button') : null;
    if (!btn) return;
    const key = keyFromElement(btn);
    if (!key || !isCatalogKey(key)) return;
    if (connectedElementFor(key) !== btn) return;
    const value = readValue(btn);
    if (isStepKey(key)) {
        notify(key, readStepValue(key));
        return;
    }
    if (valuesEqual(store.get(key), value)) return;
    store.set(key, value);
    notify(key, value);
}

document.addEventListener('input', onDomCommit, true);
document.addEventListener('change', onDomCommit, true);
document.addEventListener('click', onButtonCommit);

export function get(key) {
    if (isStepKey(key)) return readStepValue(key);
    if (store.has(key)) return store.get(key);
    return catalogDefault(key);
}

export function notifyKey(key) {
    if (!key) return;
    notify(key, get(key));
}

export function getNumber(key, fallback = 0) {
    const v = get(key);
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isFinite(n)) return n;
    const def = catalogDefault(key);
    if (typeof def === 'number' && Number.isFinite(def)) return def;
    const defN = parseFloat(def);
    if (Number.isFinite(defN)) return defN;
    return fallback;
}

export function getString(key, fallback = '') {
    const v = get(key);
    if (v == null) {
        const def = catalogDefault(key);
        if (def != null && def !== '') return String(def);
        return fallback;
    }
    return String(v);
}

export function getOscType(index, fallback = 'sawtooth') {
    return getString(`osc-type-${index}`, fallback);
}

export function getOscVol(index, fallback = 0.25) {
    return getNumber(`osc-vol-${index}`, fallback);
}

export function getOscPan(index, fallback = 0) {
    const pan = getNumber(`osc-pan-${index}`, fallback);
    if (!Number.isFinite(pan)) return fallback;
    return Math.max(-1, Math.min(1, pan));
}

/**
 * Write the store. Succeeds with no connected element. Silent value-mirror on
 * a connected node (inspector). Never click() / dispatchEvent — subscribers
 * are the engine.
 */
export function set(key, value) {
    if (!isCatalogKey(key)) return false;
    const spec = getParam(key);

    if (spec?.type === 'ratch') {
        return click(key);
    }

    if (spec?.type === 'button') {
        const next = !!value;
        if (isStepKey(key)) {
            if (!writeStepValue(key, next)) return false;
            notify(key, readStepValue(key));
            applyingSet = true;
            try { silentMirror(connectedElementFor(key), next); } finally { applyingSet = false; }
            return true;
        }
        if (valuesEqual(store.get(key), next)) return false;
        store.set(key, next);
        notify(key, next);
        applyingSet = true;
        try { silentMirror(connectedElementFor(key), next); } finally { applyingSet = false; }
        return true;
    }

    const next = coerceForKey(key, value);
    if (next === undefined) return false;

    if (isStepKey(key)) {
        if (!writeStepValue(key, next)) return false;
        notify(key, readStepValue(key));
        applyingSet = true;
        try { silentMirror(connectedElementFor(key), next); } finally { applyingSet = false; }
        return true;
    }

    if (valuesEqual(store.get(key), next)) return false;
    store.set(key, next);
    notify(key, next);
    applyingSet = true;
    try { silentMirror(connectedElementFor(key), next); } finally { applyingSet = false; }
    return true;
}

export function toggle(key) {
    return set(key, !get(key));
}

/** Cycle a non-boolean button (ratch). Never click() — live step is SoT. */
export function click(key) {
    if (isStepKey(key) && getParam(key)?.type === 'ratch') {
        const live = getLiveStep(getParam(key).stepIndex);
        live.ratch = nextRatch(live.ratch);
        applyingSet = true;
        try { silentMirror(connectedElementFor(key), live.ratch); } finally { applyingSet = false; }
        notify(key, live.ratch);
        return true;
    }
    return toggle(key);
}

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

export function subscribe(key, fn) {
    if (!key || typeof fn !== 'function') return () => {};
    let fns = subscribers.get(key);
    if (!fns) {
        fns = new Set();
        subscribers.set(key, fns);
    }
    fns.add(fn);
    try { fn(get(key), key); } catch (err) { console.error(err); }
    return () => {
        fns.delete(fn);
        if (fns.size === 0) subscribers.delete(key);
    };
}

function hydrateFromCatalogAndDom() {
    Object.entries(PARAMS).forEach(([key, spec]) => {
        if (spec.stepField) return;
        store.set(key, spec.default);
    });
    store.forEach((_, key) => {
        const spec = getParam(key);
        if (!spec || spec.type === 'button' || spec.type === 'ratch') return;
        const el = connectedElementFor(key);
        if (!el) return;
        const v = readValue(el);
        if (v === undefined) return;
        const next = coerceForKey(key, v);
        if (next !== undefined) store.set(key, next);
    });
}

hydrateFromCatalogAndDom();

export const params = {
    get, getNumber, getString, getOscType, getOscVol, getOscPan,
    set, toggle, click, notifyKey, subscribe, wireToggle, wireSelect,
    elementFor, connectedElementFor, keyFromElement,
};

if (typeof window !== 'undefined') {
    window.params = params;
}
