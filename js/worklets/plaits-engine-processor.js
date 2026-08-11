// Copyright 2016 Emilie Gillet / Mutable Instruments - Plaits DSP (MIT).
// Ported to JavaScript AudioWorklet for IngySynth OSC4 digital engines.
// See http://creativecommons.org/licenses/MIT/ for more information.
//
// Plaits FM LUTs (MIT, Copyright 2016 Emilie Gillet)
// From plaits/resources/lookup_tables.py - lut_fm_frequency_quantizer + sine
const FM_RATIO_LUT = new Float32Array([-12.00000000,-12.00000000,-12.00000000,-11.84000000,-11.84000000,-11.84000000,-11.11000000,-10.38000000,-9.65000000,-8.92000000,-8.19000000,-7.46000000,-6.73000000,-6.00000000,-6.00000000,-6.00000000,-5.54551161,-5.09102322,-4.63653483,-4.18204645,-4.18204645,-4.18204645,-3.65929064,-3.13653483,-2.61377903,-2.09102322,-1.56826742,-1.04551161,-0.52275581,0.00000000,0.00000000,0.00000000,0.16000000,0.16000000,0.16000000,0.89000000,1.62000000,2.35000000,3.08000000,3.81000000,4.54000000,5.27000000,6.00000000,6.00000000,6.00000000,6.45448839,6.90897678,7.36346517,7.81795355,7.81795355,7.81795355,8.28552993,8.75310631,9.22068269,9.68825906,9.68825906,9.68825906,10.26619430,10.84412953,11.42206477,12.00000000,12.00000000,12.00000000,12.16000000,12.16000000,12.16000000,12.62977500,13.09955001,13.56932501,14.03910002,14.03910002,14.03910002,14.90761987,15.77613972,16.64465957,17.51317942,17.51317942,17.51317942,18.00000000,18.00000000,18.00000000,18.50977500,19.01955001,19.01955001,19.01955001,19.81795355,19.81795355,19.81795355,20.66386428,21.50977500,21.50977500,21.50977500,22.13233125,22.75488750,23.37744375,24.00000000,24.00000000,24.00000000,24.50977500,25.01955001,25.01955001,25.01955001,25.47403840,25.92852679,26.38301517,26.83750356,26.83750356,26.83750356,27.35032035,27.86313714,27.86313714,27.86313714,28.39735285,28.93156857,29.46578428,30.00000000,30.00000000,30.00000000,30.75000000,31.50000000,32.25000000,33.00000000,33.75000000,34.50000000,35.25000000,36.00000000,36.00000000,36.00000000,36.00000000,36.00000000]);
const SINE_LUT = new Float32Array([0.00000000,0.01227154,0.02454123,0.03680722,0.04906767,0.06132074,0.07356456,0.08579731,0.09801714,0.11022221,0.12241068,0.13458071,0.14673047,0.15885814,0.17096189,0.18303989,0.19509032,0.20711138,0.21910124,0.23105811,0.24298018,0.25486566,0.26671276,0.27851969,0.29028468,0.30200595,0.31368174,0.32531029,0.33688985,0.34841868,0.35989504,0.37131719,0.38268343,0.39399204,0.40524131,0.41642956,0.42755509,0.43861624,0.44961133,0.46053871,0.47139674,0.48218377,0.49289819,0.50353838,0.51410274,0.52458968,0.53499762,0.54532499,0.55557023,0.56573181,0.57580819,0.58579786,0.59569930,0.60551104,0.61523159,0.62485949,0.63439328,0.64383154,0.65317284,0.66241578,0.67155895,0.68060100,0.68954054,0.69837625,0.70710678,0.71573083,0.72424708,0.73265427,0.74095113,0.74913639,0.75720885,0.76516727,0.77301045,0.78073723,0.78834643,0.79583690,0.80320753,0.81045720,0.81758481,0.82458930,0.83146961,0.83822471,0.84485357,0.85135519,0.85772861,0.86397286,0.87008699,0.87607009,0.88192126,0.88763962,0.89322430,0.89867447,0.90398929,0.90916798,0.91420976,0.91911385,0.92387953,0.92850608,0.93299280,0.93733901,0.94154407,0.94560733,0.94952818,0.95330604,0.95694034,0.96043052,0.96377607,0.96697647,0.97003125,0.97293995,0.97570213,0.97831737,0.98078528,0.98310549,0.98527764,0.98730142,0.98917651,0.99090264,0.99247953,0.99390697,0.99518473,0.99631261,0.99729046,0.99811811,0.99879546,0.99932238,0.99969882,0.99992470,1.00000000,0.99992470,0.99969882,0.99932238,0.99879546,0.99811811,0.99729046,0.99631261,0.99518473,0.99390697,0.99247953,0.99090264,0.98917651,0.98730142,0.98527764,0.98310549,0.98078528,0.97831737,0.97570213,0.97293995,0.97003125,0.96697647,0.96377607,0.96043052,0.95694034,0.95330604,0.94952818,0.94560733,0.94154407,0.93733901,0.93299280,0.92850608,0.92387953,0.91911385,0.91420976,0.90916798,0.90398929,0.89867447,0.89322430,0.88763962,0.88192126,0.87607009,0.87008699,0.86397286,0.85772861,0.85135519,0.84485357,0.83822471,0.83146961,0.82458930,0.81758481,0.81045720,0.80320753,0.79583690,0.78834643,0.78073723,0.77301045,0.76516727,0.75720885,0.74913639,0.74095113,0.73265427,0.72424708,0.71573083,0.70710678,0.69837625,0.68954054,0.68060100,0.67155895,0.66241578,0.65317284,0.64383154,0.63439328,0.62485949,0.61523159,0.60551104,0.59569930,0.58579786,0.57580819,0.56573181,0.55557023,0.54532499,0.53499762,0.52458968,0.51410274,0.50353838,0.49289819,0.48218377,0.47139674,0.46053871,0.44961133,0.43861624,0.42755509,0.41642956,0.40524131,0.39399204,0.38268343,0.37131719,0.35989504,0.34841868,0.33688985,0.32531029,0.31368174,0.30200595,0.29028468,0.27851969,0.26671276,0.25486566,0.24298018,0.23105811,0.21910124,0.20711138,0.19509032,0.18303989,0.17096189,0.15885814,0.14673047,0.13458071,0.12241068,0.11022221,0.09801714,0.08579731,0.07356456,0.06132074,0.04906767,0.03680722,0.02454123,0.01227154,0.00000000,-0.01227154,-0.02454123,-0.03680722,-0.04906767,-0.06132074,-0.07356456,-0.08579731,-0.09801714,-0.11022221,-0.12241068,-0.13458071,-0.14673047,-0.15885814,-0.17096189,-0.18303989,-0.19509032,-0.20711138,-0.21910124,-0.23105811,-0.24298018,-0.25486566,-0.26671276,-0.27851969,-0.29028468,-0.30200595,-0.31368174,-0.32531029,-0.33688985,-0.34841868,-0.35989504,-0.37131719,-0.38268343,-0.39399204,-0.40524131,-0.41642956,-0.42755509,-0.43861624,-0.44961133,-0.46053871,-0.47139674,-0.48218377,-0.49289819,-0.50353838,-0.51410274,-0.52458968,-0.53499762,-0.54532499,-0.55557023,-0.56573181,-0.57580819,-0.58579786,-0.59569930,-0.60551104,-0.61523159,-0.62485949,-0.63439328,-0.64383154,-0.65317284,-0.66241578,-0.67155895,-0.68060100,-0.68954054,-0.69837625,-0.70710678,-0.71573083,-0.72424708,-0.73265427,-0.74095113,-0.74913639,-0.75720885,-0.76516727,-0.77301045,-0.78073723,-0.78834643,-0.79583690,-0.80320753,-0.81045720,-0.81758481,-0.82458930,-0.83146961,-0.83822471,-0.84485357,-0.85135519,-0.85772861,-0.86397286,-0.87008699,-0.87607009,-0.88192126,-0.88763962,-0.89322430,-0.89867447,-0.90398929,-0.90916798,-0.91420976,-0.91911385,-0.92387953,-0.92850608,-0.93299280,-0.93733901,-0.94154407,-0.94560733,-0.94952818,-0.95330604,-0.95694034,-0.96043052,-0.96377607,-0.96697647,-0.97003125,-0.97293995,-0.97570213,-0.97831737,-0.98078528,-0.98310549,-0.98527764,-0.98730142,-0.98917651,-0.99090264,-0.99247953,-0.99390697,-0.99518473,-0.99631261,-0.99729046,-0.99811811,-0.99879546,-0.99932238,-0.99969882,-0.99992470,-1.00000000,-0.99992470,-0.99969882,-0.99932238,-0.99879546,-0.99811811,-0.99729046,-0.99631261,-0.99518473,-0.99390697,-0.99247953,-0.99090264,-0.98917651,-0.98730142,-0.98527764,-0.98310549,-0.98078528,-0.97831737,-0.97570213,-0.97293995,-0.97003125,-0.96697647,-0.96377607,-0.96043052,-0.95694034,-0.95330604,-0.94952818,-0.94560733,-0.94154407,-0.93733901,-0.93299280,-0.92850608,-0.92387953,-0.91911385,-0.91420976,-0.90916798,-0.90398929,-0.89867447,-0.89322430,-0.88763962,-0.88192126,-0.87607009,-0.87008699,-0.86397286,-0.85772861,-0.85135519,-0.84485357,-0.83822471,-0.83146961,-0.82458930,-0.81758481,-0.81045720,-0.80320753,-0.79583690,-0.78834643,-0.78073723,-0.77301045,-0.76516727,-0.75720885,-0.74913639,-0.74095113,-0.73265427,-0.72424708,-0.71573083,-0.70710678,-0.69837625,-0.68954054,-0.68060100,-0.67155895,-0.66241578,-0.65317284,-0.64383154,-0.63439328,-0.62485949,-0.61523159,-0.60551104,-0.59569930,-0.58579786,-0.57580819,-0.56573181,-0.55557023,-0.54532499,-0.53499762,-0.52458968,-0.51410274,-0.50353838,-0.49289819,-0.48218377,-0.47139674,-0.46053871,-0.44961133,-0.43861624,-0.42755509,-0.41642956,-0.40524131,-0.39399204,-0.38268343,-0.37131719,-0.35989504,-0.34841868,-0.33688985,-0.32531029,-0.31368174,-0.30200595,-0.29028468,-0.27851969,-0.26671276,-0.25486566,-0.24298018,-0.23105811,-0.21910124,-0.20711138,-0.19509032,-0.18303989,-0.17096189,-0.15885814,-0.14673047,-0.13458071,-0.12241068,-0.11022221,-0.09801714,-0.08579731,-0.07356456,-0.06132074,-0.04906767,-0.03680722,-0.02454123,-0.01227154,-0.00000000]);

