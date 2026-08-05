// Compact noise controls in the keyboard Synthesizer panel (column 2).
// Type select and toggle mirror the main Noise panel; volume knob is wired in knobs.js.

import {
    observeMainControl,
    syncToggleButtonFromMain,
} from './control-mirror.js?v=74';

let syncToggle = () => {};
let syncType = () => {};

function wireNoiseToggle() {
    const kbBtn = document.getElementById('kbNoiseToggle');
    const mainBtn = document.getElementById('noiseToggle');
    if (!kbBtn || !mainBtn) return;

    syncToggle = () => syncToggleButtonFromMain(kbBtn, mainBtn);
    observeMainControl(mainBtn, syncToggle);

    kbBtn.addEventListener('click', () => {
        mainBtn.click();
    });
}

function wireNoiseTypeSelect() {
    const kbSelect = document.getElementById('kbNoiseTypeSelect');
    const mainSelect = document.getElementById('noiseType');
    if (!kbSelect || !mainSelect) return;

    syncType = () => {
        kbSelect.value = mainSelect.value;
    };

    syncType();

    kbSelect.addEventListener('change', () => {
        if (mainSelect.value !== kbSelect.value) {
            mainSelect.value = kbSelect.value;
            mainSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    mainSelect.addEventListener('change', syncType);
}

export function syncKeyboardNoiseFromMain() {
    syncToggle();
    syncType();
}

export function initKeyboardNoise() {
    wireNoiseToggle();
    wireNoiseTypeSelect();
}
