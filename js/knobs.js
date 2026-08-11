// Circular performance knobs on the chromatic keyboard (tempo, division,
// steps, cutoff, resonance, high pass). Drive the existing #tempo / #division /
// #stepCount / #cutoff / #resonance / #highPass controls so Sequencer / Filter
// panel, XY pad, and audio engine stay in sync.

import { previewStepsOnVfd } from './sequencer.js?v=227';

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
    { dialId: 'kbOsc4HarmonicsKnob', inputId: 'osc4Harmonics', valueId: 'kbOsc4HarmonicsValue' },
    { dialId: 'kbOsc4TimbreKnob', inputId: 'osc4MorphX', valueId: 'kbOsc4TimbreValue' },
    { dialId: 'kbOsc4MorphKnob', inputId: 'osc4MorphY', valueId: 'kbOsc4MorphValue' },
    { dialId: 'osc4HarmonicsKnob', inputId: 'osc4Harmonics', valueId: 'osc4HarmonicsKnobValue' },
    { dialId: 'osc4TimbreKnob', inputId: 'osc4MorphX', valueId: 'osc4TimbreKnobValue' },
    { dialId: 'osc4MorphKnob', inputId: 'osc4MorphY', valueId: 'osc4MorphKnobValue' },
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

function canResetInput(input) {
    if (!input || input.disabled) return false;
    const id = input.id || '';
    if (id && RESET_EXCLUDE_IDS.has(id)) return false;
    return true;
}

/**
 * Snap a range/select back to its HTML initial value and notify listeners.
 * @returns {boolean} true if value changed
 */
