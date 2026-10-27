// Kb-only 6-voice polyphonic playground (shared filter, per-voice amp).
// Classic unison / ring mod locked; Poly Unison stacks the 6-voice pool on one note.

import { state, OSC_COUNT } from './state.js?v=119';
import { get, getNumber, getString, getOscType, getOscVol, getOscPan, set, subscribe } from './params.js?v=23';
import { retriggerLfoIfNeeded } from './lfo-rate.js?v=45';
import { semitonesToFrequency } from './tuning.js?v=88';
import { updateFilterCutoffRange, getFilterEnvAmount } from './filter-cutoff.js?v=92';
import { refreshFilterInputDrive } from './filter-drive.js?v=39';
import {
    updateNoteVisualizer,
    clearNoteVisualizer,
    hideLogoOverlay,
    showLogoOverlay,
} from './visualizers.js?v=130';
import { unisonCents, applyUnisonCents, syncUnisonControlsEnabled } from './unison.js?v=195';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=27';
import { syncIngy6PanelUi, initIngy6Panel } from './keyboard-ingy6-panel.js?v=50';
import { syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=111';
import {
    createOscSource,
    startAnalogOsc,
    fadeStopOsc,
    softStartVoiceGain,
    setOsc4MorphLiveHook,
    ensurePlaitsWorklet,
    warmPlaitsPool,
    PLAITS_POLY_WARM_COUNT,
    hasDarkOscActive,
    wtAttackSecForFilter,
} from './osc-source.js?v=134';
import {
    isPolyChordMemoryOn,
    getPolyChordIntervals,
    syncChordMemUI,
} from './chord-memory.js?v=32';
import {
    pairPolySeqSlidePitches,
    pairPolySeqGlissPitches,
    sortedPolySeqIntervals,
} from './poly-seq-slide.js?v=1';

/** Local bend helper — avoid circular import with pitch-bend.js. */
function bentFrequency(baseFreq) {
    const ratio = Math.pow(2, (state.pitchBendSemitones || 0) / 12);
    return Math.max(20, baseFreq * ratio);
}

export const POLY_VOICE_COUNT = 6;
const POLY_OSC_MAX = 2; // OSC 1–2 only
const POLY_DEFAULT_OSC_VOL = 0.1; // stacked chords run hot at normal mono levels
const BEND_RAMP = 0.01;
/** Same short legato ramp as the mono keyboard (voice.js RETUNE_RAMP). */
const GLIDE_RAMP = 0.012;
/** Ratchet gate-off tau (~36 ms settle). Normal notes use the Release knob, like Main Stage. */
const SEQ_GATE_CLOSE_TAU = 0.012;

/** Release-knob tau (~95% settle in `seconds`). Same as sequencer.seqReleaseTau. */
function seqReleaseTau(seconds) {
    const releaseTime = Math.max(0.02, Number(seconds) || 0);
    return Math.max(0.008, releaseTime / 3);
}

function seqFiltCloseTau(pulseRatch) {
    return pulseRatch ? SEQ_GATE_CLOSE_TAU : seqReleaseTau(readFloatParam('filterRelease', 0.3));
}
/** Mixer mute/solo open flags — poly oscs bypass shared oscMuteGains. */
const polyOscBusOpen = [true, true, true, true];

/** Snapshot taken when entering Poly; restored on exit. */
let polySnapshot = null;
let allocAge = 0;
/** Invalidates deferred poly release timeouts only — never touch state.playGeneration. */
let polyVoiceGeneration = 0;

/** @type {Array<{
 *   semi: number|null,
 *   finger: number|null,
 *   chordInterval: number,
 *   age: number,
 *   ampEnv: GainNode|null,
 *   oscs: OscillatorNode[],
 *   baseFreqs: number[],
 *   cents: number,
 *   releasing: boolean,
 * }>} */
let voices = [];

function ensureVoicePool() {
    if (!state.audioContext) return;
    if (voices.length === POLY_VOICE_COUNT) return;
    voices = [];
    for (let i = 0; i < POLY_VOICE_COUNT; i++) {
        const ampEnv = state.audioContext.createGain();
        ampEnv.gain.value = 0;
        const dest = state.ringModInput || state.filter;
        if (dest) ampEnv.connect(dest);
        voices.push({
            semi: null,
            finger: null,
            chordInterval: 0,
            age: 0,
            ampEnv,
            oscs: [],
            baseFreqs: [],
            cents: 0,
            releasing: false,
            sequenced: false,
            seqId: 0,
            engineGen: 0,
        });
    }
}

function scaleAdsrTime(seconds) {
    return Math.max(0.002, seconds);
}

/** Like parseFloat, but keeps 0 (unlike `x || default`, which treats 0 as missing). */
function readFloatParam(id, fallback) {
    return getNumber(id, fallback);
}

function getPolyDetuneCents() {
    const n = getNumber('unisonDetune', state.unisonSpread);
    if (!Number.isFinite(n)) return 10;
    return Math.max(0, Math.min(50, n));
}

function mainOscType(oscIndex) {
    return document.querySelector(`.osc-type[data-osc="${oscIndex}"]`);
}

function mainOscToggle(oscIndex) {
    return document.querySelector(`.osc-toggle[data-osc="${oscIndex}"]`);
}

function setOscVolUi(oscIndex, value) {
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    set(`osc-vol-${oscIndex}`, clamped);
    const main = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
    if (main) {
        const display = main.nextElementSibling;
        if (display) display.textContent = clamped.toFixed(2);
    }
    const kbVal = document.getElementById(`kbOsc${oscIndex + 1}VolValue`);
    if (kbVal) kbVal.textContent = clamped.toFixed(2);
}

function readOscVol(oscIndex) {
    return getOscVol(oscIndex, POLY_DEFAULT_OSC_VOL);
}

/** Unison is coherent (1/N). Distinct chord tones are incoherent (1/√N, same RMS as one note). */
function polyStackNorm(stackCount, sequenced, unison = false) {
    const chordN = stackCount > 1
        ? stackCount
        : (!sequenced && isPolyChordMemoryOn()
            ? Math.max(1, getPolyChordIntervals().length)
            : 1);
    const liveUni = !!(
        !sequenced
        && state.keyboardPolyUnison
        && state.keyboardPoly
        && !isPolyChordMemoryOn()
    );
    const uniDiv = liveUni ? POLY_VOICE_COUNT : 1;
    const stackDiv = uniDiv * (chordN > 1 ? chordN : 1);
    const coherent = !!(unison || liveUni);
    const denom = coherent ? stackDiv : Math.sqrt(Math.max(1, stackDiv));
    return { chordN, uniDiv, stackDiv, coherent, denom };
}

function polyStackVoiceVol(fullVol, stackCount, sequenced, unison = false) {
    const { denom } = polyStackNorm(stackCount, sequenced, unison);
    return Math.max(0.0001, fullVol / denom);
}

function setOscEnabled(oscIndex, enabled) {
    const want = !!enabled;
    if (!!state.oscStates[oscIndex] === want) {
        set(`osc-toggle-${oscIndex}`, want);
        syncOscToggleUi(oscIndex);
        return;
    }
    state.oscStates[oscIndex] = want;
    set(`osc-toggle-${oscIndex}`, want);
    syncOscToggleUi(oscIndex);
    if (state.audioContext && state.oscGains?.[oscIndex]) {
        const volume = want ? getOscVol(oscIndex, POLY_DEFAULT_OSC_VOL) : 0;
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
    if (state.keyboardPoly) {
        syncPolyNoiseFromUi();
        return;
    }
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

function setRingModEnabled(on) {
    state.ringModEnabled = !!on;
    if (!state.audioContext || !state.ringModDryGain || !state.ringModWetGain) return;
    if (state.ringModEnabled) {
        const value = getNumber('ringMod', 0);
        state.ringModDryGain.gain.setValueAtTime(1 - value, state.audioContext.currentTime);
        state.ringModWetGain.gain.setValueAtTime(value, state.audioContext.currentTime);
    } else {
        state.ringModDryGain.gain.setValueAtTime(1, state.audioContext.currentTime);
        state.ringModWetGain.gain.setValueAtTime(0, state.audioContext.currentTime);
    }
    const toggle = document.getElementById('ringModToggle');
    if (toggle) {
        const front = toggle.querySelector('.front');
        if (front) front.textContent = state.ringModEnabled ? 'On' : 'Off';
        toggle.classList.toggle('off', !state.ringModEnabled);
        toggle.setAttribute('aria-pressed', state.ringModEnabled ? 'true' : 'false');
    }
    const kb = document.getElementById('kbRingModToggle');
    if (kb) {
        kb.textContent = state.ringModEnabled ? 'On' : 'Off';
        kb.classList.toggle('off', !state.ringModEnabled);
        kb.setAttribute('aria-pressed', state.ringModEnabled ? 'true' : 'false');
    }
    const input = document.getElementById('ringMod');
    if (input) input.disabled = !state.ringModEnabled || !!state.keyboardPoly || !!state.keyboardMultitudes;
}

function setClassicUnisonEnabled(on) {
    state.unisonEnabled = !!on;
    const toggle = document.getElementById('unisonToggle');
    if (toggle) {
        const front = toggle.querySelector('.front');
        if (front) front.textContent = on ? 'On' : 'Off';
        toggle.classList.toggle('off', !on);
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const kb = document.getElementById('kbUnisonToggle');
    if (kb) {
        kb.textContent = on ? 'On' : 'Off';
        kb.classList.toggle('off', !on);
        kb.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
}

function setPolyLockedUi(locked) {
    document.body.classList.toggle('poly-mode', !!locked);

    // OSC 3–4 locked; OSC 2 stays usable
    for (let i = 2; i < OSC_COUNT; i++) {
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

    // Noise type/toggle locked on main UI — Ingy 6 panel owns noise while Poly
    ['kbNoiseToggle', 'noiseToggle', 'noiseType', 'kbNoiseTypeSelect'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
        if ('disabled' in el) el.disabled = !!locked;
    });

    // Classic unison toggles + voice count locked; detune stays for Poly Unison
    ['unisonToggle', 'kbUnisonToggle', 'unisonVoices', 'kbUnisonVoices'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !!locked;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });
    document.querySelector('.unison-group')?.classList.toggle('poly-classic-unison-locked', !!locked);
    document.getElementById('keyboardUnisonField')?.classList.toggle('poly-classic-unison-locked', !!locked);

    // Ring mod locked
    ['ringModToggle', 'kbRingModToggle', 'ringMod'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !!locked || (id === 'ringMod' && !state.ringModEnabled);
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });
    document.querySelector('.keyboard-effects-ringmod-field')?.classList.toggle('poly-fx-locked', !!locked);
    document.getElementById('kbRingModKnob')?.classList.toggle('disabled', !!locked);
    if (locked) {
        document.getElementById('kbRingModKnob')?.setAttribute('aria-disabled', 'true');
    } else {
        document.getElementById('kbRingModKnob')?.setAttribute('aria-disabled', 'false');
    }

    // Filter ADSR locked as mirrors of amp ADSR while Poly (Ingy 6 shared env)
    [
        'filterAttack', 'filterDecay', 'filterSustain', 'filterRelease',
        'filterEnvToggle', 'kbFilterEnvToggle',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.disabled = !!locked;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });
    [
        'kbFilterAttackKnob', 'kbFilterDecayKnob', 'kbFilterSustainKnob', 'kbFilterReleaseKnob',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('disabled', !!locked);
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });

    const polyUni = document.getElementById('kbPolyUnisonToggle');
    if (polyUni) {
        polyUni.hidden = !locked;
        polyUni.disabled = !locked;
        polyUni.setAttribute('aria-disabled', locked ? 'false' : 'true');
    }

    syncPolyUnusedOscModLock();
}

/** OSC 3–4 have no poly voices — grey the mod-matrix dests in Ingy 6 and Multitudes. */
function syncPolyUnusedOscModLock() {
    const locked = !!(state.keyboardPoly || state.keyboardMultitudes);
    ['kbOsc3PitchModKnob', 'kbOsc4PitchModKnob'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('aria-disabled', locked ? 'true' : 'false');
        el.setAttribute('tabindex', locked ? '-1' : '0');
    });
}

