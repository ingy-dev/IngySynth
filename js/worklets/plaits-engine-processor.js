// Plaits FM LUTs (MIT, Copyright 2016 Emilie Gillet)
// From plaits/resources/lookup_tables.py — lut_fm_frequency_quantizer + sine
const FM_RATIO_LUT = new Float32Array([-12.00000000,-12.00000000,-12.00000000,-11.84000000,-11.84000000,-11.84000000,-11.11000000,-10.38000000,-9.65000000,-8.92000000,-8.19000000,-7.46000000,-6.73000000,-6.00000000,-6.00000000,-6.00000000,-5.54551161,-5.09102322,-4.63653483,-4.18204645,-4.18204645,-4.18204645,-3.65929064,-3.13653483,-2.61377903,-2.09102322,-1.56826742,-1.04551161,-0.52275581,0.00000000,0.00000000,0.00000000,0.16000000,0.16000000,0.16000000,0.89000000,1.62000000,2.35000000,3.08000000,3.81000000,4.54000000,5.27000000,6.00000000,6.00000000,6.00000000,6.45448839,6.90897678,7.36346517,7.81795355,7.81795355,7.81795355,8.28552993,8.75310631,9.22068269,9.68825906,9.68825906,9.68825906,10.26619430,10.84412953,11.42206477,12.00000000,12.00000000,12.00000000,12.16000000,12.16000000,12.16000000,12.62977500,13.09955001,13.56932501,14.03910002,14.03910002,14.03910002,14.90761987,15.77613972,16.64465957,17.51317942,17.51317942,17.51317942,18.00000000,18.00000000,18.00000000,18.50977500,19.01955001,19.01955001,19.01955001,19.81795355,19.81795355,19.81795355,20.66386428,21.50977500,21.50977500,21.50977500,22.13233125,22.75488750,23.37744375,24.00000000,24.00000000,24.00000000,24.50977500,25.01955001,25.01955001,25.01955001,25.47403840,25.92852679,26.38301517,26.83750356,26.83750356,26.83750356,27.35032035,27.86313714,27.86313714,27.86313714,28.39735285,28.93156857,29.46578428,30.00000000,30.00000000,30.00000000,30.75000000,31.50000000,32.25000000,33.00000000,33.75000000,34.50000000,35.25000000,36.00000000,36.00000000,36.00000000,36.00000000,36.00000000]);
const SINE_LUT = new Float32Array([0.00000000,0.01227154,0.02454123,0.03680722,0.04906767,0.06132074,0.07356456,0.08579731,0.09801714,0.11022221,0.12241068,0.13458071,0.14673047,0.15885814,0.17096189,0.18303989,0.19509032,0.20711138,0.21910124,0.23105811,0.24298018,0.25486566,0.26671276,0.27851969,0.29028468,0.30200595,0.31368174,0.32531029,0.33688985,0.34841868,0.35989504,0.37131719,0.38268343,0.39399204,0.40524131,0.41642956,0.42755509,0.43861624,0.44961133,0.46053871,0.47139674,0.48218377,0.49289819,0.50353838,0.51410274,0.52458968,0.53499762,0.54532499,0.55557023,0.56573181,0.57580819,0.58579786,0.59569930,0.60551104,0.61523159,0.62485949,0.63439328,0.64383154,0.65317284,0.66241578,0.67155895,0.68060100,0.68954054,0.69837625,0.70710678,0.71573083,0.72424708,0.73265427,0.74095113,0.74913639,0.75720885,0.76516727,0.77301045,0.78073723,0.78834643,0.79583690,0.80320753,0.81045720,0.81758481,0.82458930,0.83146961,0.83822471,0.84485357,0.85135519,0.85772861,0.86397286,0.87008699,0.87607009,0.88192126,0.88763962,0.89322430,0.89867447,0.90398929,0.90916798,0.91420976,0.91911385,0.92387953,0.92850608,0.93299280,0.93733901,0.94154407,0.94560733,0.94952818,0.95330604,0.95694034,0.96043052,0.96377607,0.96697647,0.97003125,0.97293995,0.97570213,0.97831737,0.98078528,0.98310549,0.98527764,0.98730142,0.98917651,0.99090264,0.99247953,0.99390697,0.99518473,0.99631261,0.99729046,0.99811811,0.99879546,0.99932238,0.99969882,0.99992470,1.00000000,0.99992470,0.99969882,0.99932238,0.99879546,0.99811811,0.99729046,0.99631261,0.99518473,0.99390697,0.99247953,0.99090264,0.98917651,0.98730142,0.98527764,0.98310549,0.98078528,0.97831737,0.97570213,0.97293995,0.97003125,0.96697647,0.96377607,0.96043052,0.95694034,0.95330604,0.94952818,0.94560733,0.94154407,0.93733901,0.93299280,0.92850608,0.92387953,0.91911385,0.91420976,0.90916798,0.90398929,0.89867447,0.89322430,0.88763962,0.88192126,0.87607009,0.87008699,0.86397286,0.85772861,0.85135519,0.84485357,0.83822471,0.83146961,0.82458930,0.81758481,0.81045720,0.80320753,0.79583690,0.78834643,0.78073723,0.77301045,0.76516727,0.75720885,0.74913639,0.74095113,0.73265427,0.72424708,0.71573083,0.70710678,0.69837625,0.68954054,0.68060100,0.67155895,0.66241578,0.65317284,0.64383154,0.63439328,0.62485949,0.61523159,0.60551104,0.59569930,0.58579786,0.57580819,0.56573181,0.55557023,0.54532499,0.53499762,0.52458968,0.51410274,0.50353838,0.49289819,0.48218377,0.47139674,0.46053871,0.44961133,0.43861624,0.42755509,0.41642956,0.40524131,0.39399204,0.38268343,0.37131719,0.35989504,0.34841868,0.33688985,0.32531029,0.31368174,0.30200595,0.29028468,0.27851969,0.26671276,0.25486566,0.24298018,0.23105811,0.21910124,0.20711138,0.19509032,0.18303989,0.17096189,0.15885814,0.14673047,0.13458071,0.12241068,0.11022221,0.09801714,0.08579731,0.07356456,0.06132074,0.04906767,0.03680722,0.02454123,0.01227154,0.00000000,-0.01227154,-0.02454123,-0.03680722,-0.04906767,-0.06132074,-0.07356456,-0.08579731,-0.09801714,-0.11022221,-0.12241068,-0.13458071,-0.14673047,-0.15885814,-0.17096189,-0.18303989,-0.19509032,-0.20711138,-0.21910124,-0.23105811,-0.24298018,-0.25486566,-0.26671276,-0.27851969,-0.29028468,-0.30200595,-0.31368174,-0.32531029,-0.33688985,-0.34841868,-0.35989504,-0.37131719,-0.38268343,-0.39399204,-0.40524131,-0.41642956,-0.42755509,-0.43861624,-0.44961133,-0.46053871,-0.47139674,-0.48218377,-0.49289819,-0.50353838,-0.51410274,-0.52458968,-0.53499762,-0.54532499,-0.55557023,-0.56573181,-0.57580819,-0.58579786,-0.59569930,-0.60551104,-0.61523159,-0.62485949,-0.63439328,-0.64383154,-0.65317284,-0.66241578,-0.67155895,-0.68060100,-0.68954054,-0.69837625,-0.70710678,-0.71573083,-0.72424708,-0.73265427,-0.74095113,-0.74913639,-0.75720885,-0.76516727,-0.77301045,-0.78073723,-0.78834643,-0.79583690,-0.80320753,-0.81045720,-0.81758481,-0.82458930,-0.83146961,-0.83822471,-0.84485357,-0.85135519,-0.85772861,-0.86397286,-0.87008699,-0.87607009,-0.88192126,-0.88763962,-0.89322430,-0.89867447,-0.90398929,-0.90916798,-0.91420976,-0.91911385,-0.92387953,-0.92850608,-0.93299280,-0.93733901,-0.94154407,-0.94560733,-0.94952818,-0.95330604,-0.95694034,-0.96043052,-0.96377607,-0.96697647,-0.97003125,-0.97293995,-0.97570213,-0.97831737,-0.98078528,-0.98310549,-0.98527764,-0.98730142,-0.98917651,-0.99090264,-0.99247953,-0.99390697,-0.99518473,-0.99631261,-0.99729046,-0.99811811,-0.99879546,-0.99932238,-0.99969882,-0.99992470,-1.00000000,-0.99992470,-0.99969882,-0.99932238,-0.99879546,-0.99811811,-0.99729046,-0.99631261,-0.99518473,-0.99390697,-0.99247953,-0.99090264,-0.98917651,-0.98730142,-0.98527764,-0.98310549,-0.98078528,-0.97831737,-0.97570213,-0.97293995,-0.97003125,-0.96697647,-0.96377607,-0.96043052,-0.95694034,-0.95330604,-0.94952818,-0.94560733,-0.94154407,-0.93733901,-0.93299280,-0.92850608,-0.92387953,-0.91911385,-0.91420976,-0.90916798,-0.90398929,-0.89867447,-0.89322430,-0.88763962,-0.88192126,-0.87607009,-0.87008699,-0.86397286,-0.85772861,-0.85135519,-0.84485357,-0.83822471,-0.83146961,-0.82458930,-0.81758481,-0.81045720,-0.80320753,-0.79583690,-0.78834643,-0.78073723,-0.77301045,-0.76516727,-0.75720885,-0.74913639,-0.74095113,-0.73265427,-0.72424708,-0.71573083,-0.70710678,-0.69837625,-0.68954054,-0.68060100,-0.67155895,-0.66241578,-0.65317284,-0.64383154,-0.63439328,-0.62485949,-0.61523159,-0.60551104,-0.59569930,-0.58579786,-0.57580819,-0.56573181,-0.55557023,-0.54532499,-0.53499762,-0.52458968,-0.51410274,-0.50353838,-0.49289819,-0.48218377,-0.47139674,-0.46053871,-0.44961133,-0.43861624,-0.42755509,-0.41642956,-0.40524131,-0.39399204,-0.38268343,-0.37131719,-0.35989504,-0.34841868,-0.33688985,-0.32531029,-0.31368174,-0.30200595,-0.29028468,-0.27851969,-0.26671276,-0.25486566,-0.24298018,-0.23105811,-0.21910124,-0.20711138,-0.19509032,-0.18303989,-0.17096189,-0.15885814,-0.14673047,-0.13458071,-0.12241068,-0.11022221,-0.09801714,-0.08579731,-0.07356456,-0.06132074,-0.04906767,-0.03680722,-0.02454123,-0.01227154,-0.00000000]);

