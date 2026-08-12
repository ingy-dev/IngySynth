// Kb-only 6-voice polyphonic playground (shared filter, per-voice amp).
// Classic unison / ring mod locked; Poly Unison stacks the 6-voice pool on one note.

import { state, OSC_COUNT } from './state.js?v=109';
import { semitonesToFrequency } from './tuning.js?v=74';
import { updateFilterCutoffRange, getFilterEnvAmount } from './filter-cutoff.js?v=78';
import { refreshFilterInputDrive } from './filter-drive.js?v=12';
import {
    updateNoteVisualizer,
    clearNoteVisualizer,
    hideLogoOverlay,
    showLogoOverlay,
} from './visualizers.js?v=95';
import { unisonCents, applyUnisonCents, syncUnisonControlsEnabled } from './unison.js?v=145';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=6';
import { syncIngy6PanelUi, initIngy6Panel } from './keyboard-ingy6-panel.js?v=13';
import { syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=79';

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
            age: 0,
            ampEnv,
            oscs: [],
            baseFreqs: [],
            cents: 0,
            releasing: false,
        });
    }
}

function scaleAdsrTime(seconds) {
    return Math.max(0.002, seconds);
}

/** Like parseFloat, but keeps 0 (unlike `x || default`, which treats 0 as missing). */
function readFloatParam(id, fallback) {
    const raw = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(raw) ? raw : fallback;
}

function getPolyDetuneCents() {
    const el = document.getElementById('unisonDetune');
    const n = el ? parseFloat(el.value) : state.unisonSpread;
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
    const main = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
    if (main) {
        main.value = String(clamped);
        const display = main.nextElementSibling;
        if (display?.classList?.contains('osc-vol-value')) {
            display.textContent = clamped.toFixed(2);
        } else if (display) {
            display.textContent = clamped.toFixed(2);
        }
        try {
            main.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) { /* ignore */ }
    }
    const kbVal = document.getElementById(`kbOsc${oscIndex + 1}VolValue`);
    if (kbVal) kbVal.textContent = clamped.toFixed(2);
}

function readOscVol(oscIndex) {
    const el = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
    const n = el ? parseFloat(el.value) : POLY_DEFAULT_OSC_VOL;
    return Number.isFinite(n) ? n : POLY_DEFAULT_OSC_VOL;
}