/**
 * Sequencer / mono live voices share ringModInput + master envelope with poly.
 * After Stop, activeOscillators can still be connected until a deferred cleanup;
 * opening the master envelope for poly would let that mono note hang on top.
 */
function killSharedMonoOscillators(now) {
    if (state.stopCleanupTimeout) {
        clearTimeout(state.stopCleanupTimeout);
        state.stopCleanupTimeout = null;
    }

    if (state.activeOscillators?.length) {
        state.activeOscillators.forEach((osc) => {
            try {
                if (osc.gainNode) {
                    osc.gainNode.gain.cancelScheduledValues(now);
                    osc.gainNode.gain.setValueAtTime(0, now);
                    try { osc.gainNode.disconnect(); } catch (_) { /* ignore */ }
                }
                try { osc.stop(now); } catch (_) {
                    try { osc.stop(now + 0.01); } catch (_) { /* ignore */ }
                }
                try { osc.disconnect(); } catch (_) { /* ignore */ }
            } catch (_) { /* ignore */ }
        });
        state.activeOscillators = [];
    }

    // Phase-reset Off: persistent oscs stay started — keep their gains muted in poly
    if (state.oscGains?.length) {
        state.oscGains.forEach((g) => {
            try {
                g.gain.cancelScheduledValues(now);
                g.gain.setValueAtTime(0, now);
            } catch (_) { /* ignore */ }
        });
    }
}

function openMasterEnvelope(now) {
    if (!state.envelope) return;
    // Always clear leftover mono/seq voices before opening the shared amp bus
    killSharedMonoOscillators(now);
    state.envelope.gain.cancelScheduledValues(now);
    state.envelope.gain.setValueAtTime(1, now);
    state.envelopeHeld = true;
}

function holdMasterEnvelope() {
    if (!state.audioContext) return;
    // Open at currentTime. A future setValueAtTime(1, when) is cancelled by the
    // next lookahead step's cancelScheduledValues(now), which left the master
    // VCA at ~0 after Stop/Start in poly modes.
    openMasterEnvelope(state.audioContext.currentTime);
}

export function forceDrumFiltOffForPoly() {
    set('drumFiltToggle', false);
}

/** Invalidate lookahead poly/MIDI voices on engine hot-swap. Does not bump playGeneration. */
export function bumpSeqEngine() {
    state.seqEngineGeneration = (state.seqEngineGeneration || 0) + 1;
    forcePolyAllOff({ silent: true });
    if (state.audioContext) killSharedMonoOscillators(state.audioContext.currentTime);
    document.dispatchEvent(new CustomEvent('ingysynth:seq-engine-bump'));
}

function polyNoiseTargetLevel() {
    if (!state.keyboardPoly || !state.noiseState) return 0;
    // Noise UI is 0–1; poly DCOs sit at POLY_DEFAULT_OSC_VOL so the mix matches.
    return Math.max(0, readFloatParam('noiseVol', 0) * POLY_DEFAULT_OSC_VOL);
}

function ensurePolyNoiseSource() {
    if (!state.audioContext || !state.noiseBuffers?.white) return;
    if (state.noiseSource) return;
    try {
        const type = getString('noiseType', 'white');
        const src = state.audioContext.createBufferSource();
        src.buffer = state.noiseBuffers[type] || state.noiseBuffers.white;
        src.loop = true;
        src.connect(state.noiseGain);
        src.start(0);
        state.noiseSource = src;
    } catch (_) { /* ignore */ }
}

/** Shared noise VCA — follows amp ADSR/GATE; silent when no poly notes. */
function triggerPolyNoiseEnv(now) {
    if (!state.keyboardPoly || !state.noiseGain) return;
    const level = polyNoiseTargetLevel();
    const g = state.noiseGain.gain;
    if (level <= 0.001) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(0, now);
        return;
    }
    ensurePolyNoiseSource();
    if (state.polyVcaGate) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(level, now);
        return;
    }
    const attack = scaleAdsrTime(readFloatParam('attack', 0.01));
    const decay = scaleAdsrTime(readFloatParam('decay', 0.2));
    const sustain = Math.max(0.00001, readFloatParam('sustain', 0.7) * level);
    const startLevel = Math.max(0.00001, g.value || 0.00001);
    g.cancelScheduledValues(now);
    g.setValueAtTime(startLevel, now);
    g.linearRampToValueAtTime(level, now + attack);
    g.linearRampToValueAtTime(sustain, now + attack + decay);
}

function releasePolyNoiseEnv(now) {
    if (!state.keyboardPoly || !state.noiseGain) return;
    if (activePolyCount() > 0) return;
    const g = state.noiseGain.gain;
    const minValue = 0.00001;
    if (state.polyVcaGate) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.max(minValue, g.value || minValue), now);
        g.exponentialRampToValueAtTime(minValue, now + 0.004);
        return;
    }
    const releaseTime = Math.max(0.02, readFloatParam('release', 0.3));
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(minValue, g.value || minValue), now);
    g.exponentialRampToValueAtTime(minValue, now + releaseTime);
}

function mutePolyNoise(now) {
    if (!state.noiseGain) return;
    try {
        state.noiseGain.gain.cancelScheduledValues(now);
        state.noiseGain.gain.setValueAtTime(0, now);
    } catch (_) { /* ignore */ }
}

/** Ingy noise fader moved — arm source, keep silent unless notes are held. */
export function syncPolyNoiseFromUi() {
    if (!state.keyboardPoly || !state.audioContext || !state.noiseGain) return;
    const now = state.audioContext.currentTime;
    const level = polyNoiseTargetLevel();
    if (level <= 0.001) {
        mutePolyNoise(now);
        return;
    }
    ensurePolyNoiseSource();
    if (activePolyCount() > 0) {
        // Update sustain/gate level without a full re-attack
        const g = state.noiseGain.gain;
        if (state.polyVcaGate) {
            g.cancelScheduledValues(now);
            g.setValueAtTime(level, now);
        } else {
            const sustain = Math.max(0.00001, readFloatParam('sustain', 0.7) * level);
            g.cancelScheduledValues(now);
            g.setValueAtTime(Math.max(minValueSafe(g.value), sustain), now);
        }
    } else {
        mutePolyNoise(now);
    }
}

function minValueSafe(v) {
    return Math.max(0.00001, Number(v) || 0.00001);
}