// Multi-engine OSC worklet — Mutable Instruments Plaits (MIT).
// Engines: wavetable (banks from waves.bin pipeline), fm (2-op).
// Wavetable tables: port message { tables: ArrayBuffer } float32 [4][64][128].

const WAVE_SIZE = 128;
const GRID = 8;
const NUM_WAVES = GRID * GRID;
const NUM_BANKS = 4;
const TABLES_BYTES = NUM_BANKS * NUM_WAVES * WAVE_SIZE * 4;
const FM_OS = 4;
const SINE_LUT_BITS = 9;
const MAX_U32 = 4294967296.0;
/** Gate slew taus — down slower so note-off AudioParam steps don't hard-cut. */
const GATE_SLEW_UP_SEC = 0.004;
const GATE_SLEW_DOWN_SEC = 0.014;

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

/** Plaits SinePM — phase in uint32, pm index up to ~32. */
function sinePm(phase, pm) {
    const maxIndex = 32;
    const offset = maxIndex;
    const scale = MAX_U32 / (maxIndex * 2);
    // C++: phase += uint32((pm + offset) * scale) * max_index * 2;
    const add = ((((pm + offset) * scale) >>> 0) * maxIndex * 2) >>> 0;
    const p = (phase + add) >>> 0;
    const integral = p >>> (32 - SINE_LUT_BITS);
    const fractional = ((p << SINE_LUT_BITS) >>> 0) / MAX_U32;
    const a = SINE_LUT[integral];
    const b = SINE_LUT[Math.min(SINE_LUT.length - 1, integral + 1)];
    return a + (b - a) * fractional;
}

