// Manual step-tune knobs stay in a musical -24..+24 window so a whole knob
// sweep is usable for tuning. Write Mode still programs the full keyboard span
// (-39..+48), and any step already holding a value outside the manual window
// keeps its own headroom until it is tuned back inside.

import { state } from './state.js?v=116';
import { refreshKnobDial } from './knobs.js?v=130';

export const MANUAL_TUNE_MIN = -24;
export const MANUAL_TUNE_MAX = 24;
export const FULL_TUNE_MIN = -39;
export const FULL_TUNE_MAX = 48;

const STEP_SLOTS = 32;

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

export function refreshStepTuneRanges() {
    for (let i = 0; i < STEP_SLOTS; i++) {
        const dial = document.getElementById(`kbStepTuneDial${i}`);
        if (!dial) continue;
        refreshKnobDial(dial, `step-slider-${i}`);
    }
}

export function initStepTuneRange() {
    refreshStepTuneRanges();

    // Write mode, keyboard programming and bank loads all fire this.
    document.addEventListener('ingysynth-kb-steps-sync', refreshStepTuneRanges);
    document.addEventListener('ingysynth-pattern-shift', refreshStepTuneRanges);
}
