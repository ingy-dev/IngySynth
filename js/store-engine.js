// CP10: one engine path from the param store. Classic nodes are optional mirrors.
// Subscribe apply-once at bind (params.subscribe). Re-apply after initAudio.

import { state, OSC_COUNT } from './state.js?v=116';
import {
    get,
    getNumber,
    getString,
    getOscType,
    getOscVol,
    getOscPan,
    subscribe,
    notifyKey,
} from './params.js?v=13';
import { refreshFilterInputDrive, applyFilterResonance } from './filter-drive.js?v=29';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=82';
import { previewStepsOnVfd } from './sequencer.js?v=314';
import { resetSidechainDucker } from './sc-time.js?v=1';
import { drawADSRVisualizer, drawFilterADSRVisualizer, updateNoteVisualizer } from './visualizers.js?v=113';
import { calculateSemitoneShift, getQuantizedStepTune } from './tuning.js?v=80';
import { updateKeyboardStepVisibility, setKeyboardStepActive } from './keyboard-steps.js?v=125';
import { formatRangeValue, ensureDisplayStep } from './knobs.js?v=124';
import {
    setLfoEnabled,
    getLfoAmountAudio,
    applyLfoMasterGain,
    updateLfoSmoothing,
    updateLfoCutoffSafety,
    updateLfoHighpassSafety,
} from './lfo-strip.js?v=26';
import { applyLfoRate } from './lfo-rate.js?v=20';
import { applyPolyOscPan, forEachPolyOsc } from './poly-voice.js?v=94';
import { applyLiveOscVolume, OSC4_INDEX } from './osc-source.js?v=121';

let wired = false;
let rebuildReverbIr = null;
let reverbIrDebounce = null;

export function setReverbIrRebuilder(fn) {
    rebuildReverbIr = typeof fn === 'function' ? fn : null;
}

function makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 0;
    const nSamples = 44100;
    const curve = new Float32Array(nSamples);
    const deg = Math.PI / 180;
    for (let i = 0; i < nSamples; ++i) {
        const x = i * 2 / nSamples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

function makeBitcrushCurve(bits) {
    const b = Math.max(2, Math.min(16, typeof bits === 'number' ? bits : 16));
    const n = 65536;
    const curve = new Float32Array(n);
    const levels = Math.pow(2, b);
    const step = 2 / levels;
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.round(x / step) * step;
    }
    return curve;
}

function applyReverbSize(sizeNorm) {
    if (!state.audioContext || !state.reverbPreDelay || !state.reverbMultitap) return;
    const s = Math.max(0, Math.min(1, Number(sizeNorm) || 0));
    const t = state.audioContext.currentTime;
    const preDelay = 0.008 + s * 0.072;
    state.reverbPreDelay.delayTime.setValueAtTime(preDelay, t);
    state.reverbMultitap.forEach((tap, i) => {
        const spacing = 0.003 + (1 - s) * 0.012 + s * (preDelay * 0.35);
        tap.delayTime.setValueAtTime(0.002 + (i + 1) * spacing, t);
    });
    state.reverbErMix = 0.32 * (1 - s * 0.7);
    state.reverbTailMix = 0.5 + s * 0.5;
}

function scheduleReverbIrRebuild() {
    if (!rebuildReverbIr || !state.audioContext) return;
    clearTimeout(reverbIrDebounce);
    reverbIrDebounce = setTimeout(() => {
        rebuildReverbIr(getNumber('reverbDecay', 1.8), getNumber('reverbDamp', 0.35));
    }, 120);
}

export function liveCutoff() {
    return Math.max(40, getNumber('cutoff', 1000));
}

function updateDisplayForKey(key, spanId) {
    const el = document.getElementById(key);
    if (el) {
        ensureDisplayStep(el);
        const span = document.getElementById(spanId);
        if (span) span.textContent = formatRangeValue(el);
        return;
    }
    const span = document.getElementById(spanId);
    if (span) span.textContent = String(getNumber(key));
}