// Multi-engine OSC worklet - Mutable Instruments Plaits (MIT).
// Engines: wavetable, fm, waveshaper, modal, string, bass_drum, snare, hihat.

const WAVE_SIZE = 128;
const GRID = 8;
const NUM_WAVES = GRID * GRID;
const NUM_BANKS = 4;
const TABLES_BYTES = NUM_BANKS * NUM_WAVES * WAVE_SIZE * 4;
const FM_OS = 4;
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
    waveshaper: { triggered: false, tailSec: 0 },
    modal: { triggered: true, tailSec: 8 },
    string: { triggered: true, tailSec: 8 },
    bass_drum: { triggered: true, tailSec: 2 },
    snare: { triggered: true, tailSec: 2 },
    hihat: { triggered: true, tailSec: 2 },
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
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lp = 0;
        this.engine = 'wavetable';
        this.tables = null;
        this.wsLuts = null;
        this.prevGate = 0;
        this.gateSmooth = 0;

        // FM
        this.carrierPhase = 0;
        this.modulatorPhase = 0;
        this.subPhase = 0;
        this.fmPrevSample = 0;

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

        // RNG (LCG)
        this.rngState = 0x12345678 | 0;

        this.port.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg || typeof msg !== 'object') return;
            if (typeof msg.engine === 'string') this.engine = msg.engine;
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
            if (msg.reset && this.prevGate < 0.0001) {
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
        this.gateSmooth = 0;
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

        if (this.prevGate < 0.0001 && gate0 >= 0.0001) {
            this.carrierPhase = 0;
            this.modulatorPhase = 0;
            this.subPhase = 0;
            this.fmPrevSample = 0;
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
        let lp = this.lp;
        let gateSm = this.gateSmooth;

        for (let i = 0; i < out.length; i++) {
            const f0 = freqArr.length > 1 ? freqArr[i] : freqArr[0];
            const det = detuneArr.length > 1 ? detuneArr[i] : detuneArr[0];
            const gate = gateArr.length > 1 ? gateArr[i] : gate0;
            const hz = Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
            const carrierHz = hz;
            const modHz = Math.min(sr * 0.5, carrierHz * Math.pow(2, ratioSemis / 12));
            const modNote = 69 + 12 * Math.log2(Math.max(1e-6, modHz / 440));
            let hfTaming = 1 - (modNote - 72) * 0.025;
            hfTaming = clamp01(hfTaming);
            hfTaming *= hfTaming;
            const amount = 2 * timbre * timbre * hfTaming;
            const phaseFeedback = feedback < 0 ? 0.5 * feedback * feedback : 0;
            const modulatorFb = feedback > 0 ? 0.25 * feedback * feedback : 0;

            const carrierInc = Math.floor(MAX_U32 * (carrierHz / sr) / FM_OS) >>> 0;
            const modFreqPerOs = (modHz / sr) / FM_OS;

            let acc = 0;
            for (let j = 0; j < FM_OS; j++) {
                const modInc = Math.floor(MAX_U32 * modFreqPerOs * (1 + prev * phaseFeedback)) >>> 0;
                modulatorPhase = (modulatorPhase + modInc) >>> 0;
                carrierPhase = (carrierPhase + carrierInc) >>> 0;
                subPhase = (subPhase + (carrierInc >>> 1)) >>> 0;
                const modulator = sinePm(modulatorPhase, modulatorFb * prev);
                const carrier = sinePm(carrierPhase, amount * modulator);
                prev += 0.05 * (carrier - prev);
                acc += carrier;
            }
            const s = acc / FM_OS;
            const cutoff = Math.min(1, 0.35 * (carrierHz / sr));
            const slew = gate >= gateSm ? slewUp : slewDown;
            gateSm += slew * (gate - gateSm);
            if (gateSm < 1e-5) {
                lp *= 0.92;
                out[i] = lp * gateSm;
            } else {
                lp += cutoff * (s - lp);
                out[i] = lp * gateSm;
            }
        }

        this.carrierPhase = carrierPhase;
        this.modulatorPhase = modulatorPhase;
        this.subPhase = subPhase;
        this.fmPrevSample = prev;
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
        let prevShape = this.prevShape;
        let prevWfGain = this.prevWfGain;
        let lp = this.lp;
        let gateSm = this.gateSmooth;

        // Block-level tame using first sample freq
        const hz0 = this.noteHz(parameters, 0);
        const f00 = hz0 / sr;
        const slopeAmt = 3 + Math.abs(morph - 0.5) * 5;
        const shapeAmount = Math.abs(harmonics - 0.5) * 2;
        const shapeAtt = Tame(f00, slopeAmt, 16);
        const wfGainAtt = Tame(f00, slopeAmt * (3 + shapeAmount * shapeAtt * 5), 12);
        const shapeTarget = 0.5 + (harmonics - 0.5) * shapeAtt;
        const wfGainTarget = 0.03 + 0.46 * timbre * wfGainAtt;
        const shapeStep = (shapeTarget - prevShape) / out.length;
        const wfStep = (wfGainTarget - prevWfGain) / out.length;

        const ws = luts.ws;
        const fold = luts.fold;

        for (let i = 0; i < out.length; i++) {
            const hz = this.noteHz(parameters, i);
            const gate = gateArr.length > 1 ? gateArr[i] : gate0;
            const f0 = Math.min(0.25, hz / sr);

            const sl = slopeOscNext(slopePhase, f0, pw);
            slopePhase = sl.phase;
            const slopeSig = sl.s;

            prevShape += shapeStep;
            prevWfGain += wfStep;

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
            // fold LUT Hermite; Plaits uses lut_fold+1
            const folded = interpolateHermite(fold, index, 512);

            const slew = gate >= gateSm ? slewUp : slewDown;
            gateSm += slew * (gate - gateSm);
            if (gateSm < 1e-5) {
                lp *= 0.92;
                out[i] = lp * gateSm;
            } else {
                lp = folded;
                out[i] = folded * gateSm;
            }
        }

        this.slopePhase = slopePhase;
        this.prevShape = prevShape;
        this.prevWfGain = prevWfGain;
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

        if (rising) {
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
            // Clear mode states lightly so strike is clean
            this.modalBpS1.fill(0);
            this.modalBpS2.fill(0);
            this.excLp = 0;
            this.excBp = 0;
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
        const sustain = gateHigh;
        const range = sustain ? 36 : 60;
        const excFBase = sustain ? 4 * f0 : 2 * f0;
        const cutoff = Math.min(
            excFBase * semitonesToRatio((brightness * (2 - brightness) - 0.5) * range),
            0.499
        );
        const excQ = sustain ? 0.7 : 1.5;

        let peak = 0;
        for (let i = 0; i < out.length; i++) {
            let exc = 0;
            if (sustain) {
                // Dust noise
                const u = (this.nextNoise() + 1) * 0.5;
                if (u < dustF) {
                    exc = (4 - dustF * 3) * (0.5 + 0.5 * brightness);
                }
            } else if (rising && i === 0) {
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

        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const f0 = Math.min(0.25, Math.max(1 / (STRING_DELAY_SIZE - 4), hz / sr));

        if (rising) {
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
            // Noise burst ~1/f0 samples
            this.remainingNoise = Math.min(STRING_DELAY_SIZE - 4, Math.max(4, Math.floor(1 / f0)));
            this.srcPhase = 1;
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
            if (remaining > 0) {
                remaining--;
                // Filtered noise excitation; brightness shapes LP
                const n = this.nextNoise();
                noiseLp += Math.min(1, 0.1 + brightness * 0.8) * (n - noiseLp);
                input = noiseLp * (0.5 + 0.5 * brightness);
            } else if (gateHigh) {
                // Soft dust while held
                if ((this.nextNoise() + 1) * 0.5 < 0.002 * brightness) {
                    input = this.nextNoise() * 0.05;
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
        const timbre = clamp01(parameters.morphX[0] ?? 0.5); // tone
        const morph = clamp01(parameters.morphY[0] ?? 0.5); // decay
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5);
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        this.prevGate = gate0;

        if (rising) {
            this.bdAmpEnv = 1;
            this.bdFmEnv = 1;
            this.bdPhase = 0;
            this.bdToneLp = 0;
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }

        if (!this.ringing) {
            out.fill(0);
            return true;
        }

        const sr = sampleRate;
        const baseHz = this.noteHz(parameters, 0);
        // morph = decay: slower decay when morph high
        const ampDec = Math.exp(-1 / (sr * (0.05 + morph * morph * 0.6)));
        const fmDec = Math.exp(-1 / (sr * (0.008 + morph * 0.04)));
        const fmAmt = Math.min(harmonics * 4, 1);
        const toneF = Math.min(1, 4 * (baseHz / sr) * semitonesToRatio(timbre * 108));

        let phase = this.bdPhase;
        let ampEnv = this.bdAmpEnv;
        let fmEnv = this.bdFmEnv;
        let toneLp = this.bdToneLp;
        let peak = 0;

        for (let i = 0; i < out.length; i++) {
            const pitch = baseHz * (1 + fmEnv * fmAmt * 3);
            const f0 = Math.min(0.4, pitch / sr);
            phase += f0;
            if (phase >= 1) phase -= 1;
            // Soft sine body
            let body = softSine(phase);
            // Click from FM env transient
            const click = fmEnv * fmEnv * (this.nextNoise() * 0.15);
            let s = (body * ampEnv + click) * (0.6 + 0.4 * timbre);
            toneLp += toneF * (s - toneLp);
            s = toneLp;
            out[i] = s;
            const a = Math.abs(s);
            if (a > peak) peak = a;
            ampEnv *= ampDec;
            fmEnv *= fmDec;
        }

        this.bdPhase = phase;
        this.bdAmpEnv = ampEnv;
        this.bdFmEnv = fmEnv;
        this.bdToneLp = toneLp;

        if (ampEnv < 1e-4) {
            this.ringing = false;
            peak = 0;
        }
        this.checkSilence(peak, false);
        return true;
    }

    processSnare(out, parameters) {
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = clamp01(parameters.morphX[0] ?? 0.5);
        const morph = clamp01(parameters.morphY[0] ?? 0.5);
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5); // balance
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        this.prevGate = gate0;

        if (rising) {
            this.snToneEnv = 1;
            this.snNoiseEnv = 1;
            this.snPhase = 0;
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }

        if (!this.ringing) {
            out.fill(0);
            return true;
        }

        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const toneDec = Math.exp(-1 / (sr * (0.03 + timbre * 0.25)));
        const noiseDec = Math.exp(-1 / (sr * (0.02 + morph * 0.35)));
        const balance = harmonics; // 0=tone, 1=noise

        let phase = this.snPhase;
        let toneEnv = this.snToneEnv;
        let noiseEnv = this.snNoiseEnv;
        let peak = 0;

        for (let i = 0; i < out.length; i++) {
            const f0 = Math.min(0.4, hz / sr);
            phase += f0;
            if (phase >= 1) phase -= 1;
            const tone = softSine(phase) * toneEnv;
            // Colored noise
            let n = this.nextNoise();
            n = n * (0.5 + 0.5 * timbre) + softSine((phase * 2.3) % 1) * 0.2 * noiseEnv;
            const noise = n * noiseEnv;
            const s = tone * (1 - balance) + noise * balance;
            out[i] = s * 0.9;
            const a = Math.abs(s);
            if (a > peak) peak = a;
            toneEnv *= toneDec;
            noiseEnv *= noiseDec;
        }

        this.snPhase = phase;
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
        const harmonics = clamp01(parameters.harmonics[0] ?? 0.5); // metallic
        const rising = this.prevGate < 0.0001 && gate0 >= 0.0001;
        this.prevGate = gate0;

        if (rising) {
            this.hhEnv = 1;
            this.hhPhases.fill(0);
            this.hhHp = 0;
            this.ringing = true;
            this.reportedSilent = false;
            this.silentBlocks = 0;
        }

        if (!this.ringing) {
            out.fill(0);
            return true;
        }

        const sr = sampleRate;
        const hz = this.noteHz(parameters, 0);
        const decay = Math.exp(-1 / (sr * (0.015 + morph * 0.2)));
        // 6 metallic ratios (808-ish)
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
        let peak = 0;
        const phases = this.hhPhases;

        for (let i = 0; i < out.length; i++) {
            let acc = 0;
            for (let k = 0; k < 6; k++) {
                phases[k] += baseF * ratios[k];
                if (phases[k] >= 1) phases[k] -= 1;
                // Square / pulse
                acc += phases[k] < 0.5 ? 1 : -1;
            }
            acc *= (1 / 6) * env;
            // HP filter (timbre = decay color / brightness of noise)
            const hpCoeff = 0.05 + timbre * 0.4;
            hp += hpCoeff * (acc - hp);
            const s = (acc - hp) * (0.7 + 0.5 * harmonics);
            out[i] = s;
            const a = Math.abs(s);
            if (a > peak) peak = a;
            env *= decay;
        }

        this.hhEnv = env;
        this.hhHp = hp;

        if (env < 1e-4) {
            this.ringing = false;
            peak = 0;
        }
        this.checkSilence(peak, false);
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
            case 'wavetable':
            default: return this.processWavetable(out, parameters);
        }
    }
}

registerProcessor('plaits-engine-processor', PlaitsEngineProcessor);