function polyFilterAdsrIds() {
    // Ingy 6 / Juno-60: one ADSR shapes amp + filter while Poly is on.
    // Multitudes keeps filter env independent.
    if (state.keyboardPoly && !state.keyboardMultitudes) {
        return { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' };
    }
    return {
        attack: 'filterAttack',
        decay: 'filterDecay',
        sustain: 'filterSustain',
        release: 'filterRelease',
    };
}

function triggerSharedFilterEnvelope(now, { skipClose = false } = {}) {
    if (state.acidMode) return; // Acid owns filter env path while active
    if (!state.filterEnvGain || getFilterEnvAmount() === 0) return;

    const ids = polyFilterAdsrIds();
    const attack = readFloatParam(ids.attack, 0.01);
    const decay = readFloatParam(ids.decay, 0.2);
    const sustain = readFloatParam(ids.sustain, 0.5);
    const baseCutoff = Math.max(40, readFloatParam('cutoff', 1000));
    const safeAttack = scaleAdsrTime(attack);
    const safeDecay = scaleAdsrTime(decay);
    const minValue = 0.00001;

    updateFilterCutoffRange(baseCutoff, now, 0.01);
    const gainParam = state.filterEnvGain.gain;
    const qNow = readFloatParam('resonance', 0);
    const qFloor = Math.max(0, Math.min(1, (qNow - 6) / 14)) * 0.014;
    const minAttack = Math.max(0.002, qFloor);
    const filtAttack = Math.max(minAttack, safeAttack);
    const closeT = skipClose ? 0 : Math.max(0.004, qFloor * 0.6);
    let held = false;
    if (typeof gainParam.cancelAndHoldAtTime === 'function') {
        try { gainParam.cancelAndHoldAtTime(now); held = true; } catch (_) { /* ignore */ }
    }
    if (!held) gainParam.cancelScheduledValues(now);
    if (skipClose) {
        gainParam.linearRampToValueAtTime(1, now + filtAttack);
        gainParam.linearRampToValueAtTime(sustain, now + filtAttack + safeDecay);
    } else {
        gainParam.linearRampToValueAtTime(minValue, now + closeT);
        gainParam.linearRampToValueAtTime(1, now + closeT + filtAttack);
        gainParam.linearRampToValueAtTime(sustain, now + closeT + filtAttack + safeDecay);
    }
    state.filterEnvelopeHeld = true;
}

function releaseSharedFilterIfIdle(now) {
    if (activePolyCount() > 0) return;
    if (state.acidMode) return;
    if (!state.filterEnvGain) return;
    const ids = polyFilterAdsrIds();
    const filterRelease = readFloatParam(ids.release, 0.2);
    const filterReleaseTime = Math.max(0.02, filterRelease);
    const minValue = 0.00001;
    const baseCutoff = Math.max(40, readFloatParam('cutoff', 1000));
    state.filterEnvGain.gain.cancelScheduledValues(now);
    state.filterEnvGain.gain.setValueAtTime(
        Math.max(minValue, state.filterEnvGain.gain.value || minValue),
        now,
    );
    state.filterEnvGain.gain.exponentialRampToValueAtTime(minValue, now + filterReleaseTime);
    updateFilterCutoffRange(baseCutoff, now, filterReleaseTime);
    state.filterEnvelopeHeld = false;
}

function rampMuteGain(node, open, now) {
    if (!node) return;
    const v = open ? 1 : 0;
    try {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(v, now + 0.02);
    } catch (_) { /* ignore */ }
}

function lfoPitchGainForOsc(oscIndex) {
    return [
        state.lfoGainOsc1Pitch,
        state.lfoGainOsc2Pitch,
        state.lfoGainOsc3Pitch,
        state.lfoGainOsc4Pitch,
    ][oscIndex] || null;
}

function connectPolyOscPitchLfo(osc) {
    const lfoGain = lfoPitchGainForOsc(osc?.oscIndex);
    if (!lfoGain || !osc?.detune) return;
    try { lfoGain.connect(osc.detune); } catch (_) { /* ignore */ }
}

function disconnectPolyOscPitchLfo(osc) {
    const lfoGain = lfoPitchGainForOsc(osc?.oscIndex);
    if (!lfoGain || !osc?.detune) return;
    try { lfoGain.disconnect(osc.detune); } catch (_) { /* ignore */ }
}

function disconnectOscGraph(osc) {
    disconnectPolyOscPitchLfo(osc);
    try { osc.gainNode?.disconnect(); } catch (_) { /* ignore */ }
    try { osc.panNode?.disconnect(); } catch (_) { /* ignore */ }
    try { osc.muteNode?.disconnect(); } catch (_) { /* ignore */ }
    try { osc.disconnect(); } catch (_) { /* ignore */ }
}

function stopVoiceOscs(voice, now) {
    const ctxNow = state.audioContext?.currentTime ?? now;
    const rawT = Math.max(ctxNow, Number(now) || ctxNow);
    // Web Audio throws if osc.stop() is before osc.start(); leftover oscs then
    // start later with no matching stop (hung note into the shared filter).
    const startT = voice.oscStartWhen;
    const t = startT != null ? Math.max(rawT, startT) : rawT;
    const immediate = t <= ctxNow + 0.0005;
    voice.oscs.forEach((osc) => {
        try {
            // Match Main analog replace (22ms) / WT (55ms).
            if (!immediate && osc.started) {
                fadeStopOsc(osc, t, {
                    fadeSec: osc.isWavetable ? 0.055 : 0.022,
                    hard: !!osc.isTriggered,
                });
                const o = osc;
                const delayMs = Math.max(0, (t - ctxNow) * 1000) + 40;
                setTimeout(() => disconnectOscGraph(o), delayMs);
                return;
            }
            if (osc.isWavetable) {
                fadeStopOsc(osc, t, { fadeSec: 0.03, hard: !!osc.isTriggered });
                if (immediate) disconnectOscGraph(osc);
                else {
                    const o = osc;
                    const delayMs = Math.max(0, (t - ctxNow) * 1000) + 30;
                    setTimeout(() => disconnectOscGraph(o), delayMs);
                }
                return;
            }
            if (osc.gainNode) {
                const g = osc.gainNode.gain;
                if (immediate) {
                    g.cancelScheduledValues(ctxNow);
                    g.setValueAtTime(0.00001, ctxNow);
                } else if (typeof g.cancelAndHoldAtTime === 'function') {
                    try { g.cancelAndHoldAtTime(t); } catch (_) { /* ignore */ }
                    g.setValueAtTime(0.00001, t);
                } else {
                    g.setValueAtTime(Math.max(0.00001, Number(g.value) || 0.00001), t);
                    g.exponentialRampToValueAtTime(0.00001, t + 0.008);
                }
            }
            try {
                osc.stop(t);
            } catch (_) {
                try { osc.stop(Math.max(t, startT || t) + 0.01); } catch (_) { /* ignore */ }
            }
            if (immediate) disconnectOscGraph(osc);
            else {
                const o = osc;
                const delayMs = Math.max(0, (t - ctxNow) * 1000) + 30;
                setTimeout(() => disconnectOscGraph(o), delayMs);
            }
        } catch (_) { /* ignore */ }
    });
    voice.oscs = [];
    voice.baseFreqs = [];
    voice.oscStartWhen = null;
}

function silenceVoiceAmp(voice, now) {
    if (!voice?.ampEnv || !state.audioContext) return;
    try {
        const ctxNow = state.audioContext.currentTime;
        const t = Math.max(ctxNow, Number(now) || ctxNow);
        const g = voice.ampEnv.gain;
        if (t <= ctxNow + 0.0005) {
            g.cancelScheduledValues(ctxNow);
            g.setValueAtTime(0, ctxNow);
        } else if (typeof g.cancelAndHoldAtTime === 'function') {
            try { g.cancelAndHoldAtTime(t); } catch (_) { /* ignore */ }
            g.setValueAtTime(0, t);
        } else {
            g.setValueAtTime(Math.max(0.00001, Number(g.value) || 0.00001), t);
            g.setValueAtTime(0, t);
        }
    } catch (_) { /* ignore */ }
}

function triggerVoiceAmp(voice, now, { fromCurrent = false, peakScale = 1, gateOffAt = null, duck = false } = {}) {
    const g = voice.ampEnv.gain;
    const peak = Math.max(0.00001, peakScale);
    // Ingy 6 VCA GATE: instant open (filter still uses shared ADSR)
    if (state.keyboardPoly && state.polyVcaGate && !state.keyboardMultitudes) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(peak, now);
        voice.releasing = false;
        return;
    }
    const attack = readFloatParam('attack', 0.01);
    const decay = readFloatParam('decay', 0.2);
    const sustain = readFloatParam('sustain', 0.7);
    const safeAttack = scaleAdsrTime(attack);
    const safeDecay = scaleAdsrTime(decay);
    // Sequenced amp is pre-filter. Ducking it pings sine/tri; hold like Berlin.
    if (voice.sequenced) {
        const darkOsc = hasDarkOscActive();
        const seqAttack = Math.max(darkOsc ? Math.max(0.008, wtAttackSecForFilter() * 0.55) : 0.004, safeAttack);
        let decayStart = now + seqAttack;
        if (gateOffAt != null && gateOffAt > now + 0.008) {
            decayStart = Math.min(decayStart, gateOffAt - 0.008);
        }
        let held = false;
        if (typeof g.cancelAndHoldAtTime === 'function') {
            try { g.cancelAndHoldAtTime(now); held = true; } catch (_) { /* ignore */ }
        }
        if (!held) g.cancelScheduledValues(now);
        if (duck) {
            g.setValueAtTime(0.00001, now);
        }
        const attackTau = Math.max(0.0008, seqAttack / 3);
        g.setTargetAtTime(peak, now, attackTau);
        g.setTargetAtTime(Math.max(0.00001, sustain * peak), decayStart, Math.max(0.004, safeDecay / 3));
        voice.releasing = false;
        return;
    }
    const startLevel = fromCurrent
        ? Math.max(0.00001, g.value || 0.00001)
        : 0.00001;
    g.cancelScheduledValues(now);
    g.setValueAtTime(startLevel, now);
    g.linearRampToValueAtTime(peak, now + safeAttack);
    g.linearRampToValueAtTime(Math.max(0.00001, sustain * peak), now + safeAttack + safeDecay);
    voice.releasing = false;
}

function releaseVoiceAmp(voice, now) {
    const minValue = 0.00001;
    const g = voice.ampEnv.gain;
    // Ingy 6 VCA GATE: fast mute
    const releaseTime = (state.keyboardPoly && state.polyVcaGate && !state.keyboardMultitudes)
        ? 0.004
        : Math.max(0.02, readFloatParam('release', 0.3));
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(minValue, g.value || minValue), now);
    g.exponentialRampToValueAtTime(minValue, now + releaseTime);
    voice.releasing = true;

    const generation = polyVoiceGeneration;
    const semi = voice.semi;
    setTimeout(() => {
        if (generation !== polyVoiceGeneration) return;
        if (voice.semi !== semi) return;
        if (!voice.releasing) return;
        stopVoiceOscs(voice, state.audioContext.currentTime);
        voice.semi = null;
        voice.finger = null;
        voice.chordInterval = 0;
        voice.releasing = false;
    }, (releaseTime + 0.05) * 1000);
}

function spawnVoiceOscs(voice, soundingSemi, cents, now, { stackCount = 0, sequenced = false, unison = false } = {}) {
    stopVoiceOscs(voice, now);
    const dest = voice.ampEnv;
    let any = false;
    const multitudes = !!state.keyboardMultitudes;

    for (let i = 0; i < POLY_OSC_MAX; i++) {
        if (!state.oscStates[i]) continue;
        any = true;
        const baseFreq = Math.max(20, semitonesToFrequency(soundingSemi, i));
        const freq = applyUnisonCents(bentFrequency(baseFreq), cents);
        const wave = (!multitudes && i === 1)
            ? 'square'
            : getOscType(i);
        let fullVol = getOscVol(i, POLY_DEFAULT_OSC_VOL);
        if (i === 1 && state.keyboardPoly && !multitudes) {
            const subFader = parseFloat(
                document.querySelector('#ingy6Panel .ingy6-fader[data-param="subOsc"] .ingy6-fader-input')?.value,
            );
            const pct = Number.isFinite(subFader) ? Math.max(0, Math.min(1, subFader / 10)) : 0;
            fullVol *= pct;
        }
        const voiceVol = polyStackVoiceVol(fullVol, stackCount, sequenced, unison);

        const panValue = getOscPan(i);
        const panner = state.audioContext.createStereoPanner();
        panner.pan.value = panValue;
        const muteGain = state.audioContext.createGain();
        muteGain.gain.value = polyOscBusOpen[i] !== false ? 1 : 0;
        panner.connect(muteGain);
        muteGain.connect(dest);

        let osc;
        if (multitudes && i === 0) {
            osc = createOscSource(state.audioContext, {
                oscIndex: 0,
                wave,
                frequency: freq,
            });
            const gain = state.audioContext.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(panner);
            osc.gainNode = gain;
            osc.panNode = panner;
            osc.muteNode = muteGain;
            osc.oscIndex = i;
            osc.unisonCents = cents;
            osc.polyBaseFreq = baseFreq;
            if (typeof osc.start === 'function') osc.start(now);
            osc.started = true;
            softStartVoiceGain(gain.gain, voiceVol, now, {
                wavetable: !!osc.isWavetable,
                triggered: !!osc.isTriggered,
            });
        } else {
            osc = createOscSource(state.audioContext, {
                oscIndex: i,
                wave,
                frequency: freq,
            });
            osc.oscIndex = i;
            osc.unisonCents = cents;
            osc.polyBaseFreq = baseFreq;
            const gain = state.audioContext.createGain();
            gain.gain.value = 0;
            osc.connect(gain);
            gain.connect(panner);
            osc.gainNode = gain;
            osc.panNode = panner;
            osc.muteNode = muteGain;
            if (osc.isWavetable) osc.start(now);
            else startAnalogOsc(osc, now);
            osc.started = true;
            softStartVoiceGain(gain.gain, voiceVol, now, {
                wavetable: !!osc.isWavetable,
                triggered: !!osc.isTriggered,
            });
        }

        connectPolyOscPitchLfo(osc);
        voice.oscs.push(osc);
        voice.baseFreqs.push(baseFreq);
    }

    voice.cents = cents;
    voice.oscStartWhen = now;
    return any;
}