function setOscEnabled(oscIndex, enabled) {
    const want = !!enabled;
    if (!!state.oscStates[oscIndex] === want) {
        syncOscToggleUi(oscIndex);
        return;
    }
    state.oscStates[oscIndex] = want;
    syncOscToggleUi(oscIndex);
    if (state.audioContext && state.oscGains?.[oscIndex]) {
        const volEl = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
        const volume = want && volEl ? parseFloat(volEl.value) : 0;
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
        const volume = want ? parseFloat(document.getElementById('noiseVol')?.value) || 0 : 0;
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
        const el = document.getElementById('ringMod');
        const value = el ? parseFloat(el.value) : 0;
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
    if (input) input.disabled = !state.ringModEnabled || !!state.keyboardPoly;
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

function polyNoiseTargetLevel() {
    if (!state.keyboardPoly || !state.noiseState) return 0;
    return Math.max(0, readFloatParam('noiseVol', 0));
}

function ensurePolyNoiseSource() {
    if (!state.audioContext || !state.noiseBuffers?.white) return;
    if (state.noiseSource) return;
    try {
        const type = document.getElementById('noiseType')?.value || 'white';
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
    if (state.keyboardPoly) {
        return { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' };
    }
    return {
        attack: 'filterAttack',
        decay: 'filterDecay',
        sustain: 'filterSustain',
        release: 'filterRelease',
    };
}

function triggerSharedFilterEnvelope(now) {
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
    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(minValue, now);
    gainParam.linearRampToValueAtTime(1, now + safeAttack);
    gainParam.linearRampToValueAtTime(sustain, now + safeAttack + safeDecay);
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

function stopVoiceOscs(voice, now) {
    voice.oscs.forEach((osc) => {
        try {
            if (osc.gainNode) {
                osc.gainNode.gain.cancelScheduledValues(now);
                osc.gainNode.gain.setValueAtTime(0.00001, now);
                try { osc.gainNode.disconnect(); } catch (_) { /* ignore */ }
            }
            if (osc.panNode) {
                try { osc.panNode.disconnect(); } catch (_) { /* ignore */ }
            }
            try {
                osc.stop(now);
            } catch (_) {
                try { osc.stop(now + 0.01); } catch (_) { /* ignore */ }
            }
            try { osc.disconnect(); } catch (_) { /* ignore */ }
        } catch (_) { /* ignore */ }
    });
    voice.oscs = [];
    voice.baseFreqs = [];
}

function silenceVoiceAmp(voice, now) {
    if (!voice?.ampEnv) return;
    try {
        voice.ampEnv.gain.cancelScheduledValues(now);
        voice.ampEnv.gain.setValueAtTime(0, now);
    } catch (_) { /* ignore */ }
}

function triggerVoiceAmp(voice, now, { fromCurrent = false } = {}) {
    const g = voice.ampEnv.gain;
    // Ingy 6 VCA GATE: instant open (filter still uses shared ADSR)
    if (state.keyboardPoly && state.polyVcaGate) {
        g.cancelScheduledValues(now);
        g.setValueAtTime(1, now);
        voice.releasing = false;
        return;
    }
    const attack = readFloatParam('attack', 0.01);
    const decay = readFloatParam('decay', 0.2);
    const sustain = readFloatParam('sustain', 0.7);
    const safeAttack = scaleAdsrTime(attack);
    const safeDecay = scaleAdsrTime(decay);
    const startLevel = fromCurrent
        ? Math.max(0.00001, g.value || 0.00001)
        : 0.00001;
    g.cancelScheduledValues(now);
    g.setValueAtTime(startLevel, now);
    g.linearRampToValueAtTime(1, now + safeAttack);
    g.linearRampToValueAtTime(Math.max(0.00001, sustain), now + safeAttack + safeDecay);
    voice.releasing = false;
}

function releaseVoiceAmp(voice, now) {
    const minValue = 0.00001;
    const g = voice.ampEnv.gain;
    // Ingy 6 VCA GATE: fast mute
    const releaseTime = (state.keyboardPoly && state.polyVcaGate)
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
        voice.releasing = false;
    }, (releaseTime + 0.05) * 1000);
}

function spawnVoiceOscs(voice, soundingSemi, cents, now) {
    stopVoiceOscs(voice, now);
    const dest = voice.ampEnv;
    let any = false;

    for (let i = 0; i < POLY_OSC_MAX; i++) {
        if (!state.oscStates[i]) continue;
        any = true;
        const baseFreq = Math.max(20, semitonesToFrequency(soundingSemi, i));
        const freq = applyUnisonCents(bentFrequency(baseFreq), cents);
        // Juno-60 sub (OSC2) is square-only
        const wave = (i === 1)
            ? 'square'
            : (mainOscType(i)?.value || 'sawtooth');
        let fullVol = parseFloat(
            document.querySelector(`.osc-vol[data-osc="${i}"]`)?.value ?? String(POLY_DEFAULT_OSC_VOL),
        );
        if (!Number.isFinite(fullVol)) fullVol = POLY_DEFAULT_OSC_VOL;
        // Ingy SUB fader = 0–100% of whatever OSC2 vol is currently set to
        if (i === 1 && state.keyboardPoly) {
            const subFader = parseFloat(
                document.querySelector('#ingy6Panel .ingy6-fader[data-param="subOsc"] .ingy6-fader-input')?.value,
            );
            const pct = Number.isFinite(subFader) ? Math.max(0, Math.min(1, subFader / 10)) : 0;
            fullVol *= pct;
        }
        const stackDiv = state.keyboardPolyUnison ? POLY_VOICE_COUNT : 1;
        const voiceVol = fullVol / stackDiv;

        const osc = state.audioContext.createOscillator();
        osc.type = wave;
        osc.frequency.value = freq;
        osc.oscIndex = i;
        osc.unisonCents = cents;
        osc.polyBaseFreq = baseFreq;

        const gain = state.audioContext.createGain();
        gain.gain.value = 0;
        const panner = state.audioContext.createStereoPanner();
        const panEl = document.querySelector(`.osc-pan[data-osc="${i}"]`);
        const pan = parseFloat(panEl?.value ?? '0');
        panner.pan.value = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
        osc.connect(gain);
        gain.connect(panner);
        panner.connect(dest);
        osc.gainNode = gain;
        osc.panNode = panner;

        osc.start(now);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(voiceVol, now + 0.005);

        voice.oscs.push(osc);
        voice.baseFreqs.push(baseFreq);
    }

    voice.cents = cents;
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
    return !!state.keyboardPoly;
}

export function hasPolyVoices() {
    return voices.some((v) => v.semi != null);
}

function findVoiceForSemi(semi) {
    return voices.find((v) => v.semi === semi && !v.releasing) || null;
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
    voice.age = ++allocAge;
    const ok = spawnVoiceOscs(voice, sounding, cents, now);
    if (!ok) {
        voice.semi = null;
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
    const voice = findVoiceForSemi(semi);
    if (!voice || !state.audioContext) return;
    const now = state.audioContext.currentTime;
    releaseVoiceAmp(voice, now);
    if (activePolyCount() === 0) {
        state.keyboardVoiceActive = false;
        releaseSharedFilterIfIdle(now);
        releasePolyNoiseEnv(now);
        document.dispatchEvent(new CustomEvent('ingysynth:live-note-off'));
        const release = parseFloat(document.getElementById('release')?.value ?? '0.5');
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
        voice.age = ++allocAge;
        const ok = spawnVoiceOscs(voice, sounding, cents, now);
        if (ok) triggerVoiceAmp(voice, now, { fromCurrent: false });
        else voice.semi = null;
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
    const release = parseFloat(document.getElementById('release')?.value ?? '0.5');
    showLogoOverlay(Math.max(1500, (release + 0.1) * 1000));
    if (!state.isPlaying && !state.isArping && !window.noteVisualizerPreviewActive) {
        clearNoteVisualizer();
    }
}

/**
 * @param {number} cellSemitone
 * @param {number} soundingSemitones absolute semis from C4 (incl. global tune)
 */
export function polyNoteOn(cellSemitone, soundingSemitones) {
    if (!state.keyboardPoly || state.isPlaying) return;
    if (!state.audioContext) return;
    if (state.audioContext.state === 'suspended') state.audioContext.resume();

    ensureVoicePool();
    hideLogoOverlay();
    document.dispatchEvent(new CustomEvent('ingysynth:live-note-on'));

    if (state.keyboardPolyUnison) {
        startUnisonStack(cellSemitone, soundingSemitones);
        return;
    }

    startSingleVoice(cellSemitone, soundingSemitones, 0);
    updateNoteVisualizer(soundingSemitones);
}

export function polyNoteOff(cellSemitone) {
    if (!state.keyboardPoly || !state.audioContext) return;
    if (state.keyboardPolyUnison) {
        // Caller handles last-note retrigger; only release stack when appropriate
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

export function forcePolyAllOff({ silent = false } = {}) {
    // Poly-local only — never bump state.playGeneration (breaks seq stop cleanup)
    polyVoiceGeneration += 1;
    state.keyboardVoiceActive = false;

    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    // Kill leftover seq/mono voices when poly owns the bus or we're idle
    if (state.keyboardPoly || !state.isPlaying) {
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
        v.releasing = false;
        v.age = 0;
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
        const sounding = typeof soundingForSemi === 'function'
            ? soundingForSemi(voice.semi)
            : voice.semi;
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
    // Poly + Arp coexist (Juno Poly Arp); only play/write lock the toggle
    const locked = !!(state.isPlaying || state.keyboardWrite);
    const btn = document.getElementById('keyboardPolyToggle');
    if (btn) {
        btn.classList.toggle('off', !on);
        btn.classList.toggle('is-locked', locked);
        // Always clear disabled when idle — sticky disabled was leaving Poly unusable after Stop
        btn.disabled = locked;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
        btn.setAttribute('aria-label', on ? 'Polyphonic mode on' : 'Polyphonic mode');

        // Home: below 2nd Tuning (Chord Memory | Poly).
        // Ingy-6 on: Chord Memory far left, Poly centered, logo right.
        const home = document.getElementById('keyboardPolyToggleHome');
        const polySlot = document.getElementById('ingy6PolyToggleSlot');
        const chordSlot = document.getElementById('ingy6ChordMemSlot');
        const chordBtn = document.getElementById('keyboardChordMemToggle');
        const polyTarget = on ? polySlot : home;
        const chordTarget = on ? chordSlot : home;
        if (polyTarget && btn.parentElement !== polyTarget) {
            polyTarget.appendChild(btn);
        }
        if (chordBtn && chordTarget && chordBtn.parentElement !== chordTarget) {
            if (!on && home) home.insertBefore(chordBtn, btn);
            else chordTarget.appendChild(chordBtn);
        }
        if (home) home.hidden = on;
    }

    if (!on) {
        document.body.classList.remove('poly-mode');
    }

    syncIngy6PanelUi();

    const polyUni = document.getElementById('kbPolyUnisonToggle');
    if (polyUni) {
        const uniOn = !!state.keyboardPolyUnison;
        polyUni.hidden = !on;
        polyUni.disabled = !on || locked;
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
    const raw = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(raw) ? raw : fallback;
}

function setRangeValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const next = String(value);
    if (el.value !== next) el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function readOscTune(oscIndex) {
    const el = document.querySelector(`.osc-tune[data-osc="${oscIndex}"]`);
    const n = el ? parseInt(el.value, 10) : 0;
    return Number.isFinite(n) ? n : 0;
}

function setOscTuneUi(oscIndex, semis) {
    const el = document.querySelector(`.osc-tune[data-osc="${oscIndex}"]`);
    if (!el) return;
    const clamped = Math.max(-12, Math.min(12, Math.round(semis)));
    if (parseInt(el.value, 10) === clamped) {
        state.oscTunes[oscIndex] = clamped;
        return;
    }
    el.value = String(clamped);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function chorusButtonOn(id) {
    const el = document.getElementById(id);
    return !!(el && !el.classList.contains('off'));
}

function setChorusButton(id, wantOn) {
    const el = document.getElementById(id);
    if (!el) return;
    const isOn = !el.classList.contains('off');
    if (isOn !== !!wantOn) el.click();
}

function setFilterEnvEnabled(wantOn) {
    if (!!state.filterEnvState === !!wantOn) return;
    document.getElementById('filterEnvToggle')?.click();
}

function mirrorAmpAdsrToFilter() {
    setRangeValue('filterAttack', readRangeValue('attack', 0));
    setRangeValue('filterDecay', readRangeValue('decay', 0.5));
    setRangeValue('filterSustain', readRangeValue('sustain', 0.5));
    setRangeValue('filterRelease', readRangeValue('release', 1));
}

function onAmpAdsrInputWhilePoly() {
    if (!state.keyboardPoly) return;
    mirrorAmpAdsrToFilter();
}

let ampAdsrMirrorBound = false;
function bindAmpAdsrMirror() {
    if (ampAdsrMirrorBound) return;
    ampAdsrMirrorBound = true;
    ['attack', 'decay', 'sustain', 'release'].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', onAmpAdsrInputWhilePoly);
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
    if (next && (state.isPlaying || state.keyboardWrite)) {
        syncPolyModeUI();
        return;
    }
    if (state.keyboardPoly === next) {
        // Still ensure lock UI / disabled state matches reality
        if (!next) setPolyLockedUi(false);
        syncPolyModeUI();
        return;
    }

    if (next) {
        // Restore Acid patch first so Poly snapshots the true pre-playground state
        forceAcidOffForPoly();
        document.dispatchEvent(new CustomEvent('ingysynth:exit-berlin'));
        // Poly voices are classic OscillatorNodes — digital stays on OSC1 analog
        document.dispatchEvent(new CustomEvent('ingysynth:digital-off'));

        if (!polySnapshot) {
            polySnapshot = {
                oscStates: state.oscStates.slice(),
                oscVols: Array.from({ length: OSC_COUNT }, (_, i) => readOscVol(i)),
                oscTunes: Array.from({ length: OSC_COUNT }, (_, i) => readOscTune(i)),
                noiseState: !!state.noiseState,
                noiseVol: readRangeValue('noiseVol', 0),
                noiseType: document.getElementById('noiseType')?.value || 'white',
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
                osc2Wave: mainOscType(1)?.value || 'sawtooth',
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
        const noiseTypeEl = document.getElementById('noiseType');
        if (noiseTypeEl && noiseTypeEl.value !== 'white') {
            noiseTypeEl.value = 'white';
            noiseTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setRangeValue('chorusAmount', 1);
        mirrorAmpAdsrToFilter();

        state.keyboardPoly = true;
        state.keyboardPolyUnison = false;
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
        const noiseTypeEl = document.getElementById('noiseType');
        if (noiseTypeEl && snap.noiseType && noiseTypeEl.value !== snap.noiseType) {
            noiseTypeEl.value = snap.noiseType;
            noiseTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
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

        const osc2Type = mainOscType(1);
        if (osc2Type && snap.osc2Wave && osc2Type.value !== snap.osc2Wave) {
            osc2Type.value = snap.osc2Wave;
            osc2Type.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    syncUnisonControlsEnabled();
    if (state.audioContext) {
        refreshFilterInputDrive();
        const cutoff = Math.max(40, readRangeValue('cutoff', 1000));
        updateFilterCutoffRange(cutoff, state.audioContext.currentTime, 0.05);
    }
    syncPolyModeUI();
}

export function togglePolyMode() {
    if (state.isPlaying || state.keyboardWrite) return;
    setPolyMode(!state.keyboardPoly);
}

export function initPolyVoice() {
    bindAmpAdsrMirror();
    document.addEventListener('ingysynth:poly-noise-level', () => {
        syncPolyNoiseFromUi();
    });
    // Sequencer drives Poly Arp via events (no sequencer→poly-voice import)
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
