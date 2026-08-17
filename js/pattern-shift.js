// Shift Pattern: rotate active step content left/right within stepCount.
// `pattern.steps[]` is the source; hydrate paints the hidden bus + stage strip.

import { state } from './state.js?v=114';
import { refreshStepTuneReadouts } from './sequencer.js?v=247';
import {
    syncAllKeyboardStepButtonsFromMain,
    syncAllKeyboardStepFinesFromMain,
} from './keyboard-steps.js?v=109';
import { setWriteCursor } from './pattern-write.js?v=100';
import { rotateAutomationLanes } from './automation.js?v=42';
import {
    cloneStep,
    getPattern,
    hydratePatternToDom,
    STEP_SLOTS,
} from './pattern-bank.js?v=10';

function stepCount() {
    const el = document.getElementById('stepCount');
    return Math.max(1, Math.min(STEP_SLOTS, parseInt(el?.value, 10) || 8));
}

/**
 * Rotate active pattern by delta slots.
 * +1: content shifts left  (A B C D → B C D A) — ◀
 * -1: content shifts right (A B C D → D A B C) — ▶
 */
export function rotatePattern(delta) {
    const n = stepCount();
    if (n < 2) return;

    let d = Math.round(Number(delta)) || 0;
    d = ((d % n) + n) % n;
    if (!d) return;

    const pattern = getPattern(state.editSlot);
    const snap = Array.from({ length: n }, (_, i) => cloneStep(pattern.steps[i]));
    for (let i = 0; i < n; i++) {
        pattern.steps[i] = cloneStep(snap[(i + d) % n]);
    }
    // Steps only — do not write stored clock (step count / reverse / division).
    hydratePatternToDom(state.editSlot, { clock: false });
    rotateAutomationLanes(d);

    if (state.isPlaying || state.isArping) {
        state.currentStep = ((state.currentStep - d) % n + n) % n;
        document.querySelectorAll('.sequencer-step, .keyboard-step').forEach((el) => {
            el.classList.remove('active');
        });
        document.querySelector(`.sequencer-step[data-step="${state.currentStep}"]`)
            ?.classList.add('active');
        document.querySelector(`.keyboard-step[data-step="${state.currentStep}"]`)
            ?.classList.add('active');
    }

    refreshStepTuneReadouts();
    syncAllKeyboardStepButtonsFromMain();
    syncAllKeyboardStepFinesFromMain();
    if (state.keyboardWrite) {
        setWriteCursor(state.writeStep);
    }
    document.dispatchEvent(new CustomEvent('ingysynth-pattern-shift', { detail: { delta: d } }));
}

function wireShiftButtons() {
    const pairs = [
        ['patternShiftBack', 'patternShiftForward'],
        ['kbPatternShiftBack', 'kbPatternShiftForward'],
    ];
    // ◀ = content left (+1), ▶ = content right (-1) — matches arrow direction
    pairs.forEach(([backId, forwardId]) => {
        document.getElementById(backId)?.addEventListener('click', () => rotatePattern(1));
        document.getElementById(forwardId)?.addEventListener('click', () => rotatePattern(-1));
    });
}

export function initPatternShift() {
    wireShiftButtons();
}
