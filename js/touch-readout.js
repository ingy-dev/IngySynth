// Mobile / touch value bubble. Same idea as the VR knob readout: appears on
// grab, sits above the control (so a finger never covers the number), lingers
// briefly after release. One document-level listener — knob code already
// publishes its live value on aria-valuetext or the on-panel readout.
// Amounts show as 0–100 (dial position). Tempo, pitch, time, pan, and
// bit depth keep their own units.

import { state } from './state.js?v=119';
import { formatRangeValue } from './knobs.js?v=163';

const TOUCH_MQ = '(max-width: 768px), (hover: none) and (pointer: coarse)';
const LINGER_MS = 520;
const GAP_PX = 10;
const EDGE_PX = 8;
const FADE_MS = 160;
const MAX_BUBBLES = 4;

const DIAL_SEL = '.synth-knob-dial[role="slider"], .mi-knob-dial[role="slider"]';

const RANGE_READOUT_SEL = [
    '.berlin-ctl-value',
    '.keyboard-master-tune-value',
    '.kb-osc-pan-value',
    '.kb-step-fine-value',
    '.berlin-step-fine-value',
].join(', ');

/** @type {HTMLElement[]} */
const pool = [];
/** @type {Map<number, BubbleEntry>} */
const active = new Map();
let rafId = 0;
let installed = false;

