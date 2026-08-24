// Kb-only 6-voice polyphonic playground (shared filter, per-voice amp).
// Classic unison / ring mod locked; Poly Unison stacks the 6-voice pool on one note.

import { state, OSC_COUNT } from './state.js?v=116';
import { get, getNumber, getString, getOscType, getOscVol, getOscPan, set, subscribe } from './params.js?v=13';
import { semitonesToFrequency } from './tuning.js?v=80';
import { updateFilterCutoffRange, getFilterEnvAmount } from './filter-cutoff.js?v=82';
import { refreshFilterInputDrive } from './filter-drive.js?v=29';
import {
    updateNoteVisualizer,
    clearNoteVisualizer,
    hideLogoOverlay,
    showLogoOverlay,
} from './visualizers.js?v=113';
import { unisonCents, applyUnisonCents, syncUnisonControlsEnabled } from './unison.js?v=173';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=17';
import { syncIngy6PanelUi, initIngy6Panel } from './keyboard-ingy6-panel.js?v=28';
import { syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=89';
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
} from './osc-source.js?v=121';
import {
    isPolyChordMemoryOn,
    getPolyChordIntervals,
    clearPolyChordMemory,
} from './chord-memory.js?v=21';

/** Local bend helper — avoid circular import with pitch-bend.js. */
function bentFrequency(baseFreq) {
    const ratio = Math.pow(2, (state.pitchBendSemitones || 0) / 12);
    return Math.max(20, baseFreq * ratio);
}

export const POLY_VOICE_COUNT = 6;
const POLY_OSC_MAX = 2; // OSC 1–2 only
const POLY_DEFAULT_OSC_VOL = 0.1; // stacked chords run hot at normal mono levels
const BEND_RAMP = 0.01;

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
    return Math.max(0, readFloatParam('noiseVol', 0));
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

