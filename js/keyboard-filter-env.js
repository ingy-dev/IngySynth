// Filter envelope toggle in the keyboard Synthesizer panel (column 3).
// On/Off mirrors the main panel #filterEnvToggle; Invert is fullscreen-only.
// ADSR knobs are wired in knobs.js.

import { state } from './state.js?v=104';
import {
    observeMainControl,
    syncToggleButtonFromMain,
} from './control-mirror.js?v=74';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=78';
import { updateLfoCutoffSafety } from './lfo-strip.js?v=15';
import { drawFilterADSRVisualizer } from './visualizers.js?v=90';

let syncToggle = () => {};

function wireFilterEnvToggle() {
    const kbBtn = document.getElementById('kbFilterEnvToggle');
    const mainBtn = document.getElementById('filterEnvToggle');
    if (!kbBtn || !mainBtn) return;

    syncToggle = () => syncToggleButtonFromMain(kbBtn, mainBtn);
    observeMainControl(mainBtn, syncToggle);

    kbBtn.addEventListener('click', () => {
        mainBtn.click();
    });
}

function syncInvertButton() {
    const kbBtn = document.getElementById('kbFilterEnvInvert');
    if (!kbBtn) return;
    const on = !!state.filterEnvInvert;
    kbBtn.classList.toggle('off', !on);
    kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const ingy = document.getElementById('ingy6FilterEnvInvert');
    if (ingy) {
        ingy.classList.toggle('active', on);
        ingy.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
}

/** Set filter-env polarity invert and refresh cutoff / UI (Ingy 6 + kb). */
export function setFilterEnvInvert(on) {
    const want = !!on;
    if (!!state.filterEnvInvert === want) {
        syncInvertButton();
        return;
    }
    state.filterEnvInvert = want;
    syncInvertButton();
    if (state.audioContext) {
        const now = state.audioContext.currentTime;
        const cutoff = Math.max(40, parseFloat(document.getElementById('cutoff')?.value) || 1000);
        updateFilterCutoffRange(cutoff, now);
        updateLfoCutoffSafety();
    }
    drawFilterADSRVisualizer();
}

function wireFilterEnvInvertToggle() {
    const kbBtn = document.getElementById('kbFilterEnvInvert');
    if (!kbBtn) return;

    syncInvertButton();

    kbBtn.addEventListener('click', () => {
        setFilterEnvInvert(!state.filterEnvInvert);
    });
}

export function syncKeyboardFilterEnvFromMain() {
    syncToggle();
    syncInvertButton();
}

export function initKeyboardFilterEnv() {
    wireFilterEnvToggle();
    wireFilterEnvInvertToggle();
}