/**
 * @typedef {Object} BubbleEntry
 * @property {HTMLElement} bubble
 * @property {HTMLElement} anchor
 * @property {HTMLInputElement | null} input
 * @property {() => string} readValue
 * @property {number} hideAt
 * @property {boolean} fading
 * @property {number} lingerTimer
 * @property {number} fadeTimer
 */

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function textOf(el) {
    if (!el) return '';
    return (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function customCaption(el) {
    const host = el?.closest?.('[data-readout-caption]');
    return host?.getAttribute('data-readout-caption')?.trim() || '';
}

// Silk-screen abbreviations. Whole-label phrases first; tokens apply inside
// longer names (OSC 1, HPF frequency, cutoff mod).
const CAPTION_PHRASE = {
    a: 'attack',
    d: 'decay',
    s: 'sustain',
    r: 'release',
    hp: 'high pass',
    hpf: 'high pass',
    res: 'resonance',
    reso: 'resonance',
    vol: 'volume',
    div: 'division',
    cut: 'cutoff',
    chr: 'chorus',
    dly: 'delay',
    dec: 'decay',
    dist: 'distortion',
    env: 'envelope',
    freq: 'frequency',
    amt: 'amount',
    wet: 'dry/wet',
    pw: 'pulse width',
    arp: 'arpeggio',
    crush: 'bit depth',
    thresh: 'threshold',
    damp: 'damping',
    'env mod': 'envelope modulation',
    'sub osc': 'sub oscillator',
    'cut off freq': 'cutoff frequency',
    'cut off frequency': 'cutoff frequency',
    'tone n': 'tone / noise',
    'inv spread': 'inversion / spread',
};

const CAPTION_TOKEN = {
    osc: 'oscillator',
    drm: 'drum',
    hp: 'high pass',
    hpf: 'high pass',
    res: 'resonance',
    reso: 'resonance',
    vol: 'volume',
    div: 'division',
    chr: 'chorus',
    dly: 'delay',
    dec: 'decay',
    dist: 'distortion',
    env: 'envelope',
    freq: 'frequency',
    amt: 'amount',
    mod: 'modulation',
    vcf: 'filter',
    vca: 'amplifier',
    highpass: 'high pass',
    asymm: 'asymmetry',
    inharm: 'inharmonicity',
    pw: 'pulse width',
    arp: 'arpeggio',
    crush: 'bit depth',
    thresh: 'threshold',
    damp: 'damping',
    inv: 'inversion',
};

const CAPTION_CONTEXT = /\b(filter|reverb|sidechain|oscillator|master|noise|drum|lfo|compressor|unison|amplifier|delay|chorus|pitch|envelope|ring|high)\b/;

function normCaption(text) {
    return String(text || '')
        .replace(/µ/gi, 'micro')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function tidyCaption(text) {
    return text
        .replace(/\bmicro tune\b/g, 'microtune')
        .replace(/\bcut off\b/g, 'cutoff')
        .replace(/\bdry wet\b/g, 'dry/wet')
        .replace(/\s+/g, ' ')
        .trim();
}

function expandCaptionWords(text) {
    const key = normCaption(text);
    if (!key) return '';
    if (CAPTION_PHRASE[key]) return CAPTION_PHRASE[key];
    return key.split(' ').map((word) => CAPTION_TOKEN[word] || word).join(' ');
}

function isAbbrevCaption(printed) {
    if (/µ/.test(printed || '')) return true;
    const key = normCaption(printed);
    if (!key) return false;
    if (CAPTION_PHRASE[key]) return true;
    return key.split(' ').some((word) => CAPTION_TOKEN[word] && CAPTION_TOKEN[word] !== word);
}

function ariaAddsContext(face, access) {
    const faceWords = face.split(' ');
    const accessWords = access.split(' ');
    if (accessWords.length <= faceWords.length) return false;
    if (!faceWords.every((word) => accessWords.includes(word))) return false;
    return CAPTION_CONTEXT.test(access);
}

function chooseCaption(printed, aria) {
    const face = tidyCaption(expandCaptionWords(printed));
    const access = tidyCaption(expandCaptionWords(aria));
    if (!face) return access.toUpperCase();
    if (!access || face === access) return face.toUpperCase();
    if (isAbbrevCaption(printed)) return access.toUpperCase();
    if (ariaAddsContext(face, access)) return access.toUpperCase();
    return face.toUpperCase();
}

function withLane(el, caption) {
    if (!caption || !el?.closest) return caption;
    if (el.closest('.keyboard-step, .berlin-step')) return caption;
    const row = el.closest('.keyboard-drum-row, .berlin-row');
    if (!row) return caption;
    const legend = tidyCaption(expandCaptionWords(textOf(row.querySelector(':scope > legend')))).toUpperCase();
    if (!legend) return caption;
    if (caption.includes(legend)) return caption;
    const num = legend.match(/(\d+)$/)?.[1];
    const kind = legend.replace(/\s+\d+$/, '');
    if (num && caption.includes(kind) && caption.includes(num)) return caption;
    return `${legend} ${caption}`;
}

function finishCaption(el, printed, aria) {
    return withLane(el, chooseCaption(printed, aria));
}

function isBlocked(el) {
    if (!el) return true;
    if (el.matches?.(':disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.classList?.contains('disabled')) return true;
    return false;
}

function gestureAllowed(e) {
    if (state.midiMappingMode) return false;
    if (e.button != null && e.button !== 0) return false;
    if (e.pointerType === 'mouse' && !window.matchMedia(TOUCH_MQ).matches) return false;
    return true;
}

function visibleKnobValue(knob) {
    if (!knob) return '';
    const nodes = knob.querySelectorAll('.synth-knob-value');
    for (const el of nodes) {
        if (el.classList.contains('synth-knob-value--spacer')) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        const text = textOf(el);
        if (text) return text;
    }
    return '';
}

/** True when the readout is already a label (Hz, ms, 1/8, chord, L20), not a raw number. */
function isLabeled(text) {
    return !!text && !/^-?\d+(\.\d+)?$/.test(text);
}

function trimNum(n, decimals) {
    const s = Number(n).toFixed(decimals);
    return s.replace(/\.?0+$/, '') || '0';
}

function signed(n, decimals) {
    const mag = decimals > 0 ? trimNum(Math.abs(n), decimals) : String(Math.round(Math.abs(n)));
    if (n > 0) return `+${mag}`;
    if (n < 0) return `-${mag}`;
    return decimals > 0 ? trimNum(0, decimals) : '0';
}

function controlKey(el) {
    if (!el) return '';
    if (el.classList?.contains('kb-osc-pan') || el.classList?.contains('mixer-pan')) return 'pan';
    if (el.classList?.contains('kb-step-fine') || el.classList?.contains('berlin-step-fine')) return 'stepFine';
    if (el.closest?.('.keyboard-step-knob, .berlin-step-knob')) return 'stepTune';
    const host = el.closest?.('[data-param]');
    let key = host?.getAttribute('data-param') || '';
    if (key === 'steps') return 'stepCount';
    if (key === 'write-fine') return 'stepFine';
    if (key) return key;
    const id = el.id || '';
    const osc = id.match(/^(?:kb|mi)Osc(\d)TuneKnob$/);
    if (osc) return `osc-tune-${Number(osc[1]) - 1}`;
    if (id === 'kbTuningMasterTune' || id === 'kbXyTuningMasterTune') return 'masterTune';
    if (id === 'kbPatternSemiSwitch') return 'semitoneSwitch';
    if (id === 'kbSlideTime') return 'slideTime';
    if (id === 'kbLfoRateKnob') return 'lfoSpeed';
    if (id === 'kbScTimeKnob') return 'scTimeMs';
    return '';
}

/**
 * Units where a 0–100 position would hide the meaning. Same idea as VR
 * formatKnobValue: amounts become 0–100; counted params keep their unit.
 * Returns null when the caller should show the dial position instead.
 */
function formatCounted(key, raw) {
    const n = parseFloat(raw);
    const finite = Number.isFinite(n);
    if (key === 'tempo' && finite) return `${Math.round(n)} BPM`;
    if (key === 'stepCount' || key === 'division') return isLabeled(raw) ? raw : (finite ? String(Math.round(n)) : raw);
    if (key === 'lfoSpeed' || key === 'scTimeMs') return raw;
    if (key === 'slideTime' && finite) return `${Math.round(n)} ms`;
    if (key === 'bitDepth' && finite) return `${Math.round(n)} bit`;
    if (key === 'compThreshold' && finite) return `${Math.round(n)} dB`;
    if (key === 'unisonDetune' && finite) return `${Math.round(n)}¢`;
    if (key === 'stepFine') return isLabeled(raw) ? raw : (finite ? `${signed(n, 0)}¢` : raw);
    if (key === 'pan') return raw;
    if (key === 'gateLength' && finite) return String(Math.round(n));
    if (
        key === 'masterTune'
        || key === 'semitoneSwitch'
        || key === 'stepTune'
        || /^osc-tune-/.test(key)
        || /PitchMod$/.test(key)
    ) {
        if (!finite) return raw;
        const decimals = /PitchMod$/.test(key) ? 1 : 0;
        return `${signed(n, decimals)} st`;
    }
    return null;
}

function positionHundred(dial) {
    const norm = parseFloat(dial.style.getPropertyValue('--knob-norm'));
    if (!Number.isFinite(norm)) return '';
    return String(Math.round(clamp(norm, 0, 1) * 100));
}

function rangeHundred(input) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const value = parseFloat(input.value);
    if (!(max > min) || !Number.isFinite(value)) return '';
    return String(Math.round(clamp((value - min) / (max - min), 0, 1) * 100));
}

function scaleReadout(key, raw, hundred) {
    if (isLabeled(raw)) return raw;
    const counted = formatCounted(key, raw);
    if (counted != null) return counted;
    return hundred || raw;
}

function dialCaption(dial) {
    const custom = customCaption(dial);
    if (custom) return custom.toUpperCase();
    const knob = dial.closest('.synth-knob, .mi-knob');
    const label = textOf(knob?.querySelector('.synth-knob-label, .mi-knob-pill'));
    const aria = dial.getAttribute('aria-label') || '';
    if (label) return finishCaption(dial, label, aria);
    const legend = textOf(dial.closest('.keyboard-step')?.querySelector('legend'));
    if (legend) return `STEP ${legend}`;
    const num = textOf(dial.closest('.berlin-step')?.querySelector('.berlin-step-num'));
    if (num) return `STEP ${num}`;
    return finishCaption(dial, '', aria);
}

function readDialValue(dial) {
    // Some dials (sidechain time) refresh the on-panel span during the drag
    // and only write aria-valuetext on release.
    const raw = visibleKnobValue(dial.closest('.synth-knob'))
        || dial.getAttribute('aria-valuetext')
        || '';
    return scaleReadout(controlKey(dial), raw, positionHundred(dial));
}

function dialFromEvent(e) {
    const direct = e.target?.closest?.(DIAL_SEL);
    if (direct) return direct;
    const wrap = e.target?.closest?.('.synth-knob-dial-wrap, .mi-knob-dial-wrap');
    if (!wrap) return null;
    const dial = wrap.querySelector(DIAL_SEL);
    if (!dial) return null;
    const rect = dial.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        return null;
    }
    return dial;
}

function resolveDial(e) {
    const dial = dialFromEvent(e);
    if (!dial || isBlocked(dial)) return null;
    return {
        anchor: dial,
        input: null,
        caption: dialCaption(dial),
        readValue: () => readDialValue(dial),
    };
}

function rangeReadoutEl(input) {
    const scopes = [];
    if (input.parentElement) scopes.push(input.parentElement);
    const step = input.closest('.keyboard-step, .berlin-step, .keyboard-osc-pan-row, label');
    if (step && !scopes.includes(step)) scopes.push(step);
    for (const scope of scopes) {
        const found = scope.querySelector(RANGE_READOUT_SEL);
        if (found && scope.contains(input)) return found;
    }
    return null;
}

function isSkippableRange(input) {
    if (!input || input.type !== 'range') return true;
    if (isBlocked(input)) return true;
    if (input.getAttribute('aria-hidden') === 'true') return true;
    if (input.closest('.ingy6-fader-slot, .mixer-fader-slot')) return true;
    const cs = getComputedStyle(input);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return true;
    return false;
}

function rangeCaption(input) {
    const custom = customCaption(input);
    if (custom) return custom.toUpperCase();
    const label = input.closest('label');
    const named = textOf(label?.querySelector('.berlin-ctl-label, .keyboard-master-tune-label, .keyboard-osc-pan-label'))
        || textOf(input.closest('.keyboard-osc-pan-row')?.querySelector('.keyboard-osc-pan-label'));
    return finishCaption(input, named, input.getAttribute('aria-label') || '');
}

function resolveRange(target) {
    const input = target?.closest?.('input[type="range"]');
    if (isSkippableRange(input)) return null;
    const readout = rangeReadoutEl(input);
    return {
        anchor: input,
        input,
        caption: rangeCaption(input),
        readValue: () => {
            const live = textOf(readout) || formatRangeValue(input);
            return scaleReadout(controlKey(input), live, rangeHundred(input));
        },
    };
}

function faderCap(slot) {
    return slot.querySelector('.mixer-fader-cap, .ingy6-fader-cap') || slot;
}

function resolveFader(target) {
    const slot = target?.closest?.('.ingy6-fader-slot, .mixer-fader-slot');
    if (!slot) return null;
    const input = slot.querySelector('input[type="range"]');
    if (!input || isBlocked(input) || isBlocked(slot)) return null;
    const mixer = slot.closest('.mixer-strip');
    if (mixer) {
        const name = textOf(mixer.querySelector('.mixer-name'));
        const caption = customCaption(slot)
            || finishCaption(slot, name ? `${name} LEVEL` : '', input.getAttribute('aria-label') || 'level');
        const valueEl = mixer.querySelector(':scope > .mixer-level-value');
        return {
            anchor: faderCap(slot),
            input,
            caption,
            readValue: () => {
                const live = textOf(valueEl);
                if (live) return live;
                const n = parseFloat(input.value);
                if (!Number.isFinite(n)) return formatRangeValue(input);
                return String(Math.round(clamp(n, 0, 1) * 100));
            },
        };
    }
    const ingyLabel = textOf(slot.closest('.ingy6-fader')?.querySelector('.ingy6-fader-label'));
    const caption = customCaption(slot)
        || finishCaption(slot, ingyLabel, input.getAttribute('aria-label') || '');
    return {
        anchor: faderCap(slot),
        input,
        caption,
        readValue: () => formatRangeValue(input),
    };
}

function resolveTarget(e) {
    return resolveDial(e) || resolveFader(e.target) || resolveRange(e.target);
}

function thumbBox(input) {
    const rect = input.getBoundingClientRect();
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const value = parseFloat(input.value);
    if (!(max > min) || !Number.isFinite(value)) return rect;
    const pct = clamp((value - min) / (max - min), 0, 1);
    const thumb = 16;
    const travel = Math.max(0, rect.width - thumb);
    const x = rect.left + thumb / 2 + pct * travel;
    return {
        left: x - thumb / 2,
        top: rect.top,
        right: x + thumb / 2,
        bottom: rect.bottom,
        width: thumb,
        height: rect.height,
    };
}

function anchorRect(entry) {
    const { anchor, input } = entry;
    if (!anchor?.isConnected) return null;
    if (input && anchor === input) return thumbBox(input);
    return anchor.getBoundingClientRect();
}

function intersectsViewport(rect) {
    return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
}

function placeBubble(entry) {
    const rect = anchorRect(entry);
    const bubble = entry.bubble;
    if (!rect || !intersectsViewport(rect)) return false;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    if (bw < 1 || bh < 1) return false;
    const anchorCx = rect.left + rect.width / 2;
    let left = anchorCx - bw / 2;
    let top = rect.top - GAP_PX - bh;
    let below = false;
    if (top < EDGE_PX) {
        const belowTop = rect.bottom + GAP_PX;
        if (belowTop + bh <= window.innerHeight - EDGE_PX) {
            top = belowTop;
            below = true;
        } else {
            top = EDGE_PX;
        }
    }
    const maxLeft = window.innerWidth - EDGE_PX - bw;
    left = clamp(left, EDGE_PX, Math.max(EDGE_PX, maxLeft));
    const maxTop = window.innerHeight - EDGE_PX - bh;
    top = clamp(top, EDGE_PX, Math.max(EDGE_PX, maxTop));
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
    const inset = 14;
    const caretX = clamp(anchorCx - left, inset, Math.max(inset, bw - inset));
    bubble.style.setProperty('--caret-x', `${caretX}px`);
    bubble.classList.toggle('touch-readout--below', below);
    return true;
}

function createBubble() {
    const bubble = document.createElement('div');
    bubble.className = 'touch-readout';
    bubble.hidden = true;
    bubble.setAttribute('aria-hidden', 'true');
    const caption = document.createElement('span');
    caption.className = 'touch-readout-caption';
    const value = document.createElement('span');
    value.className = 'touch-readout-value';
    bubble.append(caption, value);
    document.body.appendChild(bubble);
    return bubble;
}

function takeBubble() {
    return pool.pop() || createBubble();
}

function paintEntry(entry) {
    const valueEl = entry.bubble.querySelector('.touch-readout-value');
    if (!valueEl) return;
    let next = '';
    try {
        next = entry.readValue() || '';
    } catch (_) {
        return;
    }
    if (valueEl.textContent !== next) valueEl.textContent = next;
}

function clearEntryTimers(entry) {
    clearTimeout(entry.lingerTimer);
    clearTimeout(entry.fadeTimer);
    entry.lingerTimer = 0;
    entry.fadeTimer = 0;
}

function beginFade(pointerId) {
    const entry = active.get(pointerId);
    if (!entry || entry.fading) return;
    entry.fading = true;
    entry.bubble.classList.remove('is-visible');
    clearTimeout(entry.fadeTimer);
    entry.fadeTimer = setTimeout(() => retire(pointerId), FADE_MS);
}

function retire(pointerId) {
    const entry = active.get(pointerId);
    if (!entry) return;
    clearEntryTimers(entry);
    active.delete(pointerId);
    const bubble = entry.bubble;
    bubble.classList.remove('is-visible', 'touch-readout--below');
    bubble.hidden = true;
    pool.push(bubble);
    ensureLoop();
}

/**
 * @param {number} pointerId
 * @param {{ anchor: HTMLElement, input: HTMLInputElement | null, caption: string, readValue: () => string }} spec
 */
function present(pointerId, spec) {
    let entry = active.get(pointerId);
    if (!entry && active.size >= MAX_BUBBLES) return;
    if (!entry) {
        entry = {
            bubble: takeBubble(),
            anchor: spec.anchor,
            input: spec.input,
            readValue: spec.readValue,
            hideAt: Infinity,
            fading: false,
            lingerTimer: 0,
            fadeTimer: 0,
        };
        active.set(pointerId, entry);
    }
    clearEntryTimers(entry);
    entry.anchor = spec.anchor;
    entry.input = spec.input;
    entry.readValue = spec.readValue;
    entry.hideAt = Infinity;
    entry.fading = false;
    const bubble = entry.bubble;
    bubble.querySelector('.touch-readout-caption').textContent = spec.caption;
    bubble.querySelector('.touch-readout-value').textContent = spec.readValue();
    const reveal = bubble.hidden || !bubble.classList.contains('is-visible');
    bubble.hidden = false;
    placeBubble(entry);
    if (reveal) {
        bubble.classList.remove('is-visible');
        void bubble.offsetWidth;
        bubble.classList.add('is-visible');
    }
    ensureLoop();
}

function release(pointerId) {
    const entry = active.get(pointerId);
    if (!entry || entry.fading) return;
    entry.hideAt = performance.now() + LINGER_MS;
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = setTimeout(() => beginFade(pointerId), LINGER_MS);
    ensureLoop();
}

function releaseAll() {
    // rAF is paused while the page is hidden, so drop bubbles immediately.
    for (const id of [...active.keys()]) retire(id);
}

function frame() {
    rafId = 0;
    for (const [id, entry] of active) {
        if (entry.fading) continue;
        paintEntry(entry);
        if (!placeBubble(entry)) beginFade(id);
    }
    if ([...active.values()].some((entry) => !entry.fading)) {
        rafId = requestAnimationFrame(frame);
    }
}

function ensureLoop() {
    if (!rafId && active.size) rafId = requestAnimationFrame(frame);
}

function onPointerDown(e) {
    if (!gestureAllowed(e)) return;
    if (!e.target || typeof e.target.closest !== 'function') return;
    const spec = resolveTarget(e);
    if (!spec) return;
    present(e.pointerId, spec);
}

function onPointerMove(e) {
    if (!active.has(e.pointerId)) return;
    const pointerId = e.pointerId;
    // Dial handlers update the value during the target phase, after this
    // capture listener. Paint once that stack unwinds, before the next frame.
    queueMicrotask(() => {
        const entry = active.get(pointerId);
        if (!entry || entry.fading) return;
        paintEntry(entry);
        placeBubble(entry);
    });
}

function onInput(e) {
    for (const entry of active.values()) {
        if (entry.fading || !entry.input || e.target !== entry.input) continue;
        paintEntry(entry);
        placeBubble(entry);
    }
}

function onPointerUp(e) {
    release(e.pointerId);
}

function onVisibility() {
    if (document.hidden) releaseAll();
}

export function initTouchReadout() {
    if (installed) return;
    installed = true;
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('input', onInput);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onVisibility);
}