function syncButton(id, on, onText = 'On', offText = 'Off') {
    const el = document.getElementById(id);
    if (!el) return;
    const front = el.querySelector('.front');
    if (front) front.textContent = on ? onText : offText;
    el.classList.toggle('off', !on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function setInputDisabled(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = !!disabled;
}

export function updateStepVisibility(stepCount) {
    const n = Math.max(1, Math.min(32, parseInt(stepCount, 10) || 8));
    updateKeyboardStepVisibility(n);
}

export function updateDelayTime() {
    if (!state.audioContext || !state.delay) return;
    const division = parseInt(getString('delayTime', '2'), 10) || 2;
    const tempo = getNumber('tempo', 120) || 120;
    const bps = 60 / tempo;
    state.delay.delayTime.setValueAtTime(bps * (4 / division), state.audioContext.currentTime);
}

export function applyCutoff() {
    updateDisplayForKey('cutoff', 'cutoffValue');
    if (!state.audioContext) return;
    updateFilterCutoffRange(liveCutoff(), state.audioContext.currentTime);
    updateLfoCutoffSafety();
    applyFilterResonance(0.03);
    refreshFilterInputDrive(0.05);
}

function applyResonance() {
    updateDisplayForKey('resonance', 'resonanceValue');
    if (!state.audioContext) return;
    applyFilterResonance(0.03);
    refreshFilterInputDrive(0.05);
}

function applyHighPass() {
    updateDisplayForKey('highPass', 'highPassValue');
    if (!state.audioContext || !state.highPassFilter) return;
    const now = state.audioContext.currentTime;
    const hz = Math.max(20, getNumber('highPass', 20));
    state.highPassFilter.frequency.cancelScheduledValues(now);
    state.highPassFilter.frequency.setValueAtTime(state.highPassFilter.frequency.value, now);
    state.highPassFilter.frequency.exponentialRampToValueAtTime(hz, now + 0.03);
    updateLfoHighpassSafety();
}

function applyVolume() {
    updateDisplayForKey('volume', 'volumeValue');
    if (!state.audioContext || !state.masterGain) return;
    state.masterGain.gain.setValueAtTime(getNumber('volume', 0.5), state.audioContext.currentTime);
}

function formatOscPan(n) {
    const v = Math.round((Number(n) || 0) * 50);
    if (v === 0) return 'C';
    return v < 0 ? `L${Math.abs(v)}` : `R${v}`;
}

function applyOscVol(index) {
    const slider = document.querySelector(`.osc-vol[data-osc="${index}"]`);
    if (slider?.nextElementSibling) slider.nextElementSibling.textContent = formatRangeValue(slider);
    if (!state.audioContext || !Number.isFinite(index)) return;
    const on = !!get(`osc-toggle-${index}`);
    const volume = on ? getOscVol(index) : 0;
    const polyExtra = [];
    forEachPolyOsc((osc) => {
        if (osc?.oscIndex === index) polyExtra.push(osc);
    });
    applyLiveOscVolume(index, volume, polyExtra);
    refreshFilterInputDrive();
}

function applyOscPan(index) {
    const pan = getOscPan(index);
    const slider = document.querySelector(`.osc-pan[data-osc="${index}"]`);
    const valueEl = slider?.nextElementSibling?.classList?.contains('osc-pan-value')
        ? slider.nextElementSibling
        : null;
    if (valueEl) valueEl.textContent = formatOscPan(pan);
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    if (state.oscPanners?.[index]) {
        state.oscPanners[index].pan.setValueAtTime(pan, now);
    }
    applyPolyOscPan(index, pan);
}

function applyOscTune(index) {
    const semis = Math.round(getNumber(`osc-tune-${index}`, 0)) || 0;
    if (state.oscTunes) state.oscTunes[index] = semis;
    const el = document.querySelector(`.osc-tune[data-osc="${index}"]`);
    if (el?.nextElementSibling) el.nextElementSibling.textContent = formatRangeValue(el);
    refreshFilterInputDrive();
}

function applyOscType(index) {
    const wave = getOscType(index);
    if (index === OSC4_INDEX && state.osc4Wavetable) return;
    if (!state.audioContext) return;
    const persistent = state.oscillators?.[index];
    // Never splice OscillatorNode.type on a started analog osc.
    // Do not firePhaseReset here — that overlaps playStep's lookahead stack.
    // Next step spawn picks up the wave.
    if (persistent && !persistent.isWavetable && !persistent.started) {
        persistent.type = wave;
    }
}

function applyOscToggle(index, on) {
    const want = !!on;
    if (state.oscStates) state.oscStates[index] = want;
    document.querySelectorAll(`.osc-toggle[data-osc="${index}"]`).forEach((btn) => {
        const front = btn.querySelector('.front');
        if (front) front.textContent = want ? 'On' : 'Off';
        btn.classList.toggle('off', !want);
    });
    if (!state.audioContext || !state.oscGains?.[index]) return;
    const volume = want ? getOscVol(index) : 0;
    const polyExtra = [];
    forEachPolyOsc((osc) => {
        if (osc?.oscIndex === index) polyExtra.push(osc);
    });
    applyLiveOscVolume(index, volume, polyExtra);
    refreshFilterInputDrive();
}

function applyNoiseEnabled(on) {
    state.noiseState = !!on;
    syncButton('noiseToggle', on);
    if (!state.audioContext || !state.noiseGain) return;
    const volume = on ? getNumber('noiseVol', 0) : 0;
    state.noiseGain.gain.cancelScheduledValues(state.audioContext.currentTime);
    state.noiseGain.gain.setValueAtTime(volume, state.audioContext.currentTime);
    refreshFilterInputDrive();
}

function applyNoiseVol() {
    const el = document.getElementById('noiseVol');
    if (el?.nextElementSibling) el.nextElementSibling.textContent = formatRangeValue(el);
    if (!state.audioContext || !state.noiseGain || !state.noiseState) return;
    state.noiseGain.gain.cancelScheduledValues(state.audioContext.currentTime);
    state.noiseGain.gain.setValueAtTime(getNumber('noiseVol', 0), state.audioContext.currentTime);
    refreshFilterInputDrive();
}

function applyNoiseType(type) {
    const t = String(type || 'white');
    if (state.noiseSource && state.noiseBuffers?.[t]) {
        state.noiseSource.buffer = state.noiseBuffers[t];
    }
}

function applyFilterEnv(on) {
    state.filterEnvState = !!on;
    syncButton('filterEnvToggle', on);
    document.getElementById('filterEnvControls')?.classList.toggle('hidden', !on);
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    updateFilterCutoffRange(liveCutoff(), now);
    updateLfoCutoffSafety();
    if (!on && state.filterEnvGain) {
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(0, now);
        state.filterEnvelopeHeld = false;
    }
}

function applyFilterEnvAmount() {
    updateDisplayForKey('filterEnvAmount', 'filterEnvAmountValue');
    if (!state.audioContext) return;
    updateFilterCutoffRange(liveCutoff(), state.audioContext.currentTime);
    updateLfoCutoffSafety();
}

function applyRingMod() {
    updateDisplayForKey('ringMod', 'ringModValue');
    if (!state.audioContext || !state.ringModDryGain || !state.ringModWetGain || !state.ringModEnabled) return;
    const value = getNumber('ringMod', 0);
    state.ringModDryGain.gain.setValueAtTime(1 - value, state.audioContext.currentTime);
    state.ringModWetGain.gain.setValueAtTime(value, state.audioContext.currentTime);
}

function applyRingModEnabled(on) {
    if ((state.keyboardPoly || state.keyboardMultitudes) && on) return;
    state.ringModEnabled = !!on;
    syncButton('ringModToggle', on);
    setInputDisabled('ringMod', !on);
    if (!state.audioContext || !state.ringModDryGain || !state.ringModWetGain) return;
    routeRingMod();
    if (state.ringModEnabled) {
        const value = getNumber('ringMod', 0);
        state.ringModDryGain.gain.setValueAtTime(1 - value, state.audioContext.currentTime);
        state.ringModWetGain.gain.setValueAtTime(value, state.audioContext.currentTime);
    }
}

function applyDistortion() {
    updateDisplayForKey('distortion', 'distortionValue');
    if (!state.audioContext || !state.distortion || !state.distortionEnabled) return;
    state.distortion.curve = makeDistortionCurve(getNumber('distortion', 0));
}

const DIST_RAMP_SEC = 0.025;
let distRouteTimer = null;

function routeDistortion() {
    const ctx = state.audioContext;
    if (!ctx || !state.distInput || !state.distortion || !state.bitcrusher) return;
    const on = !!state.distortionEnabled;
    const t = ctx.currentTime;
    if (distRouteTimer) {
        clearTimeout(distRouteTimer);
        distRouteTimer = null;
    }
    try { state.distInput.disconnect(); } catch (_) { /* ignore */ }
    try { state.distDryGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.distWetGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.distortion.disconnect(); } catch (_) { /* ignore */ }

    state.distInput.connect(state.distDryGain);
    state.distDryGain.connect(state.bitcrusher);
    if (on) {
        state.distInput.connect(state.distortion);
        state.distortion.connect(state.distWetGain);
        state.distWetGain.connect(state.bitcrusher);
        try {
            state.distDryGain.gain.setValueAtTime(Math.max(0, state.distDryGain.gain.value), t);
            state.distDryGain.gain.linearRampToValueAtTime(0, t + DIST_RAMP_SEC);
            state.distWetGain.gain.setValueAtTime(Math.max(0, state.distWetGain.gain.value), t);
            state.distWetGain.gain.linearRampToValueAtTime(1, t + DIST_RAMP_SEC);
        } catch (_) { /* ignore */ }
        distRouteTimer = setTimeout(() => {
            try { state.distDryGain.disconnect(); } catch (_) { /* ignore */ }
        }, DIST_RAMP_SEC * 1000 + 15);
        state.distortion.curve = makeDistortionCurve(getNumber('distortion', 0));
    } else {
        try {
            state.distDryGain.gain.setValueAtTime(Math.max(0, state.distDryGain.gain.value), t);
            state.distDryGain.gain.linearRampToValueAtTime(1, t + DIST_RAMP_SEC);
        } catch (_) { /* ignore */ }
    }
}

function applyDistortionEnabled(on) {
    state.distortionEnabled = !!on;
    syncButton('distortionToggle', on);
    setInputDisabled('distortion', !on);
    if (!state.audioContext || !state.distortion) return;
    routeDistortion();
}

function routeTimeFx() {
    const ctx = state.audioContext;
    if (!ctx || !state.bitcrusher || !state.masterGain) return;
    const chorusOn = !!get('chorusI') || !!get('chorusII');
    const delayOn = !!state.delayEnabled;
    try { state.bitcrusher.disconnect(); } catch (_) { /* ignore */ }
    try { state.chorusDryGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.chorusWetGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.delay?.disconnect(); } catch (_) { /* ignore */ }
    try { state.delayGain?.disconnect(); } catch (_) { /* ignore */ }

    if (chorusOn) {
        state.bitcrusher.connect(state.chorusDryGain);
        state.bitcrusher.connect(state.chorusSplitter);
        state.chorusDryGain.connect(state.masterGain);
        state.chorusWetGain.connect(state.masterGain);
    } else {
        state.bitcrusher.connect(state.masterGain);
    }
    if (delayOn && state.delay && state.delayGain) {
        state.bitcrusher.connect(state.delay);
        state.delay.connect(state.delayGain);
        state.delayGain.connect(state.masterGain);
        state.delayGain.connect(state.delay);
    }
}

function routeRingMod() {
    if (!state.audioContext || !state.ringModInput || !state.ringModulator) return;
    try { state.ringModInput.disconnect(); } catch (_) { /* ignore */ }
    try { state.ringModDryGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.ringModWetGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.ringModModulatorGain?.disconnect(); } catch (_) { /* ignore */ }
    if (state.ringModEnabled && state.ringModDryGain && state.ringModWetGain && state.ringModModulatorGain && state.ringProduct) {
        state.ringModInput.connect(state.ringModDryGain);
        state.ringModInput.connect(state.ringModModulatorGain);
        state.ringModDryGain.connect(state.ringModulator);
        state.ringModModulatorGain.connect(state.ringProduct);
        state.ringProduct.connect(state.ringModWetGain);
        state.ringModWetGain.connect(state.ringModulator);
    } else {
        state.ringModInput.connect(state.ringModulator);
    }
}

function applyBitDepth() {
    updateDisplayForKey('bitDepth', 'bitDepthValue');
    if (!state.audioContext || !state.bitcrusher || !state.bitcrusherEnabled) return;
    state.bitcrusher.curve = makeBitcrushCurve(getNumber('bitDepth', 16));
}

function applyBitcrusherEnabled(on) {
    state.bitcrusherEnabled = !!on;
    syncButton('bitcrusherToggle', on);
    setInputDisabled('bitDepth', !on);
    if (!state.audioContext || !state.bitcrusher) return;
    if (state.bitcrusherEnabled) {
        state.bitcrusher.curve = makeBitcrushCurve(getNumber('bitDepth', 16));
    } else {
        state.bitcrusher.curve = makeBitcrushCurve(16);
    }
}

function applyDelayAmount() {
    updateDisplayForKey('delayAmount', 'delayAmountValue');
    if (!state.audioContext || !state.delayGain || !state.delayEnabled) return;
    state.delayGain.gain.setValueAtTime(getNumber('delayAmount', 0), state.audioContext.currentTime);
}

function applyDelayEnabled(on) {
    state.delayEnabled = !!on;
    syncButton('delayToggle', on);
    setInputDisabled('delayAmount', !on);
    setInputDisabled('delayTime', !on);
    if (!state.audioContext || !state.delayGain) return;
    if (state.delayEnabled) {
        state.delayGain.gain.setValueAtTime(getNumber('delayAmount', 0), state.audioContext.currentTime);
    } else {
        state.delayGain.gain.setValueAtTime(0, state.audioContext.currentTime);
    }
    routeTimeFx();
}

function applyReverbAmount(amount) {
    if (!state.audioContext || !state.reverbDryGain || !state.reverbWetGain || !state.reverbErGain) return;
    const a = Math.max(0, Math.min(1, Number(amount) || 0));
    const t = state.audioContext.currentTime;
    const erMix = Number.isFinite(state.reverbErMix) ? state.reverbErMix : 0.2;
    const tailMix = Number.isFinite(state.reverbTailMix) ? state.reverbTailMix : 0.8;
    state.reverbDryGain.gain.setValueAtTime(1 - a * 0.5, t);
    state.reverbErGain.gain.setValueAtTime(a * erMix, t);
    state.reverbWetGain.gain.setValueAtTime(a * tailMix, t);
}

function routePostFx() {
    if (!state.audioContext || !state.masterGain || !state.postFxGain || !state.analyser) return;
    try { state.masterGain.disconnect(); } catch (_) { /* ignore */ }
    try { state.reverbDryGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.reverbWetGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.reverbErGain?.disconnect(); } catch (_) { /* ignore */ }
    try { state.postFxGain.disconnect(); } catch (_) { /* ignore */ }
    try { state.compressor?.disconnect(); } catch (_) { /* ignore */ }

    if (
        state.reverbEnabled &&
        state.reverbInput &&
        state.reverbDryGain &&
        state.reverbWetGain &&
        state.reverbErGain
    ) {
        state.masterGain.connect(state.reverbDryGain);
        state.masterGain.connect(state.reverbInput);
        state.reverbDryGain.connect(state.postFxGain);
        state.reverbWetGain.connect(state.postFxGain);
        state.reverbErGain.connect(state.postFxGain);
    } else {
        state.masterGain.connect(state.postFxGain);
    }

    if (state.compressorEnabled && state.compressor) {
        state.compressor.threshold.setValueAtTime(
            getNumber('compThreshold', -24),
            state.audioContext.currentTime,
        );
        state.postFxGain.connect(state.compressor);
        state.compressor.connect(state.analyser);
    } else {
        state.postFxGain.connect(state.analyser);
    }
}

function applyReverbEnabled(on) {
    state.reverbEnabled = !!on;
    syncButton('reverbToggle', on);
    ['reverbAmount', 'reverbSize', 'reverbDecay', 'reverbDamp'].forEach((id) => {
        setInputDisabled(id, !on);
    });
    if (state.reverbEnabled) applyReverbAmount(getNumber('reverbAmount', 0));
    else applyReverbAmount(0);
    routePostFx();
}

function applyCompEnabled(on) {
    state.compressorEnabled = !!on;
    syncButton('compToggle', on);
    setInputDisabled('compThreshold', !on);
    routePostFx();
}

function applyCompThreshold() {
    updateDisplayForKey('compThreshold', 'compThresholdValue');
    if (!state.audioContext || !state.compressor || !state.compressorEnabled) return;
    state.compressor.threshold.setValueAtTime(
        getNumber('compThreshold', -24),
        state.audioContext.currentTime,
    );
}

function syncChorusButton(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('off', !on);
    const front = el.querySelector('.front');
    if (front) front.style.color = on ? '' : '#ff0000';
}

export function applyChorusFromStore() {
    const iOn = !!get('chorusI');
    const iiOn = !!get('chorusII');
    const amount = getNumber('chorusAmount', 0);
    updateDisplayForKey('chorusAmount', 'chorusAmountValue');
    syncChorusButton('chorusI', iOn);
    syncChorusButton('chorusII', iiOn);
    if (!state.audioContext || !state.chorusLFO || !state.chorusLeftDelay) return;
    const now = state.audioContext.currentTime;

    if (!iOn && !iiOn) {
        state.chorusLFO.frequency.setValueAtTime(0.1, now);
        state.chorusLeftDelay.delayTime.setValueAtTime(0.003, now);
        state.chorusRightDelay.delayTime.setValueAtTime(0.003, now);
        state.chorusLFOGain.gain.setValueAtTime(0, now);
        state.chorusWetGain.gain.setValueAtTime(0, now);
        state.chorusDryGain.gain.setValueAtTime(1, now);
        routeTimeFx();
        return;
    }

    if (iOn && iiOn) {
        state.chorusLFO.frequency.setValueAtTime(0.85, now);
        state.chorusLeftDelay.delayTime.setValueAtTime(0.006, now);
        state.chorusRightDelay.delayTime.setValueAtTime(0.0065, now);
        state.chorusLFOGain.gain.setValueAtTime(0.003, now);
    } else if (iOn) {
        state.chorusLFO.frequency.setValueAtTime(0.513, now);
        state.chorusLeftDelay.delayTime.setValueAtTime(0.0045, now);
        state.chorusRightDelay.delayTime.setValueAtTime(0.0045, now);
        state.chorusLFOGain.gain.setValueAtTime(0.0013, now);
    } else {
        state.chorusLFO.frequency.setValueAtTime(1.012, now);
        state.chorusLeftDelay.delayTime.setValueAtTime(0.0055, now);
        state.chorusRightDelay.delayTime.setValueAtTime(0.0055, now);
        state.chorusLFOGain.gain.setValueAtTime(0.0025, now);
    }
    state.chorusWetGain.gain.setValueAtTime(amount, now);
    state.chorusDryGain.gain.setValueAtTime(1 - 0.5 * amount, now);
    routeTimeFx();
}

function applyLfoWaveform(wave) {
    const type = String(wave || 'sine');
    if (!state.lfo || !state.audioContext) return;
    const now = state.audioContext.currentTime;
    if (state.lfoMasterGain) {
        const g = state.lfoMasterGain.gain;
        const target = state.lfoState ? getLfoAmountAudio() : 0;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0, now + 0.01);
        state.lfo.type = type;
        updateLfoSmoothing();
        g.setValueAtTime(0, now + 0.012);
        g.linearRampToValueAtTime(target, now + 0.08);
    } else {
        state.lfo.type = type;
        updateLfoSmoothing();
    }
}

function rampLfoDepth(gainNode, value, rampTime = 0.04) {
    if (!gainNode || !state.audioContext) return;
    const now = state.audioContext.currentTime;
    const param = gainNode.gain;
    let t = rampTime;
    if (gainNode === state.lfoGainCutoff && Math.abs(value) > 800) t = Math.max(t, 0.08);
    if (gainNode === state.lfoGainResonance && Math.abs(value) > 12) t = Math.max(t, 0.06);
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + t);
}

