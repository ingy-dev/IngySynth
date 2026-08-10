// Multi-engine OSC worklet (v1: wavetable). Plaits-inspired morphing tables.
// MIT-style reuse of the wavetable morph idea from Mutable Instruments Plaits.

const WAVE_SIZE = 128;
const GRID = 8;
const NUM_WAVES = GRID * GRID;
const NUM_BANKS = 4;

function finishWave(wave) {
    // DC-free frames (wavetable standard) — DC into a high-Q filter = ping/click
    let mean = 0;
    for (let i = 0; i < WAVE_SIZE; i++) mean += wave[i];
    mean /= WAVE_SIZE;
    for (let i = 0; i < WAVE_SIZE; i++) wave[i] -= mean;

    // Rotate so phase 0 is a rising zero-crossing (note-on starts at silence)
    let rot = 0;
    let prev = wave[WAVE_SIZE - 1];
    for (let i = 0; i < WAVE_SIZE; i++) {
        const s = wave[i];
        if (prev < 0 && s >= 0) {
            rot = i;
            break;
        }
        prev = s;
    }
    if (rot > 0) {
        const rotated = new Float32Array(WAVE_SIZE);
        for (let i = 0; i < WAVE_SIZE; i++) {
            rotated[i] = wave[(i + rot) % WAVE_SIZE];
        }
        wave.set(rotated);
    }

    let peak = 1e-6;
    for (let i = 0; i < WAVE_SIZE; i++) peak = Math.max(peak, Math.abs(wave[i]));
    const inv = 0.9 / peak;
    for (let i = 0; i < WAVE_SIZE; i++) wave[i] *= inv;
    return wave;
}

/** Bank A–D: different harmonic recipes (Plaits-style bank split). */
function synthesizeFrame(bankIndex, brightness, morph, i) {
    const ph = (i / WAVE_SIZE) * Math.PI * 2;
    let s = 0;
    const nHarm = 1 + Math.floor(brightness * 15);

    if (bankIndex === 0) {
        // A — additive / harmonic-poor → saw/square morph
        for (let h = 1; h <= nHarm; h++) {
            const amp = 1 / h;
            const oddOnly = h % 2 === 1 ? 1 : Math.max(0, 1 - morph * 1.4);
            const pulseTilt = 1 + morph * Math.cos(ph) * 0.35;
            s += Math.sin(ph * h) * amp * oddOnly * pulseTilt;
        }
        if (brightness > 0.55) {
            const drive = 1 + (brightness - 0.55) * 2.5;
            s = Math.tanh(s * drive) / Math.tanh(drive);
        }
    } else if (bankIndex === 1) {
        // B — formant / waveshaped
        const form = 2 + morph * 6;
        const win = Math.pow(Math.max(0, Math.sin(ph * 0.5)), 0.6 + brightness);
        s = Math.sin(ph * form) * win;
        s += 0.35 * Math.sin(ph * (form * 1.5 + 1)) * win;
        if (brightness > 0.4) s = Math.tanh(s * (1.2 + brightness));
    } else if (bankIndex === 2) {
        // C — richer ROM-ish (more odd + even with bit crush grit)
        for (let h = 1; h <= nHarm; h++) {
            const amp = 1 / Math.pow(h, 0.7 + morph * 0.5);
            s += Math.sin(ph * h + morph * h * 0.15) * amp;
        }
        const bits = 4 + Math.floor((1 - brightness) * 8);
        const q = Math.pow(2, bits - 1);
        s = Math.round(s * q) / q;
    } else {
        // D — scrambled / inharmonic permutation
        const seed = Math.floor(brightness * 7) + Math.floor(morph * 5) * 3;
        for (let h = 1; h <= nHarm; h++) {
            const ratio = 1 + ((h * 3 + seed) % 5) * 0.37;
            const amp = 1 / (h + morph);
            s += Math.sin(ph * h * ratio) * amp;
        }
        s = Math.tanh(s * (1 + brightness));
    }
    return s;
}