/** Live mixer mute/solo for poly oscs (chord steps + live keys). */
export function applyPolyMixerMutes(oscOpen) {
    if (Array.isArray(oscOpen)) {
        for (let i = 0; i < OSC_COUNT; i++) {
            polyOscBusOpen[i] = oscOpen[i] !== false;
        }
    }
    const ctx = state.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    voices.forEach((voice) => {
        voice.oscs.forEach((osc) => {
            const i = osc?.oscIndex;
            if (i == null) return;
            rampMuteGain(osc.muteNode, polyOscBusOpen[i] !== false, now);
        });
    });
}

/** Live-update pan on sounding poly oscs for one OSC slot. */
export function applyPolyOscPan(oscIndex, panValue) {
    if (!state.audioContext) return;
    const pan = Number.isFinite(panValue) ? Math.max(-1, Math.min(1, panValue)) : 0;
    const now = state.audioContext.currentTime;
    voices.forEach((voice) => {
        if (voice.semi == null) return;
        voice.oscs.forEach((osc) => {
            if (osc.oscIndex !== oscIndex || !osc.panNode) return;
            osc.panNode.pan.setValueAtTime(pan, now);
        });
    });
}

function activePolyCount() {
    return voices.filter((v) => v.semi != null && !v.releasing).length;
}

export function isPolyMode() {
    return !!(state.keyboardPoly || state.keyboardMultitudes);
}

/** True when Multitudes (or Ingy-6) owns the 6-voice playground. */
export function isPolyPlayMode() {
    return isPolyMode();
}

export function hasPolyVoices() {
    return voices.some((v) => v.semi != null);
}

function fingerOf(voice) {
    return voice.finger != null ? voice.finger : voice.semi;
}

function findVoiceForSemi(semi) {
    return voices.find((v) => v.semi === semi && !v.releasing) || null;
}

function freeVoiceCount() {
    return voices.filter((v) => v.semi == null).length;
}

function hardFreeFinger(finger, atTime, { keepAmp = false } = {}) {
    if (!state.audioContext || !Number.isFinite(finger)) return;
    const now = atTime != null ? atTime : state.audioContext.currentTime;
    voices.forEach((v) => {
        if (v.semi == null && v.finger == null) return;
        if (fingerOf(v) !== finger) return;
        if (!keepAmp) silenceVoiceAmp(v, now);
        stopVoiceOscs(v, now);
        v.semi = null;
        v.finger = null;
        v.chordInterval = 0;
        v.releasing = false;
        v.sequenced = false;
        v.seqId = 0;
        v.engineGen = 0;
    });
}

function oldestOtherFinger(exceptFinger) {
    const ages = new Map();
    for (const v of voices) {
        if (v.semi == null) continue;
        const f = fingerOf(v);
        if (f === exceptFinger) continue;
        const prev = ages.get(f);
        if (prev == null || v.age < prev) ages.set(f, v.age);
    }
    let best = null;
    let bestAge = Infinity;
    ages.forEach((age, f) => {
        if (age < bestAge) {
            bestAge = age;
            best = f;
        }
    });
    return best;
}

function allocVoice() {
    ensureVoicePool();
    const free = voices.find((v) => v.semi == null);
    if (free) return free;
    // Steal oldest (lowest age) among non-releasing, else any
    let candidate = null;
    for (const v of voices) {
        if (!candidate || v.age < candidate.age) candidate = v;
    }
    return candidate;
}

function startSingleVoice(semi, sounding, cents) {
    const now = state.audioContext.currentTime;
    let voice = findVoiceForSemi(semi);
    const legato = !!(voice && voice.oscs.length);
    if (!voice) voice = allocVoice();
    if (!voice) return;

    if (voice.semi != null && voice.semi !== semi) {
        stopVoiceOscs(voice, now);
    }

    voice.semi = semi;
    voice.finger = semi;
    voice.chordInterval = 0;
    voice.age = ++allocAge;
    const ok = spawnVoiceOscs(voice, sounding, cents, now);
    if (!ok) {
        voice.semi = null;
        voice.finger = null;
        voice.chordInterval = 0;
        return;
    }
    openMasterEnvelope(now);
    triggerVoiceAmp(voice, now, { fromCurrent: legato });
    triggerSharedFilterEnvelope(now);
    triggerPolyNoiseEnv(now);
    state.keyboardVoiceActive = true;
    // Don't bump playGeneration while arping — the arp clock is keyed to it
    // and would die after the first poly gate (mono chord arp never bumps this).
    if (!state.isArping) {
        state.playGeneration += 1;
    }
}

function releaseSingleVoice(semi) {
    if (!state.audioContext) return;
    const owned = voices.filter((v) => v.semi != null && !v.releasing && fingerOf(v) === semi);
    if (!owned.length) return;
    const now = state.audioContext.currentTime;
    owned.forEach((voice) => releaseVoiceAmp(voice, now));
    if (activePolyCount() === 0) {
        state.keyboardVoiceActive = false;
        releaseSharedFilterIfIdle(now);
        releasePolyNoiseEnv(now);
        document.dispatchEvent(new CustomEvent('ingysynth:live-note-off'));
        const release = getNumber('release', 0.5);
        showLogoOverlay(Math.max(1500, (release + 0.1) * 1000));
        if (!state.isPlaying && !state.isArping && !window.noteVisualizerPreviewActive) {
            clearNoteVisualizer();
        }
    }
}

/** Stack all 6 voices on one note with detune spread (Alpha Juno-style). */
function startUnisonStack(semi, sounding) {
    ensureVoicePool();
    const now = state.audioContext.currentTime;
    const spread = getPolyDetuneCents();
    forcePolyAllOff({ silent: true });

    openMasterEnvelope(now);
    hideLogoOverlay();
    document.dispatchEvent(new CustomEvent('ingysynth:live-note-on'));

    for (let k = 0; k < POLY_VOICE_COUNT; k++) {
        const voice = voices[k];
        const cents = unisonCents(k, POLY_VOICE_COUNT, spread);
        voice.semi = semi;
        voice.finger = semi;
        voice.chordInterval = 0;
        voice.age = ++allocAge;
        const ok = spawnVoiceOscs(voice, sounding, cents, now);
        if (ok) triggerVoiceAmp(voice, now, { fromCurrent: false });
        else {
            voice.semi = null;
            voice.finger = null;
        }
    }
    triggerSharedFilterEnvelope(now);
    triggerPolyNoiseEnv(now);
    state.keyboardVoiceActive = true;
    if (!state.isArping) {
        state.playGeneration += 1;
    }
    updateNoteVisualizer(sounding);
}

function releaseUnisonStack() {
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    voices.forEach((v) => {
        if (v.semi == null) return;
        releaseVoiceAmp(v, now);
    });
    state.keyboardVoiceActive = false;
    releaseSharedFilterIfIdle(now);
    releasePolyNoiseEnv(now);
    document.dispatchEvent(new CustomEvent('ingysynth:live-note-off'));
    const release = getNumber('release', 0.5);
    showLogoOverlay(Math.max(1500, (release + 0.1) * 1000));
    if (!state.isPlaying && !state.isArping && !window.noteVisualizerPreviewActive) {
        clearNoteVisualizer();
    }
}

function startChordStack(finger, soundingRoot, intervals) {
    ensureVoicePool();
    hardFreeFinger(finger);
    while (freeVoiceCount() < intervals.length) {
        const steal = oldestOtherFinger(finger);
        if (steal == null) break;
        hardFreeFinger(steal);
    }

    const now = state.audioContext.currentTime;
    openMasterEnvelope(now);
    let any = false;
    let shown = soundingRoot;
    for (let i = 0; i < intervals.length; i++) {
        const voice = voices.find((v) => v.semi == null);
        if (!voice) break;
        const iv = intervals[i];
        const sounding = soundingRoot + iv;
        voice.finger = finger;
        voice.chordInterval = iv;
        voice.semi = finger;
        voice.age = ++allocAge;
        const ok = spawnVoiceOscs(voice, sounding, 0, now);
        if (!ok) {
            voice.semi = null;
            voice.finger = null;
            voice.chordInterval = 0;
            continue;
        }
        triggerVoiceAmp(voice, now, { fromCurrent: false });
        any = true;
        if (i === 0) shown = sounding;
    }
    if (!any) return;
    triggerSharedFilterEnvelope(now);
    triggerPolyNoiseEnv(now);
    state.keyboardVoiceActive = true;
    if (!state.isArping) {
        state.playGeneration += 1;
    }
    updateNoteVisualizer(shown);
}

/**
 * @param {number} cellSemitone
 * @param {number} soundingSemitones absolute semis from C4 (incl. global tune)
 */
export function polyNoteOn(cellSemitone, soundingSemitones) {
    if ((!state.keyboardPoly && !state.keyboardMultitudes) || state.isPlaying) return;
    if (!state.audioContext) return;
    if (state.audioContext.state === 'suspended') state.audioContext.resume();

    ensureVoicePool();
    hideLogoOverlay();
    document.dispatchEvent(new CustomEvent('ingysynth:live-note-on'));
    if (!state.isArping) retriggerLfoIfNeeded(state.audioContext.currentTime);

    const chordIv = isPolyChordMemoryOn() ? getPolyChordIntervals() : [];
    if (chordIv.length > 1) {
        startChordStack(cellSemitone, soundingSemitones, chordIv);
        return;
    }

    if (state.keyboardPolyUnison && state.keyboardPoly) {
        startUnisonStack(cellSemitone, soundingSemitones);
        return;
    }

    startSingleVoice(cellSemitone, soundingSemitones, 0);
    updateNoteVisualizer(soundingSemitones);
}