const RES_LFO_DEPTH_SCALE = 1.85;

function applyLfoDepths({ ramp = 0.04 } = {}) {
    updateDisplayForKey('cutoffMod', 'cutoffModValue');
    updateDisplayForKey('resonanceMod', 'resonanceModValue');
    updateDisplayForKey('highpassMod', 'highpassModValue');
    updateDisplayForKey('osc1PitchMod', 'osc1PitchModValue');
    updateDisplayForKey('osc2PitchMod', 'osc2PitchModValue');
    updateDisplayForKey('osc3PitchMod', 'osc3PitchModValue');
    updateDisplayForKey('osc4PitchMod', 'osc4PitchModValue');
    rampLfoDepth(state.lfoGainCutoff, getNumber('cutoffMod', 0), ramp);
    rampLfoDepth(state.lfoGainResonance, getNumber('resonanceMod', 0) * RES_LFO_DEPTH_SCALE, ramp);
    rampLfoDepth(state.lfoGainHighpass, getNumber('highpassMod', 0), ramp);
    rampLfoDepth(state.lfoGainOsc1Pitch, getNumber('osc1PitchMod', 0) * 100, ramp);
    rampLfoDepth(state.lfoGainOsc2Pitch, getNumber('osc2PitchMod', 0) * 100, ramp);
    rampLfoDepth(state.lfoGainOsc3Pitch, getNumber('osc3PitchMod', 0) * 100, ramp);
    rampLfoDepth(state.lfoGainOsc4Pitch, getNumber('osc4PitchMod', 0) * 100, ramp);
    updateLfoCutoffSafety();
    updateLfoHighpassSafety();
    if (state.audioContext) {
        updateFilterCutoffRange(liveCutoff(), state.audioContext.currentTime, 0.06);
    }
}

