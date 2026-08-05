// LFO shape / on-off / sync in the keyboard Mod Matrix.
// RATE dial is mode-aware (Hz / Sync) — wired in lfo-rate.js.

import {
    observeMainControl,
    syncToggleButtonFromMain,
} from './control-mirror.js?v=74';
import { setLfoSyncMode } from './lfo-rate.js?v=7';
import { state } from './state.js?v=104';

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

function syncKbWaveFromMain(waveGroup, mainSelect) {
    if (!waveGroup || !mainSelect) return;
    const value = mainSelect.value;
    waveGroup.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        const selected = btn.dataset.wave === value;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
}

function setMainWave(mainSelect, value) {
    if (!mainSelect || mainSelect.value === value) return;
    mainSelect.value = value;
    mainSelect.dispatchEvent(new Event('change', { bubbles: true }));
}

function wireWave() {
    const waveGroup = document.getElementById('kbLfoWave');
    const mainSelect = document.getElementById('lfoWaveform');
    if (!waveGroup || !mainSelect) return;

    if (!waveGroup.querySelector('.keyboard-osc-wave-btn')) {
        buildWavePicker(waveGroup);
    }

    const syncWave = () => syncKbWaveFromMain(waveGroup, mainSelect);
    syncFns.push(syncWave);
    syncWave();

    waveGroup.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            setMainWave(mainSelect, btn.dataset.wave);
            syncWave();
        });
    });

    mainSelect.addEventListener('change', syncWave);
}

function wireToggle() {
    const kbBtn = document.getElementById('kbLfoToggle');
    const mainBtn = document.getElementById('lfoToggle');
    if (!kbBtn || !mainBtn) return;

    const sync = () => syncToggleButtonFromMain(kbBtn, mainBtn);
    syncFns.push(sync);
    observeMainControl(mainBtn, sync);
    document.addEventListener('ingysynth:lfo-enabled', sync);
    sync();

    kbBtn.addEventListener('click', () => {
        mainBtn.click();
    });
}

function wireRetrigger() {
    const kbBtn = document.getElementById('kbLfoRetrigger');
    const mainBtn = document.getElementById('lfoRetrigger');
    if (!kbBtn || !mainBtn) return;

    const sync = () => {
        const on = !mainBtn.classList.contains('off');
        kbBtn.classList.toggle('off', !on);
        kbBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    syncFns.push(sync);
    observeMainControl(mainBtn, sync);
    sync();

    kbBtn.addEventListener('click', () => {
        mainBtn.click();
    });
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
    const mainBtn = document.getElementById('lfoSyncToggle');
    if (!kbBtn) return;

    const sync = () => syncKbSyncButton();
    syncFns.push(sync);
    if (mainBtn) observeMainControl(mainBtn, sync);
    document.addEventListener('ingysynth:lfo-rate', sync);
    sync();

    kbBtn.addEventListener('click', () => {
        setLfoSyncMode(!state.lfoSync);
    });
}

export function syncKeyboardLfoFromMain() {
    syncFns.forEach((fn) => fn());
}

export function initKeyboardLfo() {
    wireWave();
    wireToggle();
    wireRetrigger();
    wireSync();
}
