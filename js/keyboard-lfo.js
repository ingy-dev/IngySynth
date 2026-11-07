// LFO shape / on-off / sync in the keyboard Mod Matrix.
// RATE dial is mode-aware (Hz / Sync) — wired in lfo-rate.js.

import { getString, set, subscribe, toggle, wireToggle } from './params.js?v=44';
import { state } from './state.js?v=120';

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

function syncKbWaveFromMain(waveGroup) {
    if (!waveGroup) return;
    const value = getString('lfoWaveform');
    waveGroup.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        const selected = btn.dataset.wave === value;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
}

function wireWave() {
    const waveGroup = document.getElementById('kbLfoWave');
    if (!waveGroup) return;

    if (!waveGroup.querySelector('.keyboard-osc-wave-btn')) {
        buildWavePicker(waveGroup);
    }

    const syncWave = () => syncKbWaveFromMain(waveGroup);
    syncFns.push(syncWave);
    syncWave();

    waveGroup.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            set('lfoWaveform', btn.dataset.wave);
            syncWave();
        });
    });

    subscribe('lfoWaveform', syncWave);
}

function wireToggleOn() {
    const kbBtn = document.getElementById('kbLfoToggle');
    if (!kbBtn) return;
    const sync = wireToggle(kbBtn, 'lfoToggle', { syncLabel: true });
    syncFns.push(sync);
}

function wireRetrigger() {
    const kbBtn = document.getElementById('kbLfoRetrigger');
    if (!kbBtn) return;
    const sync = wireToggle(kbBtn, 'lfoRetrigger', { syncLabel: false });
    syncFns.push(sync);
}

function syncKbSyncButton() {
    const kbBtn = document.getElementById('kbLfoSync');
    if (!kbBtn) return;
    const on = !!state.lfoSync;
    kbBtn.textContent = on ? 'Sync' : 'Hz';
    kbBtn.classList.toggle('off', !on);
    kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function wireSync() {
    const kbBtn = document.getElementById('kbLfoSync');
    if (!kbBtn) return;

    const sync = () => syncKbSyncButton();
    syncFns.push(sync);
    document.addEventListener('ingysynth:lfo-rate', sync);
    sync();

    kbBtn.addEventListener('click', () => {
        toggle('lfoSyncToggle');
    });
}

export function syncKeyboardLfoFromMain() {
    syncFns.forEach((fn) => fn());
}

export function initKeyboardLfo() {
    wireWave();
    wireToggleOn();
    wireRetrigger();
    wireSync();
}
