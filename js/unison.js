// Global unison stacks for the phase-reset oscillator path.
// Each OSC becomes N detuned voices; lastStepFreqs[i] stays the shared unbent base.

import { state } from './state.js?v=120';
import { getNumber, getOscType, getOscVol, getOscPan } from './params.js?v=44';
import { analogLogicalWave, createOscSource, softStartVoiceGain, fadeStopOsc, startAnalogOsc } from './osc-source.js?v=157';

const ALLOWED_VOICES = [3];

function bentFromBase(baseFreq) {
    const ratio = Math.pow(2, (state.pitchBendSemitones || 0) / 12);
    return Math.max(20, baseFreq * ratio);
}

export function isUnisonActive() {
    return !!state.phaseResetEnabled && !!state.unisonEnabled;
}

export function getUnisonVoices() {
    if (!isUnisonActive()) return 1;
    const n = getNumber('unisonVoices', state.unisonVoices);
    return ALLOWED_VOICES.includes(n) ? n : 3;
}

export function getUnisonSpread() {
    if (!isUnisonActive()) return 0;
    const n = getNumber('unisonDetune', state.unisonSpread);
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

/** Current OSC pan from the store (−1…1). Canonical key is `osc-pan-N` (main `.osc-pan`). */
export function readOscPanValue(oscIndex) {
    return getOscPan(oscIndex, 0);
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
    const wave = getOscType(oscIndex);
    const fullVol = getOscVol(oscIndex);
    // Detuned voices add in power, so the stack keeps one voice's loudness at 1/sqrt(n).
    const voiceVol = fullVol / Math.sqrt(n);

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
            pooled: true,
        });
        try {
            osc.frequency.value = freq;
        } catch (_) {
            try { osc.frequency.setValueAtTime(freq, state.audioContext.currentTime); } catch (__) { /* ignore */ }
        }
        osc.oscIndex = oscIndex;
        osc.unisonIndex = k;
        osc.unisonCents = cents;

        const gain = state.audioContext.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(connectTarget);
        osc.gainNode = gain;

        if (osc.isWavetable) osc.start(oscStart);
        else startAnalogOsc(osc, oscStart);
        softStartVoiceGain(gain.gain, voiceVol, gainRampStart, {
            wavetable: !!osc.isWavetable,
            triggered: !!osc.isTriggered,
        });

        osc.started = true;
        state.activeOscillators.push(osc);

        if (lfoGain) {
            try { lfoGain.connect(osc.detune); } catch (_) { /* ignore */ }
        }
    }
}

/**
 * Stop stacks whose osc has been toggled OFF. Per-index replace never visits
 * disabled indices, so without this sweep their last voices sustain forever.
 */
export function stopDisabledOscStacks(startTime) {
    if (!Array.isArray(state.activeOscillators) || state.activeOscillators.length === 0) return;
    const keep = [];
    for (const osc of state.activeOscillators) {
        const idx = osc?.oscIndex;
        if (idx != null && state.oscStates?.[idx]) { keep.push(osc); continue; }
        fadeStopOsc(osc, startTime, {
            fadeSec: osc.isWavetable ? 0.055 : 0.022,
            hard: !!osc.isTriggered,
        });
    }
    state.activeOscillators = keep;
}

/**
 * Sequencer / phase-reset hit.
 * Plaits: retrigger the same worklet (gate edge).
 * Analog sine/tri/saw/square: retune frequency in place — stop+spawn restarts at
 * phase 0 into an open filter and clicks hard at high Q (same Multitudes bug).
 * Falls back to fadeStop+spawn on first hit, type mismatch, or stack-size change.
 */
export function firePhaseResetOscStack(oscIndex, baseFreq, startTime, spawnOpts = {}) {
    const n = getUnisonVoices();
    const existing = (state.activeOscillators || []).filter(
        (osc) => osc?.oscIndex === oscIndex && osc.started,
    );
    const wantWave = getOscType(oscIndex);
    const canReuse = existing.length === n && existing.every((osc) => {
        if (osc.isWavetable) return typeof osc.retrigger === 'function';
        return analogLogicalWave(osc) === wantWave;
    });

    if (canReuse) {
        const prevBase = state.lastStepFreqs[oscIndex];
        const sameNote = prevBase != null && Math.abs(baseFreq - prevBase) < 1e-4;
        state.lastStepFreqs[oscIndex] = baseFreq;
        const keep = [];
        let ok = true;
        for (const osc of existing) {
            const freq = voiceTargetFreq(osc, baseFreq);
            if (osc.isWavetable && typeof osc.retrigger === 'function') {
                if (osc.retrigger(startTime, freq)) {
                    keep.push(osc);
                } else {
                    ok = false;
                    fadeStopOsc(osc, startTime, { fadeSec: 0.055, hard: !!osc.isTriggered });
                }
            } else {
                try {
                    if (!sameNote) {
                        osc.frequency.cancelScheduledValues(startTime);
                        osc.frequency.setValueAtTime(freq, startTime);
                    }
                } catch (_) { /* ignore */ }
                keep.push(osc);
            }
        }
        state.activeOscillators = (state.activeOscillators || []).filter(
            (osc) => osc?.oscIndex !== oscIndex,
        );
        state.activeOscillators.push(...keep);
        if (ok && keep.length === n) {
            return { reused: true, sameNote: !!sameNote };
        }
        keep.forEach((osc) => fadeStopOsc(osc, startTime, {
            fadeSec: osc.isWavetable ? 0.055 : 0.022,
            hard: !!osc.isTriggered,
        }));
        state.activeOscillators = (state.activeOscillators || []).filter(
            (osc) => osc?.oscIndex !== oscIndex,
        );
    } else {
        existing.forEach((osc) => {
            // Analog keeps the original quick 22ms replace fade — 55ms overlap
            // audibly crossfades sine/tri. Digital needs the longer hard fade.
            fadeStopOsc(osc, startTime, {
                fadeSec: osc.isWavetable ? 0.055 : 0.022,
                hard: !!osc.isTriggered,
            });
        });
        state.activeOscillators = (state.activeOscillators || []).filter(
            (osc) => osc?.oscIndex !== oscIndex,
        );
    }

    spawnOscStack(oscIndex, baseFreq, startTime, spawnOpts);
    return { reused: false, sameNote: false };
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

    const poly = !!(state.keyboardPoly || state.keyboardMultitudes);
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
