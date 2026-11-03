// Compact oscillator controls in the keyboard Synthesizer panel.
// Knobs write osc-tune-N / osc-vol-N; pan writes osc-pan-N.

import { state } from './state.js?v=120';
import { bindKnob } from './knobs.js?v=167';
import {
    elementFor,
    get,
    getString,
    set,
    subscribe,
    wireSelect,
    wireToggle,
} from './params.js?v=24';

const OSC_COUNT = 4;

const KNOB_BINDINGS = [
    { dialId: 'kbOsc1TuneKnob', key: 'osc-tune-0', valueId: 'kbOsc1TuneValue' },
    { dialId: 'kbOsc1VolKnob', key: 'osc-vol-0', valueId: 'kbOsc1VolValue' },
    { dialId: 'kbOsc2TuneKnob', key: 'osc-tune-1', valueId: 'kbOsc2TuneValue' },
    { dialId: 'kbOsc2VolKnob', key: 'osc-vol-1', valueId: 'kbOsc2VolValue' },
    { dialId: 'kbOsc3TuneKnob', key: 'osc-tune-2', valueId: 'kbOsc3TuneValue' },
    { dialId: 'kbOsc3VolKnob', key: 'osc-vol-2', valueId: 'kbOsc3VolValue' },
    { dialId: 'kbOsc4TuneKnob', key: 'osc-tune-3', valueId: 'kbOsc4TuneValue' },
    { dialId: 'kbOsc4VolKnob', key: 'osc-vol-3', valueId: 'kbOsc4VolValue' },
];

const WAVEFORMS = [
    {
        value: 'sawtooth',
        label: 'Sawtooth',
        svg: '<svg class="keyboard-osc-wave-icon" viewBox="0 0 24 12" aria-hidden="true"><polyline points="0,11 24,1 24,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"/></svg>',
    },
    {
        value: 'square',
        label: 'Square',
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
        svg: '<svg class="keyboard-osc-wave-icon" viewBox="0 0 24 12" aria-hidden="true"><polyline points="0,11 12,1 24,11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="miter"/></svg>',
    },
];

const syncFns = [];

function formatOscPan(n) {
    const v = Math.round((Number(n) || 0) * 50);
    if (v === 0) return 'C';
    return v < 0 ? `L${Math.abs(v)}` : `R${v}`;
}

function syncKbWaveFromStore(waveGroup, oscIndex) {
    if (!waveGroup) return;
    const value = getString(`osc-type-${oscIndex}`);
    waveGroup.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        const selected = btn.dataset.wave === value;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
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

    if (waveGroup && !waveGroup.querySelector('.keyboard-osc-wave-btn')) {
        buildWavePicker(waveGroup);
    }

    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, `osc-toggle-${i}`, { syncLabel: true }));
    }

    const syncWave = () => syncKbWaveFromStore(waveGroup, i);
    syncFns.push(syncWave);
    syncWave();

    waveGroup?.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            set(`osc-type-${i}`, btn.dataset.wave);
        });
    });
    subscribe(`osc-type-${i}`, syncWave);
}

function formatDetuneCents(n) {
    return `${Math.round(Number(n) || 0)}¢`;
}

function wireUnison() {
    const kbVoices = document.getElementById('kbUnisonVoices');
    const kbDetuneValue = document.getElementById('kbUnisonDetuneValue');
    const kbToggle = document.getElementById('kbUnisonToggle');

    if (kbToggle) {
        syncFns.push(wireToggle(kbToggle, 'unisonToggle', {
            syncLabel: true,
            beforeToggle: () => (state.keyboardPoly ? false : undefined),
        }));
    }

    if (kbVoices) {
        const syncVoices = wireSelect(kbVoices, 'unisonVoices');
        const syncDisabled = () => {
            const el = elementFor('unisonVoices');
            kbVoices.disabled = el ? !!el.disabled : false;
        };
        syncFns.push(syncVoices, syncDisabled);
        subscribe('unisonToggle', syncDisabled);
        syncDisabled();
    }

    bindKnob(
        document.getElementById('kbUnisonDetuneKnob'),
        'unisonDetune',
        null,
    );
    const syncDetuneLabel = () => {
        if (kbDetuneValue) kbDetuneValue.textContent = formatDetuneCents(get('unisonDetune'));
    };
    syncFns.push(syncDetuneLabel);
    syncDetuneLabel();
    subscribe('unisonDetune', syncDetuneLabel);
}

function wirePhaseReset() {
    const kbBtn = document.getElementById('kbPhaseResetToggle');
    if (!kbBtn) return;
    syncFns.push(wireToggle(kbBtn, 'phaseResetToggle', { syncLabel: true }));
}

function wirePanSliders() {
    for (let i = 0; i < OSC_COUNT; i++) {
        const key = `osc-pan-${i}`;
        const kbPan = document.querySelector(`.kb-osc-pan[data-osc="${i}"]`);
        const kbVal = document.querySelector(`.kb-osc-pan-value[data-osc="${i}"]`);
        if (!kbPan) continue;

        const syncFromStore = () => {
            const v = get(key);
            if (v != null && String(kbPan.value) !== String(v)) kbPan.value = String(v);
            if (kbVal) kbVal.textContent = formatOscPan(v);
        };
        syncFns.push(syncFromStore);
        syncFromStore();

        kbPan.addEventListener('input', () => {
            set(key, parseFloat(kbPan.value));
            if (kbVal) kbVal.textContent = formatOscPan(get(key));
        });
        subscribe(key, syncFromStore);
    }
}

export function syncKeyboardOscillatorsFromMain() {
    syncFns.forEach((fn) => fn());
}

export function initKeyboardOscillators() {
    KNOB_BINDINGS.forEach(({ dialId, key, valueId }) => {
        bindKnob(
            document.getElementById(dialId),
            key,
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
