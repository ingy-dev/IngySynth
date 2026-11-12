// Ingy 6 panel (poly / Juno-60): fader chrome + wiring to main synth params.

import { state } from './state.js?v=120';
import { beginMidiLearn } from './midi-learn.js?v=35';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=111';
import { updateLfoCutoffSafety } from './lfo-strip.js?v=72';
import { refreshFilterInputDrive } from './filter-drive.js?v=58';
import { setFilterEnvInvert, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=135';
import { get, getNumber, getOscType, getOscVol, set, subscribe } from './params.js?v=44';
import { LFO_SYNC_DIVISIONS } from './lfo-rate.js?v=69';
import { applyIngy6Lfo } from './ingy6-lfo.js?v=2';

const HPF_HZ = [20, 250, 700, 1400];

/** @type {WeakMap<Element, true>} */
const wiredSlots = new WeakMap();
let panelWired = false;
let syncingFromMain = false;
/** While > 0, ignore main→Ingy reverse sync so drags aren't yanked back. */
let ingyFaderDragDepth = 0;

function buildFaderTicks() {
    document.querySelectorAll('#ingy6Panel .ingy6-fader-ticks').forEach((ring) => {
        if (ring.childElementCount) return;
        const hpf = ring.classList.contains('ingy6-fader-ticks--hpf');
        const count = hpf ? 4 : 11;
        for (let i = 0; i < count; i++) {
            const tick = document.createElement('span');
            tick.className = 'ingy6-fader-tick';
            // Top → bottom: 10…0 (or 3…0 for HPF). Major at ends + middle.
            if (hpf || i === 0 || i === count - 1 || i === Math.floor((count - 1) / 2)) {
                tick.classList.add('ingy6-fader-tick--major');
            }
            ring.appendChild(tick);
        }
    });
}

/** 10 / 5 / 0 beside standard faders (Juno silk-screen). Skip HPF (has 3–0). */
function buildFaderScaleNumbers() {
    // First fader of each section only (Juno silk-screen); the rest share its scale,
    // which keeps the panel narrow enough with the LFO section added.
    document.querySelectorAll('#ingy6Panel .ingy6-section').forEach((section) => {
        const body = section.querySelector('.ingy6-fader:not(.ingy6-fader--hpf) .ingy6-fader-body');
        if (!body || body.querySelector('.ingy6-fader-scale-labels')) return;
        const ticks = body.querySelector('.ingy6-fader-ticks');
        if (!ticks) return;
        const labels = document.createElement('div');
        labels.className = 'ingy6-fader-scale-labels';
        labels.setAttribute('aria-hidden', 'true');
        labels.innerHTML = '<span>10</span><span>5</span><span>0</span>';
        body.insertBefore(labels, ticks);
    });
}

function faderValueFromClientY(slot, input, clientY) {
    const rect = slot.getBoundingClientRect();
    const h = rect.height || 1;
    // Top of slot = max, bottom = min (Juno silk)
    const pct = clamp(1 - (clientY - rect.top) / h, 0, 1);
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 10;
    const stepRaw = parseFloat(input.step);
    const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;
    const raw = lo + pct * (hi - lo);
    const stepped = Math.round(raw / step) * step;
    // Avoid float dust on integer steps
    const rounded = Math.round(stepped / step) * step;
    return clamp(rounded, lo, hi);
}

/** Custom pointer drag — native vertical range thumbs are unreliable when styled away. */
function wireFaderPointer(slot) {
    const input = slot.querySelector('.ingy6-fader-input');
    if (!input || input.dataset.ingy6PtrBound) return;
    input.dataset.ingy6PtrBound = '1';

    const applyFromEvent = (e) => {
        if (input.disabled || !state.keyboardPoly) return;
        const clientY = e.clientY;
        if (!Number.isFinite(clientY)) return;
        const next = faderValueFromClientY(slot, input, clientY);
        if (Number(input.value) === next) {
            syncFaderCap(slot);
            return;
        }
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const onPointerDown = (e) => {
        const fader = slot.closest('.ingy6-fader') || slot;
        const param = fader.dataset?.param;
        const mainId = {
            attack: 'attack',
            decay: 'decay',
            sustain: 'sustain',
            release: 'release',
            cutoff: 'cutoff',
            resonance: 'resonance',
            filterEnvAmount: 'filterEnvAmount',
            highPass: 'highPass',
            noise: 'noiseVol',
            vcaLevel: 'volume',
            ingy6LfoRate: 'ingy6LfoRate',
            ingy6LfoDelay: 'ingy6LfoDelay',
            ingy6DcoLfo: 'ingy6DcoLfo',
            ingy6VcfLfo: 'ingy6VcfLfo',
        }[param];
        if (beginMidiLearn(e, mainId, fader)) return;
        if (input.disabled || !state.keyboardPoly) return;
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        ingyFaderDragDepth += 1;
        try {
            slot.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        applyFromEvent(e);
    };

    const onPointerMove = (e) => {
        if (ingyFaderDragDepth <= 0) return;
        if (!slot.hasPointerCapture?.(e.pointerId) && e.buttons === 0) return;
        e.preventDefault();
        applyFromEvent(e);
    };

    const endDrag = (e) => {
        if (ingyFaderDragDepth <= 0) return;
        ingyFaderDragDepth = Math.max(0, ingyFaderDragDepth - 1);
        try {
            if (e?.pointerId != null) slot.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    };

    slot.addEventListener('pointerdown', onPointerDown);
    slot.addEventListener('pointermove', onPointerMove);
    slot.addEventListener('pointerup', endDrag);
    slot.addEventListener('pointercancel', endDrag);
    // Keyboard / native fallback still updates the cap
    input.addEventListener('input', () => syncFaderCap(slot));
}

function ensureFaderChrome() {
    document.querySelectorAll('#ingy6Panel .ingy6-fader-slot').forEach((slot) => {
        if (!slot.querySelector('.ingy6-fader-track')) {
            const track = document.createElement('div');
            track.className = 'ingy6-fader-track';
            track.setAttribute('aria-hidden', 'true');
            slot.insertBefore(track, slot.firstChild);
        }
        if (!slot.querySelector('.ingy6-fader-cap')) {
            const cap = document.createElement('div');
            cap.className = 'ingy6-fader-cap';
            cap.setAttribute('aria-hidden', 'true');
            const track = slot.querySelector('.ingy6-fader-track');
            slot.insertBefore(cap, track ? track.nextSibling : slot.firstChild);
        }
        wireFaderPointer(slot);
        syncFaderCap(slot);
    });
}

function syncFaderCap(slot) {
    const input = slot.querySelector('.ingy6-fader-input');
    const cap = slot.querySelector('.ingy6-fader-cap');
    if (!input || !cap) return;
    const min = parseFloat(input.min) || 0;
    const max = parseFloat(input.max) || 10;
    const value = parseFloat(input.value);
    const span = max - min || 1;
    const pct = Math.min(1, Math.max(0, ((Number.isFinite(value) ? value : min) - min) / span));
    // 0 at bottom, max at top — match Juno scale
    const travel = Math.max(0, slot.clientHeight - cap.offsetHeight);
    cap.style.top = `${(1 - pct) * travel}px`;
}

export function syncIngy6FaderCaps() {
    document.querySelectorAll('#ingy6Panel .ingy6-fader-slot').forEach(syncFaderCap);
}

/** Silk bracket branch length; shared so every section's rail sits at one height. */
const SILK_BRANCH = 5;

function silkQuery(sectionClass, selector) {
    return document.querySelector(`#ingy6Panel ${sectionClass} ${selector}`);
}

/** Rail height is derived from the label band, so all brackets line up. */
function silkRailY(base, labelRect) {
    return Math.max(0.5, labelRect.top - base.top - SILK_BRANCH - 1);
}

/**
 * The tall bracket every section uses: the rail sits one branch above the label
 * band and the branches drop two branch lengths, down to just above the labels.
 */
function silkTallRail(base, labelRect) {
    const branchBottom = silkRailY(base, labelRect) + SILK_BRANCH;
    return { railY: branchBottom - 2 * SILK_BRANCH, branchBottom };
}

function drawSilk(line, pts) {
    line.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
}

/**
 * DCO: bracket from the square wave button across to the SUB OSC fader,
 * with a short branch down at each end.
 */
function syncDcoSilk() {
    const line = silkQuery('.ingy6-section--dco', '.ingy6-silk-line');
    const body = silkQuery('.ingy6-section--dco', '.ingy6-section-body');
    const square = silkQuery('.ingy6-section--dco', '.ingy6-wave-btn[data-wave="square"]');
    const slotEl = silkQuery('.ingy6-section--dco', '.ingy6-fader[data-param="subOsc"] .ingy6-fader-slot');
    const labelEl = silkQuery('.ingy6-section--dco', '.ingy6-fader[data-param="subOsc"] .ingy6-fader-label');
    if (!line || !body || !square || !slotEl || !labelEl) return;

    const base = body.getBoundingClientRect();
    const sq = square.getBoundingClientRect();
    const slot = slotEl.getBoundingClientRect();
    const label = labelEl.getBoundingClientRect();
    if (!base.width || !sq.width || !slot.width) return;

    const startX = sq.left + sq.width / 2 - base.left;
    const endX = slot.left + slot.width / 2 - base.left;
    // Tall rail, same as Bare Metal's DCO and both VCF brackets.
    const { railY, branchBottom } = silkTallRail(base, label);

    drawSilk(line, [
        [startX, branchBottom],
        [startX, railY],
        [endX, railY],
        [endX, branchBottom],
    ]);
}

/**
 * VCF: bracket from the top of the polarity switch up to the rail, across, then
 * a branch down centred on the ENV fader track.
 */
function syncVcfSilk() {
    const line = silkQuery('.ingy6-section--vcf', '.ingy6-silk-line');
    const body = silkQuery('.ingy6-section--vcf', '.ingy6-section-body');
    const well = silkQuery('.ingy6-section--vcf', '.ingy6-polarity-well');
    const slotEl = silkQuery('.ingy6-section--vcf', '.ingy6-fader[data-param="filterEnvAmount"] .ingy6-fader-slot');
    const labelEl = silkQuery('.ingy6-section--vcf', '.ingy6-fader[data-param="filterEnvAmount"] .ingy6-fader-label');
    if (!line || !body || !well || !slotEl || !labelEl) return;

    const base = body.getBoundingClientRect();
    const sw = well.getBoundingClientRect();
    const slot = slotEl.getBoundingClientRect();
    const label = labelEl.getBoundingClientRect();
    if (!base.width || !sw.width || !slot.width) return;

    const stemX = sw.left + sw.width / 2 - base.left;
    const endX = slot.left + slot.width / 2 - base.left;
    // Same tall rail as the DCO brackets.
    const { railY, branchBottom } = silkTallRail(base, label);
    const stemBottom = Math.max(branchBottom, sw.top - base.top);

    drawSilk(line, [
        [stemX, stemBottom],
        [stemX, railY],
        [endX, railY],
        [endX, branchBottom],
    ]);
}

function syncIngy6Silk() {
    syncDcoSilk();
    syncVcfSilk();
}

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function faderToLinear(fader0to10, min, max) {
    return min + (clamp(fader0to10, 0, 10) / 10) * (max - min);
}

/** Ingy 6 LFO RATE: 0.3-20 Hz (Juno-60), exponential along the fader. */
const LFO_RATE_MIN = 0.3;
const LFO_RATE_MAX = 20;

function faderToLfoRate(v) {
    return LFO_RATE_MIN * Math.pow(LFO_RATE_MAX / LFO_RATE_MIN, clamp(v, 0, 10) / 10);
}

function lfoRateToFader(hz) {
    const safe = clamp(Number(hz) || LFO_RATE_MIN, LFO_RATE_MIN, LFO_RATE_MAX);
    return Math.round((Math.log(safe / LFO_RATE_MIN) / Math.log(LFO_RATE_MAX / LFO_RATE_MIN)) * 10);
}

/** With SYNC on, RATE picks a tempo division instead (slow at the bottom). */
function faderToSyncDivision(v) {
    return Math.round((clamp(v, 0, 10) / 10) * (LFO_SYNC_DIVISIONS.length - 1));
}

function syncDivisionToFader(idx) {
    return Math.round((clamp(Number(idx) || 0, 0, LFO_SYNC_DIVISIONS.length - 1) / (LFO_SYNC_DIVISIONS.length - 1)) * 10);
}

function linearToFader(value, min, max) {
    const span = max - min || 1;
    return Math.round(clamp(((Number(value) - min) / span) * 10, 0, 10));
}

function faderToCutoff(fader0to10) {
    const t = clamp(fader0to10, 0, 10) / 10;
    return 20 * Math.pow(10000 / 20, t);
}

function cutoffToFader(hz) {
    const safe = Math.max(20, Number(hz) || 20);
    const t = Math.log(safe / 20) / Math.log(10000 / 20);
    return Math.round(clamp(t * 10, 0, 10));
}

function hpfStepToHz(step) {
    return HPF_HZ[clamp(Math.round(step), 0, 3)] ?? 20;
}

function hzToHpfStep(hz) {
    const n = Number(hz) || 20;
    let best = 0;
    let bestDist = Infinity;
    HPF_HZ.forEach((target, i) => {
        const d = Math.abs(Math.log(Math.max(20, n)) - Math.log(target));
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    });
    return best;
}

/* ---- pop-up readouts: real values, worked out from the fader position ---- */

function readoutHz(hz) {
    if (!Number.isFinite(hz)) return '';
    if (hz >= 1000) return `${(hz / 1000).toFixed(hz < 10000 ? 2 : 1)} kHz`;
    return `${hz < 100 ? hz.toFixed(1) : Math.round(hz)} Hz`;
}

function readoutSec(sec) {
    if (!Number.isFinite(sec)) return '';
    if (sec < 1) return `${Math.round(sec * 1000)} ms`;
    return `${sec.toFixed(2)} s`;
}

function readoutAmount(v) {
    return String(Math.round(clamp(v, 0, 10) * 10));
}

/** What the touch pop-up shows for an Ingy 6 fader at position v (0-10). */
function formatIngy6Fader(param, v) {
    switch (param) {
        case 'ingy6LfoRate':
            if (get('ingy6LfoSync')) return LFO_SYNC_DIVISIONS[faderToSyncDivision(v)]?.label || '';
            return readoutHz(faderToLfoRate(v));
        case 'ingy6LfoDelay': {
            const t = (clamp(v, 0, 10) / 10) * 3.786; // 2.786 s wait + 1 s fade at full
            return t <= 0 ? 'OFF' : readoutSec(t);
        }
        case 'ingy6DcoLfo': return `±${Math.round((clamp(v, 0, 10) / 10) * 300)}¢`;
        case 'ingy6VcfLfo': return `±${((clamp(v, 0, 10) / 10) * 3).toFixed(1)} oct`;
        case 'cutoff': return readoutHz(faderToCutoff(v));
        case 'highPass': {
            const step = clamp(Math.round(v), 0, 3);
            return step === 0 ? 'OFF' : readoutHz(hpfStepToHz(step));
        }
        case 'attack':
        case 'decay': return readoutSec(faderToLinear(v, 0, 2));
        case 'release': return readoutSec(faderToLinear(v, 0, 5));
        default: return readoutAmount(v); // SUB, NOISE, RES, ENV, LEVEL, SUSTAIN
    }
}

function attachFaderReadouts() {
    document.querySelectorAll('#ingy6Panel .ingy6-fader').forEach((fader) => {
        const input = fader.querySelector('.ingy6-fader-input');
        const param = fader.dataset.param;
        if (!input || !param) return;
        fader.ingy6Readout = () => formatIngy6Fader(param, parseFloat(input.value));
    });
}

function setMainRange(id, value) {
    set(id, value);
}

function readMainRange(id, fallback = 0) {
    return getNumber(id, fallback);
}

function setFaderValue(param, value, { dispatch = false } = {}) {
    const fader = document.querySelector(`#ingy6Panel .ingy6-fader[data-param="${param}"] .ingy6-fader-input`);
    if (!fader) return;
    const next = String(value);
    if (fader.value !== next) fader.value = next;
    const slot = fader.closest('.ingy6-fader-slot');
    if (slot) syncFaderCap(slot);
    if (dispatch) fader.dispatchEvent(new Event('input', { bubbles: true }));
}

function ensureLiveNoiseSource() {
    if (!state.audioContext || !state.noiseBuffers?.white) return;
    const type = get('noiseType') || 'white';
    const buf = state.noiseBuffers[type] || state.noiseBuffers.white;
    if (state.noiseSource) return;
    const src = state.audioContext.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(state.noiseGain);
    src.start(0);
    state.noiseSource = src;
}

function stopLiveNoiseSource() {
    if (state.isPlaying) return;
    if (!state.noiseSource) return;
    try { state.noiseSource.stop(); } catch (_) { /* ignore */ }
    try { state.noiseSource.disconnect(); } catch (_) { /* ignore */ }
    state.noiseSource = null;
}

function setNoiseEnabled(enabled) {
    const want = !!enabled;
    state.noiseState = want;
    // Bare Metal's engine reads the param: without it the NOISE fader was silent there.
    if (!!get('noiseToggle') !== want) set('noiseToggle', want);
    const main = document.getElementById('noiseToggle');
    if (main) {
        const front = main.querySelector('.front');
        if (front) front.textContent = want ? 'On' : 'Off';
        main.classList.toggle('off', !want);
        main.setAttribute('aria-pressed', want ? 'true' : 'false');
    }
    const kb = document.getElementById('kbNoiseToggle');
    if (kb) {
        kb.classList.toggle('off', !want);
        kb.setAttribute('aria-pressed', want ? 'true' : 'false');
        kb.textContent = want ? 'On' : 'Off';
    }
    // In Poly, noiseGain is note-gated by poly-voice — never leave it pinned open
    if (state.keyboardPoly) {
        document.dispatchEvent(new CustomEvent('ingysynth:poly-noise-level'));
        return;
    }
    if (state.audioContext && state.noiseGain) {
        const volume = want ? readMainRange('noiseVol', 0) : 0;
        state.noiseGain.gain.cancelScheduledValues(state.audioContext.currentTime);
        state.noiseGain.gain.setValueAtTime(volume, state.audioContext.currentTime);
    }
}

function setOscEnabled(oscIndex, enabled) {
    const want = !!enabled;
    state.oscStates[oscIndex] = want;
    set(`osc-toggle-${oscIndex}`, want);
    const main = document.querySelector(`.osc-toggle[data-osc="${oscIndex}"]`);
    if (main) {
        const front = main.querySelector('.front');
        if (front) front.textContent = want ? 'On' : 'Off';
        main.classList.toggle('off', !want);
        main.setAttribute('aria-pressed', want ? 'true' : 'false');
    }
    const kb = document.querySelector(`.kb-osc-toggle[data-osc="${oscIndex}"]`);
    if (kb) {
        kb.classList.toggle('off', !want);
        kb.setAttribute('aria-pressed', want ? 'true' : 'false');
        kb.textContent = want ? 'On' : 'Off';
    }
}

function setOscVol(oscIndex, value) {
    const clamped = clamp(Number(value) || 0, 0, 1);
    set(`osc-vol-${oscIndex}`, clamped);
}

function setOscTune(oscIndex, semis) {
    const clamped = clamp(Math.round(semis), -12, 12);
    if (state.oscTunes) state.oscTunes[oscIndex] = clamped;
    set(`osc-tune-${oscIndex}`, clamped);
}

/** Juno-60 sub is square-only — force OSC2 wave. */
function setSubOscSquare() {
    set('osc-type-1', 'square');
}

/**
 * SUB fader is 0–100% of whatever OSC2 vol is set to (knob stays the ceiling).
 * Voice level = osc2Vol × (fader/10) — applied in poly-voice spawnVoiceOscs.
 */
function applySubLevel(fader0to10) {
    const pct = clamp(Number(fader0to10) || 0, 0, 10) / 10;
    if (pct > 0.001) {
        setSubOscSquare();
        setOscEnabled(1, true);
        setOscTune(1, -12);
        // Keep OSC2 vol at its set ceiling — do not overwrite with attenuated value
        const ceil = readMainRangeFromOscVol(1);
        if (Number.isFinite(ceil) && ceil > 0) state.polySubCeil = ceil;
    } else {
        setOscEnabled(1, false);
    }
    if (state.audioContext && state.oscGains?.[1]) {
        // Poly voices read state on note-on; keep shared mono gains muted
        state.oscGains[1].gain.cancelScheduledValues(state.audioContext.currentTime);
        state.oscGains[1].gain.setValueAtTime(0, state.audioContext.currentTime);
    }
    refreshFilterInputDrive();
}

function applyNoiseLevel(fader0to10) {
    const level = faderToLinear(fader0to10, 0, 1);
    setMainRange('noiseVol', level);
    if (level > 0.001) {
        set('noiseType', 'white');
        ensureLiveNoiseSource();
        setNoiseEnabled(true);
    } else {
        setNoiseEnabled(false);
        if (!state.keyboardPoly) stopLiveNoiseSource();
    }
    refreshFilterInputDrive();
}

function applyFaderParam(param, faderValue) {
    const v = Number(faderValue);
    switch (param) {
        case 'attack':
            setMainRange('attack', faderToLinear(v, 0, 2));
            break;
        case 'decay':
            setMainRange('decay', faderToLinear(v, 0, 2));
            break;
        case 'sustain':
            setMainRange('sustain', faderToLinear(v, 0, 1));
            break;
        case 'release':
            setMainRange('release', faderToLinear(v, 0, 5));
            break;
        case 'cutoff':
            setMainRange('cutoff', faderToCutoff(v));
            break;
        case 'resonance':
            setMainRange('resonance', faderToLinear(v, 0, 20));
            break;
        case 'filterEnvAmount':
            setMainRange('filterEnvAmount', faderToLinear(v, 0, 100));
            if (state.audioContext) {
                const cutoff = Math.max(40, readMainRange('cutoff', 1000));
                updateFilterCutoffRange(cutoff, state.audioContext.currentTime, 0.03);
                updateLfoCutoffSafety();
            }
            break;
        case 'highPass':
            setMainRange('highPass', hpfStepToHz(v));
            break;
        case 'vcaLevel':
            setMainRange('volume', faderToLinear(v, 0, 1));
            break;
        case 'subOsc':
            applySubLevel(v);
            break;
        case 'noise':
            applyNoiseLevel(v);
            break;
        case 'ingy6LfoRate':
            if (get('ingy6LfoSync')) set('ingy6LfoSyncDivision', faderToSyncDivision(v));
            else set('ingy6LfoRate', Math.round(faderToLfoRate(v) * 100) / 100);
            syncLfoRateLabel();
            break;
        case 'ingy6LfoDelay':
            set('ingy6LfoDelay', faderToLinear(v, 0, 1));
            break;
        case 'ingy6DcoLfo':
            set('ingy6DcoLfo', faderToLinear(v, 0, 1));
            break;
        case 'ingy6VcfLfo':
            set('ingy6VcfLfo', faderToLinear(v, 0, 1));
            break;
        default:
            break;
    }
}

function chorusButtonOn(id) {
    return !!get(id);
}

function setChorusButton(id, wantOn) {
    set(id, !!wantOn);
}

function setChorusMode(mode) {
    // OFF clears both; I and II are independent toggles (can both be on)
    if (mode === 'off') {
        setChorusButton('chorusI', false);
        setChorusButton('chorusII', false);
    } else if (mode === 'i') {
        setChorusButton('chorusI', !chorusButtonOn('chorusI'));
    } else if (mode === 'ii') {
        setChorusButton('chorusII', !chorusButtonOn('chorusII'));
    }
    if (chorusButtonOn('chorusI') || chorusButtonOn('chorusII')) {
        setMainRange('chorusAmount', 1);
    }
    syncChorusUi();
}

function syncChorusUi() {
    const iOn = chorusButtonOn('chorusI');
    const iiOn = chorusButtonOn('chorusII');
    const anyOn = iOn || iiOn;
    document.querySelectorAll('#ingy6Panel .ingy6-chorus-btn').forEach((btn) => {
        const key = btn.dataset.chorus;
        const on = key === 'off' ? !anyOn : (key === 'i' ? iOn : key === 'ii' ? iiOn : false);
        // Match project toggle convention: lit when not .off
        btn.classList.toggle('off', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

/** Mute shared mono osc gain — poly voices read state on note-on. */
function muteSharedOscGain(oscIndex) {
    if (!state.audioContext || !state.oscGains?.[oscIndex]) return;
    state.oscGains[oscIndex].gain.cancelScheduledValues(state.audioContext.currentTime);
    state.oscGains[oscIndex].gain.setValueAtTime(0, state.audioContext.currentTime);
}

/**
 * Juno-style latching main DCO waves: exclusive among themselves, all can be off
 * (sub-only / noise-only when those faders are up).
 */
function toggleMainWave(wave) {
    if (!wave) return;
    const osc1On = !!state.oscStates[0];
    const current = getOscType(0);

    // Clicking the lit wave kills the main DCO
    if (osc1On && current === wave) {
        setOscEnabled(0, false);
        muteSharedOscGain(0);
        syncWaveUi();
        refreshFilterInputDrive();
        return;
    }

    if (getOscType(0) !== wave) {
        set('osc-type-0', wave);
    }
    setOscEnabled(0, true);
    muteSharedOscGain(0);
    syncWaveUi();
    refreshFilterInputDrive();
}

function syncWaveUi() {
    const osc1On = !!state.oscStates[0];
    const current = getOscType(0);
    document.querySelectorAll('#ingy6Panel .ingy6-wave-btn').forEach((btn) => {
        const on = osc1On && btn.dataset.wave === current;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

/**
 * Juno-60 lever switches (PWM source, VCA mode): a slot with a lever and the
 * positions printed beside it. Click a label, or the slot at the height you want.
 * The lit label and data-pos follow the state.
 */
function syncLever(lever, activeLabel) {
    if (!lever) return;
    const labels = [...lever.querySelectorAll('.ingy6-lever-label')];
    labels.forEach((label, i) => {
        const on = label === activeLabel;
        label.classList.toggle('is-on', on);
        label.setAttribute('aria-checked', on ? 'true' : 'false');
        if (on) lever.dataset.pos = String(i);
    });
}

function wireLeverWells(panel) {
    panel.querySelectorAll('.ingy6-lever').forEach((lever) => {
        const well = lever.querySelector('.ingy6-lever-well');
        if (!well) return;
        well.addEventListener('click', (e) => {
            if (!state.keyboardPoly) return;
            const labels = [...lever.querySelectorAll('.ingy6-lever-label')];
            const r = well.getBoundingClientRect();
            if (!labels.length || !r.height) return;
            const i = clamp(Math.floor(((e.clientY - r.top) / r.height) * labels.length), 0, labels.length - 1);
            labels[i].click();
        });
    });
}

function syncVcaGateUi() {
    const gate = !!state.polyVcaGate;
    const want = gate ? 'gate' : 'env';
    const label = document.querySelector(`#ingy6Panel .ingy6-lever-label[data-vca="${want}"]`);
    syncLever(label?.closest('.ingy6-lever'), label);
}

function syncPolarityUi() {
    const btn = document.getElementById('ingy6FilterEnvInvert');
    if (!btn) return;
    const on = !!state.filterEnvInvert;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

export function setIngy6ControlsEnabled(enabled) {
    const on = !!enabled;
    document.querySelectorAll('#ingy6Panel input, #ingy6Panel button').forEach((el) => {
        el.disabled = !on;
    });
}

export function syncIngy6PanelFromMain() {
    if (!state.keyboardPoly) return;
    // Don't yank the fader under the pointer mid-drag
    if (ingyFaderDragDepth > 0) return;
    syncingFromMain = true;
    try {
        setFaderValue('attack', linearToFader(readMainRange('attack', 0), 0, 2));
        setFaderValue('decay', linearToFader(readMainRange('decay', 0.5), 0, 2));
        setFaderValue('sustain', linearToFader(readMainRange('sustain', 0.5), 0, 1));
        setFaderValue('release', linearToFader(readMainRange('release', 1), 0, 5));
        setFaderValue('cutoff', cutoffToFader(readMainRange('cutoff', 1000)));
        setFaderValue('resonance', linearToFader(readMainRange('resonance', 1), 0, 20));
        setFaderValue('filterEnvAmount', linearToFader(readMainRange('filterEnvAmount', 0), 0, 100));
        setFaderValue('highPass', hzToHpfStep(readMainRange('highPass', 20)));
        setFaderValue('vcaLevel', linearToFader(readMainRange('volume', 0.5), 0, 1));

        // SUB fader is independent UI (0–100% of live OSC2 vol); don't derive from osc-vol
        const ceil = readMainRangeFromOscVol(1);
        if (Number.isFinite(ceil) && ceil > 0) state.polySubCeil = ceil;

        const noiseOn = !!state.noiseState;
        const noiseVol = noiseOn ? readMainRange('noiseVol', 0) : 0;
        setFaderValue('noise', linearToFader(noiseVol, 0, 1));
        setFaderValue('ingy6LfoRate', get('ingy6LfoSync')
            ? syncDivisionToFader(getNumber('ingy6LfoSyncDivision', 6))
            : lfoRateToFader(getNumber('ingy6LfoRate', 3)));
        setFaderValue('ingy6LfoDelay', linearToFader(getNumber('ingy6LfoDelay', 0), 0, 1));
        setFaderValue('ingy6DcoLfo', linearToFader(getNumber('ingy6DcoLfo', 0), 0, 1));
        setFaderValue('ingy6VcfLfo', linearToFader(getNumber('ingy6VcfLfo', 0), 0, 1));
        syncLfoRateLabel();
        syncLfoSyncUi();

        syncWaveUi();
        syncChorusUi();
        syncVcaGateUi();
        syncPolarityUi();
        syncKeyboardFilterEnvFromMain();
    } finally {
        syncingFromMain = false;
    }
}

function syncLfoSyncUi() {
    const btn = document.getElementById('ingy6LfoSync');
    if (!btn) return;
    const on = !!get('ingy6LfoSync');
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/** RATE's label shows the division while synced (Juno-60 has no sync; this is ours). */
function syncLfoRateLabel() {
    const label = document.querySelector('#ingy6Panel .ingy6-fader[data-param="ingy6LfoRate"] .ingy6-fader-label');
    if (!label) return;
    if (!get('ingy6LfoSync')) {
        label.textContent = 'RATE';
        return;
    }
    const idx = clamp(Math.round(getNumber('ingy6LfoSyncDivision', 6)), 0, LFO_SYNC_DIVISIONS.length - 1);
    label.textContent = LFO_SYNC_DIVISIONS[idx]?.label || 'RATE';
}

/**
 * The Ingy 6 LFO plays the voices' pitch, as on the hardware, so the global LFO's
 * osc pitch destinations sit out while Ingy 6 is on. CUT/RES/HP/RING stay live.
 */
function syncGlobalLfoPitchDests() {
    const off = !!state.keyboardPoly;
    document.querySelectorAll('.keyboard-mod-matrix-knob[data-param$="PitchMod"]').forEach((knob) => {
        knob.classList.toggle('is-ingy6-off', off);
        knob.setAttribute('aria-disabled', off ? 'true' : 'false');
        knob.title = off ? 'Ingy 6 uses its own LFO for pitch (DCO LFO fader)' : '';
    });
}

function readMainRangeFromOscVol(oscIndex) {
    return getOscVol(oscIndex);
}

function wirePanelControls() {
    if (panelWired) return;
    panelWired = true;
    const panel = document.getElementById('ingy6Panel');
    if (!panel) return;

    panel.querySelectorAll('.ingy6-fader').forEach((wrap) => {
        const param = wrap.dataset.param;
        const input = wrap.querySelector('.ingy6-fader-input');
        if (!param || !input || wiredSlots.has(input)) return;
        wiredSlots.set(input, true);
        input.addEventListener('input', () => {
            if (syncingFromMain || !state.keyboardPoly) return;
            applyFaderParam(param, parseFloat(input.value));
        });
    });

    panel.querySelectorAll('.ingy6-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!state.keyboardPoly) return;
            toggleMainWave(btn.dataset.wave);
        });
    });

    panel.querySelectorAll('.ingy6-chorus-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!state.keyboardPoly) return;
            setChorusMode(btn.dataset.chorus);
        });
    });

    wireLeverWells(panel);

    panel.querySelectorAll('.ingy6-lever-label[data-vca]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!state.keyboardPoly) return;
            state.polyVcaGate = btn.dataset.vca === 'gate';
            syncVcaGateUi();
        });
    });

    document.getElementById('ingy6LfoSync')?.addEventListener('click', () => {
        if (!state.keyboardPoly) return;
        set('ingy6LfoSync', !get('ingy6LfoSync'));
        syncIngy6PanelFromMain();
    });

    document.getElementById('ingy6FilterEnvInvert')?.addEventListener('click', () => {
        if (!state.keyboardPoly) return;
        setFilterEnvInvert(!state.filterEnvInvert);
        syncPolarityUi();
    });

    // Keep Ingy faders honest when main knobs move
    [
        'attack', 'decay', 'sustain', 'release',
        'cutoff', 'resonance', 'filterEnvAmount', 'highPass', 'volume', 'noiseVol',
        'ingy6LfoRate', 'ingy6LfoDelay', 'ingy6LfoSync', 'ingy6LfoSyncDivision', 'ingy6DcoLfo', 'ingy6VcfLfo',
    ].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', () => {
            if (!state.keyboardPoly || syncingFromMain) return;
            syncIngy6PanelFromMain();
        });
        subscribe(id, () => {
            if (!state.keyboardPoly || syncingFromMain) return;
            syncIngy6PanelFromMain();
        });
    });
    document.querySelector('.osc-type[data-osc="0"]')?.addEventListener('change', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        syncWaveUi();
    });
    subscribe('osc-type-0', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        syncWaveUi();
    });
    document.querySelector('.osc-toggle[data-osc="0"]')?.addEventListener('click', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        // Main/kb On/Off can mute OSC1 — keep Ingy wave lights honest
        requestAnimationFrame(() => syncWaveUi());
    });
    subscribe('osc-toggle-0', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        syncWaveUi();
    });
    // OSC2 vol knob = dynamic SUB ceiling while Poly is on
    document.querySelector('.osc-vol[data-osc="1"]')?.addEventListener('input', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        const ceil = readMainRangeFromOscVol(1);
        if (Number.isFinite(ceil) && ceil > 0) state.polySubCeil = ceil;
        refreshFilterInputDrive();
    });
    subscribe('osc-vol-1', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        const ceil = readMainRangeFromOscVol(1);
        if (Number.isFinite(ceil) && ceil > 0) state.polySubCeil = ceil;
        refreshFilterInputDrive();
    });
    ['chorusI', 'chorusII'].forEach((id) => {
        document.getElementById(id)?.addEventListener('click', () => {
            if (!state.keyboardPoly || syncingFromMain) return;
            // After main toggle settles
            requestAnimationFrame(() => syncChorusUi());
        });
        subscribe(id, () => {
            if (!state.keyboardPoly || syncingFromMain) return;
            syncChorusUi();
        });
    });
}

export function syncIngy6PanelUi() {
    const panel = document.getElementById('ingy6Panel');
    if (!panel) return;
    const on = !!state.keyboardPoly;
    panel.hidden = !on;
    setIngy6ControlsEnabled(on);
    syncGlobalLfoPitchDests();
    applyIngy6Lfo();
    if (on) {
        syncIngy6PanelFromMain();
        requestAnimationFrame(() => {
            syncIngy6FaderCaps();
            syncIngy6Silk();
        });
    }
}

export function initIngy6Panel() {
    buildFaderTicks();
    buildFaderScaleNumbers();
    ensureFaderChrome();
    attachFaderReadouts();
    wirePanelControls();
    syncIngy6PanelUi();
    window.addEventListener('resize', () => {
        if (!state.keyboardPoly) return;
        syncIngy6FaderCaps();
        syncIngy6Silk();
    });
    // Label metrics shift once Michroma lands — silk is measured off them
    document.fonts?.ready?.then(() => {
        if (state.keyboardPoly) syncIngy6Silk();
    });
}
