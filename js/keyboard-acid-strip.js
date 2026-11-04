// Acid Mode strip above Steps: visibility, saw/square switch, OSC1 lock.

import { state, OSC_COUNT } from './state.js?v=120';
import { get, getNumber, getOscType, getOscVol, set } from './params.js?v=40';
import { refreshFilterInputDrive } from './filter-drive.js?v=55';

const ACID_WAVES = new Set(['sawtooth', 'square']);

/** Snapshot taken when entering Acid; restored on exit. */
let acidSnapshot = null;

function mainOscType(oscIndex) {
    return document.querySelector(`.osc-type[data-osc="${oscIndex}"]`);
}

function mainOscToggle(oscIndex) {
    return document.querySelector(`.osc-toggle[data-osc="${oscIndex}"]`);
}

function setOscEnabled(oscIndex, enabled) {
    const want = !!enabled;
    state.oscStates[oscIndex] = want;
    set(`osc-toggle-${oscIndex}`, want);
    syncOscToggleUi(oscIndex);
    if (state.audioContext && state.oscGains?.[oscIndex]) {
        const volume = want ? getOscVol(oscIndex) : 0;
        state.oscGains[oscIndex].gain.setValueAtTime(
            Number.isFinite(volume) ? volume : 0,
            state.audioContext.currentTime,
        );
    }
}