function disconnectOscGraph(osc) {
    try { osc.gainNode?.disconnect(); } catch (_) { /* ignore */ }
    try { osc.panNode?.disconnect(); } catch (_) { /* ignore */ }
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
                const pan = osc.panNode;
                const delayMs = Math.max(0, (t - ctxNow) * 1000) + 40;
                setTimeout(() => {
                    try { pan?.disconnect(); } catch (_) { /* ignore */ }
                }, delayMs);
                return;
            }
            if (osc.isWavetable) {
                fadeStopOsc(osc, t, { fadeSec: 0.03, hard: !!osc.isTriggered });
                if (immediate) disconnectOscGraph(osc);
                else {
                    const pan = osc.panNode;
                    const delayMs = Math.max(0, (t - ctxNow) * 1000) + 30;
                    setTimeout(() => {
                        try { pan?.disconnect(); } catch (_) { /* ignore */ }
                    }, delayMs);
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

function triggerVoiceAmp(voice, now, { fromCurrent = false, peakScale = 1 } = {}) {
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
        let held = false;
        if (typeof g.cancelAndHoldAtTime === 'function') {
            try { g.cancelAndHoldAtTime(now); held = true; } catch (_) { /* ignore */ }
        }
        if (!held) g.cancelScheduledValues(now);
        g.linearRampToValueAtTime(peak, now + seqAttack);
        g.linearRampToValueAtTime(Math.max(0.00001, sustain * peak), now + seqAttack + safeDecay);
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

function spawnVoiceOscs(voice, soundingSemi, cents, now, { stackCount = 0, sequenced = false } = {}) {
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
        const chordN = stackCount > 1
            ? stackCount
            : (!sequenced && isPolyChordMemoryOn()
                ? Math.max(1, getPolyChordIntervals().length)
                : 1);
        const uniDiv = (!sequenced && state.keyboardPolyUnison && state.keyboardPoly && !isPolyChordMemoryOn())
            ? POLY_VOICE_COUNT
            : 1;
        const stackDiv = uniDiv * (chordN > 1 ? chordN : 1);
        const voiceVol = Math.max(0.0001, fullVol / stackDiv);

        const panValue = getOscPan(i);
        const panner = state.audioContext.createStereoPanner();
        panner.pan.value = panValue;
        panner.connect(dest);

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
            if (osc.isWavetable) osc.start(now);
            else startAnalogOsc(osc, now);
            osc.started = true;
            softStartVoiceGain(gain.gain, voiceVol, now, {
                wavetable: !!osc.isWavetable,
                triggered: !!osc.isTriggered,
            });
        }

        voice.oscs.push(osc);
        voice.baseFreqs.push(baseFreq);
    }

    voice.cents = cents;
    voice.oscStartWhen = now;
    return any;
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

/** Analog seq retrigger: same stack, free-running oscs (Main phase-reset-off). */
function canRetuneSeqVoices(existing, nNeeded) {
    if (!existing.length || existing.length !== nNeeded) return false;
    const want = wantedPolyOscIndexes();
    if (!want.length) return false;
    return existing.every((v) => {
        if (v.oscs.some((o) => o.isWavetable || !o.started)) return false;
        if (v.oscs.length !== want.length) return false;
        return v.oscs.every((osc) => (
            want.includes(osc.oscIndex) && osc.type === analogWaveForIndex(osc.oscIndex)
        ));
    });
}

function retuneVoiceOscs(voice, soundingSemi, cents, when) {
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

function slewVoiceToSounding(voice, sounding, when, slideTime) {
    voice.oscs.forEach((osc) => {
        const baseFreq = Math.max(20, semitonesToFrequency(sounding, osc.oscIndex));
        osc.polyBaseFreq = baseFreq;
        const target = applyUnisonCents(bentFrequency(baseFreq), osc.unisonCents || 0);
        try {
            osc.frequency.cancelScheduledValues(when);
            osc.frequency.setTargetAtTime(target, when, Math.max(0.01, slideTime) / 3);
        } catch (_) { /* ignore */ }
    });
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
    slideFromSounding = null,
    slideTime = 0.05,
    engineGen,
    unison = false,
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
    const ivs = Array.isArray(intervals) && intervals.length ? intervals : [0];
    const isChord = ivs.length > 1;
    const useUni = !isChord && !!unison && !!state.keyboardPoly && !state.keyboardMultitudes;
    const nVoices = useUni ? POLY_VOICE_COUNT : ivs.length;
    // One stable seq finger: retrigger in place like Main, instead of occupying
    // a new pool slot per lookahead step and then hard-stealing (hung oscs).
    seqIdCounter += 1;
    const seqId = seqIdCounter;
    const finger = SEQ_FINGER_BASE;
    const spread = getPolyDetuneCents();
    const stackCount = nVoices;

    holdMasterEnvelope();
    const existing = seqFingerLiveVoices(finger);
    const retune = canRetuneSeqVoices(existing, nVoices);
    if (!retune) {
        hardFreeFinger(finger, when, { keepAmp: true });
        stealUntilFree(nVoices, finger, when);
    } else {
        existing.forEach((v) => {
            v.seqId = seqId;
            v.releasing = false;
        });
    }

    hideLogoOverlay();

    const startOne = (voice, sounding, cents, interval, slide) => {
        voice.semi = sounding;
        voice.finger = finger;
        voice.chordInterval = interval;
        voice.age = ++allocAge;
        voice.sequenced = true;
        voice.seqId = seqId;
        voice.engineGen = engineGen ?? state.seqEngineGeneration;
        const spawnPitch = (slide && slideFromSounding != null) ? slideFromSounding : sounding;
        if (retune && voice.oscs.length && voice.oscs.every((o) => o.started && !o.isWavetable)) {
            retuneVoiceOscs(voice, spawnPitch, cents, when);
            if (slide && slideFromSounding != null) {
                slewVoiceToSounding(voice, sounding, when, slideTime);
            }
            triggerVoiceAmp(voice, when, { peakScale: accentScale });
            return true;
        }
        if (voice.oscs.length) stopVoiceOscs(voice, when);
        const ok = spawnVoiceOscs(voice, spawnPitch, cents, when, { stackCount, sequenced: true });
        if (!ok) {
            voice.semi = null;
            voice.finger = null;
            voice.sequenced = false;
            voice.seqId = 0;
            return false;
        }
        if (slide && slideFromSounding != null) {
            slewVoiceToSounding(voice, sounding, when, slideTime);
        }
        triggerVoiceAmp(voice, when, { peakScale: accentScale });
        return true;
    };

    let any = false;
    if (useUni) {
        const pool = retune ? existing : null;
        for (let k = 0; k < POLY_VOICE_COUNT; k++) {
            const voice = (pool && pool[k]) || voices.find((v) => v.semi == null) || allocVoice();
            if (!voice) break;
            const cents = unisonCents(k, POLY_VOICE_COUNT, spread);
            if (startOne(voice, soundingRoot, cents, 0, k === 0)) any = true;
        }
    } else {
        const pool = retune ? existing : null;
        for (let i = 0; i < ivs.length; i++) {
            const voice = (pool && pool[i]) || voices.find((v) => v.semi == null) || allocVoice();
            if (!voice) break;
            const iv = ivs[i];
            const sounding = soundingRoot + iv;
            const slide = i === 0 && slideFromSounding != null;
            if (startOne(voice, sounding, 0, iv, slide)) any = true;
        }
    }

    if (!any) return;
    triggerSharedFilterEnvelope(when, { skipClose: retune });
    triggerPolyNoiseEnv(when);
    state.keyboardVoiceActive = true;

    const offAt = when + Math.max(0.02, Number(gateSec) || 0.05);
    const gen = polyVoiceGeneration;
    const eng = state.seqEngineGeneration;
    setTimeout(() => {
        if (gen !== polyVoiceGeneration) return;
        if (eng !== state.seqEngineGeneration) return;
        if (!state.audioContext) return;
        const now = state.audioContext.currentTime;
        voices.forEach((v) => {
            if (v.seqId !== seqId) return;
            releaseVoiceAmp(v, now);
        });
        if (activePolyCount() === 0) {
            state.keyboardVoiceActive = false;
            releaseSharedFilterIfIdle(now);
            releasePolyNoiseEnv(now);
        }
    }, Math.max(0, (offAt - ctxNow) * 1000));
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
        // Ingy-6 on: Multitudes far left, Poly centered, logo right.
        // Multitudes panel owns docking while Multitudes mode is on (Poly off).
        const home = document.getElementById('keyboardPolyToggleHome');
        const polySlot = document.getElementById('ingy6PolyToggleSlot');
        const chordSlot = document.getElementById('ingy6ChordMemSlot');
        const multBtn = document.getElementById('keyboardMultitudesToggle');
        if (on) {
            if (polySlot && btn.parentElement !== polySlot) {
                polySlot.appendChild(btn);
            }
            if (chordSlot && multBtn) chordSlot.appendChild(multBtn);
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
        clearPolyChordMemory();
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
        return;
    }

    // Exit — hard-kill voices before restoring patch
    clearPolyChordMemory();
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