export function polyNoteOff(cellSemitone) {
    if ((!state.keyboardPoly && !state.keyboardMultitudes) || !state.audioContext) return;
    if (state.keyboardPolyUnison && state.keyboardPoly && !isPolyChordMemoryOn()) {
        releaseUnisonStack();
        return;
    }
    releaseSingleVoice(cellSemitone);
}

/** Release unison stack without last-note logic (used when no keys remain). */
export function polyUnisonNoteOff() {
    if (!state.keyboardPolyUnison) return;
    releaseUnisonStack();
}

let seqIdCounter = 0;
const SEQ_FINGER_BASE = 100000;

function oldestNonReleasingFinger(exceptFinger, atTime) {
    const ages = new Map();
    for (const v of voices) {
        if (v.semi == null || v.releasing) continue;
        if (atTime != null && v.oscStartWhen != null && v.oscStartWhen > atTime + 0.0005) continue;
        const f = fingerOf(v);
        if (exceptFinger != null && f === exceptFinger) continue;
        const prev = ages.get(f);
        if (prev == null || v.age < prev) ages.set(f, v.age);
    }
    let best = null;
    let bestAge = Infinity;
    ages.forEach((age, f) => {
        if (age < bestAge) {
            bestAge = age;
            best = f;
        }
    });
    return best;
}

function stealUntilFree(needed, exceptFinger, atTime) {
    const n = Math.max(1, needed | 0);
    while (voices.filter((v) => v.semi == null).length < n) {
        const steal = oldestNonReleasingFinger(exceptFinger, atTime);
        if (steal == null) break;
        hardFreeFinger(steal, atTime);
    }
}

function wantedPolyOscIndexes() {
    const ids = [];
    for (let i = 0; i < POLY_OSC_MAX; i++) {
        if (state.oscStates[i]) ids.push(i);
    }
    return ids;
}

function analogWaveForIndex(oscIndex) {
    return (!state.keyboardMultitudes && oscIndex === 1) ? 'square' : getOscType(oscIndex);
}

function seqFingerLiveVoices(finger) {
    return voices
        .filter((v) => fingerOf(v) === finger && v.oscs.length > 0)
        .sort((a, b) => (a.chordInterval || 0) - (b.chordInterval || 0) || a.age - b.age);
}

/** Keep a running voice: analog type match, or Plaits/WT with retrigger (no stop+spawn). */
function voiceCanRetune(v) {
    const want = wantedPolyOscIndexes();
    if (!want.length || !v?.oscs?.length) return false;
    if (v.oscs.some((o) => !o.started)) return false;
    if (v.oscs.length !== want.length) return false;
    return v.oscs.every((osc) => {
        if (!want.includes(osc.oscIndex)) return false;
        if (osc.isWavetable) return typeof osc.retrigger === 'function';
        return osc.type === analogWaveForIndex(osc.oscIndex);
    });
}

function seqVoiceStackVol(oscIndex, stackCount, unison = false) {
    const multitudes = !!state.keyboardMultitudes;
    let fullVol = getOscVol(oscIndex, POLY_DEFAULT_OSC_VOL);
    if (oscIndex === 1 && state.keyboardPoly && !multitudes) {
        const subFader = parseFloat(
            document.querySelector('#ingy6Panel .ingy6-fader[data-param="subOsc"] .ingy6-fader-input')?.value,
        );
        const pct = Number.isFinite(subFader) ? Math.max(0, Math.min(1, subFader / 10)) : 0;
        fullVol *= pct;
    }
    return polyStackVoiceVol(fullVol, stackCount, true, unison);
}

function retuneVoiceStackGain(voice, stackCount, when, { unison = false } = {}) {
    voice.oscs.forEach((osc) => {
        const g = osc.gainNode?.gain;
        if (!g) return;
        const target = seqVoiceStackVol(osc.oscIndex, stackCount, unison);
        try {
            if (typeof g.cancelAndHoldAtTime === 'function') {
                try { g.cancelAndHoldAtTime(when); } catch (_) { /* ignore */ }
            } else {
                g.cancelScheduledValues(when);
            }
            g.setTargetAtTime(target, when, 0.012);
        } catch (_) { /* ignore */ }
    });
}

function pulseWavetableSeqGates(voice, when) {
    let n = 0;
    (voice?.oscs || []).forEach((osc) => {
        if (osc.isWavetable && typeof osc.pulseSeqGate === 'function') {
            if (osc.pulseSeqGate(when)) n += 1;
        }
    });
    return n;
}

function releaseWavetableSeqGates(voice, offAt) {
    (voice?.oscs || []).forEach((osc) => {
        if (osc.isWavetable && typeof osc.releaseSeqGate === 'function') {
            osc.releaseSeqGate(offAt);
        }
    });
}

function setVoiceOscFrequencies(voice, soundingSemi, cents, when) {
    const freqs = [];
    voice.oscs.forEach((osc) => {
        const baseFreq = Math.max(20, semitonesToFrequency(soundingSemi, osc.oscIndex));
        osc.polyBaseFreq = baseFreq;
        osc.unisonCents = cents;
        const freq = applyUnisonCents(bentFrequency(baseFreq), osc.unisonCents || 0);
        freqs.push(baseFreq);
        try {
            osc.frequency.cancelScheduledValues(when);
            osc.frequency.setValueAtTime(freq, when);
        } catch (_) { /* ignore */ }
    });
    voice.baseFreqs = freqs;
    voice.cents = cents;
}

/** Audio-clock gate close. Oscs stay up; next step's hold+setTarget attack retriggers. */
function scheduleSeqGateClose(voice, offAt, { tau = SEQ_GATE_CLOSE_TAU, closeWt = false } = {}) {
    const g = voice.ampEnv?.gain;
    const closeTau = Math.max(0.008, Number(tau) || SEQ_GATE_CLOSE_TAU);
    if (g) {
        try {
            if (typeof g.cancelAndHoldAtTime === 'function') {
                try { g.cancelAndHoldAtTime(offAt); } catch (_) { /* ignore */ }
            }
            g.setTargetAtTime(0.00001, offAt, closeTau);
        } catch (_) { /* ignore */ }
    }
    if (closeWt) releaseWavetableSeqGates(voice, offAt);
}

/** Same dump on the shared filter — skipClose left it open for the whole step. */
function scheduleSeqFilterGateClose(offAt, tau = SEQ_GATE_CLOSE_TAU) {
    const g = state.filterEnvGain?.gain;
    if (!g) return;
    const closeTau = Math.max(0.008, Number(tau) || SEQ_GATE_CLOSE_TAU);
    try {
        if (typeof g.cancelAndHoldAtTime === 'function') {
            try { g.cancelAndHoldAtTime(offAt); } catch (_) { /* ignore */ }
        }
        g.setTargetAtTime(0.00001, offAt, closeTau);
    } catch (_) { /* ignore */ }
}

/** Drop a chord tone: hold+setTarget close (Acid), leave oscs running into the VCA. */
function releaseSeqSurplus(voice, when) {
    const g = voice.ampEnv?.gain;
    const minValue = 0.00001;
    const relSec = Math.max(0.02, readFloatParam('release', 0.3));
    const tau = seqReleaseTau(relSec);
    if (g) {
        try {
            if (typeof g.cancelAndHoldAtTime === 'function') {
                try { g.cancelAndHoldAtTime(when); } catch (_) { /* ignore */ }
            } else {
                g.cancelScheduledValues(when);
            }
            g.setTargetAtTime(minValue, when, tau);
        } catch (_) { /* ignore */ }
    }
    voice.releasing = true;
    voice.finger = null;
    voice.sequenced = false;
    voice.seqId = 0;
    voice.engineGen = 0;
    const generation = polyVoiceGeneration;
    const semi = voice.semi;
    const ctxNow = state.audioContext?.currentTime ?? when;
    setTimeout(() => {
        if (generation !== polyVoiceGeneration) return;
        if (voice.semi !== semi) return;
        if (!voice.releasing) return;
        if (!state.audioContext) return;
        stopVoiceOscs(voice, state.audioContext.currentTime);
        voice.semi = null;
        voice.chordInterval = 0;
        voice.releasing = false;
    }, Math.max(20, (when - ctxNow + relSec + 0.08) * 1000));
}

function retuneVoiceOscs(voice, soundingSemi, cents, when) {
    const freqs = [];
    voice.oscs.forEach((osc) => {
        const baseFreq = Math.max(20, semitonesToFrequency(soundingSemi, osc.oscIndex));
        osc.polyBaseFreq = baseFreq;
        osc.unisonCents = cents;
        const freq = applyUnisonCents(bentFrequency(baseFreq), osc.unisonCents || 0);
        freqs.push(baseFreq);
        if (osc.isWavetable && typeof osc.retrigger === 'function') {
            osc.retrigger(when, freq);
            return;
        }
        try {
            osc.frequency.cancelScheduledValues(when);
            osc.frequency.setValueAtTime(freq, when);
        } catch (_) { /* ignore */ }
    });
    voice.baseFreqs = freqs;
    voice.cents = cents;
}

function slewVoiceToSounding(voice, sounding, when, slideTime) {
    voice.oscs.forEach((osc) => {
        const baseFreq = Math.max(20, semitonesToFrequency(sounding, osc.oscIndex));
        osc.polyBaseFreq = baseFreq;
        const target = applyUnisonCents(bentFrequency(baseFreq), osc.unisonCents || 0);
        try {
            const tau = Math.max(0.01, slideTime) / 3;
            if (typeof osc.frequency.cancelAndHoldAtTime === 'function') {
                try { osc.frequency.cancelAndHoldAtTime(when); } catch (_) {
                    osc.frequency.cancelScheduledValues(when);
                }
            } else {
                osc.frequency.cancelScheduledValues(when);
            }
            osc.frequency.setTargetAtTime(target, when, tau);
        } catch (_) { /* ignore */ }
    });
}