function syncOscToggleUi(oscIndex) {
    const on = !!state.oscStates[oscIndex];
    const main = mainOscToggle(oscIndex);
    if (main) {
        const front = main.querySelector('.front');
        if (front) front.textContent = on ? 'On' : 'Off';
        main.classList.toggle('off', !on);
        main.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const kb = document.querySelector(`.kb-osc-toggle[data-osc="${oscIndex}"]`);
    if (kb) {
        kb.classList.toggle('off', !on);
        kb.setAttribute('aria-pressed', on ? 'true' : 'false');
        kb.textContent = on ? 'On' : 'Off';
    }
}

function setNoiseEnabled(enabled) {
    const want = !!enabled;
    if (!!state.noiseState === want) {
        syncNoiseUi();
        return;
    }
    state.noiseState = want;
    syncNoiseUi();
    if (state.audioContext && state.noiseGain) {
        const volume = want ? getNumber('noiseVol', 0) : 0;
        state.noiseGain.gain.cancelScheduledValues(state.audioContext.currentTime);
        state.noiseGain.gain.setValueAtTime(volume, state.audioContext.currentTime);
    }
}

function syncNoiseUi() {
    const on = !!state.noiseState;
    const main = document.getElementById('noiseToggle');
    if (main) {
        const front = main.querySelector('.front');
        if (front) front.textContent = on ? 'On' : 'Off';
        main.classList.toggle('off', !on);
        main.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const kb = document.getElementById('kbNoiseToggle');
    if (kb) {
        kb.classList.toggle('off', !on);
        kb.setAttribute('aria-pressed', on ? 'true' : 'false');
        kb.textContent = on ? 'On' : 'Off';
    }
}

function setOsc1Wave(value) {
    const next = ACID_WAVES.has(value) ? value : 'sawtooth';
    set('osc-type-0', next);
    syncAcidWaveUi(next);
}

function syncAcidWaveUi(value) {
    const wave = ACID_WAVES.has(value) ? value : 'sawtooth';
    document.querySelectorAll('.keyboard-acid-osc-wave .keyboard-osc-wave-btn').forEach((btn) => {
        const selected = btn.dataset.wave === wave;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-checked', selected ? 'true' : 'false');
    });
}

function buildTickRings() {
    // Static TB-303-style scale: 11 printed radial ticks over 270° travel
    const count = 11;
    const angles = [];
    for (let i = 0; i < count; i++) {
        angles.push(-135 + (i * 270) / (count - 1));
    }
    document.querySelectorAll('.acid-303-knob .synth-knob-ticks').forEach((ring) => {
        if (ring.childElementCount) return;
        angles.forEach((deg, i) => {
            const tick = document.createElement('span');
            tick.className = 'synth-knob-tick acid-303-tick';
            if (i === 0 || i === count - 1 || i === Math.floor((count - 1) / 2)) {
                tick.classList.add('acid-303-tick--major');
            }
            tick.style.setProperty('--tick-angle', `${deg}deg`);
            ring.appendChild(tick);
        });
    });
}

function setAcidControlsVisible(on) {
    const controls = document.querySelector('.keyboard-acid-strip-controls');
    if (!controls) return;
    controls.hidden = !on;
}

function setAcidLockedUi(locked) {
    document.body.classList.toggle('acid-osc-locked', !!locked);
    for (let i = 1; i < OSC_COUNT; i++) {
        const kb = document.querySelector(`.kb-osc-toggle[data-osc="${i}"]`);
        const wave = document.querySelector(`.keyboard-osc-wave[data-osc="${i}"]`);
        const main = mainOscToggle(i);
        [kb, wave, main].forEach((el) => {
            if (!el) return;
            el.setAttribute('aria-disabled', locked ? 'true' : 'false');
            if ('disabled' in el) el.disabled = !!locked;
        });
        wave?.querySelectorAll('button').forEach((btn) => {
            btn.disabled = !!locked;
        });
    }
    // OSC1: keep on, but only saw/square in main picker while locked
    const osc1Wave = document.querySelector('.keyboard-osc-wave[data-osc="0"]');
    osc1Wave?.querySelectorAll('.keyboard-osc-wave-btn').forEach((btn) => {
        const allowed = ACID_WAVES.has(btn.dataset.wave);
        btn.disabled = !!locked && !allowed;
        btn.classList.toggle('acid-wave-disabled', !!locked && !allowed);
    });
    const noiseBtn = document.getElementById('kbNoiseToggle');
    const noiseMain = document.getElementById('noiseToggle');
    [noiseBtn, noiseMain].forEach((el) => {
        if (!el) return;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
        if ('disabled' in el) el.disabled = !!locked;
    });
}

/**
 * Enter/leave Acid OSC lock. Call after state.acidMode is set.
 * @param {boolean} on
 */
export function applyAcidOscLock(on) {
    if (on) {
        if (!acidSnapshot) {
            acidSnapshot = {
                oscStates: state.oscStates.slice(),
                noiseState: !!state.noiseState,
                osc1Wave: getOscType(0) || 'sawtooth',
                // Captured before Acid forces the Dist knob's effect on.
                distortionOn: !!get('distortionToggle'),
            };
        }
        setOscEnabled(0, true);
        for (let i = 1; i < OSC_COUNT; i++) setOscEnabled(i, false);
        setNoiseEnabled(false);
        const wave = getOscType(0);
        if (!ACID_WAVES.has(wave)) setOsc1Wave('sawtooth');
        else syncAcidWaveUi(wave);
        setAcidLockedUi(true);
        if (state.audioContext) refreshFilterInputDrive();
        return;
    }

    setAcidLockedUi(false);
    if (!acidSnapshot) return;
    const snap = acidSnapshot;
    acidSnapshot = null;
    for (let i = 0; i < OSC_COUNT; i++) {
        setOscEnabled(i, !!snap.oscStates[i]);
    }
    setNoiseEnabled(!!snap.noiseState);
    if (snap.osc1Wave) set('osc-type-0', snap.osc1Wave);
    syncAcidWaveUi(snap.osc1Wave || getOscType(0) || 'sawtooth');
    // Acid enables distortion for the strip Dist knob. Drop that on exit
    // unless distortion was already on before Acid.
    if (!snap.distortionOn) set('distortionToggle', false);
    if (state.audioContext) refreshFilterInputDrive();
}

export function syncAcidStripUi() {
    const on = !!state.acidMode;
    setAcidControlsVisible(on);
    document.body.classList.toggle('acid-mode', on);
    const btn = document.getElementById('kbAcidStripToggle');
    if (btn) {
        btn.classList.toggle('off', !on);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const mainBtn = document.getElementById('acidModeToggle');
    if (mainBtn) {
        const front = mainBtn.querySelector('.front');
        if (front) front.textContent = on ? 'Acid: On' : 'Acid: Off';
        mainBtn.classList.toggle('off', !on);
        mainBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    syncAcidWaveUi(getOscType(0) || 'sawtooth');
}

/**
 * Acid ↔ Poly mutex: turn Acid off and restore its OSC snapshot before Poly enters.
 * Safe to call from poly-voice (no import cycle with controls.js).
 */
export function forceAcidOffForPoly() {
    if (!state.acidMode) {
        syncAcidStripUi();
        return;
    }
    state.acidMode = false;
    applyAcidOscLock(false);
    syncAcidStripUi();
}

function wireWaveSwitch() {
    document.querySelectorAll('.keyboard-acid-osc-wave .keyboard-osc-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!state.acidMode) return;
            setOsc1Wave(btn.dataset.wave);
        });
    });
    const typeMain = mainOscType(0);
    typeMain?.addEventListener('change', () => {
        if (!state.acidMode) return;
        const v = typeMain.value;
        if (!ACID_WAVES.has(v)) {
            setOsc1Wave('sawtooth');
            return;
        }
        syncAcidWaveUi(v);
    });
}

export function initKeyboardAcidStrip() {
    buildTickRings();
    wireWaveSwitch();
    syncAcidStripUi();
}
