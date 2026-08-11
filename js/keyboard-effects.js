// Compact effects controls in the keyboard Synthesizer panel (column 4).
// Knobs are wired in knobs.js; chorus toggles, delay time, compressor,
// ring mod, and distortion mirror the main panel.

import { state } from './state.js?v=107';
import { bindKnob, formatRangeValue } from './knobs.js?v=100';
import {
    observeMainControl,
    syncClassButtonFromMain,
    syncToggleButtonFromMain,
} from './control-mirror.js?v=74';

const syncFns = [];

function wireChorusToggle(kbId, mainId) {
    const kbBtn = document.getElementById(kbId);
    const mainBtn = document.getElementById(mainId);
    if (!kbBtn || !mainBtn) return;

    const sync = () => syncClassButtonFromMain(kbBtn, mainBtn);
    syncFns.push(sync);
    observeMainControl(mainBtn, sync);

    kbBtn.addEventListener('click', () => {
        mainBtn.click();
    });
}

function wireDelayTimeSelect() {
    const kbSelect = document.getElementById('kbDelayTimeSelect');
    const mainSelect = document.getElementById('delayTime');
    if (!kbSelect || !mainSelect) return;

    const syncFromMain = () => {
        kbSelect.value = mainSelect.value;
        kbSelect.disabled = mainSelect.disabled;
    };

    syncFns.push(syncFromMain);
    syncFromMain();

    kbSelect.addEventListener('change', () => {
        if (mainSelect.value !== kbSelect.value) {
            mainSelect.value = kbSelect.value;
            mainSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });

    mainSelect.addEventListener('change', syncFromMain);
}

function wireDelay() {
    const kbToggle = document.getElementById('kbDelayToggle');
    const mainToggle = document.getElementById('delayToggle');
    const mainAmount = document.getElementById('delayAmount');
    const kbSelect = document.getElementById('kbDelayTimeSelect');
    const dial = document.getElementById('kbDelayAmountKnob');

    if (kbToggle && mainToggle) {
        const syncToggle = () => syncToggleButtonFromMain(kbToggle, mainToggle);
        syncFns.push(syncToggle);
        observeMainControl(mainToggle, syncToggle);
        syncToggle();

        kbToggle.addEventListener('click', () => {
            mainToggle.click();
        });
    }

    const syncDisabled = () => {
        const enabled = mainAmount ? !mainAmount.disabled : true;
        if (dial) {
            dial.tabIndex = enabled ? 0 : -1;
            dial.setAttribute('aria-disabled', enabled ? 'false' : 'true');
            dial.classList.toggle('disabled', !enabled);
        }
        if (kbSelect) kbSelect.disabled = !enabled;
    };
    syncFns.push(syncDisabled);
    if (mainToggle || mainAmount) {
        observeMainControl(mainToggle || mainAmount, syncDisabled, { subtree: true });
    }
    if (mainAmount) mainAmount.addEventListener('input', syncDisabled);
    syncDisabled();
}

function wireEffectAmountToggle({ kbToggleId, mainToggleId, mainInputId, dialId }) {
    const kbToggle = document.getElementById(kbToggleId);
    const mainToggle = document.getElementById(mainToggleId);
    const mainInput = document.getElementById(mainInputId);
    const dial = document.getElementById(dialId);

    if (kbToggle && mainToggle) {
        const syncToggle = () => syncToggleButtonFromMain(kbToggle, mainToggle);
        syncFns.push(syncToggle);
        observeMainControl(mainToggle, syncToggle);
        syncToggle();

        kbToggle.addEventListener('click', () => {
            if (kbToggleId === 'kbRingModToggle' && state.keyboardPoly) return;
            mainToggle.click();
        });
    }

    if (mainInput) {
        const syncDisabled = () => {
            const enabled = !mainInput.disabled;
            if (dial) {
                dial.tabIndex = enabled ? 0 : -1;
                dial.setAttribute('aria-disabled', enabled ? 'false' : 'true');
                dial.classList.toggle('disabled', !enabled);
            }
        };
        syncFns.push(syncDisabled);
        observeMainControl(mainToggle || mainInput, syncDisabled, { subtree: true });
        mainInput.addEventListener('input', syncDisabled);
        syncDisabled();
    }
}

function wireReverb() {
    const kbToggle = document.getElementById('kbReverbToggle');
    const mainToggle = document.getElementById('reverbToggle');
    const dialIds = [
        'kbReverbSizeKnob',
        'kbReverbDecayKnob',
        'kbReverbDampKnob',
        'kbReverbAmountKnob',
    ];
    const mainInputs = [
        document.getElementById('reverbSize'),
        document.getElementById('reverbDecay'),
        document.getElementById('reverbDamp'),
        document.getElementById('reverbAmount'),
    ].filter(Boolean);

    if (kbToggle && mainToggle) {
        const syncToggle = () => syncToggleButtonFromMain(kbToggle, mainToggle);
        syncFns.push(syncToggle);
        observeMainControl(mainToggle, syncToggle);
        syncToggle();

        kbToggle.addEventListener('click', () => {
            mainToggle.click();
        });
    }

    const syncDisabled = () => {
        const enabled = mainInputs.length ? !mainInputs[0].disabled : true;
        dialIds.forEach((id) => {
            const dial = document.getElementById(id);
            if (!dial) return;
            dial.tabIndex = enabled ? 0 : -1;
            dial.setAttribute('aria-disabled', enabled ? 'false' : 'true');
            dial.classList.toggle('disabled', !enabled);
        });
    };
    syncFns.push(syncDisabled);
    if (mainToggle || mainInputs[0]) {
        observeMainControl(mainToggle || mainInputs[0], syncDisabled, { subtree: true });
    }
    mainInputs.forEach((input) => input.addEventListener('input', syncDisabled));
    syncDisabled();
}

function wireCompressor() {
    const kbToggle = document.getElementById('kbCompToggle');
    const mainToggle = document.getElementById('compToggle');
    const mainThreshold = document.getElementById('compThreshold');
    const kbValue = document.getElementById('kbCompThresholdValue');
    const dial = document.getElementById('kbCompThresholdKnob');

    if (kbToggle && mainToggle) {
        const syncToggle = () => syncToggleButtonFromMain(kbToggle, mainToggle);
        syncFns.push(syncToggle);
        observeMainControl(mainToggle, syncToggle);
        syncToggle();

        kbToggle.addEventListener('click', () => {
            mainToggle.click();
        });
    }

    if (mainThreshold) {
        bindKnob(dial, mainThreshold, kbValue);

        const syncDisabled = () => {
            const enabled = !mainThreshold.disabled;
            if (dial) {
                dial.tabIndex = enabled ? 0 : -1;
                dial.setAttribute('aria-disabled', enabled ? 'false' : 'true');
                dial.classList.toggle('disabled', !enabled);
            }
            if (kbValue) kbValue.textContent = formatRangeValue(mainThreshold);
        };
        syncFns.push(syncDisabled);
        observeMainControl(mainToggle || mainThreshold, syncDisabled, { subtree: true });
        mainThreshold.addEventListener('input', syncDisabled);
        syncDisabled();
    }
}

export function syncKeyboardEffectsFromMain() {
    syncFns.forEach((fn) => fn());
}

export function initKeyboardEffects() {
    wireChorusToggle('kbChorusI', 'chorusI');
    wireChorusToggle('kbChorusII', 'chorusII');
    wireDelayTimeSelect();
    wireDelay();
    wireEffectAmountToggle({
        kbToggleId: 'kbRingModToggle',
        mainToggleId: 'ringModToggle',
        mainInputId: 'ringMod',
        dialId: 'kbRingModKnob',
    });
    wireEffectAmountToggle({
        kbToggleId: 'kbDistortionToggle',
        mainToggleId: 'distortionToggle',
        mainInputId: 'distortion',
        dialId: 'kbDistortionKnob',
    });
    wireEffectAmountToggle({
        kbToggleId: 'kbBitcrushToggle',
        mainToggleId: 'bitcrusherToggle',
        mainInputId: 'bitDepth',
        dialId: 'kbBitDepthKnob',
    });
    wireReverb();
    wireCompressor();
}