function linearRampVoiceToSounding(voice, fromSemi, toSemi, t0, t1) {
    const end = Math.max(t0 + 0.001, Number(t1) || t0);
    voice.oscs.forEach((osc) => {
        const fromBase = Math.max(20, semitonesToFrequency(fromSemi, osc.oscIndex));
        const toBase = Math.max(20, semitonesToFrequency(toSemi, osc.oscIndex));
        osc.polyBaseFreq = toBase;
        const fromHz = applyUnisonCents(bentFrequency(fromBase), osc.unisonCents || 0);
        const toHz = applyUnisonCents(bentFrequency(toBase), osc.unisonCents || 0);
        if (osc.isWavetable && typeof osc.retrigger === 'function') {
            osc.retrigger(t0, fromHz);
        }
        try {
            osc.frequency.cancelScheduledValues(t0);
            osc.frequency.setValueAtTime(Math.max(0.01, fromHz), t0);
            if (Math.abs(toHz - fromHz) > 0.01) {
                osc.frequency.linearRampToValueAtTime(Math.max(0.01, toHz), end);
            }
        } catch (_) { /* ignore */ }
    });
}

/** Rest after a slide-hold: close sequenced finger amps. Does not steal the pool. */
export function releasePolySeqHold(when) {
    if (!state.audioContext) return;
    const t = Math.max(state.audioContext.currentTime, Number(when) || state.audioContext.currentTime);
    const live = seqFingerLiveVoices(SEQ_FINGER_BASE);
    live.forEach((voice) => {
        if (voice.semi == null) return;
        releaseSeqSurplus(voice, t);
    });
    if (live.length) scheduleSeqFilterGateClose(t, seqFiltCloseTau(false));
}

/**
 * Sequenced poly voicing for the step clock. Does not bump playGeneration.
 * Plays caller intervals as-is (Chord Mem overlay is applied in playPolySeqStep
 * and does not write pattern chord[]). Unison only when requested on a 1-note step.
 */
export function schedulePolySeqVoicing({
    startTime,
    gateSec,
    soundingRoot,
    intervals,
    cellRoot,
    accentScale = 1,
    slideTime = 0.05,
    engineGen,
    unison = false,
    slideThisStep = false,
    nextStepWillSlideEnv = false,
    glissRoll = false,
    skipPitch = false,
    pulseRatch = false,
    lastRatchHit = false,
    slideFrom = null,
    nextSounding = null,
    glissEndTime = null,
} = {}) {
    if ((!state.keyboardPoly && !state.keyboardMultitudes) || !state.audioContext) {
        return;
    }
    if (engineGen != null && engineGen !== state.seqEngineGeneration) {
        return;
    }
    ensureVoicePool();
    const ctxNow = state.audioContext.currentTime;
    const when = Math.max(ctxNow, Number(startTime) || ctxNow);
    const ivs = sortedPolySeqIntervals(intervals);
    const isChord = ivs.length > 1;
    const useUni = !isChord && !!unison && !!state.keyboardPoly && !state.keyboardMultitudes;
    const nVoices = useUni ? POLY_VOICE_COUNT : ivs.length;
    seqIdCounter += 1;
    const seqId = seqIdCounter;
    const finger = SEQ_FINGER_BASE;
    const spread = getPolyDetuneCents();
    const stackCount = nVoices;
    const gateFrac = Math.max(0.05, Math.min(1, (Number(getNumber('gateLength', 90)) || 90) / 100));
    const gateSecN = Math.max(0.02, Number(gateSec) || 0.05);
    const legato = gateFrac >= 0.98;
    const holdGate = !!nextStepWillSlideEnv && !glissRoll;
    const closeGate = !legato && !holdGate;
    const offAt = when + gateSecN;
    const ampCloseTau = (pulseRatch && !lastRatchHit) ? SEQ_GATE_CLOSE_TAU : seqReleaseTau(readFloatParam('release', 0.3));
    const filtCloseTau = (pulseRatch && !lastRatchHit) ? SEQ_GATE_CLOSE_TAU : seqReleaseTau(readFloatParam('filterRelease', 0.3));
    const closeWt = !!pulseRatch && closeGate && !lastRatchHit;
    const doSlide = !!slideThisStep && slideFrom != null && !glissRoll && !skipPitch;
    const doGliss = !!glissRoll && nextSounding != null && !skipPitch;
    const slidePairs = doSlide
        ? pairPolySeqSlidePitches(slideFrom.root, slideFrom.intervals, soundingRoot, ivs)
        : null;
    const glissPairs = doGliss
        ? pairPolySeqGlissPitches(soundingRoot, ivs, nextSounding.root, nextSounding.intervals)
        : null;

    if (!slideThisStep) holdMasterEnvelope();
    hideLogoOverlay();

    if (skipPitch) {
        const live = seqFingerLiveVoices(finger).filter(voiceCanRetune);
        live.forEach((voice) => {
            voice.seqId = seqId;
            voice.releasing = false;
            pulseWavetableSeqGates(voice, when);
            triggerVoiceAmp(voice, when, { peakScale: accentScale, gateOffAt: closeGate ? offAt : null, duck: !!pulseRatch });
            if (closeGate) scheduleSeqGateClose(voice, offAt, { tau: ampCloseTau, closeWt });
        });
        if (!live.length) return;
        triggerSharedFilterEnvelope(when, { skipClose: !closeGate });
        if (closeGate) scheduleSeqFilterGateClose(offAt, filtCloseTau);
        triggerPolyNoiseEnv(when);
        state.keyboardVoiceActive = true;
        return;
    }

    const existing = seqFingerLiveVoices(finger);
    const reusable = existing.filter(voiceCanRetune);
    const keepN = Math.min(reusable.length, nVoices);
    const reused = reusable.slice(0, keepN);
    const reusedSet = new Set(reused);
    const skipClose = keepN > 0;
    const hardFree = keepN === 0 && existing.length > 0;
    if (hardFree) {
        hardFreeFinger(finger, when, { keepAmp: true });
        stealUntilFree(nVoices, finger, when);
    } else {
        existing.forEach((v) => {
            if (reusedSet.has(v)) {
                v.seqId = seqId;
                v.releasing = false;
            } else {
                releaseSeqSurplus(v, when);
            }
        });
        stealUntilFree(Math.max(0, nVoices - keepN), finger, when);
    }

    const applyPitch = (voice, pair, cents, reusedVoice) => {
        const sounding = pair.to;
        const fromSemi = pair.from;
        if (doGliss && !pair.same) {
            if (reusedVoice) retuneVoiceStackGain(voice, stackCount, when, { unison: useUni });
            linearRampVoiceToSounding(voice, fromSemi, sounding, when, glissEndTime ?? (when + gateSecN));
            return;
        }
        // Main Stage slide dest: slew or hold — never retrigger Plaits, never poke stack gain.
        if (doSlide) {
            if (!pair.same) slewVoiceToSounding(voice, sounding, when, slideTime);
            return;
        }
        if (reusedVoice) {
            retuneVoiceOscs(voice, sounding, cents, when);
            retuneVoiceStackGain(voice, stackCount, when, { unison: useUni });
        }
    };

    const startOne = (voice, pair, cents) => {
        const sounding = pair.to;
        voice.semi = sounding;
        voice.finger = finger;
        voice.chordInterval = pair.interval;
        voice.age = ++allocAge;
        voice.sequenced = true;
        voice.seqId = seqId;
        voice.engineGen = engineGen ?? state.seqEngineGeneration;
        const reusedVoice = reusedSet.has(voice) && voiceCanRetune(voice);
        const spawnPitch = (doSlide || doGliss) ? pair.from : sounding;
        if (reusedVoice) {
            if (pulseRatch && !doSlide && !doGliss) {
                setVoiceOscFrequencies(voice, sounding, cents, when);
                retuneVoiceStackGain(voice, stackCount, when, { unison: useUni });
                pulseWavetableSeqGates(voice, when);
            } else if (!doSlide && !doGliss) {
                retuneVoiceOscs(voice, sounding, cents, when);
                retuneVoiceStackGain(voice, stackCount, when, { unison: useUni });
            } else {
                applyPitch(voice, pair, cents, true);
            }
            if (!slideThisStep) {
                triggerVoiceAmp(voice, when, { peakScale: accentScale, gateOffAt: closeGate ? offAt : null, duck: !!pulseRatch });
            }
            if (closeGate) scheduleSeqGateClose(voice, offAt, { tau: ampCloseTau, closeWt });
            return true;
        }
        if (voice.oscs.length) stopVoiceOscs(voice, when);
        const ok = spawnVoiceOscs(voice, spawnPitch, cents, when, { stackCount, sequenced: true, unison: useUni });
        if (!ok) {
            voice.semi = null;
            voice.finger = null;
            voice.sequenced = false;
            voice.seqId = 0;
            return false;
        }
        applyPitch(voice, pair, cents, false);
        triggerVoiceAmp(voice, when, { peakScale: accentScale, gateOffAt: closeGate ? offAt : null, duck: !!pulseRatch });
        if (closeGate) scheduleSeqGateClose(voice, offAt, { tau: ampCloseTau, closeWt });
        return true;
    };

    const pairAt = (i) => {
        if (slidePairs) return slidePairs[i];
        if (glissPairs) return glissPairs[Math.min(i, glissPairs.length - 1)];
        return {
            from: soundingRoot + ivs[Math.min(i, ivs.length - 1)],
            to: soundingRoot + ivs[Math.min(i, ivs.length - 1)],
            interval: ivs[Math.min(i, ivs.length - 1)],
            same: true,
        };
    };

    let any = false;
    if (useUni) {
        const base = pairAt(0);
        for (let k = 0; k < POLY_VOICE_COUNT; k++) {
            const voice = reused[k] || voices.find((v) => v.semi == null) || allocVoice();
            if (!voice) break;
            const cents = unisonCents(k, POLY_VOICE_COUNT, spread);
            if (startOne(voice, { ...base, interval: 0 }, cents)) any = true;
        }
    } else {
        for (let i = 0; i < nVoices; i++) {
            const voice = reused[i] || voices.find((v) => v.semi == null) || allocVoice();
            if (!voice) break;
            if (startOne(voice, pairAt(i), 0)) any = true;
        }
    }

    if (!any) return;
    const retriggerFilter = !slideThisStep || keepN === 0;
    if (retriggerFilter) {
        triggerSharedFilterEnvelope(when, { skipClose: skipClose || holdGate });
    }
    if (closeGate) scheduleSeqFilterGateClose(offAt, filtCloseTau);
    if (!slideThisStep) triggerPolyNoiseEnv(when);
    state.keyboardVoiceActive = true;
}

