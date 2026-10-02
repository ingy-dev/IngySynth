// Circular performance knobs on the chromatic keyboard (tempo, division,
// steps, cutoff, resonance, high pass). Drive the existing #tempo / #division /
// #stepCount / #cutoff / #resonance / #highPass controls so Sequencer / Filter
// panel, XY pad, and audio engine stay in sync.

import { previewStepsOnVfd } from './sequencer.js?v=416';
import { state } from './state.js?v=116';
import { beginMidiLearn } from './midi-learn.js?v=7';
import { connectedElementFor, get, getNumber, keyFromElement, set, subscribe } from './params.js?v=15';
import { getParam, isCatalogKey } from './param-catalog.js?v=3';
import { stepTuneBounds } from './step-tune-range.js?v=24';

const ANGLE_MIN = -135;
const ANGLE_MAX = 135;
const DRAG_PIXELS = 120; // vertical drag distance for full range

/** Transport / keyboard-performance controls — no double-click reset. */
const RESET_EXCLUDE_IDS = new Set([
    'tempo',
    'division',
    'keyboardMasterTune',
    'kbTuningMasterTune',
    'kbXyTuningMasterTune',
    'kbWriteFineProxy',
]);

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_MOVE_PX = 8;

const KNOB_BINDINGS = [
    { dialId: 'kbTempoKnob', inputId: 'tempo', valueId: 'kbTempoValue' },
    { dialId: 'kbStepsKnob', inputId: 'stepCount', valueId: 'kbStepsValue' },
    { dialId: 'kbCutoffKnob', inputId: 'cutoff' },
    { dialId: 'kbResonanceKnob', inputId: 'resonance' },
    { dialId: 'kbHighPassKnob', inputId: 'highPass' },
    { dialId: 'kbFilterAttackKnob', inputId: 'filterAttack' },
    { dialId: 'kbFilterDecayKnob', inputId: 'filterDecay' },
    { dialId: 'kbFilterSustainKnob', inputId: 'filterSustain' },
    { dialId: 'kbFilterReleaseKnob', inputId: 'filterRelease' },
    { dialId: 'kbFilterEnvAmountKnob', inputId: 'filterEnvAmount', valueId: 'kbFilterEnvAmountValue' },
    // Acid Mode strip (mirrors same params as Filter / Pattern knobs)
    { dialId: 'kbAcidTuningKnob', inputId: 'masterTune', valueId: 'kbAcidTuningValue' },
    { dialId: 'kbAcidCutoffKnob', inputId: 'cutoff' },
    { dialId: 'kbAcidResonanceKnob', inputId: 'resonance' },
    { dialId: 'kbAcidEnvModKnob', inputId: 'filterEnvAmount' },
    { dialId: 'kbAcidDecayKnob', inputId: 'filterDecay' },
    { dialId: 'kbAcidAccentKnob', inputId: 'accentAmount', valueId: 'kbAcidAccentValue' },
    { dialId: 'kbAcidDistortionKnob', inputId: 'distortion', valueId: 'kbAcidDistortionValue' },
    { dialId: 'kbNoiseVolKnob', inputId: 'noiseVol' },
    { dialId: 'kbAttackKnob', inputId: 'attack' },
    { dialId: 'kbDecayKnob', inputId: 'decay' },
    { dialId: 'kbSustainKnob', inputId: 'sustain' },
    { dialId: 'kbReleaseKnob', inputId: 'release' },
    { dialId: 'kbVolumeKnob', inputId: 'volume' },
    { dialId: 'kbDistortionKnob', inputId: 'distortion' },
    { dialId: 'kbBitDepthKnob', inputId: 'bitDepth', valueId: 'kbBitDepthValue' },
    { dialId: 'kbRingModKnob', inputId: 'ringMod' },
    { dialId: 'kbChorusAmountKnob', inputId: 'chorusAmount' },
    { dialId: 'kbDelayAmountKnob', inputId: 'delayAmount' },
    { dialId: 'kbReverbSizeKnob', inputId: 'reverbSize' },
    { dialId: 'kbReverbDecayKnob', inputId: 'reverbDecay' },
    { dialId: 'kbReverbDampKnob', inputId: 'reverbDamp' },
    { dialId: 'kbReverbAmountKnob', inputId: 'reverbAmount' },
    // RATE dial is mode-aware (Hz / Sync) — wired in lfo-rate.js
    { dialId: 'kbCutoffModKnob', inputId: 'cutoffMod' },
    { dialId: 'kbResonanceModKnob', inputId: 'resonanceMod' },
    { dialId: 'kbHighpassModKnob', inputId: 'highpassMod' },
    { dialId: 'kbOsc1PitchModKnob', inputId: 'osc1PitchMod' },
    { dialId: 'kbOsc2PitchModKnob', inputId: 'osc2PitchMod' },
    { dialId: 'kbOsc3PitchModKnob', inputId: 'osc3PitchMod' },
    { dialId: 'kbOsc4PitchModKnob', inputId: 'osc4PitchMod' },
    { dialId: 'kbRingFreqModKnob', inputId: 'ringFreqMod' },
    { dialId: 'kbOsc4HarmonicsKnob', inputId: 'osc4Harmonics', valueId: 'kbOsc4HarmonicsValue' },
    { dialId: 'kbOsc4TimbreKnob', inputId: 'osc4MorphX', valueId: 'kbOsc4TimbreValue' },
    { dialId: 'kbOsc4MorphKnob', inputId: 'osc4MorphY', valueId: 'kbOsc4MorphValue' },
];