export function resetInputToDefault(input, { eventName = 'input' } = {}) {
    if (!canResetInput(input)) return false;
    const next = input.defaultValue;
    if (String(input.value) === String(next)) return false;
    input.value = next;
    input.dispatchEvent(new Event(eventName, { bubbles: true }));
    if (eventName !== 'change') {
        input.dispatchEvent(new Event('change', { bubbles: true }));
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

/** Readout string from native step (display only; input keeps full precision). */
export function formatRangeValue(input) {
    if (!input) return '';
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

function valueToNorm(input) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    const value = parseFloat(input.value);
    if (max === min) return 0;
    return clamp((value - min) / (max - min), 0, 1);
}

function normToValue(input, norm) {
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    ensureDisplayStep(input);
    const liveStep = parseFloat(input.step);
    const step = (Number.isFinite(liveStep) && liveStep > 0)
        ? liveStep
        : (parseFloat(input.dataset.displayStep) || 1);
    const raw = min + clamp(norm, 0, 1) * (max - min);
    // Snap to step when step is meaningful
    if (step > 0 && Number.isFinite(step)) {
        const snapped = Math.round((raw - min) / step) * step + min;
        return clamp(snapped, min, max);
    }
    return raw;
}

function setKnobAngle(dial, norm) {
    const n = clamp(norm, 0, 1);
    const angle = ANGLE_MIN + n * (ANGLE_MAX - ANGLE_MIN);
    dial.style.setProperty('--knob-angle', `${angle}deg`);
    dial.style.setProperty('--knob-norm', String(n));
    const wrap = dial.closest?.('.synth-knob-dial-wrap');
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
export function refreshKnobDial(dial, input, valueEl = null) {
    if (!dial || !input) return;
    syncDialFromInput(dial, input, valueEl);
}

function writeInputFromNorm(input, norm) {
    const next = normToValue(input, norm);
    if (parseFloat(input.value) === next) return;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function bindKnob(dial, input, valueEl, { onInteract } = {}) {
    if (!dial || !input) return;

    ensureDisplayStep(input);
    syncDialFromInput(dial, input, valueEl);

    let dragging = false;
    let startY = 0;
    let startNorm = 0;
    let activePointerId = null;

    const notify = () => {
        if (typeof onInteract === 'function') onInteract(input.value);
    };

    const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (input.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        startNorm = valueToNorm(input);
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
        const deltaY = startY - e.clientY; // up = increase
        const norm = clamp(startNorm + deltaY / DRAG_PIXELS, 0, 1);
        setKnobAngle(dial, norm);
        writeInputFromNorm(input, norm);
        dial.setAttribute('aria-valuetext', formatRangeValue(input));
        syncValueDisplay(valueEl, input);
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

    // Keep knob in sync when Filter panel / XY pad / sequencer slider change
    input.addEventListener('input', () => {
        if (dragging) return;
        syncDialFromInput(dial, input, valueEl);
    });

    // Keyboard fine control when focused
    dial.addEventListener('keydown', (e) => {
        if (input.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        const stepNorm = e.shiftKey ? 0.05 : 0.01;
        let norm = valueToNorm(input);
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
        writeInputFromNorm(input, norm);
        dial.setAttribute('aria-valuetext', formatRangeValue(input));
        syncValueDisplay(valueEl, input);
        notify();
    });

    attachDialReset(dial, () => {
        if (!resetInputToDefault(input)) return;
        syncDialFromInput(dial, input, valueEl);
        notify();
    });
}

function nearestSteppedIndex(control, steps) {
    const exact = steps.findIndex((s) => s.value === String(control.value));
    if (exact >= 0) return exact;
    const value = parseFloat(control.value);
    if (!Number.isFinite(value) || steps.length === 0) return 0;
    let best = 0;
    let bestDist = Infinity;
    steps.forEach((s, i) => {
        const dist = Math.abs(parseFloat(s.value) - value);
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    });
    return best;
}

function setSteppedIndex(dial, control, steps, index, eventName = 'change') {
    const idx = clamp(Math.round(index), 0, steps.length - 1);
    const step = steps[idx];
    const norm = steps.length === 1 ? 0 : idx / (steps.length - 1);
    setKnobAngle(dial, norm);
    dial.setAttribute('aria-valuenow', String(idx));
    dial.setAttribute('aria-valuetext', step.label);
    if (String(control.value) !== step.value) {
        control.value = step.value;
        control.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
}

function bindSteppedKnob({ dialId, controlId, steps, eventName = 'change' }) {
    const dial = document.getElementById(dialId);
    const control = document.getElementById(controlId);
    if (!dial || !control || !steps?.length) return;

    setSteppedIndex(dial, control, steps, nearestSteppedIndex(control, steps), eventName);

    let dragging = false;
    let startY = 0;
    let startIndex = 0;
    let activePointerId = null;
    const perStepPixels = STEPPED_DRAG_PIXELS / Math.max(1, steps.length - 1);

    const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (control.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        startIndex = nearestSteppedIndex(control, steps);
        dial.classList.add('active');
        try {
            dial.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    };

    const onPointerMove = (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        e.stopPropagation();
        const deltaY = startY - e.clientY; // up = increase
        setSteppedIndex(dial, control, steps, startIndex + deltaY / perStepPixels, eventName);
    };

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        dial.classList.remove('active');
        setSteppedIndex(dial, control, steps, nearestSteppedIndex(control, steps), eventName);
    };

    dial.addEventListener('pointerdown', onPointerDown);
    dial.addEventListener('pointermove', onPointerMove);
    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);
    dial.addEventListener('lostpointercapture', endDrag);

    const syncFromControl = () => {
        if (dragging) return;
        setSteppedIndex(dial, control, steps, nearestSteppedIndex(control, steps), eventName);
    };
    control.addEventListener('change', syncFromControl);
    control.addEventListener('input', syncFromControl);

    dial.addEventListener('keydown', (e) => {
        if (control.disabled || dial.getAttribute('aria-disabled') === 'true') return;
        let idx = nearestSteppedIndex(control, steps);
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
        setSteppedIndex(dial, control, steps, idx, eventName);
    });

    attachDialReset(dial, () => {
        if (!canResetInput(control)) return;
        if (!resetInputToDefault(control, { eventName })) return;
        setSteppedIndex(dial, control, steps, nearestSteppedIndex(control, steps), eventName);
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
            document.getElementById(inputId),
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