function applyLfoRetrigger(on) {
    state.lfoRetriggerState = !!on;
    const btn = document.getElementById('lfoRetrigger');
    if (btn) {
        const front = btn.querySelector('.front');
        if (front) front.textContent = `Retrigger: ${on ? 'On' : 'Off'}`;
        btn.classList.toggle('off', !on);
    }
}

function applyStepCount(value) {
    const n = Math.max(1, Math.min(32, parseInt(value, 10) || 8));
    updateDisplayForKey('stepCount', 'stepCountValue');
    updateStepVisibility(n);
    previewStepsOnVfd(n);
}

function applyTempo() {
    updateDisplayForKey('tempo', 'tempoValue');
    if (state.audioContext) updateDelayTime();
    if (state.lfoSync) applyLfoRate({ ramp: 0.02 });
}

function maybeUpdateNoteVisualizer() {
    if ((state.isPlaying || state.isArping) && !window.noteVisualizerPreviewActive) {
        const currentStepTune = getQuantizedStepTune(state.currentStep);
        const masterTune = getNumber('masterTune', 0);
        const octaveSwitch = getNumber('octaveSwitch', 0) * 12;
        const semitoneShift = calculateSemitoneShift();
        updateNoteVisualizer(currentStepTune + masterTune + octaveSwitch + semitoneShift);
    }
}