const DIVISION_STEPS = [
    { value: '2', label: '1/2' },
    { value: '4', label: '1/4' },
    { value: '8', label: '1/8' },
    { value: '16', label: '1/16' },
];

const STEPPED_DRAG_PIXELS = 90; // vertical drag for full stepped range

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function canResetKey(key) {
    if (!key || RESET_EXCLUDE_IDS.has(key)) return false;
    return true;
}

function canResetInput(input) {
    if (!input || input.disabled) return false;
    const key = keyFromElement(input) || input.id || '';
    if (key && RESET_EXCLUDE_IDS.has(key)) return false;
    return true;
}

function currentParamValue(key, input) {
    if (key) {
        const n = getNumber(key, NaN);
        if (Number.isFinite(n)) return n;
        const v = get(key);
        if (v != null && v !== '') return v;
    }
    if (input) {
        const n = parseFloat(input.value);
        if (Number.isFinite(n)) return n;
        return input.value;
    }
    return 0;
}

function rangeBounds(key, input) {
    if (key && key.startsWith('step-slider-')) {
        return stepTuneBounds(getNumber(key, 0));
    }
    const spec = key ? getParam(key) : null;
    if (spec?.type === 'range') {
        return { min: spec.min, max: spec.max, step: spec.step || 1 };
    }
    if (input) {
        return {
            min: parseFloat(input.min),
            max: parseFloat(input.max),
            step: parseFloat(input.step) || parseFloat(input.dataset?.displayStep) || 1,
        };
    }
    return { min: 0, max: 1, step: 0.01 };
}

/**
 * Snap a range/select back to catalog default (or HTML defaultValue for Berlin).
 * @returns {boolean} true if value changed
 */