export function forcePolyAllOff({ silent = false } = {}) {
    // Poly-local only — never bump state.playGeneration (breaks seq stop cleanup)
    polyVoiceGeneration += 1;
    state.keyboardVoiceActive = false;

    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    // Kill leftover seq/mono voices when poly owns the bus or we're idle
    if (state.keyboardPoly || state.keyboardMultitudes || !state.isPlaying) {
        killSharedMonoOscillators(now);
    }
    ensureVoicePool();
    if (!voices.length) {
        if (!silent && !state.isPlaying) syncPolyModeUI();
        return;
    }

    voices.forEach((v) => {
        silenceVoiceAmp(v, now);
        stopVoiceOscs(v, now);
        v.semi = null;
        v.finger = null;
        v.chordInterval = 0;
        v.releasing = false;
        v.age = 0;
        v.sequenced = false;
        v.seqId = 0;
        v.engineGen = 0;
    });
    if (state.keyboardPoly) mutePolyNoise(now);
    // Keep master bus closed unless sequencer owns it
    if (!silent && !state.isPlaying && state.envelope) {
        try {
            state.envelope.gain.cancelScheduledValues(now);
            state.envelope.gain.setValueAtTime(0, now);
        } catch (_) { /* ignore */ }
        state.envelopeHeld = false;
        showLogoOverlay(0);
    }
    if (!silent && !state.isPlaying) syncPolyModeUI();
}

/**
 * Move one finger's live voices to a new key without retriggering envelopes.
 * `voice.semi` stays the cell key (not the sounding pitch). Chord intervals
 * stay put, so a chord-memory stack transposes as a shape.
 * No polyNoteOn fallback: a silent Poly Uni key has no voices, and note-on
 * would forcePolyAllOff the stack that is actually sounding.
 * @returns {boolean} true when at least one voice was ramped
 */
export function glidePolyFinger(fromSemi, toSemi, soundingRoot) {
    if (!state.audioContext) return false;
    if (!Number.isFinite(fromSemi) || !Number.isFinite(toSemi) || !Number.isFinite(soundingRoot)) {
        return false;
    }
    const owned = voices.filter((v) => (
        v.semi != null && !v.releasing && fingerOf(v) === fromSemi
    ));
    if (!owned.length) return false;

    const now = state.audioContext.currentTime;
    owned.forEach((voice) => {
        const sounding = soundingRoot + (voice.chordInterval || 0);
        const freqs = [];
        voice.oscs.forEach((osc) => {
            const baseFreq = Math.max(20, semitonesToFrequency(sounding, osc.oscIndex));
            osc.polyBaseFreq = baseFreq;
            freqs.push(baseFreq);
            const targetHz = Math.max(20, applyUnisonCents(bentFrequency(baseFreq), osc.unisonCents || 0));
            try {
                // Read before cancel. cancelScheduledValues snaps .value back to
                // the previous setValueAtTime, so a fast slide never leaves the first key.
                // Plain cancel + set, not cancelAndHoldAtTime: Safari has left the
                // param stuck after a hold, so a slide moves the lights but not the pitch.
                const freq = osc.frequency;
                const live = Math.max(20, freq.value || targetHz);
                freq.cancelScheduledValues(now);
                freq.setValueAtTime(live, now);
                if (Math.abs(live - targetHz) > 0.01) {
                    freq.exponentialRampToValueAtTime(targetHz, now + GLIDE_RAMP);
                } else {
                    freq.setValueAtTime(targetHz, now);
                }
            } catch (_) { /* ignore */ }
        });
        voice.baseFreqs = freqs;
        voice.semi = toSemi;
        voice.finger = toSemi;
    });
    return true;
}

/** Retune live poly oscs after pitch bend changes. */
export function applyPolyPitchBend({ ramp = BEND_RAMP } = {}) {
    if (!state.audioContext || !hasPolyVoices()) return;
    const now = state.audioContext.currentTime;
    voices.forEach((voice) => {
        if (voice.semi == null) return;
        voice.oscs.forEach((osc) => {
            const base = osc.polyBaseFreq;
            if (base == null || !Number.isFinite(base)) return;
            const target = applyUnisonCents(bentFrequency(base), osc.unisonCents || 0);
            try {
                osc.frequency.cancelScheduledValues(now);
                const prev = Math.max(20, osc.frequency.value || target);
                if (ramp > 0 && Math.abs(prev - target) > 0.01) {
                    osc.frequency.setValueAtTime(prev, now);
                    osc.frequency.exponentialRampToValueAtTime(target, now + ramp);
                } else {
                    osc.frequency.setValueAtTime(target, now);
                }
            } catch (_) { /* ignore */ }
        });
    });
}

/** Retune active poly voices after OSC tune / master tune changes. */
export function retunePolyVoices(soundingForSemi) {
    if (!state.audioContext || !hasPolyVoices()) return;
    const now = state.audioContext.currentTime;
    voices.forEach((voice) => {
        if (voice.semi == null) return;
        const finger = voice.finger ?? voice.semi;
        const root = typeof soundingForSemi === 'function'
            ? soundingForSemi(finger)
            : finger;
        const sounding = root + (voice.chordInterval || 0);
        voice.oscs.forEach((osc) => {
            const baseFreq = Math.max(20, semitonesToFrequency(sounding, osc.oscIndex));
            osc.polyBaseFreq = baseFreq;
            const target = applyUnisonCents(bentFrequency(baseFreq), osc.unisonCents || 0);
            try {
                osc.frequency.cancelScheduledValues(now);
                osc.frequency.setValueAtTime(target, now);
            } catch (_) { /* ignore */ }
        });
    });
}

export function syncPolyModeUI() {
    const on = !!state.keyboardPoly;
    const btn = document.getElementById('keyboardPolyToggle');
    if (btn) {
        btn.classList.toggle('off', !on);
        btn.classList.remove('is-locked');
        btn.disabled = false;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-disabled', 'false');
        btn.setAttribute('aria-label', on ? 'Polyphonic mode on' : 'Polyphonic mode');

        // Home: Poly | Multitudes. Chord Memory stays left of computer-keys toggle.
        // Ingy-6 on: Poly | Multitudes stay centered as a pair; logo far right.
        // Multitudes panel owns docking while Multitudes mode is on (Poly off).
        const home = document.getElementById('keyboardPolyToggleHome');
        const polySlot = document.getElementById('ingy6PolyToggleSlot');
        const multBtn = document.getElementById('keyboardMultitudesToggle');
        if (on) {
            if (polySlot) {
                polySlot.appendChild(btn);
                if (multBtn) polySlot.appendChild(multBtn);
            }
            if (home) home.hidden = true;
        } else if (!state.keyboardMultitudes && home) {
            home.appendChild(btn);
            if (multBtn) home.appendChild(multBtn);
            home.hidden = false;
        } else if (home) {
            home.hidden = !!state.keyboardMultitudes;
        }
    }

    if (!on) {
        document.body.classList.remove('poly-mode');
    }

    syncIngy6PanelUi();

    const polyUni = document.getElementById('kbPolyUnisonToggle');
    if (polyUni) {
        const uniOn = !!state.keyboardPolyUnison;
        polyUni.hidden = !on;
        polyUni.disabled = !on;
        polyUni.classList.toggle('off', !uniOn);
        polyUni.setAttribute('aria-pressed', uniOn ? 'true' : 'false');
        polyUni.textContent = uniOn ? 'Poly Uni: On' : 'Poly Uni: Off';
    }
}

export function setPolyUnison(on) {
    const next = !!on && !!state.keyboardPoly;
    if (state.keyboardPolyUnison === next) {
        syncPolyModeUI();
        return;
    }
    forcePolyAllOff();
    state.keyboardPolyUnison = next;
    syncPolyModeUI();
}

export function togglePolyUnison() {
    if (!state.keyboardPoly) return;
    setPolyUnison(!state.keyboardPolyUnison);
}

function readRangeValue(id, fallback = 0) {
    return getNumber(id, fallback);
}

function setRangeValue(id, value) {
    set(id, value);
}

function readOscTune(oscIndex) {
    const n = Number(state.oscTunes[oscIndex]);
    return Number.isFinite(n) ? n : 0;
}

function setOscTuneUi(oscIndex, semis) {
    const clamped = Math.max(-12, Math.min(12, Math.round(semis)));
    if (state.oscTunes) state.oscTunes[oscIndex] = clamped;
    set(`osc-tune-${oscIndex}`, clamped);
}

function chorusButtonOn(id) {
    return !!get(id);
}

function setChorusButton(id, wantOn) {
    set(id, !!wantOn);
}

function setFilterEnvEnabled(wantOn) {
    const want = !!wantOn;
    set('filterEnvToggle', want);
    if (!!state.filterEnvState === want) return;
    state.filterEnvState = want;
    syncKeyboardFilterEnvFromMain();
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    const actualCutoff = Math.max(40, getNumber('cutoff', 1000));
    updateFilterCutoffRange(actualCutoff, now);
    if (!want && state.filterEnvGain) {
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(0, now);
        state.filterEnvelopeHeld = false;
    }
}

const AMP_TO_FILTER = [
    ['attack', 'filterAttack'],
    ['decay', 'filterDecay'],
    ['sustain', 'filterSustain'],
    ['release', 'filterRelease'],
];

function mirrorAmpAdsrToFilter() {
    AMP_TO_FILTER.forEach(([ampKey, filterKey]) => {
        set(filterKey, get(ampKey));
    });
}

let ampAdsrMirrorBound = false;
function bindAmpAdsrMirror() {
    if (ampAdsrMirrorBound) return;
    ampAdsrMirrorBound = true;
    AMP_TO_FILTER.forEach(([ampKey, filterKey]) => {
        subscribe(ampKey, () => {
            if (!state.keyboardPoly) return;
            set(filterKey, get(ampKey));
        });
    });
}

function stopPolyOwnedNoiseSource() {
    if (state.isPlaying) return;
    if (!state.noiseSource) return;
    try {
        state.noiseSource.stop();
    } catch (_) { /* ignore */ }
    try {
        state.noiseSource.disconnect();
    } catch (_) { /* ignore */ }
    state.noiseSource = null;
}

/**
 * Enter/leave Poly OSC lock. Call to set state.keyboardPoly.
 * Acid and Poly are mutually exclusive — Acid is forced off (snapshot restored) before Poly enters.
 * @param {boolean} on
 */
