// Shift Pattern: rotate active step content left/right within stepCount.
// Main Sequencer controls are source of truth; keyboard strip mirrors after apply.

import { state } from './state.js?v=104';
import { refreshStepTuneReadouts } from './sequencer.js?v=159';
import {
    syncAllKeyboardStepButtonsFromMain,
    syncAllKeyboardStepFinesFromMain,
} from './keyboard-steps.js?v=92';
import { setWriteCursor } from './pattern-write.js?v=86';
import { rotateAutomationLanes } from './automation.js?v=32';
import { clampRatch, syncRatchButton } from './step-ratch.js?v=1';

function stepCount() {
    const el = document.getElementById('stepCount');
    return Math.max(1, Math.min(32, parseInt(el?.value, 10) || 8));
}

function formatCentsLabel(cents) {
    return `${cents > 0 ? '+' : ''}${cents}&cent;`;
}

function captureStep(i) {
    const tune = document.querySelector(`.step-tune[data-step="${i}"]`);
    const fine = document.querySelector(`.step-fine[data-step="${i}"]`);
    const accent = document.querySelector(`.step-accent[data-step="${i}"]`);
    const slide = document.querySelector(`.step-slide[data-step="${i}"]`);
    const ratch = document.querySelector(`.step-ratch[data-step="${i}"]`);
    const toggle = document.querySelector(`.step-toggle[data-step="${i}"]`);
    const front = toggle?.querySelector('.front');
    return {
        tune: tune ? (parseInt(tune.value, 10) || 0) : 0,
        fine: fine ? (parseInt(fine.value, 10) || 0) : 0,
        accent: accent ? !accent.classList.contains('off') : false,
        slide: slide ? !slide.classList.contains('off') : false,
        on: front ? front.textContent.trim() === 'On' : true,
        ratch: clampRatch(parseInt(ratch?.dataset?.ratch, 10) || 1),
    };
}

function applyStep(i, data) {
    const tune = document.querySelector(`.step-tune[data-step="${i}"]`);
    const fine = document.querySelector(`.step-fine[data-step="${i}"]`);
    const accent = document.querySelector(`.step-accent[data-step="${i}"]`);
    const slide = document.querySelector(`.step-slide[data-step="${i}"]`);
    const ratch = document.querySelector(`.step-ratch[data-step="${i}"]`);
    const toggle = document.querySelector(`.step-toggle[data-step="${i}"]`);
    const front = toggle?.querySelector('.front');

    if (tune) {
        // Widen first: manual knobs sit at ±24, Write Mode can program past it
        const v = Math.round(Number(data.tune) || 0);
        if (v < parseFloat(tune.min)) tune.min = String(v);
        if (v > parseFloat(tune.max)) tune.max = String(v);
        tune.value = String(v);
        // Keep dial angles in sync; readout refresh runs once after rotate
        tune.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (fine) {
        // Set value without input — fine listener snaps under microtune lock
        fine.value = String(data.fine);
        if (fine.nextElementSibling) {
            fine.nextElementSibling.innerHTML = formatCentsLabel(data.fine);
        }
    }
    if (accent) accent.classList.toggle('off', !data.accent);
    if (slide) slide.classList.toggle('off', !data.slide);
    if (front) front.textContent = data.on ? 'On' : 'Off';
    if (toggle) toggle.classList.toggle('off', !data.on);
    syncRatchButton(ratch, data.ratch);
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

    const snap = Array.from({ length: n }, (_, i) => captureStep(i));
    for (let i = 0; i < n; i++) {
        applyStep(i, snap[(i + d) % n]);
    }
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