export function resetInputToDefault(input, { eventName = 'input', key: keyOpt } = {}) {
    const key = keyOpt
        || (typeof input === 'string' ? input : (input ? (keyFromElement(input) || input.id) : null));
    const spec = key ? getParam(key) : null;
    if (key && spec && spec.type !== 'ratch') {
        if (!canResetKey(key)) return false;
        const cur = currentParamValue(key, typeof input === 'string' ? null : input);
        const next = spec.default;
        if (spec.type === 'range' && parseFloat(cur) === next) return false;
        if (spec.type !== 'range' && String(cur) === String(next)) return false;
        return set(key, next);
    }
    const el = typeof input === 'string' ? null : input;
    if (!canResetInput(el)) return false;
    const next = el.defaultValue;
    if (String(el.value) === String(next)) return false;
    el.value = next;
    el.dispatchEvent(new Event(eventName, { bubbles: true }));
    if (eventName !== 'change') {
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
}

/**
 * Attach dblclick + double-tap reset on a dial. pointerdown preventDefault
 * often blocks native dblclick, so we also detect two quick taps.
 */
function attachDialReset(dial, onReset) {
    if (!dial || typeof onReset !== 'function') return;

    dial.addEventListener('dblclick', (e) => {
        if (state.midiMappingMode) return;
        e.preventDefault();
        e.stopPropagation();
        onReset();
    });

    let lastTapAt = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let downX = 0;
    let downY = 0;
    let moved = false;

    dial.addEventListener('pointerdown', (e) => {
        if (state.midiMappingMode) return;
        if (e.button !== undefined && e.button !== 0) return;
        downX = e.clientX;
        downY = e.clientY;
        moved = false;
    }, true);

    dial.addEventListener('pointermove', (e) => {
        if (Math.abs(e.clientX - downX) > DOUBLE_TAP_MOVE_PX
            || Math.abs(e.clientY - downY) > DOUBLE_TAP_MOVE_PX) {
            moved = true;
        }
    }, true);

    dial.addEventListener('pointerup', (e) => {
        if (state.midiMappingMode) return;
        if (e.button !== undefined && e.button !== 0) return;
        if (moved) {
            lastTapAt = 0;
            return;
        }
        const now = performance.now();
        const dt = now - lastTapAt;
        const near = Math.abs(e.clientX - lastTapX) <= DOUBLE_TAP_MOVE_PX
            && Math.abs(e.clientY - lastTapY) <= DOUBLE_TAP_MOVE_PX;
        if (dt > 0 && dt <= DOUBLE_TAP_MS && near) {
            lastTapAt = 0;
            e.preventDefault();
            e.stopPropagation();
            onReset();
            return;
        }
        lastTapAt = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
    }, true);
}

/** Stash HTML step once — automation briefly sets step="any" during apply. */
export function ensureDisplayStep(input) {
    if (!input || !(input instanceof HTMLInputElement)) return;
    if (input.dataset.displayStep) return;
    const attr = input.getAttribute('step');
    // Never learn from the temporary automation override
    if (attr === 'any') return;
    input.dataset.displayStep = attr || '1';
}

function displayStepDecimals(step) {
    if (!(step > 0) || step >= 1) return 0;
    const s = String(step);
    if (/e/i.test(s)) {
        return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-12)));
    }
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : Math.min(6, s.length - dot - 1);
}

const OSC4_CHORD_NAMES = [
    'OCT', '5TH', 'SUS4', 'MIN', 'MIN7', 'MIN9', 'MIN11', '6ADD9', 'MAJ9', 'MAJ7', 'MAJ',
];

export function chordNameFromHarmonics(h) {
    const n = OSC4_CHORD_NAMES.length;
    const v = Math.max(0, Math.min(1, Number(h) || 0));
    const i = Math.floor(v * 1.02 * n);
    return OSC4_CHORD_NAMES[Math.max(0, Math.min(n - 1, i))];
}

function osc4ChordReadout(value) {
    if (!state.osc4Wavetable) return null;
    const model = state.osc4Model;
    if (model !== 'chord' && model !== 'chiptune' && model !== 'string_machine') return null;
    return chordNameFromHarmonics(value);
}

/** Readout string from native step (display only; input keeps full precision). */
export function formatRangeValue(input) {
    if (!input) return '';
    if (input.id === 'osc4Harmonics') {
        const chord = osc4ChordReadout(parseFloat(input.value));
        if (chord) return chord;
    }
    ensureDisplayStep(input);
    const n = parseFloat(input.value);
    if (!Number.isFinite(n)) return String(input.value ?? '');
    const step = parseFloat(input.dataset.displayStep || '1') || 1;
    const min = parseFloat(input.min);
    const base = Number.isFinite(min) ? min : 0;
    const snapped = Math.round((n - base) / step) * step + base;
    const decimals = displayStepDecimals(step);
    if (decimals <= 0) return String(Math.round(snapped));
    return snapped.toFixed(decimals);
}

function valueToNormFromRange(min, max, value) {
    if (max === min) return 0;
    return clamp((value - min) / (max - min), 0, 1);
}

function valueToNorm(input) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const value = parseFloat(input.value);
    return valueToNormFromRange(min, max, value);
}