export function setPolyMode(on) {
    const next = !!on;
    if (state.keyboardPoly === next) {
        // Still ensure lock UI / disabled state matches reality
        if (!next) setPolyLockedUi(false);
        syncPolyModeUI();
        return;
    }

    bumpSeqEngine();

    if (next) {
        // Keep stored chord memory — Ingy-6 / Multitudes share one voicing until reset
        // Multitudes panel is UI-only mutex with Ingy-6 — unlock restores classic Unison/Ring first
        if (state.keyboardMultitudes) {
            syncMultitudesPolyLocks(false);
            state.keyboardMultitudes = false;
            document.body.classList.remove('multitudes-mode', 'multitudes-poly-lock');
            const multPanel = document.getElementById('multitudesPanel');
            if (multPanel) multPanel.hidden = true;
            const multBtn = document.getElementById('keyboardMultitudesToggle');
            if (multBtn) {
                multBtn.classList.add('off');
                multBtn.setAttribute('aria-pressed', 'false');
                multBtn.setAttribute('aria-label', 'Multitudes Polyphonic Plaititudes');
            }
        }
        // Restore Acid patch first so Poly snapshots the true pre-playground state
        forceAcidOffForPoly();
        document.dispatchEvent(new CustomEvent('ingysynth:exit-berlin'));
        forceDrumFiltOffForPoly();
        // Poly voices are classic OscillatorNodes — digital stays on OSC1 analog
        document.dispatchEvent(new CustomEvent('ingysynth:digital-off'));

        if (!polySnapshot) {
            polySnapshot = {
                oscStates: state.oscStates.slice(),
                oscVols: Array.from({ length: OSC_COUNT }, (_, i) => readOscVol(i)),
                oscTunes: Array.from({ length: OSC_COUNT }, (_, i) => readOscTune(i)),
                noiseState: !!state.noiseState,
                noiseVol: readRangeValue('noiseVol', 0),
                noiseType: getString('noiseType', 'white'),
                unisonEnabled: !!state.unisonEnabled,
                ringModEnabled: !!state.ringModEnabled,
                filterAttack: readRangeValue('filterAttack', 0.1),
                filterDecay: readRangeValue('filterDecay', 0.2),
                filterSustain: readRangeValue('filterSustain', 0.5),
                filterRelease: readRangeValue('filterRelease', 0.2),
                filterEnvState: !!state.filterEnvState,
                filterEnvInvert: !!state.filterEnvInvert,
                chorusAmount: readRangeValue('chorusAmount', 0),
                chorusI: chorusButtonOn('chorusI'),
                chorusII: chorusButtonOn('chorusII'),
                osc2Wave: getOscType(1),
            };
        }
        // Kill any leftover poly/mono/seq voice before poly owns the bus
        forcePolyAllOff({ silent: true });
        state.keyboardVoiceActive = false;
        if (state.audioContext) {
            const now = state.audioContext.currentTime;
            killSharedMonoOscillators(now);
            if (state.envelope) {
                state.envelope.gain.cancelScheduledValues(now);
                state.envelope.gain.setValueAtTime(0, now);
                state.envelopeHeld = false;
            }
        }

        // Main DCO on by default (Ingy wave buttons can latch all off → sub/noise only)
        setOscEnabled(0, true);
        for (let i = 1; i < OSC_COUNT; i++) setOscEnabled(i, false);
        // Both OSCs use poly default; OSC2 knob is the live SUB ceiling (user can change it)
        setOscVolUi(0, POLY_DEFAULT_OSC_VOL);
        setOscVolUi(1, POLY_DEFAULT_OSC_VOL);
        state.polySubCeil = POLY_DEFAULT_OSC_VOL;
        // UI can re-enable oscGains via vol input — mute them again for poly
        if (state.audioContext) killSharedMonoOscillators(state.audioContext.currentTime);
        setNoiseEnabled(false);
        stopPolyOwnedNoiseSource();
        setClassicUnisonEnabled(false);
        setRingModEnabled(false);

        // Ingy 6 defaults while Poly owns the bus
        state.polyVcaGate = false;
        setFilterEnvEnabled(true);
        if (state.filterEnvInvert) {
            state.filterEnvInvert = false;
            syncKeyboardFilterEnvFromMain();
        }
        set('noiseType', 'white');
        setRangeValue('chorusAmount', 1);
        mirrorAmpAdsrToFilter();

        state.keyboardPoly = true;
        state.keyboardPolyUnison = false;
        // Chord stays off in Ingy-6 (classic OSC1 voices). Allowed in Multitudes.
        if (getString('osc4Model') === 'chord' || state.osc4Model === 'chord') {
            set('osc4Model', 'wavetable');
        }
        setPolyLockedUi(true);
        syncUnisonControlsEnabled();
        ensureVoicePool();
        if (state.audioContext) {
            refreshFilterInputDrive();
            const cutoff = Math.max(40, readRangeValue('cutoff', 1000));
            updateFilterCutoffRange(cutoff, state.audioContext.currentTime, 0.01);
        }
        syncPolyModeUI();
        syncChordMemUI();
        return;
    }

    // Exit — restore main-stage oscs (root only). Parked voicing stays until reset.
    forcePolyAllOff({ silent: true });
    stopPolyOwnedNoiseSource();
    state.keyboardPoly = false;
    state.keyboardPolyUnison = false;
    state.polyVcaGate = false;
    state.polySubCeil = POLY_DEFAULT_OSC_VOL;
    setPolyLockedUi(false);
    if (state.audioContext && state.envelope) {
        const now = state.audioContext.currentTime;
        state.envelope.gain.cancelScheduledValues(now);
        state.envelope.gain.setValueAtTime(0, now);
        state.envelopeHeld = false;
    }

    if (polySnapshot) {
        const snap = polySnapshot;
        polySnapshot = null;
        for (let i = 0; i < OSC_COUNT; i++) {
            setOscEnabled(i, !!snap.oscStates[i]);
            if (snap.oscVols) setOscVolUi(i, snap.oscVols[i] ?? POLY_DEFAULT_OSC_VOL);
            if (snap.oscTunes) setOscTuneUi(i, snap.oscTunes[i] ?? 0);
        }
        setRangeValue('noiseVol', snap.noiseVol ?? 0);
        if (snap.noiseType) set('noiseType', snap.noiseType);
        setNoiseEnabled(!!snap.noiseState);
        setClassicUnisonEnabled(!!snap.unisonEnabled);
        setRingModEnabled(!!snap.ringModEnabled);

        setRangeValue('filterAttack', snap.filterAttack);
        setRangeValue('filterDecay', snap.filterDecay);
        setRangeValue('filterSustain', snap.filterSustain);
        setRangeValue('filterRelease', snap.filterRelease);
        setFilterEnvEnabled(!!snap.filterEnvState);
        state.filterEnvInvert = !!snap.filterEnvInvert;
        syncKeyboardFilterEnvFromMain();

        setRangeValue('chorusAmount', snap.chorusAmount ?? 0);
        setChorusButton('chorusI', !!snap.chorusI);
        setChorusButton('chorusII', !!snap.chorusII);

        if (snap.osc2Wave) set('osc-type-1', snap.osc2Wave);
    }
    syncUnisonControlsEnabled();
    if (state.audioContext) {
        refreshFilterInputDrive();
        const cutoff = Math.max(40, readRangeValue('cutoff', 1000));
        updateFilterCutoffRange(cutoff, state.audioContext.currentTime, 0.05);
    }
    syncPolyModeUI();
    syncChordMemUI();
}

/** Push morph/harmonics onto Multitudes/Ingy poly wavetable voices. */
export function forEachPolyWavetableOsc(fn) {
    if (typeof fn !== 'function') return;
    voices.forEach((voice) => {
        voice.oscs.forEach((osc) => {
            if (osc?.isWavetable) fn(osc);
        });
    });
}

/** All live poly-pool oscillators (digital or analog) for volume / param updates. */
export function forEachPolyOsc(fn) {
    if (typeof fn !== 'function') return;
    voices.forEach((voice) => {
        voice.oscs.forEach((osc) => {
            if (osc) fn(osc);
        });
    });
}

/** Arm the 6-voice pool for Multitudes (no Ingy-6 panel). */
export function ensureMultitudesPolyReady() {
    if (!state.audioContext) return;
    ensureVoicePool();
    forcePolyAllOff({ silent: true });
    const now = state.audioContext.currentTime;
    killSharedMonoOscillators(now);
    if (state.envelope) {
        state.envelope.gain.cancelScheduledValues(now);
        state.envelope.gain.setValueAtTime(0, now);
        state.envelopeHeld = false;
    }
    state.polyVcaGate = false;
    state.keyboardPolyUnison = false;
    const ctx = state.audioContext;
    void ensurePlaitsWorklet(ctx).then((ok) => {
        if (!ok || !state.keyboardMultitudes) return;
        warmPlaitsPool(ctx, PLAITS_POLY_WARM_COUNT);
    });
}

/** @type {{ unisonEnabled: boolean, ringModEnabled: boolean } | null } */
let multitudesLockSnapshot = null;

/** Lock OSC3–4 / ring-mod style affordances while Multitudes owns the bus. */
export function syncMultitudesPolyLocks(on) {
    document.body.classList.toggle('multitudes-poly-lock', !!on);
    if (on) {
        if (!multitudesLockSnapshot) {
            multitudesLockSnapshot = {
                unisonEnabled: !!state.unisonEnabled,
                ringModEnabled: !!state.ringModEnabled,
            };
        }
        setClassicUnisonEnabled(false);
        setRingModEnabled(false);
    } else if (multitudesLockSnapshot) {
        const snap = multitudesLockSnapshot;
        multitudesLockSnapshot = null;
        setClassicUnisonEnabled(!!snap.unisonEnabled);
        setRingModEnabled(!!snap.ringModEnabled);
    }
    syncUnisonControlsEnabled();
    const input = document.getElementById('ringMod');
    if (input) {
        input.disabled = !state.ringModEnabled || !!state.keyboardPoly || !!on;
    }
    syncPolyUnusedOscModLock();
}

export function togglePolyMode() {
    setPolyMode(!state.keyboardPoly);
}

export function initPolyVoice() {
    bindAmpAdsrMirror();
    setOsc4MorphLiveHook((touch) => {
        forEachPolyWavetableOsc(touch);
    });
    document.addEventListener('ingysynth:poly-noise-level', () => {
        syncPolyNoiseFromUi();
    });
    // Sequencer drives Poly/Multitudes Arp via events (no sequencer→poly-voice import)
    document.addEventListener('ingysynth:poly-arp-on', (e) => {
        const semi = e.detail?.cellSemitone;
        const sounding = e.detail?.sounding;
        if (!Number.isFinite(semi) || !Number.isFinite(sounding)) return;
        polyNoteOn(semi, sounding);
    });
    document.addEventListener('ingysynth:poly-arp-off', (e) => {
        const semi = e.detail?.cellSemitone;
        if (!Number.isFinite(semi)) return;
        polyNoteOff(semi);
    });
    document.addEventListener('ingysynth:poly-arp-reset', () => {
        forcePolyAllOff({ silent: true });
        state.arpLastPolySemi = null;
    });
    initIngy6Panel();
    syncPolyModeUI();
    setPolyLockedUi(!!state.keyboardPoly);
}
