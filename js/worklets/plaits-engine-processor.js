import { EXTRA_ENGINE_META, installExtraEngines } from './plaits-extra-engines.js?v=6';
import { parseSpeechBin, installSpeechEngine, applySpeechUserBank } from './plaits-speech-dsp.js?v=8';

// Copyright 2016 Emilie Gillet / Mutable Instruments - Plaits DSP (MIT).
// Ported to JavaScript AudioWorklet for IngySynth OSC4 digital engines.
// See http://creativecommons.org/licenses/MIT/ for more information.
//
// Plaits FM LUTs (MIT, Copyright 2016 Emilie Gillet)
// From plaits/resources/lookup_tables.py - lut_fm_frequency_quantizer + sine
const FM_RATIO_LUT = new Float32Array([-12.00000000,-12.00000000,-12.00000000,-11.84000000,-11.84000000,-11.84000000,-11.11000000,-10.38000000,-9.65000000,-8.92000000,-8.19000000,-7.46000000,-6.73000000,-6.00000000,-6.00000000,-6.00000000,-5.54551161,-5.09102322,-4.63653483,-4.18204645,-4.18204645,-4.18204645,-3.65929064,-3.13653483,-2.61377903,-2.09102322,-1.56826742,-1.04551161,-0.52275581,0.00000000,0.00000000,0.00000000,0.16000000,0.16000000,0.16000000,0.89000000,1.62000000,2.35000000,3.08000000,3.81000000,4.54000000,5.27000000,6.00000000,6.00000000,6.00000000,6.45448839,6.90897678,7.36346517,7.81795355,7.81795355,7.81795355,8.28552993,8.75310631,9.22068269,9.68825906,9.68825906,9.68825906,10.26619430,10.84412953,11.42206477,12.00000000,12.00000000,12.00000000,12.16000000,12.16000000,12.16000000,12.62977500,13.09955001,13.56932501,14.03910002,14.03910002,14.03910002,14.90761987,15.77613972,16.64465957,17.51317942,17.51317942,17.51317942,18.00000000,18.00000000,18.00000000,18.50977500,19.01955001,19.01955001,19.01955001,19.81795355,19.81795355,19.81795355,20.66386428,21.50977500,21.50977500,21.50977500,22.13233125,22.75488750,23.37744375,24.00000000,24.00000000,24.00000000,24.50977500,25.01955001,25.01955001,25.01955001,25.47403840,25.92852679,26.38301517,26.83750356,26.83750356,26.83750356,27.35032035,27.86313714,27.86313714,27.86313714,28.39735285,28.93156857,29.46578428,30.00000000,30.00000000,30.00000000,30.75000000,31.50000000,32.25000000,33.00000000,33.75000000,34.50000000,35.25000000,36.00000000,36.00000000,36.00000000,36.00000000,36.00000000]);
// Expose for plaits-extra-engines (PD FREQ quantizer) — module scope is not global.
globalThis.FM_RATIO_LUT = FM_RATIO_LUT;
const SINE_LUT = new Float32Array([0.00000000,0.01227154,0.02454123,0.03680722,0.04906767,0.06132074,0.07356456,0.08579731,0.09801714,0.11022221,0.12241068,0.13458071,0.14673047,0.15885814,0.17096189,0.18303989,0.19509032,0.20711138,0.21910124,0.23105811,0.24298018,0.25486566,0.26671276,0.27851969,0.29028468,0.30200595,0.31368174,0.32531029,0.33688985,0.34841868,0.35989504,0.37131719,0.38268343,0.39399204,0.40524131,0.41642956,0.42755509,0.43861624,0.44961133,0.46053871,0.47139674,0.48218377,0.49289819,0.50353838,0.51410274,0.52458968,0.53499762,0.54532499,0.55557023,0.56573181,0.57580819,0.58579786,0.59569930,0.60551104,0.61523159,0.62485949,0.63439328,0.64383154,0.65317284,0.66241578,0.67155895,0.68060100,0.68954054,0.69837625,0.70710678,0.71573083,0.72424708,0.73265427,0.74095113,0.74913639,0.75720885,0.76516727,0.77301045,0.78073723,0.78834643,0.79583690,0.80320753,0.81045720,0.81758481,0.82458930,0.83146961,0.83822471,0.84485357,0.85135519,0.85772861,0.86397286,0.87008699,0.87607009,0.88192126,0.88763962,0.89322430,0.89867447,0.90398929,0.90916798,0.91420976,0.91911385,0.92387953,0.92850608,0.93299280,0.93733901,0.94154407,0.94560733,0.94952818,0.95330604,0.95694034,0.96043052,0.96377607,0.96697647,0.97003125,0.97293995,0.97570213,0.97831737,0.98078528,0.98310549,0.98527764,0.98730142,0.98917651,0.99090264,0.99247953,0.99390697,0.99518473,0.99631261,0.99729046,0.99811811,0.99879546,0.99932238,0.99969882,0.99992470,1.00000000,0.99992470,0.99969882,0.99932238,0.99879546,0.99811811,0.99729046,0.99631261,0.99518473,0.99390697,0.99247953,0.99090264,0.98917651,0.98730142,0.98527764,0.98310549,0.98078528,0.97831737,0.97570213,0.97293995,0.97003125,0.96697647,0.96377607,0.96043052,0.95694034,0.95330604,0.94952818,0.94560733,0.94154407,0.93733901,0.93299280,0.92850608,0.92387953,0.91911385,0.91420976,0.90916798,0.90398929,0.89867447,0.89322430,0.88763962,0.88192126,0.87607009,0.87008699,0.86397286,0.85772861,0.85135519,0.84485357,0.83822471,0.83146961,0.82458930,0.81758481,0.81045720,0.80320753,0.79583690,0.78834643,0.78073723,0.77301045,0.76516727,0.75720885,0.74913639,0.74095113,0.73265427,0.72424708,0.71573083,0.70710678,0.69837625,0.68954054,0.68060100,0.67155895,0.66241578,0.65317284,0.64383154,0.63439328,0.62485949,0.61523159,0.60551104,0.59569930,0.58579786,0.57580819,0.56573181,0.55557023,0.54532499,0.53499762,0.52458968,0.51410274,0.50353838,0.49289819,0.48218377,0.47139674,0.46053871,0.44961133,0.43861624,0.42755509,0.41642956,0.40524131,0.39399204,0.38268343,0.37131719,0.35989504,0.34841868,0.33688985,0.32531029,0.31368174,0.30200595,0.29028468,0.27851969,0.26671276,0.25486566,0.24298018,0.23105811,0.21910124,0.20711138,0.19509032,0.18303989,0.17096189,0.15885814,0.14673047,0.13458071,0.12241068,0.11022221,0.09801714,0.08579731,0.07356456,0.06132074,0.04906767,0.03680722,0.02454123,0.01227154,0.00000000,-0.01227154,-0.02454123,-0.03680722,-0.04906767,-0.06132074,-0.07356456,-0.08579731,-0.09801714,-0.11022221,-0.12241068,-0.13458071,-0.14673047,-0.15885814,-0.17096189,-0.18303989,-0.19509032,-0.20711138,-0.21910124,-0.23105811,-0.24298018,-0.25486566,-0.26671276,-0.27851969,-0.29028468,-0.30200595,-0.31368174,-0.32531029,-0.33688985,-0.34841868,-0.35989504,-0.37131719,-0.38268343,-0.39399204,-0.40524131,-0.41642956,-0.42755509,-0.43861624,-0.44961133,-0.46053871,-0.47139674,-0.48218377,-0.49289819,-0.50353838,-0.51410274,-0.52458968,-0.53499762,-0.54532499,-0.55557023,-0.56573181,-0.57580819,-0.58579786,-0.59569930,-0.60551104,-0.61523159,-0.62485949,-0.63439328,-0.64383154,-0.65317284,-0.66241578,-0.67155895,-0.68060100,-0.68954054,-0.69837625,-0.70710678,-0.71573083,-0.72424708,-0.73265427,-0.74095113,-0.74913639,-0.75720885,-0.76516727,-0.77301045,-0.78073723,-0.78834643,-0.79583690,-0.80320753,-0.81045720,-0.81758481,-0.82458930,-0.83146961,-0.83822471,-0.84485357,-0.85135519,-0.85772861,-0.86397286,-0.87008699,-0.87607009,-0.88192126,-0.88763962,-0.89322430,-0.89867447,-0.90398929,-0.90916798,-0.91420976,-0.91911385,-0.92387953,-0.92850608,-0.93299280,-0.93733901,-0.94154407,-0.94560733,-0.94952818,-0.95330604,-0.95694034,-0.96043052,-0.96377607,-0.96697647,-0.97003125,-0.97293995,-0.97570213,-0.97831737,-0.98078528,-0.98310549,-0.98527764,-0.98730142,-0.98917651,-0.99090264,-0.99247953,-0.99390697,-0.99518473,-0.99631261,-0.99729046,-0.99811811,-0.99879546,-0.99932238,-0.99969882,-0.99992470,-1.00000000,-0.99992470,-0.99969882,-0.99932238,-0.99879546,-0.99811811,-0.99729046,-0.99631261,-0.99518473,-0.99390697,-0.99247953,-0.99090264,-0.98917651,-0.98730142,-0.98527764,-0.98310549,-0.98078528,-0.97831737,-0.97570213,-0.97293995,-0.97003125,-0.96697647,-0.96377607,-0.96043052,-0.95694034,-0.95330604,-0.94952818,-0.94560733,-0.94154407,-0.93733901,-0.93299280,-0.92850608,-0.92387953,-0.91911385,-0.91420976,-0.90916798,-0.90398929,-0.89867447,-0.89322430,-0.88763962,-0.88192126,-0.87607009,-0.87008699,-0.86397286,-0.85772861,-0.85135519,-0.84485357,-0.83822471,-0.83146961,-0.82458930,-0.81758481,-0.81045720,-0.80320753,-0.79583690,-0.78834643,-0.78073723,-0.77301045,-0.76516727,-0.75720885,-0.74913639,-0.74095113,-0.73265427,-0.72424708,-0.71573083,-0.70710678,-0.69837625,-0.68954054,-0.68060100,-0.67155895,-0.66241578,-0.65317284,-0.64383154,-0.63439328,-0.62485949,-0.61523159,-0.60551104,-0.59569930,-0.58579786,-0.57580819,-0.56573181,-0.55557023,-0.54532499,-0.53499762,-0.52458968,-0.51410274,-0.50353838,-0.49289819,-0.48218377,-0.47139674,-0.46053871,-0.44961133,-0.43861624,-0.42755509,-0.41642956,-0.40524131,-0.39399204,-0.38268343,-0.37131719,-0.35989504,-0.34841868,-0.33688985,-0.32531029,-0.31368174,-0.30200595,-0.29028468,-0.27851969,-0.26671276,-0.25486566,-0.24298018,-0.23105811,-0.21910124,-0.20711138,-0.19509032,-0.18303989,-0.17096189,-0.15885814,-0.14673047,-0.13458071,-0.12241068,-0.11022221,-0.09801714,-0.08579731,-0.07356456,-0.06132074,-0.04906767,-0.03680722,-0.02454123,-0.01227154,-0.00000000]);

// Multi-engine OSC worklet - Mutable Instruments Plaits (MIT).
// Engines: wavetable, fm, fm6, waveshaper, modal, string, drums + extras (va…).

const WAVE_SIZE = 128;
const GRID = 8;
const NUM_WAVES = GRID * GRID;
const NUM_BANKS = 4;
const TABLES_BYTES = NUM_BANKS * NUM_WAVES * WAVE_SIZE * 4;
const FM_OS = 4;
/** Plaits lut_4x_downsampler_fir (resources/lookup_tables.py). */
const FM_FIR = [0.02442415, 0.09297315, 0.16712938, 0.21547332];
const SINE_LUT_BITS = 9;
const MAX_U32 = 4294967296.0;
/** Gate slew taus - down slower so note-off AudioParam steps don't hard-cut. */
const GATE_SLEW_UP_SEC = 0.004;
const GATE_SLEW_DOWN_SEC = 0.014;
/** Integrated wavetable ROM + Differentiator path (Plaits Franck & Välimäki AA). */
const USE_INTEGRATED_WAVETABLES = true;
/** Plaits resonator uses up to 24 modes; we keep 8 for CPU. */
const MODAL_NUM_MODES = 8;
const STRING_DELAY_SIZE = 2048;
const SILENT_PEAK = 1e-4;
const SILENT_BLOCKS_NEEDED = 20;