function sampleWave(bank, waveIndex, phase01) {
    const base = waveIndex * WAVE_SIZE;
    const p = phase01 * WAVE_SIZE;
    const i0 = Math.floor(p) % WAVE_SIZE;
    const i1 = (i0 + 1) % WAVE_SIZE;
    const frac = p - Math.floor(p);
    return lerp(bank[base + i0], bank[base + i1], frac);
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

function findZeroCrossingPhase(bank, w00, w10, w01, w11, xf, yf) {
    let bestP = 0;
    let bestAbs = 1e9;
    let prev = blendSample(bank, w00, w10, w01, w11, xf, yf, 0);
    for (let i = 1; i <= WAVE_SIZE; i++) {
        const p = (i % WAVE_SIZE) / WAVE_SIZE;
        const s = blendSample(bank, w00, w10, w01, w11, xf, yf, p);
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

class PlaitsEngineProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 440, minValue: 1, maxValue: 14000, automationRate: 'a-rate' },
            { name: 'detune', defaultValue: 0, minValue: -4800, maxValue: 4800, automationRate: 'a-rate' },
            { name: 'morphX', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'morphY', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'harmonics', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'bank', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
            { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lp = 0;
        this.engine = 'wavetable';
        this.tables = null;
        this.prevGate = 0;
        // FM state (Plaits FMEngine)
        this.carrierPhase = 0;
        this.modulatorPhase = 0;
        this.subPhase = 0;
        this.fmPrevSample = 0;
        this.gateSmooth = 0;
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
            if (msg.reset && this.prevGate < 0.0001) {
                this.phase = 0;
                this.lp = 0;
                this.carrierPhase = 0;
                this.modulatorPhase = 0;
                this.subPhase = 0;
                this.fmPrevSample = 0;
                this.gateSmooth = 0;
            }
        };
    }

    processFm(out, parameters) {
        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const timbre = Math.max(0, Math.min(1, parameters.morphX[0] ?? 0.5));
        const morph = Math.max(0, Math.min(1, parameters.morphY[0] ?? 0.5));
        const harmonics = Math.max(0, Math.min(1, parameters.harmonics[0] ?? 0.5));

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

        // Ratio in semitones (Plaits lut_fm_frequency_quantizer)
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
            // Keep keyboard pitch; Plaits uses note-24 internally — we map carrier = hz
            const carrierHz = hz;
            const modHz = Math.min(sr * 0.5, carrierHz * Math.pow(2, ratioSemis / 12));
            // MIDI-ish note for hf taming (Plaits: modulator_note)
            const modNote = 69 + 12 * Math.log2(Math.max(1e-6, modHz / 440));
            let hfTaming = 1 - (modNote - 72) * 0.025;
            hfTaming = Math.max(0, Math.min(1, hfTaming));
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
                // Soft one-pole on feedback path (Plaits ONE_POLE 0.05)
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
        const morphX = Math.max(0, Math.min(1, parameters.morphX[0] ?? 0.5));
        const morphY = Math.max(0, Math.min(1, parameters.morphY[0] ?? 0.5));
        const bankIdx = Math.max(0, Math.min(NUM_BANKS - 1, Math.round(parameters.bank[0] ?? 0)));
        const tables = this.tables?.[bankIdx];

        if (!tables) {
            out.fill(0);
            this.prevGate = gate0;
            return true;
        }

        if (this.prevGate < 0.0001 && gate0 >= 0.0001) {
            const x = morphX * (GRID - 1.0001);
            const y = morphY * (GRID - 1.0001);
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const x1 = Math.min(GRID - 1, x0 + 1);
            const y1 = Math.min(GRID - 1, y0 + 1);
            const xf = x - x0;
            const yf = y - y0;
            const w00 = y0 * GRID + x0;
            const w10 = y0 * GRID + x1;
            const w01 = y1 * GRID + x0;
            const w11 = y1 * GRID + x1;
            this.phase = findZeroCrossingPhase(tables, w00, w10, w01, w11, xf, yf);
            this.lp = 0;
            this.gateSmooth = 0;
        }
        this.prevGate = gate0;

        if (gate0 < 1e-5 && gateArr.length <= 1 && Math.abs(this.lp) < 1e-4 && this.gateSmooth < 1e-4) {
            out.fill(0);
            return true;
        }

        const x = morphX * (GRID - 1.0001);
        const y = morphY * (GRID - 1.0001);
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(GRID - 1, x0 + 1);
        const y1 = Math.min(GRID - 1, y0 + 1);
        const xf = x - x0;
        const yf = y - y0;
        const w00 = y0 * GRID + x0;
        const w10 = y0 * GRID + x1;
        const w01 = y1 * GRID + x0;
        const w11 = y1 * GRID + x1;

        const sr = sampleRate;
        const slewUp = gateSlewCoeff(GATE_SLEW_UP_SEC);
        const slewDown = gateSlewCoeff(GATE_SLEW_DOWN_SEC);
        let phase = this.phase;
        let lp = this.lp;
        let gateSm = this.gateSmooth;

        for (let i = 0; i < out.length; i++) {
            const f0 = freqArr.length > 1 ? freqArr[i] : freqArr[0];
            const det = detuneArr.length > 1 ? detuneArr[i] : detuneArr[0];
            const gate = gateArr.length > 1 ? gateArr[i] : gate0;
            const hz = Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
            const inc = hz / sr;
            phase += inc;
            if (phase >= 1) phase -= Math.floor(phase);

            const s00 = sampleWave(tables, w00, phase);
            const s10 = sampleWave(tables, w10, phase);
            const s01 = sampleWave(tables, w01, phase);
            const s11 = sampleWave(tables, w11, phase);
            const s0 = lerp(s00, s10, xf);
            const s1 = lerp(s01, s11, xf);
            const s = lerp(s0, s1, yf);

            const cutoff = Math.min(1, (WAVE_SIZE * 0.35 * inc));
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

        this.phase = phase;
        this.lp = lp;
        this.gateSmooth = gateSm;
        return true;
    }

    process(_inputs, outputs, parameters) {
        const out = outputs[0]?.[0];
        if (!out) return true;
        if (this.engine === 'fm') return this.processFm(out, parameters);
        return this.processWavetable(out, parameters);
    }
}

registerProcessor('plaits-engine-processor', PlaitsEngineProcessor);
