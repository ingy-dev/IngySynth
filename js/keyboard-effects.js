// Compact effects controls in the keyboard Effects fieldset (under Synthesizer).
// Knobs are wired in knobs.js; chorus, delay, ring, distortion write params
// (same keys as acid / Multitudes). Compressor / sidechain live on the mixer strip.

import { state } from './state.js?v=116';
import { bindKnob, formatRangeValue } from './knobs.js?v=124';
import {
    elementFor,
    get,
    subscribe,
    wireSelect,
    wireToggle,
} from './params.js?v=13';
import { initScTimeKnob } from './sc-time.js?v=1';

const syncFns = [];

function syncDialDisabled(dial, enabled) {
    if (!dial) return;
    dial.tabIndex = enabled ? 0 : -1;
    dial.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    dial.classList.toggle('disabled', !enabled);
}

function inputEnabled(key) {
    if (key === 'delayTime' || key === 'delayAmount') return !!state.delayEnabled;
    if (key === 'reverbSize' || key === 'reverbDecay' || key === 'reverbDamp' || key === 'reverbAmount') {
        return !!state.reverbEnabled;
    }
    if (key === 'compThreshold') return !!state.compressorEnabled;
    if (key === 'scDepth') return !!get('scToggle');
    if (key === 'distortion') return !!state.distortionEnabled;
    if (key === 'bitDepth') return !!state.bitcrusherEnabled;
    if (key === 'ringMod') return !!state.ringModEnabled;
    const el = elementFor(key);
    return el ? !el.disabled : false;
}

function wireChorusToggle(kbId, key) {
    const kbBtn = document.getElementById(kbId);
    if (!kbBtn) return;
    syncFns.push(wireToggle(kbBtn, key, { syncLabel: false }));
}

function wireDelayTimeSelect() {
    const kbSelect = document.getElementById('kbDelayTimeSelect');
    if (!kbSelect) return;
    const syncFromStore = wireSelect(kbSelect, 'delayTime');
    const syncDisabled = () => {
        kbSelect.disabled = !inputEnabled('delayTime');
    };
    syncFns.push(syncFromStore, syncDisabled);
    subscribe('delayToggle', syncDisabled);
    syncDisabled();
}

function wireDelay() {
    const kbToggle = document.getElementById('kbDelayToggle');
    const dial = document.getElementById('kbDelayAmountKnob');

    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, 'delayToggle', { syncLabel: true }));
    }

    const syncDisabled = () => {
        const enabled = inputEnabled('delayAmount');
        syncDialDisabled(dial, enabled);
    };
    syncFns.push(syncDisabled);
    subscribe('delayToggle', syncDisabled);
    syncDisabled();
}

function wireEffectAmountToggle({ kbToggleId, toggleKey, inputKey, dialId, beforeToggle }) {
    const kbToggle = document.getElementById(kbToggleId);
    const dial = document.getElementById(dialId);

    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, toggleKey, {
            syncLabel: true,
            beforeToggle,
        }));
    }

    const syncDisabled = () => {
        syncDialDisabled(dial, inputEnabled(inputKey));
    };
    syncFns.push(syncDisabled);
    subscribe(toggleKey, syncDisabled);
    syncDisabled();
}

function wireReverb() {
    const kbToggle = document.getElementById('kbReverbToggle');
    const dialIds = [
        'kbReverbSizeKnob',
        'kbReverbDecayKnob',
        'kbReverbDampKnob',
        'kbReverbAmountKnob',
    ];

    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, 'reverbToggle', { syncLabel: true }));
    }

    const syncDisabled = () => {
        const enabled = inputEnabled('reverbSize');
        dialIds.forEach((id) => syncDialDisabled(document.getElementById(id), enabled));
    };
    syncFns.push(syncDisabled);
    subscribe('reverbToggle', syncDisabled);
    syncDisabled();
}

function wireCompressor() {
    const kbToggle = document.getElementById('kbCompToggle');
    const kbValue = document.getElementById('kbCompThresholdValue');
    const dial = document.getElementById('kbCompThresholdKnob');

    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, 'compToggle', { syncLabel: true }));
    }

    bindKnob(dial, 'compThreshold', kbValue);

    const syncDisabled = () => {
        const enabled = inputEnabled('compThreshold');
        syncDialDisabled(dial, enabled);
        const el = elementFor('compThreshold');
        if (kbValue && el) kbValue.textContent = formatRangeValue(el);
    };
    syncFns.push(syncDisabled);
    subscribe('compToggle', syncDisabled);
    syncDisabled();
}

function wireSidechain() {
    const kbToggle = document.getElementById('kbScToggle');
    const src = document.getElementById('scSource');
    const depthDial = document.getElementById('kbScDepthKnob');
    const depthValue = document.getElementById('kbScDepthValue');
    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, 'scToggle', { syncLabel: true }));
    }
    if (src) syncFns.push(wireSelect(src, 'scSource'));
    bindKnob(depthDial, 'scDepth', depthValue);
    initScTimeKnob();
    const syncDisabled = () => {
        const enabled = inputEnabled('scDepth');
        syncDialDisabled(depthDial, enabled);
        syncDialDisabled(document.getElementById('kbScTimeKnob'), enabled);
        if (src) src.disabled = !enabled;
        const timeSync = document.getElementById('kbScTimeSync');
        if (timeSync) timeSync.disabled = !enabled;
    };
    syncFns.push(syncDisabled);
    subscribe('scToggle', syncDisabled);
    syncDisabled();
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
        toggleKey: 'ringModToggle',
        inputKey: 'ringMod',
        dialId: 'kbRingModKnob',
        beforeToggle: () => (state.keyboardPoly ? false : undefined),
    });
    wireEffectAmountToggle({
        kbToggleId: 'kbDistortionToggle',
        toggleKey: 'distortionToggle',
        inputKey: 'distortion',
        dialId: 'kbDistortionKnob',
    });
    wireEffectAmountToggle({
        kbToggleId: 'kbBitcrushToggle',
        toggleKey: 'bitcrusherToggle',
        inputKey: 'bitDepth',
        dialId: 'kbBitDepthKnob',
    });
    wireReverb();
    wireCompressor();
    wireSidechain();
}