function applyReverbSizeFromStore() {
    updateDisplayForKey('reverbSize', 'reverbSizeValue');
    if (!state.audioContext) return;
    applyReverbSize(getNumber('reverbSize', 0.45));
    if (state.reverbEnabled) applyReverbAmount(getNumber('reverbAmount', 0));
}

function applyReverbDecay() {
    updateDisplayForKey('reverbDecay', 'reverbDecayValue');
    scheduleReverbIrRebuild();
}

function applyReverbDamp() {
    updateDisplayForKey('reverbDamp', 'reverbDampValue');
    scheduleReverbIrRebuild();
}

function applyReverbAmountFromStore() {
    updateDisplayForKey('reverbAmount', 'reverbAmountValue');
    if (!state.audioContext || !state.reverbEnabled) return;
    applyReverbAmount(getNumber('reverbAmount', 0));
}

/** Direct apply after initAudio — notify() equality-guards would skip a second subscribe. */
export function applyStoreToAudio() {
    applyCutoff();
    applyResonance();
    applyHighPass();
    applyVolume();
    applyDelayAmount();
    applyDelayEnabled(!!get('delayToggle'));
    updateDelayTime();
    applyRingModEnabled(!!get('ringModToggle'));
    applyRingMod();
    applyDistortionEnabled(!!get('distortionToggle'));
    applyDistortion();
    applyBitcrusherEnabled(!!get('bitcrusherToggle'));
    applyBitDepth();
    applyReverbEnabled(!!get('reverbToggle'));
    applyReverbAmountFromStore();
    applyCompEnabled(!!get('compToggle'));
    applyCompThreshold();
    applyChorusFromStore();
    applyNoiseEnabled(!!get('noiseToggle'));
    applyNoiseVol();
    applyNoiseType(getString('noiseType', 'white'));
    applyFilterEnv(!!get('filterEnvToggle'));
    applyFilterEnvAmount();
    applyLfoWaveform(getString('lfoWaveform', 'sine'));
    applyLfoDepths({ ramp: 0 });
    setLfoEnabled(!!get('lfoToggle'), { ramp: 0 });
    applyLfoMasterGain({ ramp: 0 });
    applyLfoRate({ ramp: 0 });
    applyLfoRetrigger(!!get('lfoRetrigger'));
    for (let i = 0; i < OSC_COUNT; i++) {
        applyOscTune(i);
        applyOscType(i);
        applyOscPan(i);
        applyOscToggle(i, !!get(`osc-toggle-${i}`));
    }
    applyStepCount(getNumber('stepCount', 8));
    applyTempo();
    applyMixerMutes();
}