const ENGINE_META = {
    wavetable: { triggered: false, tailSec: 0 },
    fm: { triggered: false, tailSec: 0 },
    fm6: { triggered: true, tailSec: 8 },
    waveshaper: { triggered: false, tailSec: 0 },
    modal: { triggered: true, tailSec: 8 },
    string: { triggered: true, tailSec: 8 },
    bass_drum: { triggered: true, tailSec: 2 },
    snare: { triggered: true, tailSec: 2 },
    hihat: { triggered: true, tailSec: 2 },
    ...EXTRA_ENGINE_META,
};

function gateSlewCoeff(sec) {
    return 1 - Math.exp(-1 / (sampleRate * Math.max(0.001, sec)));
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function interpolateLut(table, index, scale) {
    const max = table.length - 2;
    const x = Math.max(0, Math.min(max, index * scale));
    const i0 = Math.floor(x);
    const i1 = Math.min(table.length - 1, i0 + 1);
    return lerp(table[i0], table[i1], x - i0);
}

/**
 * Hermite interpolate fold LUT - matches Plaits InterpolateHermite(lut_fold + 1, index, 512).
 * index ~0..1, scale e.g. 512.
 */
function interpolateHermite(table, index, scale) {
    let x = index * scale;
    if (x < 0) x = 0;
    const max = table.length - 5;
    if (x > max) x = max;
    const i = Math.floor(x);
    const f = x - i;
    const xm1 = table[i + 1];
    const x0 = table[i + 2];
    const x1 = table[i + 3];
    const x2 = table[i + 4];
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const bNeg = w + a;
    return (((a * f) - bNeg) * f + c) * f + x0;
}

/** Plaits SinePM - phase in uint32, pm index up to ~32. */
function sinePm(phase, pm) {
    const maxIndex = 32;
    const offset = maxIndex;
    const scale = MAX_U32 / (maxIndex * 2);
    const add = ((((pm + offset) * scale) >>> 0) * maxIndex * 2) >>> 0;
    const p = (phase + add) >>> 0;
    const integral = p >>> (32 - SINE_LUT_BITS);
    const fractional = ((p << SINE_LUT_BITS) >>> 0) / MAX_U32;
    const a = SINE_LUT[integral];
    const b = SINE_LUT[Math.min(SINE_LUT.length - 1, integral + 1)];
    return a + (b - a) * fractional;
}

function softSine(phase01) {
    // phase01 in [0,1) → sine via LUT
    const x = ((phase01 % 1) + 1) % 1;
    return interpolateLut(SINE_LUT, x < 0 ? x + 1 : x, 512);
}

class Differentiator {
    constructor() {
        this.previous_ = 0;
        this.lp_ = 0;
    }
    Init() {
        this.previous_ = 0;
        this.lp_ = 0;
    }
    Process(coefficient, s) {
        // ONE_POLE(lp_, s - previous_, coefficient)
        this.lp_ += coefficient * ((s - this.previous_) - this.lp_);
        this.previous_ = s;
        return this.lp_;
    }
}

function sampleWave(bank, waveIndex, phase01) {
    const base = waveIndex * WAVE_SIZE;
    const p = phase01 * WAVE_SIZE;
    const i0 = Math.floor(p) % WAVE_SIZE;
    const i1 = (i0 + 1) % WAVE_SIZE;
    const frac = p - Math.floor(p);
    return lerp(bank[base + i0], bank[base + i1], frac);
}

/** Hermite sample with wrap (Plaits InterpolateWaveHermite on WAVE_SIZE tables). */
function sampleWaveHermite(bank, waveIndex, phase01) {
    const base = waveIndex * WAVE_SIZE;
    const p = phase01 * WAVE_SIZE;
    let i0 = Math.floor(p);
    const f = p - i0;
    i0 = ((i0 % WAVE_SIZE) + WAVE_SIZE) % WAVE_SIZE;
    const xm1 = bank[base + ((i0 - 1 + WAVE_SIZE) % WAVE_SIZE)];
    const x0 = bank[base + i0];
    const x1 = bank[base + ((i0 + 1) % WAVE_SIZE)];
    const x2 = bank[base + ((i0 + 2) % WAVE_SIZE)];
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const bNeg = w + a;
    return (((a * f) - bNeg) * f + c) * f + x0;
}

function blendSample(bank, w00, w10, w01, w11, xf, yf, phase01) {
    const s00 = sampleWave(bank, w00, phase01);
    const s10 = sampleWave(bank, w10, phase01);
    const s01 = sampleWave(bank, w01, phase01);
    const s11 = sampleWave(bank, w11, phase01);
    const s0 = lerp(s00, s10, xf);
    const s1 = lerp(s01, s11, xf);
    return lerp(s0, s1, yf);
}

function blendSampleHermite(bank, w00, w10, w01, w11, xf, yf, phase01) {
    const s00 = sampleWaveHermite(bank, w00, phase01);
    const s10 = sampleWaveHermite(bank, w10, phase01);
    const s01 = sampleWaveHermite(bank, w01, phase01);
    const s11 = sampleWaveHermite(bank, w11, phase01);
    const s0 = lerp(s00, s10, xf);
    const s1 = lerp(s01, s11, xf);
    return lerp(s0, s1, yf);
}

function blendSampleHermiteZ(bank0, bank1, zf, w00, w10, w01, w11, xf, yf, phase01) {
    const a = blendSampleHermite(bank0, w00, w10, w01, w11, xf, yf, phase01);
    if (zf <= 0 || bank1 === bank0) return a;
    const b = blendSampleHermite(bank1, w00, w10, w01, w11, xf, yf, phase01);
    return lerp(a, b, zf);
}

/** Zero-crossing on differentiated (or raw) blend - for integrated tables use diffs. */
function findZeroCrossingPhase(bank0, bank1, zf, w00, w10, w01, w11, xf, yf) {
    const sampleFn = (phase01) => {
        if (USE_INTEGRATED_WAVETABLES) {
            const s0 = blendSampleHermiteZ(bank0, bank1, zf, w00, w10, w01, w11, xf, yf, phase01);
            const s1 = blendSampleHermiteZ(
                bank0, bank1, zf, w00, w10, w01, w11, xf, yf,
                (phase01 + 1 / WAVE_SIZE) % 1
            );
            return s1 - s0;
        }
        return blendSample(bank0, w00, w10, w01, w11, xf, yf, phase01);
    };
    let bestP = 0;
    let bestAbs = 1e9;
    let prev = sampleFn(0);
    for (let i = 1; i <= WAVE_SIZE; i++) {
        const p = (i % WAVE_SIZE) / WAVE_SIZE;
        const s = sampleFn(p);
        const a = Math.abs(s);
        if (a < bestAbs) {
            bestAbs = a;
            bestP = p;
        }
        if (prev < 0 && s >= 0) return p;
        prev = s;
    }
    return bestP;
}

function parsePlaitsTables(buffer) {
    if (!buffer || buffer.byteLength < TABLES_BYTES) return null;
    const view = new Float32Array(buffer, 0, NUM_BANKS * NUM_WAVES * WAVE_SIZE);
    const banks = [];
    for (let b = 0; b < NUM_BANKS; b++) {
        const start = b * NUM_WAVES * WAVE_SIZE;
        banks.push(view.subarray(start, start + NUM_WAVES * WAVE_SIZE));
    }
    return banks;
}

/**
 * Waveshaper bin layout (from generate-plaits-waveshaper.py):
 *   ws[6][257] f32, fold[516] f32, fold2[516] f32, stiffness[65] f32
 */
function parseWaveshaperBin(buffer) {
    if (!buffer) return null;
    const need = (6 * 257 + 516 + 516 + 65) * 4;
    if (buffer.byteLength < need) return null;
    const view = new Float32Array(buffer, 0, 6 * 257 + 516 + 516 + 65);
    let o = 0;
    const ws = [];
    for (let i = 0; i < 6; i++) {
        ws.push(view.subarray(o, o + 257));
        o += 257;
    }
    const fold = view.subarray(o, o + 516);
    o += 516;
    const fold2 = view.subarray(o, o + 516);
    o += 516;
    const stiffness = view.subarray(o, o + 65);
    return { ws, fold, fold2, stiffness };
}

function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

function readAlt(self, parameters) {
    return ((parameters.alt && parameters.alt[0]) ?? (self.alt ? 1 : 0)) >= 0.5;
}

function readTrigPatched(self, parameters) {
    return ((parameters.trigPatched && parameters.trigPatched[0]) ?? (self.trigPatched !== false ? 1 : 0)) >= 0.5;
}

function emitAlt(out, main, aux, alt) {
    const src = alt ? aux : main;
    if (src !== out) out.set(src.subarray(0, out.length));
    else if (alt && aux !== out) {
        for (let i = 0; i < out.length; i++) out[i] = aux[i];
    }
}

function constrain(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
}

function semitonesToRatio(semis) {
    return Math.pow(2, semis / 12);
}

/** PolyBLEP residual for discontinuity at phase 0. */
function polyBlep(t, dt) {
    if (t < dt) {
        t /= dt;
        return t + t - t * t - 1;
    } else if (t > 1 - dt) {
        t = (t - 1) / dt;
        return t * t + t + t + 1;
    }
    return 0;
}

/**
 * Variable-slope oscillator (Plaits OSCILLATOR_SHAPE_SLOPE approximation).
 * pw in ~0.5..0.95 - asymmetry of triangle.
 */
function slopeOscNext(phase, f0, pw) {
    // Naive asymmetric triangle + polyblep at slope breakpoints
    let s;
    if (phase < pw) {
        s = phase / pw;
    } else {
        s = (1 - phase) / (1 - pw);
    }
    s = 2 * s - 1;
    // Soften edges
    s -= polyBlep(phase, f0);
    const t2 = phase - pw;
    const t2w = t2 < 0 ? t2 + 1 : t2;
    s += polyBlep(t2w, f0);
    let next = phase + f0;
    if (next >= 1) next -= 1;
    return { s, phase: next };
}

function Tame(f0, harmonics, order) {
    const f = f0 * harmonics;
    const maxF = 0.5 / order;
    let maxAmount = 1 - (f - maxF) / (0.5 - maxF);
    maxAmount = constrain(maxAmount, 0, 1);
    return maxAmount * maxAmount * maxAmount;
}

function delayReadHermite(line, writePos, delay) {
    const size = line.length;
    const pos = writePos - delay;
    let i = Math.floor(pos);
    const f = pos - i;
    // wrap
    const i0 = ((i % size) + size) % size;
    const xm1 = line[((i0 - 1 + size) % size)];
    const x0 = line[i0];
    const x1 = line[(i0 + 1) % size];
    const x2 = line[(i0 + 2) % size];
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const bNeg = w + a;
    return (((a * f) - bNeg) * f + c) * f + x0;
}

// Copyright 2021 Emilie Gillet.
//
// Author: Emilie Gillet (emilie.o.gillet@gmail.com)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// See http://creativecommons.org/licenses/MIT/ for more information.
//
// -----------------------------------------------------------------------------
//
// Plaits firmware 1.2 — 6-operator FM DSP (AudioWorklet port).
// From plaits/dsp/fm/{patch,dx_units,envelope,lfo,operator,algorithms,voice}.

const FM6_NUM_OPS = 6;
const FM6_NUM_ALGOS = 32;
const FM6_SYX_SIZE = 128;
const FM6_DESTINATION_MASK = 0x03;
const FM6_SOURCE_MASK = 0x30;
const FM6_SOURCE_FEEDBACK = 0x30;
const FM6_ADDITIVE_FLAG = 0x04;
const FM6_FEEDBACK_SOURCE_FLAG = 0x40;
const FM6_PREVIOUS_LEVEL = -100;
const FM6_MIN_LFO_FREQUENCY = 0.005865;

const FM6_LUT_COARSE = [
  -12.000000, 0.000000, 12.000000, 19.019550, 24.000000, 27.863137, 31.019550, 33.688259,
  36.000000, 38.039100, 39.863137, 41.513180, 43.019550, 44.405276, 45.688259, 46.882687,
  48.000000, 49.049554, 50.039100, 50.975130, 51.863137, 52.707809, 53.513180, 54.282743,
  55.019550, 55.726274, 56.405276, 57.058650, 57.688259, 58.295772, 58.882687, 59.450356
];

const FM6_LUT_AMP_MOD_SENSITIVITY = [0.0, 0.2588, 0.4274, 1.0];

const FM6_LUT_PITCH_MOD_SENSITIVITY = [
  0.0, 0.0781250, 0.1562500, 0.2578125, 0.4296875, 0.7187500, 1.1953125, 2.0
];

const FM6_LUT_CUBE_ROOT = [
  0.0, 0.39685062976, 0.50000000000, 0.57235744065, 0.62996081605, 0.67860466725,
  0.72112502092, 0.75914745216, 0.79370070937, 0.82548197054, 0.85498810729,
  0.88258719406, 0.90856038354, 0.93312785379, 0.95646563396, 0.97871693135, 1.0
];

// Algorithms<6>::opcodes_ — MOD(n)=(n<<4), ADD(n)=(n|0x04), OUT(n)=n,
// FB_SRC=0x40, FB_DST=0x30, FB=0x70, NO_MOD=0, OUTPUT=ADD(0)=0x04
const FM6_OPCODES = [
  [0x71, 0x11, 0x11, 0x14, 0x01, 0x14],
  [0x01, 0x11, 0x11, 0x14, 0x71, 0x14],
  [0x71, 0x11, 0x14, 0x01, 0x11, 0x14],
  [0x31, 0x11, 0x54, 0x01, 0x11, 0x14],
  [0x71, 0x14, 0x01, 0x14, 0x01, 0x14],
  [0x31, 0x54, 0x01, 0x14, 0x01, 0x14],
  [0x71, 0x11, 0x05, 0x14, 0x01, 0x14],
  [0x01, 0x11, 0x75, 0x14, 0x01, 0x14],
  [0x01, 0x11, 0x05, 0x14, 0x71, 0x14],
  [0x01, 0x05, 0x14, 0x71, 0x11, 0x14],
  [0x71, 0x05, 0x14, 0x01, 0x11, 0x14],
  [0x01, 0x05, 0x05, 0x14, 0x71, 0x14],
  [0x71, 0x05, 0x05, 0x14, 0x01, 0x14],
  [0x71, 0x05, 0x11, 0x14, 0x01, 0x14],
  [0x01, 0x05, 0x11, 0x14, 0x71, 0x14],
  [0x71, 0x11, 0x02, 0x25, 0x05, 0x14],
  [0x01, 0x11, 0x02, 0x25, 0x75, 0x14],
  [0x01, 0x11, 0x11, 0x75, 0x05, 0x14],
  [0x71, 0x14, 0x14, 0x01, 0x11, 0x14],
  [0x01, 0x05, 0x14, 0x71, 0x14, 0x14],
  [0x01, 0x14, 0x14, 0x71, 0x14, 0x14],
  [0x71, 0x14, 0x14, 0x14, 0x01, 0x14],
  [0x71, 0x14, 0x14, 0x01, 0x14, 0x04],
  [0x71, 0x14, 0x14, 0x14, 0x04, 0x04],
  [0x71, 0x14, 0x14, 0x04, 0x04, 0x04],
  [0x71, 0x05, 0x14, 0x01, 0x14, 0x04],
  [0x01, 0x05, 0x14, 0x71, 0x14, 0x04],
  [0x04, 0x71, 0x11, 0x14, 0x01, 0x14],
  [0x71, 0x14, 0x01, 0x14, 0x04, 0x04],
  [0x04, 0x71, 0x11, 0x14, 0x04, 0x04],
  [0x71, 0x14, 0x04, 0x04, 0x04, 0x04],
  [0x74, 0x04, 0x04, 0x04, 0x04, 0x04]
];

function fm6Sine(phase01) {
  if (typeof softSine === 'function') return softSine(phase01);
  const x = ((phase01 % 1) + 1) % 1;
  return interpolateLut(SINE_LUT, x, 512);
}

function fm6SoftClip(x) {
  if (x < -3) return -1;
  if (x > 3) return 1;
  return x * (27 + x * x) / (27 + 9 * x * x);
}

function fm6SemitonesToRatio(semis) {
  return Math.pow(2, semis / 12);
}

function OperatorLevel(level) {
  let tlc = level | 0;
  if (level < 20) {
    tlc = tlc < 15 ? (tlc * (36 - tlc)) >> 3 : 27 + tlc;
  } else {
    tlc += 28;
  }
  return tlc;
}

function PitchEnvelopeLevel(level) {
  const l = (level - 50) / 32;
  const tail = Math.max(Math.abs(l + 0.02) - 1, 0);
  return l * (1 + tail * tail * 5.3056);
}

function OperatorEnvelopeIncrement(rate) {
  const rateScaled = (rate * 41) >> 6;
  const mantissa = 4 + (rateScaled & 3);
  const exponent = 2 + (rateScaled >> 2);
  return (mantissa << exponent) / (1 << 24);
}

function PitchEnvelopeIncrement(rate) {
  const r = rate * 0.01;
  return (1 + 192 * r * (r * r * r * r + 0.3333)) / (21.3 * 44100);
}

function LFOFrequency(rate) {
  let rateScaled = rate === 0 ? 1 : (rate * 165) >> 6;
  rateScaled *= rateScaled < 160 ? 11 : (11 + ((rateScaled - 160) >> 4));
  return rateScaled * FM6_MIN_LFO_FREQUENCY;
}

function LFODelay(delay, increments) {
  if (delay === 0) {
    increments[0] = increments[1] = 100000;
  } else {
    let d = 99 - delay;
    d = (16 + (d & 15)) << (1 + (d >> 4));
    increments[0] = d * FM6_MIN_LFO_FREQUENCY;
    increments[1] = Math.max(0x80, d & 0xff80) * FM6_MIN_LFO_FREQUENCY;
  }
}

function NormalizeVelocity(velocity) {
  const cubeRoot = interpolateLut(FM6_LUT_CUBE_ROOT, velocity, 16);
  return 16 * (cubeRoot - 0.918);
}

function RateScaling(note, rateScaling) {
  return Math.pow(2, rateScaling * (note * 0.33333 - 7) * 0.03125);
}

function AmpModSensitivity(ampModSensitivity) {
  return FM6_LUT_AMP_MOD_SENSITIVITY[ampModSensitivity & 3];
}

function PitchModSensitivity(pitchModSensitivity) {
  return FM6_LUT_PITCH_MOD_SENSITIVITY[pitchModSensitivity & 7];
}

function KeyboardScaling(note, ks) {
  const x = note - ks.breakPoint - 15;
  const curve = x > 0 ? ks.rightCurve : ks.leftCurve;
  let t = Math.abs(x);
  if (curve === 1 || curve === 2) {
    t = Math.min(t * 0.010467, 1);
    t = t * t * t;
    t *= 96;
  }
  if (curve < 2) t = -t;
  const depth = x > 0 ? ks.rightDepth : ks.leftDepth;
  return t * depth * 0.02677;
}

function FrequencyRatio(op) {
  const detune = op.mode === 0 && op.fine ? 1 + 0.01 * op.fine : 1;
  let base = op.mode === 0
    ? FM6_LUT_COARSE[op.coarse & 31]
    : ((op.coarse & 3) * 100 + op.fine) * 0.39864;
  base += (op.detune - 7) * 0.015;
  return fm6SemitonesToRatio(base) * detune;
}

function unpackFm6Patch(data, offset) {
  offset = offset | 0;
  const op = [];
  for (let i = 0; i < 6; i++) {
    const o = offset + i * 17;
    const envRate = new Uint8Array(4);
    const envLevel = new Uint8Array(4);
    for (let j = 0; j < 4; j++) {
      envRate[j] = Math.min(data[o + j] & 0x7f, 99);
      envLevel[j] = Math.min(data[o + 4 + j] & 0x7f, 99);
    }
    const b12 = data[o + 12];
    const b13 = data[o + 13];
    const b15 = data[o + 15];
    op.push({
      envelope: { rate: envRate, level: envLevel },
      keyboardScaling: {
        breakPoint: Math.min(data[o + 8] & 0x7f, 99),
        leftDepth: Math.min(data[o + 9] & 0x7f, 99),
        rightDepth: Math.min(data[o + 10] & 0x7f, 99),
        leftCurve: data[o + 11] & 0x3,
        rightCurve: (data[o + 11] >> 2) & 0x3
      },
      rateScaling: b12 & 0x7,
      ampModSensitivity: b13 & 0x3,
      velocitySensitivity: (b13 >> 2) & 0x7,
      level: Math.min(data[o + 14] & 0x7f, 99),
      mode: b15 & 0x1,
      coarse: (b15 >> 1) & 0x1f,
      fine: Math.min(data[o + 16] & 0x7f, 99),
      detune: Math.min((b12 >> 3) & 0xf, 14)
    });
  }
  const pitchRate = new Uint8Array(4);
  const pitchLevel = new Uint8Array(4);
  for (let j = 0; j < 4; j++) {
    pitchRate[j] = Math.min(data[offset + 102 + j] & 0x7f, 99);
    pitchLevel[j] = Math.min(data[offset + 106 + j] & 0x7f, 99);
  }
  const name = new Uint8Array(10);
  for (let i = 0; i < 10; i++) name[i] = data[offset + 118 + i] & 0x7f;
  const b111 = data[offset + 111];
  const b116 = data[offset + 116];
  return {
    op,
    pitchEnvelope: { rate: pitchRate, level: pitchLevel },
    algorithm: data[offset + 110] & 0x1f,
    feedback: b111 & 0x7,
    resetPhase: (b111 >> 3) & 0x1,
    modulations: {
      rate: Math.min(data[offset + 112] & 0x7f, 99),
      delay: Math.min(data[offset + 113] & 0x7f, 99),
      pitchModDepth: Math.min(data[offset + 114] & 0x7f, 99),
      ampModDepth: Math.min(data[offset + 115] & 0x7f, 99),
      resetPhase: b116 & 0x1,
      waveform: Math.min((b116 >> 1) & 0x7, 5),
      pitchModSensitivity: b116 >> 4
    },
    transpose: Math.min(data[offset + 117] & 0x7f, 48),
    name,
    activeOperators: 0x3f
  };
}

function fm6PatchName(patch) {
  const n = patch.name;
  let s = '';
  for (let i = 0; i < 10; i++) {
    const c = n[i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function loadFm6Bank(uint8Array4096) {
  const patches = new Array(32);
  for (let i = 0; i < 32; i++) {
    patches[i] = unpackFm6Patch(uint8Array4096, i * FM6_SYX_SIZE);
  }
  return patches;
}

class Fm6Envelope {
  constructor(numStages, reshapeAscending) {
    this.numStages = numStages;
    this.reshapeAscending = reshapeAscending;
    this.stage = numStages - 1;
    this.phase = 1;
    this.start = 0;
    this.increment = new Float32Array(numStages);
    this.level = new Float32Array(numStages);
    this.scale = 1;
  }

  init(scale) {
    this.scale = scale;
    this.stage = this.numStages - 1;
    this.phase = 1;
    this.start = 0;
    for (let i = 0; i < this.numStages; i++) {
      this.increment[i] = 0.001;
      this.level[i] = 1 / (1 << i);
    }
    this.level[this.numStages - 1] = 0;
  }

  valueAt(stage, phase, startLevel) {
    let from = startLevel === FM6_PREVIOUS_LEVEL
      ? this.level[(stage - 1 + this.numStages) % this.numStages]
      : startLevel;
    let to = this.level[stage];
    if (this.reshapeAscending && from < to) {
      from = Math.max(6.7, from);
      to = Math.max(6.7, to);
      phase *= (2.5 - phase) * 0.666667;
    }
    return phase * (to - from) + from;
  }

  value() {
    return this.valueAt(this.stage, this.phase, this.start);
  }

  renderAtSample(t, gateDuration) {
    const ns = this.numStages;
    if (t > gateDuration) {
      const phase = (t - gateDuration) * this.increment[ns - 1];
      return phase >= 1
        ? this.level[ns - 1]
        : this.valueAt(ns - 1, phase, this.renderAtSample(gateDuration, gateDuration));
    }
    let stage = 0;
    for (; stage < ns - 1; stage++) {
      const stageDuration = 1 / this.increment[stage];
      if (t < stageDuration) break;
      t -= stageDuration;
    }
    if (stage === ns - 1) {
      t -= gateDuration;
      if (t <= 0) return this.level[ns - 2];
      if (t * this.increment[ns - 1] > 1) return this.level[ns - 1];
    }
    return this.valueAt(stage, t * this.increment[stage], FM6_PREVIOUS_LEVEL);
  }

  render(gate, rate, adScale, releaseScale) {
    const ns = this.numStages;
    if (gate) {
      if (this.stage === ns - 1) {
        this.start = this.value();
        this.stage = 0;
        this.phase = 0;
      }
    } else if (this.stage !== ns - 1) {
      this.start = this.value();
      this.stage = ns - 1;
      this.phase = 0;
    }
    this.phase += this.increment[this.stage] * rate *
      (this.stage === ns - 1 ? releaseScale : adScale);
    if (this.phase >= 1) {
      if (this.stage >= ns - 2) {
        this.phase = 1;
      } else {
        this.phase = 0;
        this.stage++;
      }
      this.start = FM6_PREVIOUS_LEVEL;
    }
    return this.value();
  }
}

class Fm6OperatorEnvelope extends Fm6Envelope {
  constructor() {
    super(4, true);
  }

  set(rate, level, globalLevel) {
    for (let i = 0; i < 4; i++) {
      let levelScaled = OperatorLevel(level[i]);
      levelScaled = (levelScaled & ~1) + globalLevel - 133;
      this.level[i] = 0.125 * (levelScaled < 1 ? 0.5 : levelScaled);
    }
    for (let i = 0; i < 4; i++) {
      let increment = OperatorEnvelopeIncrement(rate[i]);
      let from = this.level[(i - 1 + 4) % 4];
      let to = this.level[i];
      if (from === to) {
        increment *= 0.6;
        if (i === 0 && !level[i]) increment *= 20;
      } else if (from < to) {
        from = Math.max(6.7, from);
        to = Math.max(6.7, to);
        if (from === to) increment = 1;
        else increment *= 7.2 / (to - from);
      } else {
        increment *= 1 / (from - to);
      }
      this.increment[i] = increment * this.scale;
    }
  }
}

class Fm6PitchEnvelope extends Fm6Envelope {
  constructor() {
    super(4, false);
  }

  set(rate, level) {
    for (let i = 0; i < 4; i++) {
      this.level[i] = PitchEnvelopeLevel(level[i]);
    }
    for (let i = 0; i < 4; i++) {
      const from = this.level[(i - 1 + 4) % 4];
      const to = this.level[i];
      let increment = PitchEnvelopeIncrement(rate[i]);
      if (from !== to) increment *= 1 / Math.abs(from - to);
      else if (i !== 3) increment = 0.2;
      this.increment[i] = increment * this.scale;
    }
  }
}

class Fm6Lfo {
  constructor(sr) {
    this.phase = 0;
    this.frequency = 0.1;
    this.delayPhase = 0;
    this.delayIncrement = [0.1, 0.1];
    this.randomValue = 0;
    this.value_ = 0;
    this.oneHz = 1 / sr;
    this.ampModDepth = 0;
    this.pitchModDepth = 0;
    this.waveform = 0;
    this.resetPhase = false;
    this.phaseIntegral = 0;
  }

  set(modulations) {
    this.frequency = LFOFrequency(modulations.rate) * this.oneHz;
    LFODelay(modulations.delay, this.delayIncrement);
    this.delayIncrement[0] *= this.oneHz;
    this.delayIncrement[1] *= this.oneHz;
    this.waveform = modulations.waveform;
    this.resetPhase = !!modulations.resetPhase;
    this.ampModDepth = modulations.ampModDepth * 0.01;
    this.pitchModDepth = modulations.pitchModDepth * 0.01 *
      PitchModSensitivity(modulations.pitchModSensitivity);
  }

  reset() {
    if (this.resetPhase) this.phase = 0;
    this.delayPhase = 0;
  }

  value() {
    const phase = this.phase;
    switch (this.waveform) {
      case 0: return 2 * (phase < 0.5 ? 0.5 - phase : phase - 0.5);
      case 1: return 1 - phase;
      case 2: return phase;
      case 3: return phase < 0.5 ? 0 : 1;
      case 4: return 0.5 + 0.5 * fm6Sine(phase + 0.5);
      case 5: return this.randomValue;
      default: return 0;
    }
  }

  step(scale) {
    this.phase += scale * this.frequency;
    if (this.phase >= 1) {
      this.phase -= 1;
      this.randomValue = Math.random();
    }
    this.value_ = this.value();
    this.delayPhase += scale * this.delayIncrement[this.delayPhase < 0.5 ? 0 : 1];
    if (this.delayPhase >= 1) this.delayPhase = 1;
  }

  scrub(sample) {
    const phase = sample * this.frequency;
    const phaseIntegral = phase | 0;
    this.phase = phase - phaseIntegral;
    if (phaseIntegral !== this.phaseIntegral) {
      this.phaseIntegral = phaseIntegral;
      this.randomValue = Math.random();
    }
    this.value_ = this.value();
    this.delayPhase = sample * this.delayIncrement[0];
    if (this.delayPhase > 0.5) {
      sample -= 0.5 / this.delayIncrement[0];
      this.delayPhase = 0.5 + sample * this.delayIncrement[1];
      if (this.delayPhase >= 1) this.delayPhase = 1;
    }
  }

  delayRamp() {
    return this.delayPhase < 0.5 ? 0 : (this.delayPhase - 0.5) * 2;
  }

  pitchMod() {
    return (this.value_ - 0.5) * this.delayRamp() * this.pitchModDepth;
  }

  ampMod() {
    return (1 - this.value_) * this.delayRamp() * this.ampModDepth;
  }
}

function renderOperators(n, modulationSource, additive, ops, f, a, fbState, fbAmount, modulation, out, size) {
  let previous0 = 0;
  let previous1 = 0;
  const useFb = modulationSource >= 0;
  if (useFb) {
    previous0 = fbState[0];
    previous1 = fbState[1];
  }
  const frequency = new Uint32Array(n);
  const phase = new Uint32Array(n);
  const amplitude = new Float32Array(n);
  const amplitudeIncrement = new Float32Array(n);
  const scale = 1 / size;
  for (let i = 0; i < n; i++) {
    frequency[i] = (Math.min(f[i], 0.5) * MAX_U32) >>> 0;
    phase[i] = ops[i].phase >>> 0;
    amplitude[i] = ops[i].amplitude;
    amplitudeIncrement[i] = (Math.min(a[i], 4) - amplitude[i]) * scale;
  }
  const fbScale = fbAmount ? (1 << fbAmount) / 512 : 0;
  let modIndex = 0;
  for (let s = 0; s < size; s++) {
    let pm = 0;
    if (useFb) {
      pm = (previous0 + previous1) * fbScale;
    } else if (modulationSource === -2) {
      pm = modulation[modIndex++];
    }
    for (let i = 0; i < n; i++) {
      phase[i] = (phase[i] + frequency[i]) >>> 0;
      pm = sinePm(phase[i], pm) * amplitude[i];
      amplitude[i] += amplitudeIncrement[i];
      if (i === modulationSource) {
        previous1 = previous0;
        previous0 = pm;
      }
    }
    if (additive) out[s] += pm;
    else out[s] = pm;
  }
  for (let i = 0; i < n; i++) {
    ops[i].phase = phase[i];
    ops[i].amplitude = amplitude[i];
  }
  if (useFb) {
    fbState[0] = previous0;
    fbState[1] = previous1;
  }
}

class Fm6Algorithms {
  constructor() {
    this.renderCall = null;
  }

  hasRenderer(n, modulationSource, additive) {
    if (n === 1 && (modulationSource === -2 || modulationSource === -1 || modulationSource === 0)) {
      return true;
    }
    if (n === 3 && modulationSource === 2 && additive) return true;
    if (n === 2 && modulationSource === 1 && additive) return true;
    return false;
  }

  compile(algorithm) {
    const opcodes = FM6_OPCODES[algorithm];
    const calls = this.renderCall[algorithm];
    for (let i = 0; i < FM6_NUM_OPS; ) {
      const opcode = opcodes[i];
      let n = 1;
      while (i + n < FM6_NUM_OPS) {
        const from = opcodes[i + n - 1];
        const to = (opcodes[i + n] & FM6_SOURCE_MASK) >> 4;
        const hasAdditive = !!(from & FM6_ADDITIVE_FLAG);
        const broken = (from & FM6_DESTINATION_MASK) !== to;
        if (hasAdditive || broken) {
          if (to === (opcode & FM6_DESTINATION_MASK)) n = 1;
          break;
        }
        n++;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const outOpcode = opcodes[i + n - 1];
        const additive = !!(outOpcode & FM6_ADDITIVE_FLAG);
        let modulationSource = -3;
        if (!(opcode & FM6_SOURCE_MASK)) {
          modulationSource = -1;
        } else if ((opcode & FM6_SOURCE_MASK) !== FM6_SOURCE_FEEDBACK) {
          modulationSource = -2;
        } else {
          for (let j = 0; j < n; j++) {
            if (opcodes[i + j] & FM6_FEEDBACK_SOURCE_FLAG) modulationSource = j;
          }
        }
        if (this.hasRenderer(n, modulationSource, additive)) {
          calls[i] = {
            n,
            modulationSource,
            additive,
            inputIndex: (opcode & FM6_SOURCE_MASK) >> 4,
            outputIndex: outOpcode & FM6_DESTINATION_MASK
          };
          break;
        } else if (n === 1) {
          calls[i] = {
            n: 1,
            modulationSource: -1,
            additive: false,
            inputIndex: 0,
            outputIndex: 0
          };
          break;
        } else {
          n = 1;
        }
      }
      i += calls[i].n;
    }
  }

  init() {
    this.renderCall = new Array(FM6_NUM_ALGOS);
    for (let a = 0; a < FM6_NUM_ALGOS; a++) {
      this.renderCall[a] = new Array(FM6_NUM_OPS);
      this.compile(a);
    }
  }

  isModulator(algo, op) {
    return !!(FM6_OPCODES[algo][op] & FM6_DESTINATION_MASK);
  }
}

class Fm6Voice {
  constructor(sr) {
    this.sampleRate = sr;
    this.oneHz = 1 / sr;
    this.a0 = 55 / sr;
    const envelopeScale = 44100 * this.oneHz;
    this.algorithms = new Fm6Algorithms();
    this.algorithms.init();
    this.ops = [];
    this.opEnvelopes = [];
    this.ratios = new Float32Array(FM6_NUM_OPS);
    this.levelHeadroom = new Float32Array(FM6_NUM_OPS);
    this.levels = new Float32Array(FM6_NUM_OPS);
    for (let i = 0; i < FM6_NUM_OPS; i++) {
      this.ops.push({ phase: 0, amplitude: 0 });
      const env = new Fm6OperatorEnvelope();
      env.init(envelopeScale);
      this.opEnvelopes.push(env);
    }
    this.pitchEnvelope = new Fm6PitchEnvelope();
    this.pitchEnvelope.init(envelopeScale);
    this.feedbackState = [0, 0];
    this.patch = null;
    this.gate = false;
    this.note = 48;
    this.normalizedVelocity = 10;
    this.dirty = true;
    this.buf1 = null;
    this.buf2 = null;
  }

  setPatch(patch) {
    this.patch = patch;
    this.dirty = true;
  }

  reset() {
    for (let i = 0; i < FM6_NUM_OPS; i++) {
      this.ops[i].phase = 0;
      this.ops[i].amplitude = 0;
    }
    this.feedbackState[0] = this.feedbackState[1] = 0;
    this.gate = false;
  }

  setup() {
    if (!this.dirty || !this.patch) return false;
    const patch = this.patch;
    this.pitchEnvelope.set(patch.pitchEnvelope.rate, patch.pitchEnvelope.level);
    for (let i = 0; i < FM6_NUM_OPS; i++) {
      const op = patch.op[i];
      const level = OperatorLevel(op.level);
      this.opEnvelopes[i].set(op.envelope.rate, op.envelope.level, level);
      this.levelHeadroom[i] = 127 - level;
      const sign = op.mode === 0 ? 1 : -1;
      this.ratios[i] = sign * FrequencyRatio(op);
    }
    this.dirty = false;
    return true;
  }

  render(params, out) {
    if (this.setup()) return;
    if (!this.patch) {
      out.fill(0);
      return;
    }
    const size = out.length;
    if (!this.buf1 || this.buf1.length !== size) {
      this.buf1 = new Float32Array(size);
      this.buf2 = new Float32Array(size);
    }
    out.fill(0);
    this.buf1.fill(0);
    this.buf2.fill(0);
    const buffers = [out, this.buf1, this.buf2, this.buf2];

    const patch = this.patch;
    const envelopeRate = size;
    const adScale = Math.pow(2, (0.5 - params.envelopeControl) * 8);
    const rScale = Math.pow(2, -Math.abs(params.envelopeControl - 0.3) * 8);
    const gateDuration = 1.5 * this.sampleRate;
    const envelopeSample = gateDuration * params.envelopeControl;

    const pitchEnvelope = params.sustain
      ? this.pitchEnvelope.renderAtSample(envelopeSample, gateDuration)
      : this.pitchEnvelope.render(params.gate, envelopeRate, adScale, rScale);
    const pitchMod = pitchEnvelope + params.pitchMod;
    const f0 = this.a0 * 0.25 * fm6SemitonesToRatio(params.note - 9 + pitchMod * 12);

    const noteOn = params.gate && !this.gate;
    this.gate = params.gate;
    if (noteOn || params.sustain) {
      this.normalizedVelocity = NormalizeVelocity(params.velocity);
      this.note = params.note;
    }
    if (noteOn && patch.resetPhase) {
      for (let i = 0; i < FM6_NUM_OPS; i++) this.ops[i].phase = 0;
    }

    const f = new Float32Array(FM6_NUM_OPS);
    const a = new Float32Array(FM6_NUM_OPS);
    for (let i = 0; i < FM6_NUM_OPS; i++) {
      const op = patch.op[i];
      f[i] = this.ratios[i] * (this.ratios[i] < 0 ? -this.oneHz : f0);

      const rateScaling = RateScaling(this.note, op.rateScaling);
      let level = params.sustain
        ? this.opEnvelopes[i].renderAtSample(envelopeSample, gateDuration)
        : this.opEnvelopes[i].render(params.gate, envelopeRate * rateScaling, adScale, rScale);
      const kbScaling = KeyboardScaling(this.note, op.keyboardScaling);
      const velocityScaling = this.normalizedVelocity * op.velocitySensitivity;
      const brightness = this.algorithms.isModulator(patch.algorithm, i)
        ? (params.brightness - 0.5) * 32
        : 0;
      level += 0.125 * Math.min(kbScaling + velocityScaling + brightness, this.levelHeadroom[i]);
      this.levels[i] = level;

      const sensitivity = AmpModSensitivity(op.ampModSensitivity);
      const logLevelMod = sensitivity * params.ampMod - 1;
      const levelMod = 1 - Math.pow(2, 6.4 * logLevelMod);
      a[i] = Math.pow(2, -14 + level * levelMod);
    }

    for (let i = 0; i < FM6_NUM_OPS; ) {
      const call = this.algorithms.renderCall[patch.algorithm][i];
      const n = call.n;
      const opsSlice = this.ops.slice(i, i + n);
      const fSlice = f.subarray(i, i + n);
      const aSlice = a.subarray(i, i + n);
      renderOperators(
        n,
        call.modulationSource,
        call.additive,
        opsSlice,
        fSlice,
        aSlice,
        this.feedbackState,
        patch.feedback,
        buffers[call.inputIndex],
        buffers[call.outputIndex],
        size
      );
      for (let j = 0; j < n; j++) {
        this.ops[i + j].phase = opsSlice[j].phase;
        this.ops[i + j].amplitude = opsSlice[j].amplitude;
      }
      i += n;
    }

    for (let s = 0; s < size; s++) {
      out[s] = fm6SoftClip(out[s] * 0.25);
    }
  }
}


class PlaitsEngineProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 440, minValue: 1, maxValue: 14000, automationRate: 'a-rate' },
            { name: 'detune', defaultValue: 0, minValue: -4800, maxValue: 4800, automationRate: 'a-rate' },
            { name: 'morphX', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'morphY', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'harmonics', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'bank', defaultValue: -1, minValue: -1, maxValue: 3, automationRate: 'k-rate' },
            { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
            { name: 'velocity', defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            /** 0 = Plaits OUT, 1 = Plaits AUX (UI: ALT). */
            { name: 'alt', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            /** 1 = TRIG patched (Mode 2), 0 = unpatched (Mode 1). */
            { name: 'trigPatched', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lp = 0;
        this.engine = 'wavetable';
        this.polyMode = false;
        this.alt = false;
        this.trigPatched = true;
        this.tables = null;
        this.wsLuts = null;
        this.prevGate = 0;
        this.gateSmooth = 0;

        // FM (2-op)
        this.carrierPhase = 0;
        this.modulatorPhase = 0;
        this.subPhase = 0;
        this.fmPrevSample = 0;
        this.fmCarrierFir = 0;
        this.fmSubFir = 0;

        // FM6 (Plaits 1.2 six-op)
        this.fm6Voice = null;
        this.fm6Lfo = null;
        this.fm6Patches = null;
        this.fm6PatchIndex = -1;
        this.fm6ClickFade = 1;

        // Wavetable
        this.diff = new Differentiator();
        this.diffPrev = 0;
        this.diffLp = 0;
        this.xLp = 0;
        this.yLp = 0;
        this.zLp = 0;
        this.xPre = 0;
        this.yPre = 0;
        this.zPre = 0;
        this.prevX = 0;
        this.prevY = 0;
        this.prevZ = 0;

        // Waveshaper
        this.slopePhase = 0;
        this.triPhase = 0;
        this.prevShape = 0;
        this.prevWfGain = 0;
        this.prevOvertone = 0;
        this.wsAux = new Float32Array(128);

        // Modal - 8 SVF bandpass modes
        this.modalF = new Float32Array(MODAL_NUM_MODES);
        this.modalQ = new Float32Array(MODAL_NUM_MODES);
        this.modalA = new Float32Array(MODAL_NUM_MODES);
        this.modalBpS1 = new Float32Array(MODAL_NUM_MODES);
        this.modalBpS2 = new Float32Array(MODAL_NUM_MODES);
        this.excLp = 0;
        this.excBp = 0;
        this.harmonicsLp = 0;
        this.silentBlocks = 0;
        this.reportedSilent = false;
        this.ringing = false;
        this.modalTemp = new Float32Array(128);

        // String KS
        this.delayLine = new Float32Array(STRING_DELAY_SIZE);
        this.writePos = 0;
        this.remainingNoise = 0;
        this.dampLp = 0;
        this.noiseLp = 0;
        this.dcX = 0;
        this.dcY = 0;
        this.curvedBridge = 0;
        this.out0 = 0;
        this.out1 = 0;
        this.srcPhase = 1;
        this.delaySmooth = 100;
        this.dispersionNoise = 0;

        // Bass drum
        this.bdPhase = 0;
        this.bdAmpEnv = 0;
        this.bdFmEnv = 0;
        this.bdToneLp = 0;

        // Snare
        this.snPhase = 0;
        this.snNoiseEnv = 0;
        this.snToneEnv = 0;

        // Hihat
        this.hhPhases = new Float32Array(6);
        this.hhEnv = 0;
        this.hhHp = 0;
        this.hhAuxHp = 0;
        this.drumAux = new Float32Array(128);
        this.bdPhaseNoise = 0;
        this.snAuxPhase = 0;

        // RNG (LCG)
        this.rngState = 0x12345678 | 0;

        this.port.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg || typeof msg !== 'object') return;
            if (typeof msg.engine === 'string') {
                if (msg.engine === 'speech') this.prevGate = 0;
                this.engine = msg.engine;
            }
            if (typeof msg.polyMode === 'boolean') this.polyMode = msg.polyMode;
            if (typeof msg.alt === 'boolean') this.alt = msg.alt;
            if (typeof msg.trigPatched === 'boolean') this.trigPatched = msg.trigPatched;
            if (msg.tables) {
                const buf = msg.tables instanceof ArrayBuffer
                    ? msg.tables
                    : (msg.tables.buffer || null);
                const parsed = parsePlaitsTables(buf);
                if (parsed) this.tables = parsed;
            }
            if (msg.waveshaper) {
                const buf = msg.waveshaper instanceof ArrayBuffer
                    ? msg.waveshaper
                    : (msg.waveshaper.buffer || null);
                const parsed = parseWaveshaperBin(buf);
                if (parsed) this.wsLuts = parsed;
            }
            if (msg.fmBank) {
                const buf = msg.fmBank instanceof ArrayBuffer
                    ? new Uint8Array(msg.fmBank)
                    : (msg.fmBank instanceof Uint8Array
                        ? msg.fmBank
                        : (msg.fmBank.buffer ? new Uint8Array(msg.fmBank.buffer) : null));
                if (buf && buf.length >= 4096) {
                    this.fm6Patches = loadFm6Bank(buf.subarray(0, 4096));
                    this.fm6PatchIndex = -1;
                    if (this.fm6Voice) this.fm6Voice.setPatch(null);
                }
            }
            if (msg.speech) {
                const buf = msg.speech instanceof ArrayBuffer
                    ? msg.speech
                    : (msg.speech.buffer || null);
                const parsed = parseSpeechBin(buf);
                if (parsed) {
                    this.speechRom = parsed;
                    if (this._speech) this._speech.romSynced = false;
                    if (typeof this.resetSpeechState === 'function') {
                        this.resetSpeechState();
                    }
                }
            }
            if ('userBank' in msg) {
                const raw = msg.userBank;
                let bytes = null;
                if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
                else if (raw instanceof Uint8Array) bytes = raw;
                else if (raw && raw.buffer) bytes = new Uint8Array(raw.buffer);
                applySpeechUserBank(this, bytes, msg.userBankActive !== false && !!bytes);
            }
            if (typeof msg.userBankActive === 'boolean' && !('userBank' in msg)) {
                applySpeechUserBank(
                    this,
                    this._speech?.userBankBytes || null,
                    msg.userBankActive,
                );
            }
            if (msg.reset && (this.prevGate < 0.0001 || this.engine === 'speech')) {
                this.prevGate = 0;
                this.resetIdleState();
            }
        };
    }

    nextNoise() {
        // xorshift32 → [-1, 1)
        let x = this.rngState | 0;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.rngState = x | 0;
        return (x | 0) / 2147483648;
    }

    resetIdleState() {
        this.phase = 0;
        this.lp = 0;
        this.carrierPhase = 0;
        this.modulatorPhase = 0;
        this.subPhase = 0;
        this.fmPrevSample = 0;
        this.fmCarrierFir = 0;
        this.fmSubFir = 0;
        this.gateSmooth = 0;
        this.prevGate = 0;
        if (this.fm6Voice) this.fm6Voice.reset();
        this.diff.Init();
        this.diffPrev = 0;
        this.diffLp = 0;
        this.xLp = this.yLp = this.zLp = 0;
        this.xPre = this.yPre = this.zPre = 0;
        this.slopePhase = 0;
        this.triPhase = 0;
        this.prevShape = 0;
        this.prevWfGain = 0;
        this.prevOvertone = 0;
        this.modalBpS1.fill(0);
        this.modalBpS2.fill(0);
        this.excLp = 0;
        this.excBp = 0;
        this.silentBlocks = 0;
        this.reportedSilent = false;
        this.ringing = false;
        this.delayLine.fill(0);
        this.writePos = 0;
        this.remainingNoise = 0;
        this.dampLp = 0;
        this.noiseLp = 0;
        this.dcX = 0;
        this.dcY = 0;
        this.curvedBridge = 0;
        this.out0 = this.out1 = 0;
        this.srcPhase = 1;
        this.bdPhase = 0;
        this.bdAmpEnv = 0;
        this.bdFmEnv = 0;
        this.bdToneLp = 0;
        this.snPhase = 0;
        this.snNoiseEnv = 0;
        this.snToneEnv = 0;
        this.hhPhases.fill(0);
        this.hhEnv = 0;
        this.hhHp = 0;
        if (typeof this.resetSpeechState === 'function') {
            this.resetSpeechState();
        }
    }

    noteHz(parameters, i) {
        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const f0 = freqArr.length > 1 ? freqArr[i] : freqArr[0];
        const det = detuneArr.length > 1 ? detuneArr[i] : detuneArr[0];
        return Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
    }

    checkSilence(peak, gateHigh) {
        if (gateHigh) {
            this.silentBlocks = 0;
            this.reportedSilent = false;
            return;
        }
        if (peak < SILENT_PEAK) {
            this.silentBlocks++;
            if (this.silentBlocks >= SILENT_BLOCKS_NEEDED && !this.reportedSilent) {
                this.reportedSilent = true;
                this.ringing = false;
                this.port.postMessage({ silent: true });
            }
        } else {
            this.silentBlocks = 0;
        }
    }

    processFm(out, parameters) {
        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const alt = readAlt(this, parameters);

        if (this.prevGate < 0.0001 && gate0 >= 0.0001) {
            this.carrierPhase = 0;
            this.modulatorPhase = 0;
            this.subPhase = 0;
            this.fmPrevSample = 0;
            this.fmCarrierFir = 0;
            this.fmSubFir = 0;
            this.lp = 0;
        }
        this.prevGate = gate0;

        if (gate0 < 1e-5 && gateArr.length <= 1 && Math.abs(this.lp) < 1e-4 && this.gateSmooth < 1e-4) {
            out.fill(0);
            return true;
        }

        const ratioSemis = interpolateLut(FM_RATIO_LUT, harmonics, 128);
        const feedback = 2 * morph - 1;
        const sr = sampleRate;
        const slewUp = gateSlewCoeff(GATE_SLEW_UP_SEC);
        const slewDown = gateSlewCoeff(GATE_SLEW_DOWN_SEC);
        let carrierPhase = this.carrierPhase >>> 0;
        let modulatorPhase = this.modulatorPhase >>> 0;
        let subPhase = this.subPhase >>> 0;
        let prev = this.fmPrevSample;
        let carrierFirHead = this.fmCarrierFir || 0;
        let subFirHead = this.fmSubFir || 0;
        let lp = this.lp;
        let gateSm = this.gateSmooth;

        for (let i = 0; i < out.length; i++) {
            const f0 = freqArr.length > 1 ? freqArr[i] : freqArr[0];
            const det = detuneArr.length > 1 ? detuneArr[i] : detuneArr[0];
            const gate = gateArr.length > 1 ? gateArr[i] : gate0;
            const hz = Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
            // Plaits: note = parameters.note - 24 (4× OS), then modulator_note = note + ratio
            const midiNote = 69 + 12 * Math.log2(Math.max(1e-6, hz / 440));
            const modNoteOs = (midiNote - 24) + ratioSemis;
            let hfTaming = 1 - (modNoteOs - 72) * 0.025;
            hfTaming = clamp01(hfTaming);
            hfTaming *= hfTaming;
            const amount = 2 * timbre * timbre * hfTaming;
            const phaseFeedback = feedback < 0 ? 0.5 * feedback * feedback : 0;
            const modulatorFb = feedback > 0 ? 0.25 * feedback * feedback : 0;

            // Frequency at oversampled rate (Plaits NoteToFrequency(note - 24))
            const carrierHzOs = Math.min(sr * 0.5, hz / FM_OS);
            const modHzOs = Math.min(sr * 0.5, carrierHzOs * Math.pow(2, ratioSemis / 12));
            const carrierInc = Math.floor(MAX_U32 * (carrierHzOs / sr)) >>> 0;
            const modFreqPerOs = modHzOs / sr;

            let carrierFirTail = 0;
            let subFirTail = 0;
            for (let j = 0; j < FM_OS; j++) {
                const modInc = Math.floor(MAX_U32 * modFreqPerOs * (1 + prev * phaseFeedback)) >>> 0;
                modulatorPhase = (modulatorPhase + modInc) >>> 0;
                carrierPhase = (carrierPhase + carrierInc) >>> 0;
                subPhase = (subPhase + (carrierInc >>> 1)) >>> 0;
                const modulator = sinePm(modulatorPhase, modulatorFb * prev);
                const carrier = sinePm(carrierPhase, amount * modulator);
                const sub = sinePm(subPhase, amount * carrier * 0.25);
                prev += 0.05 * (carrier - prev);
                // Plaits Downsampler::Accumulate
                carrierFirHead += carrier * FM_FIR[3 - (j & 3)];
                carrierFirTail += carrier * FM_FIR[j & 3];
                subFirHead += sub * FM_FIR[3 - (j & 3)];
                subFirTail += sub * FM_FIR[j & 3];
            }
            const carrierOut = carrierFirHead;
            const subOut = subFirHead;
            carrierFirHead = carrierFirTail;
            subFirHead = subFirTail;
            // No extra output LP (Plaits OUT has none). Soft-mix AUX sub into mono.
            const s = alt ? subOut : carrierOut;
            const slew = gate >= gateSm ? slewUp : slewDown;
            gateSm += slew * (gate - gateSm);
            if (gateSm < 1e-5) {
                lp *= 0.92;
                out[i] = lp * gateSm;
            } else {
                lp = s; // track level for gate early-out only
                out[i] = s * gateSm;
            }
        }

        this.carrierPhase = carrierPhase;
        this.modulatorPhase = modulatorPhase;
        this.subPhase = subPhase;
        this.fmPrevSample = prev;
        this.fmCarrierFir = carrierFirHead;
        this.fmSubFir = subFirHead;
        this.lp = lp;
        this.gateSmooth = gateSm;
        return true;
    }

    processWavetable(out, parameters) {
        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const bankParam = parameters.bank[0] ?? -1;
        const tables = this.tables;

        if (!tables) {
            out.fill(0);
            this.prevGate = gate0;
            return true;
        }

        // Plaits: timbre→x, morph→y, harmonics→z (bank scan)
        this.xPre += 0.2 * (timbre * 6.9999 - this.xPre);
        this.yPre += 0.2 * (morph * 6.9999 - this.yPre);
        this.zPre += 0.05 * (harmonics * 6.9999 - this.zPre);

        let x = this.xPre;
        let y = this.yPre;
        let z = this.zPre;

        let zIntegral;
        let zFractional;
        if (bankParam >= 0) {
            zIntegral = Math.max(0, Math.min(NUM_BANKS - 1, Math.round(bankParam)));
            zFractional = 0;
            z = zIntegral;
        } else {
            zIntegral = Math.floor(z);
            zFractional = z - zIntegral;
        }

        // Quantization when scanning into reverse banks (z > 3)
        const quantization = constrain(z - 3, 0, 1);
        const f0Est = Math.max(1, (freqArr[0] ?? 440)) / sampleRate;
        const lpCoefficient = constrain(
            2 * f0Est * (4 - 3 * quantization),
            0.01,
            0.1
        );

        let xIntegral = Math.floor(x);
        let xFractional = x - xIntegral;
        let yIntegral = Math.floor(y);
        let yFractional = y - yIntegral;

        // Snap fractions when quantized (Plaits Clamp)
        const clampFrac = (frac, amount) => {
            let t = frac - 0.5;
            t *= amount;
            t = constrain(t, -0.5, 0.5);
            return t + 0.5;
        };
        xFractional += quantization * (clampFrac(xFractional, 16) - xFractional);
        yFractional += quantization * (clampFrac(yFractional, 16) - yFractional);
        if (bankParam < 0) {
            zFractional += quantization * (clampFrac(zFractional, 16) - zFractional);
        }

        x = xIntegral + xFractional;
        y = yIntegral + yFractional;
        z = zIntegral + zFractional;

        // Fold z for reverse banks
        let z0 = Math.floor(z);
        let z1 = z0 + 1;
        const zf = z - z0;
        if (z0 >= 4) z0 = 7 - z0;
        if (z1 >= 4) z1 = 7 - z1;
        z0 = constrain(z0, 0, NUM_BANKS - 1);
        z1 = constrain(z1, 0, NUM_BANKS - 1);
        const bank0 = tables[z0];
        const bank1 = tables[z1];

        xIntegral = Math.floor(x);
        xFractional = x - xIntegral;
        yIntegral = Math.floor(y);
        yFractional = y - yIntegral;
        const x0 = constrain(xIntegral, 0, GRID - 1);
        const x1 = constrain(xIntegral + 1, 0, GRID - 1);
        const y0 = constrain(yIntegral, 0, GRID - 1);
        const y1 = constrain(yIntegral + 1, 0, GRID - 1);
        // wave index = x + y*8 (Plaits ReadWave)
        const w00 = y0 * GRID + x0;
        const w10 = y0 * GRID + x1;
        const w01 = y1 * GRID + x0;
        const w11 = y1 * GRID + x1;
        const xf = xFractional;
        const yf = yFractional;

        if (this.prevGate < 0.0001 && gate0 >= 0.0001) {
            this.phase = findZeroCrossingPhase(bank0, bank1, zf, w00, w10, w01, w11, xf, yf);
            this.lp = 0;
            this.gateSmooth = 0;
            this.diff.Init();
        }
        this.prevGate = gate0;

        if (gate0 < 1e-5 && gateArr.length <= 1 && Math.abs(this.lp) < 1e-4 && this.gateSmooth < 1e-4) {
            out.fill(0);
            return true;
        }

        const sr = sampleRate;
        const slewUp = gateSlewCoeff(GATE_SLEW_UP_SEC);
        const slewDown = gateSlewCoeff(GATE_SLEW_DOWN_SEC);
        let phase = this.phase;
        let lp = this.lp;
        let gateSm = this.gateSmooth;
        let xLp = this.xLp;
        let yLp = this.yLp;
        let zLp = this.zLp;

        for (let i = 0; i < out.length; i++) {
            const fHz = freqArr.length > 1 ? freqArr[i] : freqArr[0];
            const det = detuneArr.length > 1 ? detuneArr[i] : detuneArr[0];
            const gate = gateArr.length > 1 ? gateArr[i] : gate0;
            const hz = Math.max(1, Math.min(14000, fHz * Math.pow(2, det / 1200)));
            const f0 = hz / sr;

            xLp += lpCoefficient * (x - xLp);
            yLp += lpCoefficient * (y - yLp);
            zLp += lpCoefficient * (z - zLp);

            // Recompute indices from smoothed morph (cheap: use block-level indices)
            phase += f0;
            if (phase >= 1) phase -= Math.floor(phase);

            let s;
            if (USE_INTEGRATED_WAVETABLES) {
                const mix = blendSampleHermiteZ(bank0, bank1, zf, w00, w10, w01, w11, xf, yf, phase);
                const cutoff = Math.min(WAVE_SIZE * f0, 1);
                // compensate integrate_wave scale of 4/WAVE_SIZE (Plaits wavetable_engine)
                const gain = Math.max(0.05, (0.95 - f0) * (WAVE_SIZE / 4));
                s = this.diff.Process(cutoff, mix) * gain;
                lp = s; // track level for gate early-out; no extra LP (Plaits engine has none)
            } else {
                s = blendSample(bank0, w00, w10, w01, w11, xf, yf, phase);
                if (zf > 0) {
                    const sB = blendSample(bank1, w00, w10, w01, w11, xf, yf, phase);
                    s = lerp(s, sB, zf);
                }
                const cutoff = Math.min(1, WAVE_SIZE * 0.35 * f0);
                lp += cutoff * (s - lp);
                s = lp;
            }

            const slew = gate >= gateSm ? slewUp : slewDown;
            gateSm += slew * (gate - gateSm);
            if (gateSm < 1e-5) {
                lp *= 0.92;
                out[i] = lp * gateSm;
            } else {
                out[i] = s * gateSm;
            }
        }

        this.phase = phase;
        this.lp = lp;
        this.gateSmooth = gateSm;
        this.xLp = xLp;
        this.yLp = yLp;
        this.zLp = zLp;
        return true;
    }

    processWaveshaper(out, parameters) {
        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const luts = this.wsLuts;

        if (!luts) {
            out.fill(0);
            this.prevGate = gate0;
            return true;
        }

        if (this.prevGate < 0.0001 && gate0 >= 0.0001) {
            this.slopePhase = 0;
            this.triPhase = 0;
            this.lp = 0;
            this.gateSmooth = 0;
        }
        this.prevGate = gate0;

        if (gate0 < 1e-5 && gateArr.length <= 1 && Math.abs(this.lp) < 1e-4 && this.gateSmooth < 1e-4) {
            out.fill(0);
            return true;
        }

        const sr = sampleRate;
        const slewUp = gateSlewCoeff(GATE_SLEW_UP_SEC);
        const slewDown = gateSlewCoeff(GATE_SLEW_DOWN_SEC);
        const pw = morph * 0.45 + 0.5;
        let slopePhase = this.slopePhase;
        let triPhase = this.triPhase;
        let prevShape = this.prevShape;
        let prevWfGain = this.prevWfGain;
        let prevOvertone = this.prevOvertone;
        let lp = this.lp;
        let gateSm = this.gateSmooth;
        const alt = readAlt(this, parameters);
        if (!this.wsAux || this.wsAux.length !== out.length) this.wsAux = new Float32Array(out.length);
        const aux = this.wsAux;

        // Block-level tame using first sample freq
        const hz0 = this.noteHz(parameters, 0);
        const f00 = hz0 / sr;
        const slopeAmt = 3 + Math.abs(morph - 0.5) * 5;
        const shapeAmount = Math.abs(harmonics - 0.5) * 2;
        const shapeAtt = Tame(f00, slopeAmt, 16);
        const wfGainAtt = Tame(f00, slopeAmt * (3 + shapeAmount * shapeAtt * 5), 12);
        const shapeTarget = 0.5 + (harmonics - 0.5) * shapeAtt;
        const wfGainTarget = 0.03 + 0.46 * timbre * wfGainAtt;
        const overtoneGain = timbre * (2 - timbre);
        const overtoneTarget = overtoneGain * (2 - overtoneGain);
        const shapeStep = (shapeTarget - prevShape) / out.length;
        const wfStep = (wfGainTarget - prevWfGain) / out.length;
        const ovStep = (overtoneTarget - prevOvertone) / out.length;

        const ws = luts.ws;
        const fold = luts.fold;
        const fold2 = luts.fold2;

        for (let i = 0; i < out.length; i++) {
            const hz = this.noteHz(parameters, i);
            const gate = gateArr.length > 1 ? gateArr[i] : gate0;
            const f0 = Math.min(0.25, hz / sr);

            const sl = slopeOscNext(slopePhase, f0, pw);
            slopePhase = sl.phase;
            const slopeSig = sl.s;
            const tri = slopeOscNext(triPhase, f0, 0.5);
            triPhase = tri.phase;

            prevShape += shapeStep;
            prevWfGain += wfStep;
            prevOvertone += ovStep;

            let shape = prevShape * 3.9999;
            let shapeI = Math.floor(shape);
            const shapeF = shape - shapeI;
            shapeI = constrain(shapeI, 0, 4);
            const shape1 = ws[shapeI];
            const shape2 = ws[shapeI + 1];

            // ws_index = 127 * out + 128 → [0..255]
            let wsIndex = 127 * slopeSig + 128;
            let wsI = Math.floor(wsIndex) & 255;
            const wsF = wsIndex - Math.floor(wsIndex);
            const x0 = shape1[wsI];
            const x1 = shape1[wsI + 1];
            const xx = x0 + (x1 - x0) * wsF;
            const y0 = shape2[wsI];
            const y1 = shape2[wsI + 1];
            const yy = y0 + (y1 - y0) * wsF;
            const mix = xx + (yy - xx) * shapeF;

            const index = mix * prevWfGain + 0.5;
            const folded = interpolateHermite(fold, index, 512);
            const folded2 = fold2 ? -interpolateHermite(fold2, index, 512) : -folded;
            const sine = Math.sin((tri.s * 0.25 + 0.5) * Math.PI * 2);
            out[i] = folded;
            aux[i] = sine + (folded2 - sine) * prevOvertone;

            const slew = gate >= gateSm ? slewUp : slewDown;
            gateSm += slew * (gate - gateSm);
            const raw = alt ? aux[i] : out[i];
            if (gateSm < 1e-5) {
                lp *= 0.92;
                out[i] = lp * gateSm;
            } else {
                lp = raw;
                out[i] = raw * gateSm;
            }
        }

        this.slopePhase = slopePhase;
        this.triPhase = triPhase;
        this.prevShape = prevShape;
        this.prevWfGain = prevWfGain;
        this.prevOvertone = prevOvertone;
        this.lp = lp;
        this.gateSmooth = gateSm;
        return true;
    }

    /** One sample of SVF bandpass (Chamberlin-ish / Plaits ResonatorSvf lite). */
    modalModeProcess(m, f, q, a, input) {
        // f = normalized freq, q = resonance coefficient
        const g = Math.tan(Math.PI * Math.min(0.49, f));
        const k = 1 / Math.max(0.5, q);
        let s1 = this.modalBpS1[m];
        let s2 = this.modalBpS2[m];
        const hp = (input - (k + g) * s1 - s2) / (1 + g * (k + g));
        const bp = g * hp + s1;
        s1 = g * hp + bp;
        const lp = g * bp + s2;
        s2 = g * bp + lp;
        this.modalBpS1[m] = s1;
        this.modalBpS2[m] = s2;
        return bp * a;
    }

    processModal(out, parameters) {
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5); // brightness
        const morph = clamp01(parameters.morphY[0] ?? 0.5); // damping
        const structure = clamp01(parameters.harmonics[0] ?? 0.5);
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        const gateHigh = gate0 >= 0.0001;
        const trigPatched = readTrigPatched(this, parameters);
        const sustain = !trigPatched && gateHigh;

        if (rising) {
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
            this.modalBpS1.fill(0);
            this.modalBpS2.fill(0);
            this.excLp = 0;
            this.excBp = 0;
        }
        if (sustain) {
            this.ringing = true;
            this.reportedSilent = false;
        }
        this.prevGate = gate0;

        if (!this.ringing && !gateHigh) {
            out.fill(0);
            return true;
        }

        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const f0 = Math.min(0.25, hz / sr);
        const brightness = timbre;
        const damping = morph;

        // Stiffness from lut or default linear
        let stiffness;
        if (this.wsLuts && this.wsLuts.stiffness) {
            stiffness = interpolateLut(this.wsLuts.stiffness, structure, 64);
        } else {
            stiffness = structure * structure * 0.5;
        }

        // Mode frequencies / Q / amplitudes (resonator lite)
        let harmonic = f0;
        let stretch = 1;
        let stiff = stiffness;
        let qSqrt = semitonesToRatio(damping * 79.7);
        let q = 500 * qSqrt * qSqrt;
        let bright = brightness * (1 - structure * 0.3) * (1 - damping * 0.3);
        const qLoss = bright * (2 - bright) * 0.85 + 0.15;
        // Cosine-ish amplitudes from position ~0.25
        for (let m = 0; m < MODAL_NUM_MODES; m++) {
            let mf = harmonic * stretch;
            if (mf >= 0.499) mf = 0.499;
            const atten = 1 - mf * 2;
            this.modalF[m] = mf;
            this.modalQ[m] = 1 + mf * q;
            this.modalA[m] = 0.25 * Math.cos(m * 0.5) * atten;
            stretch += stiff;
            if (stiff < 0) stiff *= 0.93;
            else stiff *= 0.98;
            harmonic += f0;
            q *= qLoss;
        }

        const density = brightness * brightness;
        const dustF = 0.00005 + 0.99995 * density * density;
        const range = sustain ? 36 : 60;
        const excFBase = sustain ? 4 * f0 : 2 * f0;
        const cutoff = Math.min(
            excFBase * semitonesToRatio((brightness * (2 - brightness) - 0.5) * range),
            0.499
        );
        const excQ = sustain ? 0.7 : 1.5;
        const strike = trigPatched && rising;

        let peak = 0;
        for (let i = 0; i < out.length; i++) {
            let exc = 0;
            if (sustain) {
                const u = (this.nextNoise() + 1) * 0.5;
                if (u < dustF) {
                    exc = (4 - dustF * 3) * (0.5 + 0.5 * brightness);
                }
            } else if (strike && i === 0) {
                const attenuation = 1 - damping * 0.5;
                const amplitude = (0.12 + 0.08) * attenuation;
                exc = amplitude * semitonesToRatio(cutoff * cutoff * 24) / Math.max(1e-4, cutoff);
            }

            // Excitation LPF (one-pole approx of SVF LP)
            const g = Math.min(1, cutoff * 2);
            this.excLp += g * (exc - this.excLp);
            const filtered = this.excLp / Math.max(0.5, excQ);

            let acc = 0;
            for (let m = 0; m < MODAL_NUM_MODES; m++) {
                acc += this.modalModeProcess(
                    m,
                    this.modalF[m],
                    this.modalQ[m],
                    this.modalA[m],
                    filtered
                );
            }
            const s = constrain(acc, -1.5, 1.5);
            out[i] = s;
            const a = Math.abs(s);
            if (a > peak) peak = a;
        }

        this.checkSilence(peak, gateHigh);
        return true;
    }

    processString(out, parameters) {
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        const gateHigh = gate0 >= 0.0001;
        const trigPatched = readTrigPatched(this, parameters);
        const sustain = !trigPatched && gateHigh;

        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const f0 = Math.min(0.25, Math.max(1 / (STRING_DELAY_SIZE - 4), hz / sr));

        if (rising && trigPatched) {
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
            this.delayLine.fill(0);
            this.writePos = 0;
            this.dampLp = 0;
            this.noiseLp = 0;
            this.dcX = 0;
            this.dcY = 0;
            this.curvedBridge = 0;
            this.remainingNoise = Math.min(STRING_DELAY_SIZE - 4, Math.max(4, Math.floor(1 / f0)));
            this.srcPhase = 1;
        }
        if (sustain) {
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }
        this.prevGate = gate0;

        if (!this.ringing && !gateHigh) {
            out.fill(0);
            return true;
        }

        // harmonics → nonlinearity (−bridge .. +dispersion), centered
        const nonLin = harmonics * 2 - 1;
        const brightness = timbre * timbre;
        const damping = morph;

        let delay = 1 / f0;
        delay = constrain(delay, 4, STRING_DELAY_SIZE - 4);

        let dampingCutoff = Math.min(12 + damping * damping * 60 + brightness * 24, 84);
        let dampingF = Math.min(f0 * semitonesToRatio(dampingCutoff), 0.499);
        if (damping >= 0.95) {
            const toInf = 20 * (damping - 0.95);
            dampingF += toInf * (0.4999 - dampingF);
        }

        let delaySm = this.delaySmooth;
        const delayTarget = delay;
        const delayStep = (delayTarget - delaySm) / out.length;
        let writePos = this.writePos;
        let remaining = this.remainingNoise;
        let dampLp = this.dampLp;
        let noiseLp = this.noiseLp;
        let dcX = this.dcX;
        let dcY = this.dcY;
        let curvedBridge = this.curvedBridge;
        let out0 = this.out0;
        let out1 = this.out1;
        let srcPhase = this.srcPhase;
        let peak = 0;
        const line = this.delayLine;
        const bridgeCurving = Math.abs(Math.min(0, nonLin));
        const bridgeAmt = bridgeCurving * bridgeCurving * 0.01;
        const noiseAmtSqrt = nonLin > 0.75 ? 4 * (nonLin - 0.75) : 0;
        const noiseAmt = noiseAmtSqrt * noiseAmtSqrt * 0.1;
        const noiseFilter = 0.06 + 0.94 * brightness * brightness;

        for (let i = 0; i < out.length; i++) {
            delaySm += delayStep;
            let input = 0;
            if (remaining > 0 && trigPatched) {
                remaining--;
                const n = this.nextNoise();
                noiseLp += Math.min(1, 0.1 + brightness * 0.8) * (n - noiseLp);
                input = noiseLp * (0.5 + 0.5 * brightness);
            } else if (sustain) {
                const dustF = 0.00005 + 0.99995 * brightness * brightness;
                if ((this.nextNoise() + 1) * 0.5 < dustF) {
                    input = this.nextNoise() * (8 - dustF * 6) * 0.25;
                }
            }

            srcPhase += 1;
            if (srcPhase > 1) {
                srcPhase -= 1;
                let d = delaySm;
                if (nonLin > 0) {
                    const noise = this.nextNoise() * 0.5;
                    this.dispersionNoise += noiseFilter * (noise - this.dispersionNoise);
                    d *= 1 + this.dispersionNoise * noiseAmt;
                } else {
                    d *= 1 - curvedBridge * bridgeAmt;
                }
                d = constrain(d, 4, STRING_DELAY_SIZE - 4);
                let s = delayReadHermite(line, writePos, d);
                if (nonLin <= 0) {
                    const value = Math.abs(s) - 0.025;
                    const sign = s > 0 ? 1 : -1.5;
                    curvedBridge = (Math.abs(value) + value) * sign;
                }
                s += input;
                s = constrain(s, -20, 20);
                // DC block: y[n] = x[n] - x[n-1] + R * y[n-1]
                dcY = s - dcX + 0.995 * dcY;
                dcX = s;
                s = dcY;
                // Damping LP
                dampLp += dampingF * (s - dampLp);
                s = dampLp;
                line[writePos] = s;
                writePos = (writePos + 1) % STRING_DELAY_SIZE;
                out1 = out0;
                out0 = s;
            }
            const sOut = lerp(out1, out0, srcPhase);
            out[i] = sOut;
            const a = Math.abs(sOut);
            if (a > peak) peak = a;
        }

        this.writePos = writePos;
        this.remainingNoise = remaining;
        this.dampLp = dampLp;
        this.noiseLp = noiseLp;
        this.dcX = dcX;
        this.dcY = dcY;
        this.curvedBridge = curvedBridge;
        this.out0 = out0;
        this.out1 = out1;
        this.srcPhase = srcPhase;
        this.delaySmooth = delaySm;
        this.checkSilence(peak, gateHigh);
        return true;
    }

    processBassDrum(out, parameters) {
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        const gateHigh = gate0 >= 0.0001;
        const alt = readAlt(this, parameters);
        const trigPatched = readTrigPatched(this, parameters);
        const sustain = !trigPatched && gateHigh;
        this.prevGate = gate0;

        if (rising || sustain) {
            if (rising) {
                this.bdAmpEnv = 1;
                this.bdFmEnv = 1;
                this.bdPhase = 0;
                this.bdToneLp = 0;
            }
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }

        if (!this.ringing) {
            out.fill(0);
            return true;
        }

        if (!this.drumAux || this.drumAux.length !== out.length) this.drumAux = new Float32Array(out.length);
        const aux = this.drumAux;
        const sr = sampleRate;
        const baseHz = this.noteHz(parameters, 0);
        const ampDec = Math.exp(-1 / (sr * (0.05 + morph * morph * 0.6)));
        const fmDec = Math.exp(-1 / (sr * (0.008 + morph * 0.04)));
        const fmAmt = Math.min(harmonics * 4, 1);
        const toneF = Math.min(1, 4 * (baseHz / sr) * semitonesToRatio(timbre * 108));
        const dirtiness = Math.max(1 - 8 * (baseHz / sr), 0) * Math.min(harmonics * 2, 1);
        const velocity = clamp01(parameters.velocity?.[0] ?? 0.8);
        const sustainGain = velocity * morph;

        let phase = this.bdPhase;
        let ampEnv = this.bdAmpEnv;
        let fmEnv = this.bdFmEnv;
        let toneLp = this.bdToneLp;
        let phaseNoise = this.bdPhaseNoise || 0;
        let peak = 0;

        for (let i = 0; i < out.length; i++) {
            const f0 = Math.min(0.4, baseHz / sr);
            if (sustain) {
                phase += f0;
                if (phase >= 1) phase -= 1;
                const body = softSine(phase);
                toneLp += toneF * (body * sustainGain - toneLp);
                out[i] = toneLp;
                phaseNoise += 0.002 * (Math.random() - 0.5 - phaseNoise);
                let p = phase + phaseNoise * dirtiness;
                p -= Math.floor(p);
                const tri = (p < 0.5 ? p : 1 - p) * 4 - 1;
                const dist = 2 * tri / (1 + Math.abs(tri));
                const clean = softSine(p + 0.75);
                aux[i] = -(dist + (1 - dirtiness) * (clean - dist)) * sustainGain * 0.7;
            } else {
                const pitch = baseHz * (1 + fmEnv * fmAmt * 3);
                const ff = Math.min(0.4, pitch / sr);
                phase += ff;
                if (phase >= 1) phase -= 1;
                const body = softSine(phase);
                const click = fmEnv * fmEnv * (this.nextNoise() * 0.15);
                let s = (body * ampEnv + click) * (0.6 + 0.4 * timbre);
                toneLp += toneF * (s - toneLp);
                out[i] = toneLp;
                phaseNoise += 0.002 * (Math.random() - 0.5 - phaseNoise);
                let p = phase + phaseNoise * dirtiness;
                p -= Math.floor(p);
                const tri = (p < 0.5 ? p : 1 - p) * 4 - 1;
                const dist = 2 * tri / (1 + Math.abs(tri));
                aux[i] = -(dist * ampEnv + click) * 0.7;
                ampEnv *= ampDec;
                fmEnv *= fmDec;
            }
            const a = Math.abs(alt ? aux[i] : out[i]);
            if (a > peak) peak = a;
        }

        emitAlt(out, out, aux, alt);
        this.bdPhase = phase;
        this.bdAmpEnv = ampEnv;
        this.bdFmEnv = fmEnv;
        this.bdToneLp = toneLp;
        this.bdPhaseNoise = phaseNoise;

        if (!sustain && ampEnv < 1e-4) {
            this.ringing = false;
            peak = 0;
        }
        this.checkSilence(peak, sustain);
        return true;
    }

    processSnare(out, parameters) {
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        const alt = readAlt(this, parameters);
        this.prevGate = gate0;

        if (rising) {
            this.snToneEnv = 1;
            this.snNoiseEnv = 1;
            this.snPhase = 0;
            this.snAuxPhase = 0;
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }

        if (!this.ringing) {
            out.fill(0);
            return true;
        }

        if (!this.drumAux || this.drumAux.length !== out.length) this.drumAux = new Float32Array(out.length);
        const aux = this.drumAux;
        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const toneDec = Math.exp(-1 / (sr * (0.03 + timbre * 0.25)));
        const noiseDec = Math.exp(-1 / (sr * (0.02 + morph * 0.35)));
        const balance = harmonics;

        let phase = this.snPhase;
        let auxPhase = this.snAuxPhase || 0;
        let toneEnv = this.snToneEnv;
        let noiseEnv = this.snNoiseEnv;
        let peak = 0;

        for (let i = 0; i < out.length; i++) {
            const f0 = Math.min(0.4, hz / sr);
            phase += f0;
            if (phase >= 1) phase -= 1;
            auxPhase += f0 * 1.5;
            if (auxPhase >= 1) auxPhase -= 1;
            const tone = softSine(phase) * toneEnv;
            let n = this.nextNoise();
            n = n * (0.5 + 0.5 * timbre) + softSine((phase * 2.3) % 1) * 0.2 * noiseEnv;
            const noise = n * noiseEnv;
            out[i] = (tone * (1 - balance) + noise * balance) * 0.9;
            const synTone = (softSine(phase) + 0.6 * softSine(auxPhase)) * toneEnv;
            aux[i] = (synTone * 0.35 + noise * 0.85) * 0.85;
            const a = Math.abs(alt ? aux[i] : out[i]);
            if (a > peak) peak = a;
            toneEnv *= toneDec;
            noiseEnv *= noiseDec;
        }

        emitAlt(out, out, aux, alt);
        this.snPhase = phase;
        this.snAuxPhase = auxPhase;
        this.snToneEnv = toneEnv;
        this.snNoiseEnv = noiseEnv;

        if (toneEnv < 1e-4 && noiseEnv < 1e-4) {
            this.ringing = false;
            peak = 0;
        }
        this.checkSilence(peak, false);
        return true;
    }

    processHihat(out, parameters) {
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        const alt = readAlt(this, parameters);
        this.prevGate = gate0;

        if (rising) {
            this.hhEnv = 1;
            this.hhPhases.fill(0);
            this.hhHp = 0;
            this.hhAuxHp = 0;
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }

        if (!this.ringing) {
            out.fill(0);
            return true;
        }

        if (!this.drumAux || this.drumAux.length !== out.length) this.drumAux = new Float32Array(out.length);
        const aux = this.drumAux;
        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const decay = Math.exp(-1 / (sr * (0.015 + morph * 0.2)));
        const ratios = [
            1,
            1.34 + harmonics * 0.2,
            1.54 + harmonics * 0.3,
            1.98,
            2.61 + harmonics * 0.4,
            3.12 + harmonics * 0.5,
        ];
        const baseF = Math.max(hz, 40) / sr;

        let env = this.hhEnv;
        let hp = this.hhHp;
        let auxHp = this.hhAuxHp || 0;
        let peak = 0;
        const phases = this.hhPhases;

        for (let i = 0; i < out.length; i++) {
            let acc = 0;
            for (let k = 0; k < 6; k++) {
                phases[k] += baseF * ratios[k];
                if (phases[k] >= 1) phases[k] -= 1;
                acc += phases[k] < 0.5 ? 1 : -1;
            }
            acc *= (1 / 6) * env;
            const hpCoeff = 0.05 + timbre * 0.4;
            hp += hpCoeff * (acc - hp);
            out[i] = (acc - hp) * (0.7 + 0.5 * harmonics);
            const n = this.nextNoise() * env;
            const auxHpCoeff = 0.12 + timbre * 0.5;
            auxHp += auxHpCoeff * (n - auxHp);
            aux[i] = (n - auxHp) * (0.8 + 0.4 * harmonics);
            const a = Math.abs(alt ? aux[i] : out[i]);
            if (a > peak) peak = a;
            env *= decay;
        }

        emitAlt(out, out, aux, alt);
        this.hhEnv = env;
        this.hhHp = hp;
        this.hhAuxHp = auxHp;

        if (env < 1e-4) {
            this.ringing = false;
            peak = 0;
        }
        this.checkSilence(peak, false);
        return true;
    }

    processFm6(out, parameters) {
        if (!this.fm6Voice) {
            this.fm6Voice = new Fm6Voice(sampleRate);
            this.fm6Lfo = new Fm6Lfo(sampleRate);
        }
        const patches = this.fm6Patches;
        if (!patches || !patches.length) {
            out.fill(0);
            this.prevGate = parameters.gate[0] ?? 0;
            return true;
        }

        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const f0 = freqArr[0] ?? 440;
        const det = detuneArr[0] ?? 0;
        const hz = Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
        const midiNote = 69 + 12 * Math.log2(Math.max(1e-6, hz / 440));

        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        // Plaits HysteresisQuantizer2(32) ≈ floor(harmonics * 1.02 * 32) clamped
        let patchIndex = Math.floor(harmonics * 1.02 * 32);
        if (patchIndex > 31) patchIndex = 31;
        if (patchIndex < 0) patchIndex = 0;

        if (patchIndex !== this.fm6PatchIndex) {
            this.fm6PatchIndex = patchIndex;
            const patch = patches[patchIndex];
            this.fm6Voice.setPatch(patch);
            this.fm6Lfo.set(patch.modulations);
        }

        const gateHigh = gate0 >= 0.0001;
        const trigPatched = readTrigPatched(this, parameters);
        const sustain = !trigPatched && gateHigh;
        if (trigPatched && this.prevGate < 0.0001 && gateHigh) {
            this.fm6Lfo.reset();
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
            this.fm6ClickFade = 0;
        }
        if (sustain) {
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }
        this.prevGate = gate0;

        const patch = patches[this.fm6PatchIndex];
        const transpose = patch ? (patch.transpose - 24) : 0;
        const brightness = clamp01(parameters.morphX[0] ?? 0.5);
        const envelopeControl = clamp01(parameters.morphY[0] ?? 0.5);
        const velocity = clamp01(parameters.velocity?.[0] ?? 0.8);

        if (sustain) {
            this.fm6Lfo.scrub(2 * sampleRate * envelopeControl);
        } else {
            this.fm6Lfo.step(out.length);
        }

        this.fm6Voice.render({
            sustain,
            gate: trigPatched && gateHigh,
            note: midiNote + transpose,
            velocity,
            brightness,
            envelopeControl,
            pitchMod: this.fm6Lfo.pitchMod(),
            ampMod: this.fm6Lfo.ampMod(),
        }, out);

        // Tiny click fade on attack (DX envelopes own amplitude — no VCA slew)
        let fade = this.fm6ClickFade;
        if (fade < 1) {
            const step = 1 / (sampleRate * 0.002);
            for (let i = 0; i < out.length; i++) {
                fade = Math.min(1, fade + step);
                out[i] *= fade;
            }
            this.fm6ClickFade = fade;
        }

        let peak = 0;
        for (let i = 0; i < out.length; i++) {
            const a = Math.abs(out[i]);
            if (a > peak) peak = a;
        }
        if (!gateHigh && peak < SILENT_PEAK) {
            // keep ringing until silent reporting frees the pool
        } else if (gateHigh) {
            this.ringing = true;
        }
        this.checkSilence(peak, gateHigh);
        return true;
    }

    process(_inputs, outputs, parameters) {
        const out = outputs[0]?.[0];
        if (!out) return true;

        const engine = this.engine;
        const meta = ENGINE_META[engine] || ENGINE_META.wavetable;
        const gate0 = parameters.gate[0] ?? 0;

        if (meta.triggered) {
            if (!this.ringing && gate0 < 0.0001) {
                out.fill(0);
                this.prevGate = gate0;
                return true;
            }
            switch (engine) {
                case 'fm6': return this.processFm6(out, parameters);
                case 'modal': return this.processModal(out, parameters);
                case 'string': return this.processString(out, parameters);
                case 'bass_drum': return this.processBassDrum(out, parameters);
                case 'snare': return this.processSnare(out, parameters);
                case 'hihat': return this.processHihat(out, parameters);
                default: out.fill(0); return true;
            }
        }

        switch (engine) {
            case 'fm': return this.processFm(out, parameters);
            case 'waveshaper': return this.processWaveshaper(out, parameters);
            case 'va': return this.processVa(out, parameters);
            case 'va_vcf': return this.processVaVcf(out, parameters);
            case 'additive': return this.processAdditive(out, parameters);
            case 'grain': return this.processGrain(out, parameters);
            case 'swarm': return this.processSwarm(out, parameters);
            case 'noise': return this.processNoise(out, parameters);
            case 'particle': return this.processParticle(out, parameters);
            case 'pd': return this.processPd(out, parameters);
            case 'terrain': return this.processTerrain(out, parameters);
            case 'string_machine': return this.processStringMachine(out, parameters);
            case 'chiptune': return this.processChiptune(out, parameters);
            case 'chord': return this.processChord(out, parameters);
            case 'speech': return this.processSpeech(out, parameters);
            case 'wavetable':
            default: return this.processWavetable(out, parameters);
        }
    }
}

installExtraEngines(PlaitsEngineProcessor.prototype);
installSpeechEngine(PlaitsEngineProcessor.prototype);
registerProcessor('plaits-engine-processor', PlaitsEngineProcessor);
