// Compact oscillator controls in the keyboard Synthesizer panel.
// Knobs drive .osc-tune / .osc-vol; pan uses a microtune-style slider mirroring .osc-pan.

import { state } from './state.js?v=104';
import { bindKnob } from './knobs.js?v=96';
import {
    observeMainControl,
    syncToggleButtonFromMain,
} from './control-mirror.js?v=74';

const OSC_COUNT = 4;

const KNOB_BINDINGS = [
    { dialId: 'kbOsc1TuneKnob', selector: '.osc-tune[data-osc="0"]', valueId: 'kbOsc1TuneValue' },
    { dialId: 'kbOsc1VolKnob', selector: '.osc-vol[data-osc="0"]', valueId: 'kbOsc1VolValue' },
    { dialId: 'kbOsc2TuneKnob', selector: '.osc-tune[data-osc="1"]', valueId: 'kbOsc2TuneValue' },
    { dialId: 'kbOsc2VolKnob', selector: '.osc-vol[data-osc="1"]', valueId: 'kbOsc2VolValue' },
    { dialId: 'kbOsc3TuneKnob', selector: '.osc-tune[data-osc="2"]', valueId: 'kbOsc3TuneValue' },
    { dialId: 'kbOsc3VolKnob', selector: '.osc-vol[data-osc="2"]', valueId: 'kbOsc3VolValue' },
    { dialId: 'kbOsc4TuneKnob', selector: '.osc-tune[data-osc="3"]', valueId: 'kbOsc4TuneValue' },
    { dialId: 'kbOsc4VolKnob', selector: '.osc-vol[data-osc="3"]', valueId: 'kbOsc4VolValue' },
];

const WAVEFORMS = [
    {
        value: 'sawtooth',
        label: 'Sawtooth',
        // Moog: linear rise + instant vertical reset (not a symmetric triangle)
        svg: '<svg class="keyboard-osc-wave-icon" viewBox="0 0 24 12" aria-hidden="true"><polyline points="0,11 24,1 24,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"/></svg>',
    },
    {
        value: 'square',
        label: 'Square',
        // One cycle: low → high → low
        svg: '<svg class="keyboard-osc-wave-icon" viewBox="0 0 24 12" aria-hidden="true"><polyline points="0,11 6,11 6,2 18,2 18,11 24,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"/></svg>',
    },
    {
        value: 'sine',
        label: 'Sine',
        svg: '<svg class="keyboard-osc-wave-icon" viewBox="0 0 24 12" aria-hidden="true"><path d="M0,6 Q6,1 12,6 T24,6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    },
    {
        value: 'triangle',
        label: 'Triangle',
        // Moog: symmetric rise and fall — no vertical reset segments
        svg: '<svg class="keyboard-osc-wave-icon" viewBox="0 0 24 12" aria-hidden="true"><polyline points="0,11 12,1 24,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"/></svg>',
    },
];

const syncFns = [];

function formatOscPan(n) {
    const v = Math.round((Number(n) || 0) * 50);
    if (v === 0) return 'C';
    return v < 0 ? `L${Math.abs(v)}` : `R${v}`;
}

function mainOscToggle(oscIndex) {
    return document.querySelector(`.osc-toggle[data-osc="${oscIndex}"]`);
}

function mainOscType(oscIndex) {
    return document.querySelector(`.osc-type[data-osc="${oscIndex}"]`);
}

function syncKbToggleFromMain(kbBtn, mainBtn) {
    syncToggleButtonFromMain(kbBtn, mainBtn);
}

function syncKbWaveFromMain(waveGroup, mainSelect) {
    if (!waveGroup || !mainSelect) return;
    const value = mainSelect.value;
    waveGroup.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        const selected = btn.dataset.wave === value;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
}

function setMainWave(typeMain, value) {
    if (!typeMain || typeMain.value === value) return;
    typeMain.value = value;
    typeMain.dispatchEvent(new Event('change', { bubbles: true }));
}

function buildWavePicker(waveGroup) {
    waveGroup.innerHTML = '';
    WAVEFORMS.forEach(({ value, label, svg }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'keyboard-osc-wave-btn';
        btn.dataset.wave = value;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-checked', 'false');
        btn.innerHTML = svg;
        waveGroup.appendChild(btn);
    });
}

function wireOsc(i) {
    const kbToggle = document.querySelector(`.kb-osc-toggle[data-osc="${i}"]`);
    const waveGroup = document.querySelector(`.keyboard-osc-wave[data-osc="${i}"]`);
    const toggleMain = mainOscToggle(i);
    const typeMain = mainOscType(i);

    if (waveGroup && !waveGroup.querySelector('.keyboard-osc-wave-btn')) {
        buildWavePicker(waveGroup);
    }

    const syncToggle = () => syncKbToggleFromMain(kbToggle, toggleMain);
    const syncWave = () => syncKbWaveFromMain(waveGroup, typeMain);
    syncFns.push(syncToggle, syncWave);

    observeMainControl(toggleMain, syncToggle);
    syncWave();

    kbToggle?.addEventListener('click', () => {
        toggleMain?.click();
    });

    waveGroup?.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            setMainWave(typeMain, btn.dataset.wave);
            syncWave();
        });
    });

    typeMain?.addEventListener('change', syncWave);
}