export function applyMixerMutes() {
    const ctx = state.audioContext;
    if (!ctx) return;
    const mix = state.mixer || {};
    const t = ctx.currentTime;
    const anySolo = (mix.oscSolo || []).some(Boolean)
        || !!mix.noiseSolo
        || (mix.drumSolo || []).some(Boolean);
    const ramp = (node, open) => {
        if (!node) return;
        const v = open ? 1 : 0;
        try {
            node.gain.cancelScheduledValues(t);
            node.gain.setValueAtTime(node.gain.value, t);
            node.gain.linearRampToValueAtTime(v, t + 0.02);
        } catch (_) { /* ignore */ }
    };
    for (let i = 0; i < OSC_COUNT; i++) {
        let on = !mix.oscMute?.[i];
        if (anySolo) on = on && !!mix.oscSolo?.[i];
        ramp(state.oscMuteGains?.[i], on);
    }
    let noiseOn = !mix.noiseMute;
    if (anySolo) noiseOn = noiseOn && !!mix.noiseSolo;
    ramp(state.noiseMuteGain, noiseOn);
    for (let i = 0; i < 3; i++) {
        let on = !mix.drumMute?.[i];
        if (anySolo) on = on && !!mix.drumSolo?.[i];
        ramp(state.drumMuteGains?.[i], on);
    }
}

