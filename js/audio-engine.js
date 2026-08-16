import { state, OSC_COUNT } from './state.js?v=113';
import { getNumber, getString, getOscType, getOscVol, getOscPan } from './params.js?v=5';
import { wireControls } from './controls.js?v=255';
import { getFilterCutoffRange } from './filter-cutoff.js?v=80';
import { updateLfoSmoothing } from './lfo-strip.js?v=17';
import { getLfoRateHz, applyLfoRate } from './lfo-rate.js?v=10';
import { makeFilterInputCurve, refreshFilterInputDrive } from './filter-drive.js?v=20';
import { ensurePlaitsWorklet, createOscSource, OSC4_INDEX } from './osc-source.js?v=86';

function makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 0;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = i * 2 / n_samples - 1;
        curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

// Bit-depth reduction as a WaveShaper stair-step curve. `bits` in 2..16;
// 1-bit collapses most of the signal to 0 (silence), so 2 is the floor.
// 16 is effectively transparent; low values quantize hard (crunch).
function makeBitcrushCurve(bits) {
    const b = Math.max(2, Math.min(16, typeof bits === 'number' ? bits : 16));
    const n = 65536;
    const curve = new Float32Array(n);
    const levels = Math.pow(2, b);
    const step = 2 / levels;
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1; // input -1..1
        curve[i] = Math.round(x / step) * step; // quantize to `levels` steps
    }
    return curve;
}

const REVERB_IR_EXPONENT = 2.0;
const REVERB_TAP_COUNT = 3;

/**
 * AdvancedReverb-style IR: decaying stereo noise rendered through HP/LP in an
 * OfflineAudioContext so Damp shapes brightness without live filter cost.
 */
function renderReverbImpulse(decaySec, damp) {
    if (!state.audioContext || !state.reverb) return Promise.resolve();

    const duration = Math.max(0.45, Math.min(4.5, Number(decaySec) || 1.8));
    const d = Math.max(0, Math.min(1, Number(damp) || 0));
    const sampleRate = state.audioContext.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate * duration));
    const gen = ++state.reverbRenderGen;

    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OfflineCtx(2, length, sampleRate);

    const noise = offline.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const data = noise.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            const n = i / length;
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, REVERB_IR_EXPONENT);
        }
    }

    const src = offline.createBufferSource();
    src.buffer = noise;

    // damp 0 = bright room, 1 = darker / more absorbed
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60 + d * 440;
    hp.Q.value = 0.7;

    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 14000 - d * 11000;
    lp.Q.value = 0.7;

    src.connect(hp);
    hp.connect(lp);
    lp.connect(offline.destination);
    src.start(0);

    return offline.startRendering().then((buffer) => {
        if (gen !== state.reverbRenderGen || !state.reverb) return;
        state.reverbImpulseResponse = buffer;
        state.reverb.buffer = buffer;
    }).catch(() => { /* ignore aborted / unsupported offline render */ });
}

/** Size drives predelay, ER tap spacing, and ER↔tail balance (no IR rebuild). */
function applyReverbSize(sizeNorm) {
    if (!state.audioContext || !state.reverbPreDelay || !state.reverbMultitap) return;
    const s = Math.max(0, Math.min(1, Number(sizeNorm) || 0));
    const t = state.audioContext.currentTime;
    // Larger size → longer predelay (walls feel farther)
    const preDelay = 0.008 + s * 0.072; // 8–80 ms
    state.reverbPreDelay.delayTime.setValueAtTime(preDelay, t);
    state.reverbMultitap.forEach((tap, i) => {
        // Closer taps / denser ERs when size is small (tighter room)
        const spacing = 0.003 + (1 - s) * 0.012 + s * (preDelay * 0.35);
        tap.delayTime.setValueAtTime(0.002 + (i + 1) * spacing, t);
    });
    // Small rooms: more early reflections; large rooms: more diffuse tail
    state.reverbErMix = 0.32 * (1 - s * 0.7);
    state.reverbTailMix = 0.5 + s * 0.5;
}

function readReverbDecayDamp() {
    return {
        decay: getNumber('reverbDecay', 1.8),
        damp: getNumber('reverbDamp', 0.35),
    };
}