function normToValueFromRange(min, max, step, norm) {
    const raw = min + clamp(norm, 0, 1) * (max - min);
    if (step > 0 && Number.isFinite(step)) {
        const snapped = Math.round((raw - min) / step) * step + min;
        return clamp(snapped, min, max);
    }
    return raw;
}

function normToValue(input, norm) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    ensureDisplayStep(input);
    const liveStep = parseFloat(input.step);
    const step = (Number.isFinite(liveStep) && liveStep > 0)
        ? liveStep
        : (parseFloat(input.dataset.displayStep) || 1);
    return normToValueFromRange(min, max, step, norm);
}

function formatParamReadout(key, value, input) {
    if (key === 'osc4Harmonics') {
        const n = typeof value === 'number' ? value : parseFloat(value);
        const chord = osc4ChordReadout(Number.isFinite(n) ? n : 0);
        if (chord) return chord;
    }
    const spec = key ? getParam(key) : null;
    const n = typeof value === 'number' ? value : parseFloat(value);
    const step = spec?.step || (input ? parseFloat(input.dataset?.displayStep || input.step) : 1) || 1;
    const min = spec?.min ?? (input ? parseFloat(input.min) : 0);
    const base = Number.isFinite(min) ? min : 0;
    if (!Number.isFinite(n)) return String(value ?? '');
    const snapped = Math.round((n - base) / step) * step + base;
    const decimals = displayStepDecimals(step);
    if (decimals <= 0) return String(Math.round(snapped));
    return snapped.toFixed(decimals);
}

function setKnobAngle(dial, norm) {
    const n = clamp(norm, 0, 1);
    const angle = ANGLE_MIN + n * (ANGLE_MAX - ANGLE_MIN);
    dial.style.setProperty('--knob-angle', `${angle}deg`);
    dial.style.setProperty('--knob-norm', String(n));
    const wrap = dial.closest?.('.synth-knob-dial-wrap, .mi-knob-dial-wrap');
    if (wrap) {
        wrap.style.setProperty('--knob-angle', `${angle}deg`);
        wrap.style.setProperty('--knob-norm', String(n));
    }
    dial.setAttribute('aria-valuenow', String(Math.round(n * 1000) / 1000));
}

function syncValueDisplay(valueEl, input) {
    if (!valueEl) return;
    valueEl.textContent = formatRangeValue(input);
}

function syncDialFromInput(dial, input, valueEl) {
    const norm = valueToNorm(input);
    setKnobAngle(dial, norm);
    dial.setAttribute('aria-valuemin', input.min);
    dial.setAttribute('aria-valuemax', input.max);
    dial.setAttribute('aria-valuetext', formatRangeValue(input));
    syncValueDisplay(valueEl, input);
}

/** Re-read min/max/value into a bound dial (after a range or value swap). */
export function refreshKnobDial(dial, inputOrKey, valueEl = null) {
    if (!dial || inputOrKey == null) return;
    if (typeof inputOrKey === 'string') {
        syncDialFromKey(dial, inputOrKey, connectedElementFor(inputOrKey), valueEl);
        return;
    }
    syncDialFromInput(dial, inputOrKey, valueEl);
}