function formatDetuneCents(n) {
    return `${Math.round(Number(n) || 0)}¢`;
}

function wireUnison() {
    const kbVoices = document.getElementById('kbUnisonVoices');
    const mainVoices = document.getElementById('unisonVoices');
    const mainDetune = document.getElementById('unisonDetune');
    const kbDetuneValue = document.getElementById('kbUnisonDetuneValue');
    const kbToggle = document.getElementById('kbUnisonToggle');
    const mainToggle = document.getElementById('unisonToggle');

    if (kbToggle && mainToggle) {
        const syncToggle = () => syncToggleButtonFromMain(kbToggle, mainToggle);
        syncFns.push(syncToggle);
        observeMainControl(mainToggle, syncToggle);
        syncToggle();

        kbToggle.addEventListener('click', () => {
            if (state.keyboardPoly) return;
            mainToggle.click();
        });
    }

    if (kbVoices && mainVoices) {
        const syncVoices = () => {
            kbVoices.value = mainVoices.value;
            kbVoices.disabled = mainVoices.disabled;
        };
        syncFns.push(syncVoices);
        syncVoices();

        kbVoices.addEventListener('change', () => {
            if (mainVoices.value !== kbVoices.value) {
                mainVoices.value = kbVoices.value;
                mainVoices.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        mainVoices.addEventListener('change', syncVoices);
    }

    if (mainDetune) {
        bindKnob(
            document.getElementById('kbUnisonDetuneKnob'),
            mainDetune,
            null,
        );
        const syncDetuneLabel = () => {
            if (kbDetuneValue) kbDetuneValue.textContent = formatDetuneCents(mainDetune.value);
        };
        syncFns.push(syncDetuneLabel);
        syncDetuneLabel();
        mainDetune.addEventListener('input', syncDetuneLabel);
    }
}

function wirePhaseReset() {
    const kbBtn = document.getElementById('kbPhaseResetToggle');
    const mainBtn = document.getElementById('phaseResetToggle');
    if (!kbBtn || !mainBtn) return;

    const sync = () => syncToggleButtonFromMain(kbBtn, mainBtn);
    syncFns.push(sync);
    observeMainControl(mainBtn, sync);
    sync();

    kbBtn.addEventListener('click', () => {
        mainBtn.click();
    });
}

function wirePanSliders() {
    for (let i = 0; i < OSC_COUNT; i++) {
        const mainPan = document.querySelector(`.osc-pan[data-osc="${i}"]`);
        const kbPan = document.querySelector(`.kb-osc-pan[data-osc="${i}"]`);
        const kbVal = document.querySelector(`.kb-osc-pan-value[data-osc="${i}"]`);
        if (!mainPan || !kbPan) continue;

        const syncFromMain = () => {
            kbPan.value = mainPan.value;
            if (kbVal) kbVal.textContent = formatOscPan(mainPan.value);
        };
        syncFns.push(syncFromMain);
        syncFromMain();

        kbPan.addEventListener('input', () => {
            if (mainPan.value !== kbPan.value) {
                mainPan.value = kbPan.value;
                mainPan.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (kbVal) {
                kbVal.textContent = formatOscPan(kbPan.value);
            }
        });
        mainPan.addEventListener('input', syncFromMain);
    }
}

export function syncKeyboardOscillatorsFromMain() {
    syncFns.forEach((fn) => fn());
}

export function initKeyboardOscillators() {
    KNOB_BINDINGS.forEach(({ dialId, selector, valueId }) => {
        bindKnob(
            document.getElementById(dialId),
            document.querySelector(selector),
            document.getElementById(valueId),
        );
    });
    wirePanSliders();

    for (let i = 0; i < OSC_COUNT; i++) {
        wireOsc(i);
    }
    wireUnison();
    wirePhaseReset();
}