function buildWavetableBank(bankIndex) {
    const bank = new Float32Array(NUM_WAVES * WAVE_SIZE);
    for (let row = 0; row < GRID; row++) {
        for (let col = 0; col < GRID; col++) {
            const wave = new Float32Array(WAVE_SIZE);
            const brightness = row / (GRID - 1);
            const morph = col / (GRID - 1);
            for (let i = 0; i < WAVE_SIZE; i++) {
                wave[i] = synthesizeFrame(bankIndex, brightness, morph, i);
            }
            finishWave(wave);
            const base = (row * GRID + col) * WAVE_SIZE;
            for (let i = 0; i < WAVE_SIZE; i++) bank[base + i] = wave[i];
        }
    }
    return bank;
}

function buildAllBanks() {
    const banks = [];
    for (let b = 0; b < NUM_BANKS; b++) banks.push(buildWavetableBank(b));
    return banks;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
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

/** Prefer a rising zero-cross of the blended morph (falls back to nearest-to-zero). */
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
        // Rising edge only — matches commercial WT / sine-at-zero note-ons
        if (prev < 0 && s >= 0) return p;
        prev = s;
    }
    return bestP;
}

class PlaitsEngineProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'frequency', defaultValue: 440, minValue: 1, maxValue: 14000, automationRate: 'a-rate' },
            { name: 'detune', defaultValue: 0, minValue: -4800, maxValue: 4800, automationRate: 'a-rate' },
            { name: 'morphX', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'morphY', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'bank', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
            // a-rate so soft gate attacks interpolate inside the quantum
            { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
        ];
    }

    constructor() {
        super();
        this.phase = 0;
        this.lp = 0;
        this.engine = 'wavetable';
        this.tables = buildAllBanks();
        this.prevGate = 0;
        this.port.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg || typeof msg !== 'object') return;
            if (typeof msg.engine === 'string') this.engine = msg.engine;
            // Only reset while idle (gate down). Note-on reset is edge-triggered in process().
            if (msg.reset && this.prevGate < 0.0001) {
                this.phase = 0;
                this.lp = 0;
            }
        };
    }

    process(_inputs, outputs, parameters) {
        const out = outputs[0]?.[0];
        if (!out) return true;

        const freqArr = parameters.frequency;
        const detuneArr = parameters.detune;
        const gateArr = parameters.gate;
        const gate0 = gateArr[0] ?? 0;
        const morphX = Math.max(0, Math.min(1, parameters.morphX[0] ?? 0.5));
        const morphY = Math.max(0, Math.min(1, parameters.morphY[0] ?? 0.5));
        const bankIdx = Math.max(0, Math.min(NUM_BANKS - 1, Math.round(parameters.bank[0] ?? 0)));
        const tables = this.tables[bankIdx];

        // Rising edge: start at a zero-crossing of the current morph (open filter safe)
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
        }
        this.prevGate = gate0;

        // Keep rendering while releasing — hard-zeroing when gate≈0 was cutting mid-wave
        // (logs: filterIn hood 0.09→0.00 in one sample). Always multiply by gate.
        if (gate0 < 1e-5 && gateArr.length <= 1 && Math.abs(this.lp) < 1e-4) {
            out.fill(0);
            return true;
        }

        // 8x8 grid: X = column, Y = row (Plaits TIMBRE/MORPH style)
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
        let phase = this.phase;
        let lp = this.lp;

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
            let s = lerp(s0, s1, yf);

            // Mild frequency-dependent damping (cheap anti-alias / darken highs)
            const cutoff = Math.min(1, (WAVE_SIZE * 0.35 * inc));
            if (gate < 1e-5) {
                // Idle: decay residual filter state; keep * gate so a gate snap→0 stays continuous
                lp *= 0.92;
                out[i] = lp * gate;
            } else {
                lp += cutoff * (s - lp);
                out[i] = lp * gate;
            }
        }

        this.phase = phase;
        this.lp = lp;
        return true;
    }
}

registerProcessor('plaits-engine-processor', PlaitsEngineProcessor);