function writeFromNorm(key, input, norm) {
    const { min, max, step } = rangeBounds(key, input);
    const next = input && !key
        ? normToValue(input, norm)
        : normToValueFromRange(min, max, step, norm);
    if (key) {
        set(key, next);
        return next;
    }
    if (input?.isConnected && parseFloat(input.value) !== next) {
        input.value = String(next);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return next;
}

function syncDialFromKey(dial, key, input, valueEl) {
    const { min, max } = rangeBounds(key, input);
    const value = parseFloat(currentParamValue(key, input));
    const norm = valueToNormFromRange(min, max, Number.isFinite(value) ? value : min);
    setKnobAngle(dial, norm);
    dial.setAttribute('aria-valuemin', String(min));
    dial.setAttribute('aria-valuemax', String(max));
    const text = formatParamReadout(key, Number.isFinite(value) ? value : min, input);
    dial.setAttribute('aria-valuetext', text);
    if (valueEl) valueEl.textContent = text;
}

/**
 * @param {HTMLElement | null} dial
 * @param {string | HTMLInputElement | null} inputOrKey canonical param key or range element
 */
export function bindKnob(dial, inputOrKey, valueEl, { onInteract } = {}) {
    let key = typeof inputOrKey === 'string' ? inputOrKey : keyFromElement(inputOrKey);
    const input = typeof inputOrKey === 'string'
        ? connectedElementFor(inputOrKey)
        : (inputOrKey && inputOrKey.isConnected ? inputOrKey : null);
    if (key && !isCatalogKey(key)) key = null;
    if (!dial || (!key && !input)) return;

    if (key && key.startsWith('step-slider-') && input) {
        const bounds = stepTuneBounds(getNumber(key, 0));
        input.min = String(bounds.min);
        input.max = String(bounds.max);
    }

    if (input) ensureDisplayStep(input);
    if (key) syncDialFromKey(dial, key, input, valueEl);
    else syncDialFromInput(dial, input, valueEl);

    let dragging = false;
    let startY = 0;
    let startNorm = 0;
    let activePointerId = null;

    const liveInput = () => (key ? connectedElementFor(key) : (input?.isConnected ? input : null));

    const notify = () => {
        if (typeof onInteract !== 'function') return;
        onInteract(String(currentParamValue(key, liveInput())));
    };

    const onPointerDown = (e) => {
        if (beginMidiLearn(e, key || input, dial.closest('.synth-knob') || dial)) return;
        if (e.button !== undefined && e.button !== 0) return;
        const el = liveInput();
        if (el?.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        const { min, max } = rangeBounds(key, el);
        startNorm = valueToNormFromRange(min, max, parseFloat(currentParamValue(key, el)));
        dial.classList.add('active');
        notify();
        try {
            dial.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    };

    const onPointerMove = (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        e.stopPropagation();
        const deltaY = startY - e.clientY;
        const norm = clamp(startNorm + deltaY / DRAG_PIXELS, 0, 1);
        setKnobAngle(dial, norm);
        const el = liveInput();
        const next = writeFromNorm(key, el, norm);
        const text = formatParamReadout(key, next, el);
        dial.setAttribute('aria-valuetext', text);
        if (valueEl) valueEl.textContent = text;
        notify();
    };

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        dial.classList.remove('active');
    };

    dial.addEventListener('pointerdown', onPointerDown);
    dial.addEventListener('pointermove', onPointerMove);
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);
    dial.addEventListener('lostpointercapture', endDrag);

    if (key) {
        subscribe(key, () => {
            if (dragging) return;
            syncDialFromKey(dial, key, liveInput(), valueEl);
        });
    } else if (input) {
        input.addEventListener('input', () => {
            if (dragging) return;
            syncDialFromInput(dial, input, valueEl);
        });
    }

    dial.addEventListener('keydown', (e) => {
        if (liveInput()?.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        const stepNorm = e.shiftKey ? 0.05 : 0.01;
        const el = liveInput();
        const { min, max } = rangeBounds(key, el);
        let norm = valueToNormFromRange(min, max, parseFloat(currentParamValue(key, el)));
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            norm = clamp(norm + stepNorm, 0, 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            norm = clamp(norm - stepNorm, 0, 1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            norm = 0;
        } else if (e.key === 'End') {
            e.preventDefault();
            norm = 1;
        } else {
            return;
        }
        setKnobAngle(dial, norm);
        const next = writeFromNorm(key, el, norm);
        const text = formatParamReadout(key, next, el);
        dial.setAttribute('aria-valuetext', text);
        if (valueEl) valueEl.textContent = text;
        notify();
    });

    attachDialReset(dial, () => {
        if (key) {
            if (!canResetKey(key)) return;
            const spec = getParam(key);
            if (!spec || spec.type === 'ratch') return;
            if (!set(key, spec.default)) return;
        } else if (!resetInputToDefault(input)) {
            return;
        }
        const el = liveInput();
        if (key) syncDialFromKey(dial, key, el, valueEl);
        else if (el) syncDialFromInput(dial, el, valueEl);
        notify();
    });
}

function nearestSteppedIndexFromValue(value, steps) {
    const exact = steps.findIndex((s) => s.value === String(value));
    if (exact >= 0) return exact;
    const n = parseFloat(value);
    if (!Number.isFinite(n) || steps.length === 0) return 0;
    let best = 0;
    let bestDist = Infinity;
    steps.forEach((s, i) => {
        const dist = Math.abs(parseFloat(s.value) - n);
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    });
    return best;
}

function setSteppedIndex(dial, key, control, steps, index) {
    const idx = clamp(Math.round(index), 0, steps.length - 1);
    const step = steps[idx];
    const norm = steps.length === 1 ? 0 : idx / (steps.length - 1);
    setKnobAngle(dial, norm);
    dial.setAttribute('aria-valuenow', String(idx));
    dial.setAttribute('aria-valuetext', step.label);
    const cur = key ? String(get(key) ?? '') : String(control?.value ?? '');
    if (cur !== step.value) {
        if (key) set(key, step.value);
        else if (control?.isConnected) {
            control.value = step.value;
            control.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}

function bindSteppedKnob({ dialId, controlId, steps }) {
    const dial = document.getElementById(dialId);
    const key = controlId;
    const control = connectedElementFor(key);
    if (!dial || !steps?.length) return;

    setSteppedIndex(dial, key, control, steps, nearestSteppedIndexFromValue(get(key) ?? control?.value, steps));

    let dragging = false;
    let startY = 0;
    let startIndex = 0;
    let activePointerId = null;
    const perStepPixels = STEPPED_DRAG_PIXELS / Math.max(1, steps.length - 1);

    const onPointerDown = (e) => {
        if (beginMidiLearn(e, key, dial.closest('.synth-knob') || dial)) return;
        if (e.button !== undefined && e.button !== 0) return;
        if (connectedElementFor(key)?.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        startIndex = nearestSteppedIndexFromValue(get(key), steps);
        dial.classList.add('active');
        try {
            dial.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    };

    const onPointerMove = (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        e.stopPropagation();
        const deltaY = startY - e.clientY;
        setSteppedIndex(dial, key, connectedElementFor(key), steps, startIndex + deltaY / perStepPixels);
    };

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        dial.classList.remove('active');
        setSteppedIndex(dial, key, connectedElementFor(key), steps, nearestSteppedIndexFromValue(get(key), steps));
    };

    dial.addEventListener('pointerdown', onPointerDown);
    dial.addEventListener('pointermove', onPointerMove);
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);
    dial.addEventListener('lostpointercapture', endDrag);

    subscribe(key, () => {
        if (dragging) return;
        setSteppedIndex(dial, key, connectedElementFor(key), steps, nearestSteppedIndexFromValue(get(key), steps));
    });

    dial.addEventListener('keydown', (e) => {
        if (connectedElementFor(key)?.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        let idx = nearestSteppedIndexFromValue(get(key), steps);
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            idx += 1;
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            idx -= 1;
        } else if (e.key === 'Home') {
            e.preventDefault();
            idx = 0;
        } else if (e.key === 'End') {
            e.preventDefault();
            idx = steps.length - 1;
        } else {
            return;
        }
        setSteppedIndex(dial, key, connectedElementFor(key), steps, idx);
    });
}

/** Classic main-panel range sliders: double-click resets to HTML default. */
export function initDoubleClickReset() {
    document.addEventListener('dblclick', (e) => {
        const input = e.target?.closest?.('input[type="range"]');
        if (!input) return;
        if (!canResetInput(input)) return;
        e.preventDefault();
        resetInputToDefault(input);
    });
}

export function initKeyboardKnobs() {
    KNOB_BINDINGS.forEach(({ dialId, inputId, valueId }) => {
        const opts = inputId === 'stepCount'
            ? { onInteract: (value) => previewStepsOnVfd(value) }
            : {};
        bindKnob(
            document.getElementById(dialId),
            inputId,
            valueId ? document.getElementById(valueId) : null,
            opts,
        );
    });
    bindSteppedKnob({
        dialId: 'kbDivisionKnob',
        controlId: 'division',
        steps: DIVISION_STEPS,
        eventName: 'change',
    });
}
