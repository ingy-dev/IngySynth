// Ingy 6 panel (poly / Juno-60): fader chrome + wiring to main synth params.

import { state } from './state.js?v=104';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=78';
import { updateLfoCutoffSafety } from './lfo-strip.js?v=15';
import { drawFilterADSRVisualizer, drawADSRVisualizer } from './visualizers.js?v=90';
import { refreshFilterInputDrive } from './filter-drive.js?v=4';
import { setFilterEnvInvert, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=79';

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
    document.querySelectorAll('#ingy6Panel .ingy6-fader:not(.ingy6-fader--hpf) .ingy6-fader-body').forEach((body) => {
        if (body.querySelector('.ingy6-fader-scale-labels')) return;
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
    const railY = silkRailY(base, label);

    drawSilk(line, [
        [startX, railY + SILK_BRANCH],
        [startX, railY],
        [endX, railY],
        [endX, railY + SILK_BRANCH],
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
    const railY = silkRailY(base, label);
    const stemBottom = Math.max(railY + SILK_BRANCH, sw.top - base.top);

    drawSilk(line, [
        [stemX, stemBottom],
        [stemX, railY],
        [endX, railY],
        [endX, railY + SILK_BRANCH],
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

function setMainRange(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const next = String(value);
    if (el.value === next) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function readMainRange(id, fallback = 0) {
    const n = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(n) ? n : fallback;
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
    const type = document.getElementById('noiseType')?.value || 'white';
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
    const el = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
    if (!el) return;
    const clamped = clamp(Number(value) || 0, 0, 1);
    el.value = String(clamped);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setOscTune(oscIndex, semis) {
    const el = document.querySelector(`.osc-tune[data-osc="${oscIndex}"]`);
    if (!el) return;
    const clamped = clamp(Math.round(semis), -12, 12);
    el.value = String(clamped);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Juno-60 sub is square-only — force OSC2 wave. */
function setSubOscSquare() {
    const typeMain = document.querySelector('.osc-type[data-osc="1"]');
    if (!typeMain) return;
    if (typeMain.value !== 'square') {
        typeMain.value = 'square';
        typeMain.dispatchEvent(new Event('change', { bubbles: true }));
    }
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
        const typeEl = document.getElementById('noiseType');
        if (typeEl && typeEl.value !== 'white') {
            typeEl.value = 'white';
            typeEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
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
            drawADSRVisualizer();
            break;
        case 'decay':
            setMainRange('decay', faderToLinear(v, 0, 2));
            drawADSRVisualizer();
            break;
        case 'sustain':
            setMainRange('sustain', faderToLinear(v, 0, 1));
            drawADSRVisualizer();
            break;
        case 'release':
            setMainRange('release', faderToLinear(v, 0, 5));
            drawADSRVisualizer();
            break;
        case 'cutoff':
            setMainRange('cutoff', faderToCutoff(v));
            break;
        case 'resonance':
            setMainRange('resonance', faderToLinear(v, 0, 20));
            break;
        case 'filterEnvAmount':
            setMainRange('filterEnvAmount', faderToLinear(v, 0, 100));
            drawFilterADSRVisualizer();
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
        default:
            break;
    }
}

function chorusButtonOn(id) {
    const el = document.getElementById(id);
    return !!(el && !el.classList.contains('off'));
}

function setChorusButton(id, wantOn) {
    const el = document.getElementById(id);
    if (!el) return;
    const isOn = !el.classList.contains('off');
    if (isOn !== !!wantOn) el.click();
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
    const typeMain = document.querySelector('.osc-type[data-osc="0"]');
    const osc1On = !!state.oscStates[0];
    const current = typeMain?.value;

    // Clicking the lit wave kills the main DCO
    if (osc1On && current === wave) {
        setOscEnabled(0, false);
        muteSharedOscGain(0);
        syncWaveUi();
        refreshFilterInputDrive();
        return;
    }

    if (typeMain && typeMain.value !== wave) {
        typeMain.value = wave;
        typeMain.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setOscEnabled(0, true);
    muteSharedOscGain(0);
    syncWaveUi();
    refreshFilterInputDrive();
}

function syncWaveUi() {
    const osc1On = !!state.oscStates[0];
    const current = document.querySelector('.osc-type[data-osc="0"]')?.value || '';
    document.querySelectorAll('#ingy6Panel .ingy6-wave-btn').forEach((btn) => {
        const on = osc1On && btn.dataset.wave === current;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function syncVcaGateUi() {
    const gate = !!state.polyVcaGate;
    document.querySelectorAll('#ingy6Panel .ingy6-switch-btn[data-vca]').forEach((btn) => {
        const match = gate ? btn.dataset.vca === 'gate' : btn.dataset.vca === 'env';
        // Match project toggle convention: lit when not .off
        btn.classList.toggle('off', !match);
        btn.setAttribute('aria-pressed', match ? 'true' : 'false');
    });
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

        syncWaveUi();
        syncChorusUi();
        syncVcaGateUi();
        syncPolarityUi();
        syncKeyboardFilterEnvFromMain();
    } finally {
        syncingFromMain = false;
    }
}

function readMainRangeFromOscVol(oscIndex) {
    const el = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
    const n = el ? parseFloat(el.value) : 0;
    return Number.isFinite(n) ? n : 0;
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

    panel.querySelectorAll('.ingy6-switch-btn[data-vca]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!state.keyboardPoly) return;
            state.polyVcaGate = btn.dataset.vca === 'gate';
            syncVcaGateUi();
        });
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
    ].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', () => {
            if (!state.keyboardPoly || syncingFromMain) return;
            syncIngy6PanelFromMain();
        });
    });
    document.querySelector('.osc-type[data-osc="0"]')?.addEventListener('change', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        syncWaveUi();
    });
    document.querySelector('.osc-toggle[data-osc="0"]')?.addEventListener('click', () => {
        if (!state.keyboardPoly || syncingFromMain) return;
        // Main/kb On/Off can mute OSC1 — keep Ingy wave lights honest
        requestAnimationFrame(() => syncWaveUi());
    });
    // OSC2 vol knob = dynamic SUB ceiling while Poly is on
    document.querySelector('.osc-vol[data-osc="1"]')?.addEventListener('input', () => {
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
    });
}

export function syncIngy6PanelUi() {
    const panel = document.getElementById('ingy6Panel');
    if (!panel) return;
    const on = !!state.keyboardPoly;
    panel.hidden = !on;
    setIngy6ControlsEnabled(on);
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
