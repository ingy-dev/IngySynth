// Global unison stacks for the phase-reset oscillator path.
// Each OSC becomes N detuned voices; lastStepFreqs[i] stays the shared unbent base.

import { state } from './state.js?v=107';
import { createOscSource, softStartVoiceGain } from './osc-source.js?v=34';

const ALLOWED_VOICES = [3, 5, 7];

function bentFromBase(baseFreq) {
    const ratio = Math.pow(2, (state.pitchBendSemitones || 0) / 12);
    return Math.max(20, baseFreq * ratio);
}

export function isUnisonActive() {
    return !!state.phaseResetEnabled && !!state.unisonEnabled;
}

export function getUnisonVoices() {
    if (!isUnisonActive()) return 1;
    const el = document.getElementById('unisonVoices');
    const n = el ? parseInt(el.value, 10) : state.unisonVoices;
    return ALLOWED_VOICES.includes(n) ? n : 3;
}

export function getUnisonSpread() {
    if (!isUnisonActive()) return 0;
    const el = document.getElementById('unisonDetune');
    const n = el ? parseFloat(el.value) : state.unisonSpread;
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(50, n));
}

/** Linear cents offsets across the stack: -spread … +spread (center voice at 0). */
export function unisonCents(voiceIndex, voiceCount, spread) {
    if (voiceCount <= 1 || !spread) return 0;
    const t = (voiceIndex / (voiceCount - 1)) * 2 - 1;
    return t * spread;
}

export function applyUnisonCents(freq, cents = 0) {
    if (!cents) return Math.max(20, freq);
    return Math.max(20, freq * Math.pow(2, cents / 1200));
}

/** Target Hz for a voice given the shared unbent base frequency. */
export function voiceTargetFreq(osc, baseFreq) {
    return applyUnisonCents(bentFromBase(baseFreq), osc.unisonCents || 0);
}

function lfoPitchGainFor(oscIndex) {
    return [
        state.lfoGainOsc1Pitch,
        state.lfoGainOsc2Pitch,
        state.lfoGainOsc3Pitch,
        state.lfoGainOsc4Pitch,
    ][oscIndex] || null;
}

/** Current OSC pan from the main slider (−1…1). */
export function readOscPanValue(oscIndex) {
    const panEl = document.querySelector(`.osc-pan[data-osc="${oscIndex}"]`);
    const pan = parseFloat(panEl?.value ?? '0');
    return Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
}

/**
 * Spawn N detuned oscillators for one OSC slot into state.activeOscillators.
 * Caller clears previous active oscs when replacing a note.
 */
export function spawnOscStack(oscIndex, baseFreq, startTime, {
    // Default through the shared per-OSC panner → ring mod → filter.
    connectTarget = state.oscPanners?.[oscIndex] || state.ringModInput || state.filter,
    oscStart = startTime,
    gainRampStart = startTime,
    gainRampEnd = startTime + 0.005,
} = {}) {
    const n = getUnisonVoices();
    const spread = getUnisonSpread();
    const wave = document.querySelector(`.osc-type[data-osc="${oscIndex}"]`)?.value || 'sawtooth';
    const fullVol = parseFloat(document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`)?.value ?? '0.33');
    const voiceVol = fullVol / n;

    state.lastStepFreqs[oscIndex] = baseFreq;

    const lfoGain = lfoPitchGainFor(oscIndex);
    if (lfoGain) {
        try { lfoGain.disconnect(); } catch (_) { /* ignore */ }
    }

    // Keep shared panner in sync (digital + analog) before connecting the stack
    const panner = state.oscPanners?.[oscIndex];
    if (panner && connectTarget === panner) {
        try {
            panner.pan.setValueAtTime(readOscPanValue(oscIndex), Math.max(0, startTime));
        } catch (_) { /* ignore */ }
    }

    for (let k = 0; k < n; k++) {
        const cents = unisonCents(k, n, spread);
        const freq = voiceTargetFreq({ unisonCents: cents }, baseFreq);
        const osc = createOscSource(state.audioContext, {
            oscIndex,
            wave,
            frequency: freq,
        });
        osc.frequency.value = freq;
        osc.oscIndex = oscIndex;
        osc.unisonIndex = k;
        osc.unisonCents = cents;

        const gain = state.audioContext.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(connectTarget);
        osc.gainNode = gain;

        osc.start(oscStart);
        softStartVoiceGain(gain.gain, voiceVol, gainRampStart, {
            wavetable: !!osc.isWavetable,
        });

        osc.started = true;
        state.activeOscillators.push(osc);

        if (lfoGain) {
            try { lfoGain.connect(osc.detune); } catch (_) { /* ignore */ }
        }
    }
}

function setUnisonToggleUi(on) {
    const toggle = document.getElementById('unisonToggle');
    if (!toggle) return;
    const front = toggle.querySelector('.front');
    if (front) front.textContent = on ? 'On' : 'Off';
    toggle.classList.toggle('off', !on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/** Force Unison Off when Phase Reset is Off. Controls stay enabled so Unison can auto-enable Phase Reset. */
export function syncUnisonControlsEnabled() {
    if (!state.phaseResetEnabled && state.unisonEnabled) {
        state.unisonEnabled = false;
        setUnisonToggleUi(false);
    }

    const poly = !!state.keyboardPoly;
    const group = document.querySelector('.unison-group');
    const kbGroup = document.getElementById('keyboardUnisonField');
    group?.classList.remove('unison-disabled');
    kbGroup?.classList.remove('unison-disabled');
    group?.classList.toggle('poly-classic-unison-locked', poly);
    kbGroup?.classList.toggle('poly-classic-unison-locked', poly);

    // Detune stays available in Poly (feeds Poly Unison spread)
    const dial = document.getElementById('kbUnisonDetuneKnob');
    if (dial) {
        dial.tabIndex = 0;
        dial.setAttribute('aria-disabled', 'false');
        dial.classList.remove('disabled');
    }

    ['unisonVoices', 'unisonDetune', 'unisonToggle', 'kbUnisonVoices', 'kbUnisonToggle'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const lockClassic = poly && id !== 'unisonDetune';
        el.disabled = !!lockClassic;
        el.setAttribute('aria-disabled', lockClassic ? 'true' : 'false');
    });
}
