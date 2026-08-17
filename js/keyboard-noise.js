// Compact noise controls in the keyboard Synthesizer panel (column 2).
// Type select and toggle write params; volume knob is wired in knobs.js.

import { wireSelect, wireToggle } from './params.js?v=8';

let syncToggle = () => {};
let syncType = () => {};

function wireNoiseToggle() {
    const kbBtn = document.getElementById('kbNoiseToggle');
    if (!kbBtn) return;
    syncToggle = wireToggle(kbBtn, 'noiseToggle', { syncLabel: true });
}

function wireNoiseTypeSelect() {
    const kbSelect = document.getElementById('kbNoiseTypeSelect');
    if (!kbSelect) return;
    syncType = wireSelect(kbSelect, 'noiseType');
}

export function syncKeyboardNoiseFromMain() {
    syncToggle();
    syncType();
}

export function initKeyboardNoise() {
    wireNoiseToggle();
    wireNoiseTypeSelect();
}