export function wireStoreEngine() {
    if (wired) return;
    wired = true;

    subscribe('cutoff', applyCutoff);
    subscribe('resonance', applyResonance);
    subscribe('highPass', applyHighPass);
    subscribe('volume', applyVolume);
    subscribe('stepCount', applyStepCount);
    subscribe('tempo', applyTempo);
    subscribe('slideTime', () => updateDisplayForKey('slideTime', 'slideTimeValue'));
    subscribe('accentAmount', () => updateDisplayForKey('accentAmount', 'accentAmountValue'));
    subscribe('gateLength', () => updateDisplayForKey('gateLength', 'gateLengthValue'));
    subscribe('delayTime', updateDelayTime);
    subscribe('delayAmount', applyDelayAmount);
    subscribe('delayToggle', applyDelayEnabled);
    subscribe('ringMod', applyRingMod);
    subscribe('ringModToggle', applyRingModEnabled);
    subscribe('distortion', applyDistortion);
    subscribe('distortionToggle', applyDistortionEnabled);
    subscribe('bitDepth', applyBitDepth);
    subscribe('bitcrusherToggle', applyBitcrusherEnabled);
    subscribe('chorusI', applyChorusFromStore);
    subscribe('chorusII', applyChorusFromStore);
    subscribe('chorusAmount', applyChorusFromStore);
    subscribe('reverbToggle', applyReverbEnabled);
    subscribe('reverbAmount', applyReverbAmountFromStore);
    subscribe('reverbSize', applyReverbSizeFromStore);
    subscribe('reverbDecay', applyReverbDecay);
    subscribe('reverbDamp', applyReverbDamp);
    subscribe('compToggle', applyCompEnabled);
    subscribe('compThreshold', applyCompThreshold);
    subscribe('scToggle', (on) => {
        if (!on) resetSidechainDucker();
    });
    subscribe('noiseToggle', applyNoiseEnabled);
    subscribe('noiseVol', applyNoiseVol);
    subscribe('noiseType', applyNoiseType);
    subscribe('filterEnvToggle', applyFilterEnv);
    subscribe('filterEnvAmount', applyFilterEnvAmount);
    subscribe('lfoWaveform', applyLfoWaveform);
    subscribe('lfoToggle', (on) => setLfoEnabled(!!on));
    subscribe('lfoRetrigger', applyLfoRetrigger);
    subscribe('cutoffMod', () => applyLfoDepths());
    subscribe('resonanceMod', () => applyLfoDepths());
    subscribe('highpassMod', () => applyLfoDepths());
    subscribe('osc1PitchMod', () => applyLfoDepths());
    subscribe('osc2PitchMod', () => applyLfoDepths());
    subscribe('osc3PitchMod', () => applyLfoDepths());
    subscribe('osc4PitchMod', () => applyLfoDepths());
    subscribe('masterTune', () => {
        updateDisplayForKey('masterTune', 'masterTuneValue');
        maybeUpdateNoteVisualizer();
    });
    subscribe('octaveSwitch', () => {
        updateDisplayForKey('octaveSwitch', 'octaveSwitchValue');
        maybeUpdateNoteVisualizer();
    });
    subscribe('semitoneSwitch', () => {
        updateDisplayForKey('semitoneSwitch', 'semitoneSwitchValue');
        maybeUpdateNoteVisualizer();
    });
    subscribe('semitoneAmount', maybeUpdateNoteVisualizer);
    ['attack', 'decay', 'sustain', 'release'].forEach((param) => {
        subscribe(param, () => {
            updateDisplayForKey(param, `${param}Value`);
            drawADSRVisualizer();
        });
    });
    ['filterAttack', 'filterDecay', 'filterSustain', 'filterRelease'].forEach((param) => {
        subscribe(param, () => {
            updateDisplayForKey(param, `${param}Value`);
            drawFilterADSRVisualizer();
            if (param === 'filterSustain') updateLfoCutoffSafety();
        });
    });
    for (let i = 0; i < OSC_COUNT; i++) {
        subscribe(`osc-vol-${i}`, () => applyOscVol(i));
        subscribe(`osc-pan-${i}`, () => applyOscPan(i));
        subscribe(`osc-tune-${i}`, () => applyOscTune(i));
        subscribe(`osc-type-${i}`, () => applyOscType(i));
        subscribe(`osc-toggle-${i}`, (on) => applyOscToggle(i, on));
    }
}

wireStoreEngine();

// Touch notifyKey so callers can force a replay when lastNotified matches.
export { notifyKey };
