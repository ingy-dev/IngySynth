// Manual step-tune knobs stay in a musical -24..+24 window so a whole knob
// sweep is usable for tuning. Write Mode still programs the full keyboard span
// (-39..+48), and any step already holding a value outside the manual window
// keeps its own headroom until it is tuned back inside.

import { state } from './state.js?v=107';
import { refreshKnobDial } from './knobs.js?v=99';

export const MANUAL_TUNE_MIN = -24;
export const MANUAL_TUNE_MAX = 24;
export const FULL_TUNE_MIN = -39;
export const FULL_TUNE_MAX = 48;

/** Range a step-tune input should expose right now, given its stored value. */
export function stepTuneBounds(value) {
    if (state.keyboardWrite) {
        return { min: FULL_TUNE_MIN, max: FULL_TUNE_MAX };
    }
    const v = Number.isFinite(value) ? value : 0;
    return {
        min: Math.min(MANUAL_TUNE_MIN, v),
        max: Math.max(MANUAL_TUNE_MAX, v),
    };
}

export function clampManualTune(value) {
    const v = Math.round(Number(value) || 0);
    if (state.keyboardWrite) {
        return Math.max(FULL_TUNE_MIN, Math.min(FULL_TUNE_MAX, v));
    }
    return Math.max(MANUAL_TUNE_MIN, Math.min(MANUAL_TUNE_MAX, v));
}

function applyRange(input) {
    const { min, max } = stepTuneBounds(parseInt(input.value, 10));
    if (String(input.min) === String(min) && String(input.max) === String(max)) return false;
    input.min = String(min);
    input.max = String(max);
    return true;
}

function refreshOne(input) {
    if (!applyRange(input)) return;
    const step = parseInt(input.dataset.step, 10);
    // Value readout stays owned by the scale-quantized display, so pass none.
    refreshKnobDial(document.getElementById(`kbStepTuneDial${step}`), input, null);
}

export function refreshStepTuneRanges() {
    document.querySelectorAll('.step-tune').forEach(refreshOne);
}

export function initStepTuneRange() {
    refreshStepTuneRanges();

    // Drag end on a main-panel slider: drop any widened headroom it no longer needs.
    document.addEventListener('change', (e) => {
        const input = e.target?.closest?.('.step-tune');
        if (input) refreshOne(input);
    });

    // Write mode, keyboard programming and bank loads all fire this.
    document.addEventListener('ingysynth-kb-steps-sync', refreshStepTuneRanges);
    document.addEventListener('ingysynth-pattern-shift', refreshStepTuneRanges);
}