function generateNoiseBuffers() {
    const bufferSize = 2 * state.audioContext.sampleRate;
    const whiteBuffer = state.audioContext.createBuffer(1, bufferSize, state.audioContext.sampleRate);
    const whiteData = whiteBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        whiteData[i] = Math.random() * 2 - 1;
    }

    const pinkBuffer = state.audioContext.createBuffer(1, bufferSize, state.audioContext.sampleRate);
    const pinkData = pinkBuffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        pinkData[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        pinkData[i] *= 0.11;
        b6 = white * 0.115926;
    }

    const brownBuffer = state.audioContext.createBuffer(1, bufferSize, state.audioContext.sampleRate);
    const brownData = brownBuffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        brownData[i] = (lastOut + (0.02 * white)) / 1.02;
        lastOut = brownData[i];
        brownData[i] *= 3.5;
    }

    state.noiseBuffers.white = whiteBuffer;
    state.noiseBuffers.pink = pinkBuffer;
    state.noiseBuffers.brown = brownBuffer;
}


function initAudio() {
    if (state.audioContext) {
        if (state.audioContext.state === 'suspended') {
            state.audioContext.resume();
        }
        return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContext({
        latencyHint: 'playback',
        sampleRate: 44100
    });

    // Kick off multi-engine worklet load (OSC1 digital); rebuild if Digital was armed early.
    ensurePlaitsWorklet(state.audioContext).then((ok) => {
        if (!ok || !state.osc4Wavetable) return;
        const i = OSC4_INDEX;
        if (state.phaseResetEnabled || !state.oscillators?.[i]) return;
        // Persistent path: swap classic → digital now that the worklet is ready
        try {
            const old = state.oscillators[i];
            const freq = old?.frequency?.value || 261.63;
            try { if (old?.started) old.stop(); } catch (_) { /* ignore */ }
            try { old?.disconnect(); } catch (_) { /* ignore */ }
            const osc = createOscSource(state.audioContext, {
                oscIndex: i,
                wave: getOscType(i),
                frequency: freq,
            });
            osc.frequency.value = freq;
            osc.connect(state.oscGains[i]);
            osc.start();
            osc.started = true;
            state.oscillators[i] = osc;
            const pitchLfo = [
                state.lfoGainOsc1Pitch,
                state.lfoGainOsc2Pitch,
                state.lfoGainOsc3Pitch,
                state.lfoGainOsc4Pitch,
            ][i];
            if (pitchLfo) {
                try { pitchLfo.disconnect(); } catch (_) { /* ignore */ }
                try { pitchLfo.connect(osc.detune); } catch (_) { /* ignore */ }
            }
        } catch (err) {
            console.warn('OSC1 digital rebuild after worklet load failed:', err);
        }
    });
    
    // Fix potential browser audio context limitations
    if (state.audioContext.state === 'suspended') {
        // Some browsers require user interaction to start audio context
        const resumeAudio = function() {
            if (state.audioContext.state === 'suspended') {
                state.audioContext.resume();
            }
            document.body.removeEventListener('touchstart', resumeAudio);
            document.body.removeEventListener('mousedown', resumeAudio);
            document.body.removeEventListener('keydown', resumeAudio);
        };
        document.body.addEventListener('touchstart', resumeAudio);
        document.body.addEventListener('mousedown', resumeAudio);
        document.body.addEventListener('keydown', resumeAudio);
    }

    state.oscillators = Array(OSC_COUNT).fill().map((_, i) => createOscSource(state.audioContext, {
        oscIndex: i,
        wave: getOscType(i),
        frequency: 261.63,
    }));
    state.oscGains = Array(OSC_COUNT).fill().map(() => state.audioContext.createGain());
    state.oscPanners = Array(OSC_COUNT).fill().map(() => {
        const panner = state.audioContext.createStereoPanner();
        panner.pan.value = 0;
        return panner;
    });
    state.noiseGain = state.audioContext.createGain();
    state.filter = state.audioContext.createBiquadFilter();
    state.highPassFilter = state.audioContext.createBiquadFilter();
    state.filterCutoffMin = state.audioContext.createConstantSource();
    state.filterEnvConstant = state.audioContext.createConstantSource();
    state.filterEnvGain = state.audioContext.createGain();
    state.filterEnvDepth = state.audioContext.createGain();
    state.accentSweepConstant = state.audioContext.createConstantSource();
    state.accentSweepGain = state.audioContext.createGain();
    state.highPassFilter.type = 'highpass';
    state.highPassFilter.frequency.value = 20;
    state.highPassFilter.Q.value = 0.7;
    state.envelope = state.audioContext.createGain();
    
    // Initialize chorus nodes before they're used
    state.chorusDryGain = state.audioContext.createGain();
    state.chorusWetGain = state.audioContext.createGain();
    state.chorusLeftDelay = state.audioContext.createDelay(0.05);
    state.chorusRightDelay = state.audioContext.createDelay(0.05);
    state.chorusLFO = state.audioContext.createOscillator();
    state.chorusLFOGain = state.audioContext.createGain();
    state.chorusSplitter = state.audioContext.createChannelSplitter(2);
    state.chorusMerger = state.audioContext.createChannelMerger(2);
    
    // Initialize chorus settings
    state.chorusDryGain.gain.value = 1;
    state.chorusWetGain.gain.value = 0; // Start with chorus off by default
    state.chorusLFO.type = 'triangle';
    state.chorusLFOGain.gain.value = 0; // No modulation by default
    
    // Start the chorus LFO
    state.chorusLFO.start();
    
    // Ring modulation: true 4-quadrant multiply (signal × carrier).
    // The carrier drives ringProduct.gain (base 0), so the output is the
    // product — not a sum. Dry/wet gains crossfade original vs modulated.
    const ringModCarrier = state.audioContext.createOscillator();
    ringModCarrier.type = 'sine';
    ringModCarrier.frequency.value = 1000; // 1kHz carrier frequency

    state.ringModulator = state.audioContext.createGain(); // dry/wet mixer output
    const dryGain = state.audioContext.createGain(); // Original signal
    const wetGain = state.audioContext.createGain(); // Modulated signal

    // Initialize with no modulation
    dryGain.gain.value = 1;
    wetGain.gain.value = 0;

    // Signal into the multiplier
    const modulatorGain = state.audioContext.createGain();

    // Multiplier: base gain 0, carrier swings it ±1 → signal × carrier
    const ringProduct = state.audioContext.createGain();
    ringProduct.gain.value = 0;
    ringModCarrier.connect(ringProduct.gain);

    // Shared input for everything that should pass through ring mod
    // (voices, noise, persistent oscillators) — fans out to dry + wet paths
    const ringModInput = state.audioContext.createGain();
    ringModInput.connect(dryGain);
    ringModInput.connect(modulatorGain);

    // Start the carrier
    ringModCarrier.start();

    // Save references for slider control
    window.ringModDryGain = dryGain;
    window.ringModWetGain = wetGain;
    state.ringModDryGain = dryGain;
    state.ringModWetGain = wetGain;
    state.ringModModulatorGain = modulatorGain;
    state.ringModInput = ringModInput;
    state.ringModulatorOsc = ringModCarrier;

    // Per-OSC pan always feeds the shared ring-mod input (stereo preserved downstream).
    state.oscPanners.forEach((panner, i) => {
        panner.pan.value = getOscPan(i);
        panner.connect(ringModInput);
    });
    
    state.distortion = state.audioContext.createWaveShaper();
    state.bitcrusher = state.audioContext.createWaveShaper();
    state.delay = state.audioContext.createDelay(2.0);
    state.delayGain = state.audioContext.createGain();
    state.reverb = state.audioContext.createConvolver();
    state.reverbInput = state.audioContext.createGain();
    state.reverbPreDelay = state.audioContext.createDelay(0.2);
    state.reverbMultitap = [];
    for (let i = 0; i < REVERB_TAP_COUNT; i++) {
        state.reverbMultitap.push(state.audioContext.createDelay(0.2));
    }
    state.reverbErGain = state.audioContext.createGain();
    state.reverbDryGain = state.audioContext.createGain();
    state.reverbWetGain = state.audioContext.createGain();
    state.postFxGain = state.audioContext.createGain();
    state.masterGain = state.audioContext.createGain();
    state.compressor = state.audioContext.createDynamicsCompressor();
    state.analyser = state.audioContext.createAnalyser();

    if (!state.phaseResetEnabled) {
        state.oscillators.forEach((osc, i) => {
            osc.connect(state.oscGains[i]);
            state.oscGains[i].connect(state.oscPanners[i]);
            osc.start(0);
        });
    }

    // Noise passes through ring mod too
    state.noiseGain.connect(ringModInput);

    // Setup ring modulation paths
    // Dry path
    dryGain.connect(state.ringModulator);

    // Wet path: signal × carrier via the multiplier, then wet amount
    modulatorGain.connect(ringProduct);
    ringProduct.connect(wetGain);
    wetGain.connect(state.ringModulator);
    
    // Filter drive: pad → mild pre-limit → LP → post soft-clip → makeup.
    // Chord-aware pad/Q live in filter-drive.js (biquad rails on multi-pitch + high Q).
    state.filterInputPad = state.audioContext.createGain();
    state.filterInputPad.gain.value = 0.28;
    state.filterPreLimit = state.audioContext.createWaveShaper();
    state.filterPreLimit.curve = makeFilterInputCurve(1.35);
    state.filterPreLimit.oversample = '2x';
    state.filterSoftClip = state.audioContext.createWaveShaper();
    state.filterSoftClip.curve = makeFilterInputCurve(2.45);
    state.filterSoftClip.oversample = '4x';
    state.filterMakeup = state.audioContext.createGain();
    state.filterMakeup.gain.value = 2.4;

    state.ringModulator.connect(state.filterInputPad);
    state.filterInputPad.connect(state.filterPreLimit);
    state.filterPreLimit.connect(state.filter);
    state.filter.connect(state.filterSoftClip);
    state.filterSoftClip.connect(state.filterMakeup);
    state.filterMakeup.connect(state.highPassFilter);
    state.highPassFilter.connect(state.envelope);
    state.envelope.connect(state.distortion);


    // Bit crusher sits right after distortion, feeding the chorus/delay split
    state.distortion.connect(state.bitcrusher);

    // Connect chorus effect
    // Split the signal into dry and wet paths
    state.bitcrusher.connect(state.chorusDryGain);
    state.bitcrusher.connect(state.chorusSplitter);
    
    // Wet path goes through chorus processing
    state.chorusSplitter.connect(state.chorusLeftDelay, 0);  // Left channel
    state.chorusSplitter.connect(state.chorusRightDelay, 1); // Right channel
    
    // Connect LFO to modulate delay times
    state.chorusLFO.connect(state.chorusLFOGain);
    state.chorusLFOGain.connect(state.chorusLeftDelay.delayTime);
    state.chorusLFOGain.connect(state.chorusRightDelay.delayTime);
    
    // Merge the delayed signals back together
    state.chorusLeftDelay.connect(state.chorusMerger, 0, 0);  // Left to left
    state.chorusRightDelay.connect(state.chorusMerger, 0, 1); // Right to right
    
    // Connect the merged wet signal through the wet gain
    state.chorusMerger.connect(state.chorusWetGain);

    // Dry path goes straight to output
    state.chorusDryGain.connect(state.masterGain);
    // Wet path to output
    state.chorusWetGain.connect(state.masterGain);

    // Delay (parallel wet + feedback)
    state.bitcrusher.connect(state.delay);
    state.delay.connect(state.delayGain);
    state.delayGain.connect(state.masterGain);
    state.delayGain.connect(state.delay);

    // Advanced reverb internals (always wired). Edges connect only when enabled
    // so Off is a true bypass with no convolver input.
    state.reverbInput.gain.value = 1;
    state.reverbDryGain.gain.value = 1;
    state.reverbWetGain.gain.value = 0;
    state.reverbErGain.gain.value = 0;
    state.postFxGain.gain.value = 1;

    state.reverbInput.connect(state.reverbPreDelay);
    state.reverbPreDelay.connect(state.reverb);
    state.reverb.connect(state.reverbWetGain);

    state.reverbInput.connect(state.reverbMultitap[0]);
    for (let i = 0; i < state.reverbMultitap.length - 1; i++) {
        state.reverbMultitap[i].connect(state.reverbMultitap[i + 1]);
    }
    state.reverbMultitap[state.reverbMultitap.length - 1].connect(state.reverbErGain);

    const initialSize = getNumber('reverbSize', 0.45);
    applyReverbSize(Number.isFinite(initialSize) ? initialSize : 0.45);
    const { decay, damp } = readReverbDecayDamp();
    renderReverbImpulse(decay, damp);

    state.masterGain.connect(state.postFxGain);
    state.postFxGain.connect(state.compressor);
    state.compressor.connect(state.analyser);
    state.analyser.connect(state.audioContext.destination);

    state.oscillators.forEach((osc, i) => {
        osc.type = getOscType(i);
        osc.frequency.value = 261.63;
    });
    state.oscGains.forEach((gain, i) => {
        gain.gain.value = state.oscStates[i] ? getOscVol(i) : 0;
    });
    state.noiseGain.gain.value = 0;
    state.filter.type = 'lowpass';
    state.filter.frequency.value = 0;
    state.filter.Q.value = 1;

    const initialCutoff = getNumber('cutoff', 1000);
    const initialAmount = 0;
    const { baseFreq, signedDepth } = getFilterCutoffRange(initialCutoff, initialAmount);
    state.filterCutoffMin.offset.value = baseFreq;
    state.filterEnvConstant.offset.value = 1;
    state.filterEnvGain.gain.value = 0;
    state.filterEnvDepth.gain.value = signedDepth;
    state.accentSweepConstant.offset.value = 1;
    state.accentSweepGain.gain.value = 0;
    state.filterCutoffMin.connect(state.filter.frequency);
    state.filterEnvConstant.connect(state.filterEnvGain);
    state.filterEnvGain.connect(state.filterEnvDepth);
    state.filterEnvDepth.connect(state.filter.frequency);
    state.accentSweepConstant.connect(state.accentSweepGain);
    state.accentSweepGain.connect(state.filter.frequency);
    state.filterCutoffMin.start();
    state.filterEnvConstant.start();
    state.accentSweepConstant.start();

    state.envelope.gain.value = 0;
    state.distortion.curve = makeDistortionCurve(0);
    state.distortion.oversample = '4x';

    // Bit crusher: keep aliasing (no oversampling), start clean/transparent
    state.bitcrusher.curve = makeBitcrushCurve(16);
    state.bitcrusher.oversample = 'none';
    
    // Initialize chorus with default values
    state.chorusLeftDelay.delayTime.value = 0.003;
    state.chorusRightDelay.delayTime.value = 0.003;
    state.chorusLFO.frequency.value = 0.1;
    state.chorusLFOGain.gain.value = 0;
    
    state.delay.delayTime.value = 0.25;
    state.delayGain.gain.value = 0;

    state.masterGain.gain.value = 0.5;
    state.compressor.threshold.value = -24;
    state.compressor.knee.value = 30;
    state.compressor.ratio.value = 12;
    state.compressor.attack.value = 0.003;
    state.compressor.release.value = 0.25;
    state.analyser.fftSize = 2048;
    state.analyser.smoothingTimeConstant = 0.8;

    state.lfo = state.audioContext.createOscillator();
    state.lfo.type = getString('lfoWaveform', 'sine');
    state.lfo.frequency.value = getLfoRateHz();

    // Soften discontinuous LFO waveforms (square/saw) before they hit AudioParams
    state.lfoSmooth = state.audioContext.createBiquadFilter();
    state.lfoSmooth.type = 'lowpass';
    state.lfoSmooth.frequency.value = 16;
    state.lfoSmooth.Q.value = 0.2;

    // Soft-clip LFO peaks so deep CUT mod doesn't hard-rail filter.frequency to 0
    state.lfoShaper = state.audioContext.createWaveShaper();
    {
        const n = 1024;
        const curve = new Float32Array(n);
        const drive = 2.2;
        const norm = Math.tanh(drive);
        for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * 2 - 1;
            curve[i] = Math.tanh(x * drive) / norm;
        }
        state.lfoShaper.curve = curve;
        state.lfoShaper.oversample = '4x';
    }

    state.lfoMasterGain = state.audioContext.createGain();
    state.lfoMasterGain.gain.value = state.lfoState ? (Number(state.lfoAmount) || 0) : 0;

    // Extra smoothing on filter-cutoff destination only (high rate + depth clicks)
    state.lfoFilterSlew = state.audioContext.createBiquadFilter();
    state.lfoFilterSlew.type = 'lowpass';
    state.lfoFilterSlew.frequency.value = 8;
    state.lfoFilterSlew.Q.value = 0.15;

    // Pad cutoff path — scaled with cutoff in updateLfoCutoffSafety()
    state.lfoFilterPad = state.audioContext.createGain();
    state.lfoFilterPad.gain.value = 0.7;

    // Highpass LFO path (same pattern — raw HP mod was clicking at the floor)
    state.lfoHpSlew = state.audioContext.createBiquadFilter();
    state.lfoHpSlew.type = 'lowpass';
    state.lfoHpSlew.frequency.value = 5;
    state.lfoHpSlew.Q.value = 0.15;
    state.lfoHpPad = state.audioContext.createGain();
    state.lfoHpPad.gain.value = 0.55;

    state.lfoGainCutoff = state.audioContext.createGain();
    state.lfoGainResonance = state.audioContext.createGain();
    state.lfoGainHighpass = state.audioContext.createGain();
    state.lfoGainOsc1Pitch = state.audioContext.createGain();
    state.lfoGainOsc2Pitch = state.audioContext.createGain();
    state.lfoGainOsc3Pitch = state.audioContext.createGain();
    state.lfoGainOsc4Pitch = state.audioContext.createGain();

    // Depths must start at 0 — GainNode defaults to 1 and would slam full LFO into the filter
    state.lfoGainCutoff.gain.value = 0;
    state.lfoGainResonance.gain.value = 0;
    state.lfoGainHighpass.gain.value = 0;
    state.lfoGainOsc1Pitch.gain.value = 0;
    state.lfoGainOsc2Pitch.gain.value = 0;
    state.lfoGainOsc3Pitch.gain.value = 0;
    state.lfoGainOsc4Pitch.gain.value = 0;

    state.lfo.connect(state.lfoSmooth);
    state.lfoSmooth.connect(state.lfoShaper);
    state.lfoShaper.connect(state.lfoMasterGain);
    state.lfoMasterGain.connect(state.lfoFilterSlew);
    state.lfoFilterSlew.connect(state.lfoFilterPad);
    state.lfoFilterPad.connect(state.lfoGainCutoff);
    state.lfoMasterGain.connect(state.lfoHpSlew);
    state.lfoHpSlew.connect(state.lfoHpPad);
    state.lfoHpPad.connect(state.lfoGainHighpass);
    state.lfoMasterGain.connect(state.lfoGainResonance);
    state.lfoMasterGain.connect(state.lfoGainOsc1Pitch);
    state.lfoMasterGain.connect(state.lfoGainOsc2Pitch);
    state.lfoMasterGain.connect(state.lfoGainOsc3Pitch);
    state.lfoMasterGain.connect(state.lfoGainOsc4Pitch);

    state.lfoGainCutoff.connect(state.filter.frequency);
    state.lfoGainResonance.connect(state.filter.Q);
    state.lfoGainHighpass.connect(state.highPassFilter.frequency);
    state.lfoGainOsc1Pitch.connect(state.oscillators[0].detune);
    state.lfoGainOsc2Pitch.connect(state.oscillators[1].detune);
    state.lfoGainOsc3Pitch.connect(state.oscillators[2].detune);
    state.lfoGainOsc4Pitch.connect(state.oscillators[3].detune);

    // Always start the LFO oscillator; master gain gates audible modulation
    state.lfo.start();
    state.lfo.started = true;

    generateNoiseBuffers();

    wireControls();
    applyLfoRate({ ramp: 0 });
    updateLfoSmoothing();
    refreshFilterInputDrive(0);
}

export {
    makeDistortionCurve,
    makeBitcrushCurve,
    generateNoiseBuffers,
    renderReverbImpulse,
    applyReverbSize,
    initAudio,
};
