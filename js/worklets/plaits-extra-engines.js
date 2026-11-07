// Copyright 2016–2021 Emilie Gillet / Mutable Instruments — Plaits DSP (MIT).
// Ported to JavaScript AudioWorklet for IngySynth OSC1 digital engines.
// See http://creativecommons.org/licenses/MIT/ for more information.
//
// Extra engines: va, va_vcf, additive, grain, swarm, noise, particle,
// pd, terrain, string_machine, chiptune, chord, speech.

export const EXTRA_ENGINE_META = {
    va: { triggered: false, tailSec: 0 },
    va_vcf: { triggered: false, tailSec: 0 },
    additive: { triggered: false, tailSec: 0 },
    grain: { triggered: false, tailSec: 0 },
    swarm: { triggered: false, tailSec: 0 },
    noise: { triggered: false, tailSec: 0 },
    particle: { triggered: false, tailSec: 0 },
    pd: { triggered: false, tailSec: 0 },
    terrain: { triggered: false, tailSec: 0 },
    string_machine: { triggered: false, tailSec: 0 },
    chiptune: { triggered: false, tailSec: 0 },
    chord: { triggered: false, tailSec: 0 },
    speech: { triggered: false, tailSec: 0 },
};

const X_GATE_UP = 0.004;
const X_GATE_DOWN = 0.014;
const X_K_MAX_F = 0.25;
const X_VA_NOTCH = 0.2;
const X_SWARM_N = 8;
const X_ADD_N = 24;
const X_PART_N = 6;
const X_CHORD_N = 4;
const X_CHORD_V = 5;
const X_CHORD_H = 3;
const X_ORGAN_H = [0, 1, 2, 3, 5, 7, 9, 11];
const X_CHORD_FADE = [0.55, 0.47, 0.49, 0.51, 0.53];
const X_CHORD_WT = [
    [2, 49], [2, 54], [2, 52],
    [0, 48], [0, 49], [0, 50], [0, 55],
    [2, 39], [2, 38], [2, 37], [2, 36],
    [2, 35], [2, 34], [2, 33], [2, 32],
];

const X_CHORD_SEMIS = [
    [0.00, 0.01, 11.99, 12.00],
    [0.00, 7.00, 7.01, 12.00],
    [0.00, 5.00, 7.00, 12.00],
    [0.00, 3.00, 7.00, 12.00],
    [0.00, 3.00, 7.00, 10.00],
    [0.00, 3.00, 10.00, 14.00],
    [0.00, 3.00, 10.00, 17.00],
    [0.00, 2.00, 9.00, 16.00],
    [0.00, 4.00, 11.00, 14.00],
    [0.00, 4.00, 7.00, 11.00],
    [0.00, 4.00, 7.00, 12.00],
];

const X_VA_INTERVALS = [0.0, 7.01, 12.01, 19.01, 24.01];

const X_REG_CHORD = [
    [0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
    [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.5, 0.0, 0.5, 0.0, 0.0, 0.0],
    [0.33, 0.0, 0.33, 0.0, 0.33, 0.0],
    [0.33, 0.0, 0.0, 0.33, 0.0, 0.33],
    [0.5, 0.0, 0.0, 0.0, 0.0, 0.5],
    [0.0, 0.5, 0.0, 0.0, 0.0, 0.5],
    [0.0, 0.1, 0.1, 0.0, 0.2, 0.6],
];

const X_REG_SM = [
    [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.5, 0.0, 0.5, 0.0, 0.0, 0.0],
    [0.4, 0.0, 0.2, 0.0, 0.4, 0.0],
    [0.3, 0.0, 0.0, 0.3, 0.0, 0.4],
    [0.3, 0.0, 0.0, 0.0, 0.0, 0.7],
    [0.2, 0.0, 0.0, 0.2, 0.0, 0.6],
    [0.0, 0.2, 0.1, 0.0, 0.2, 0.5],
    [0.0, 0.3, 0.0, 0.3, 0.0, 0.4],
    [0.0, 0.4, 0.0, 0.3, 0.0, 0.3],
    [0.0, 0.5, 0.0, 0.5, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
];

function xClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function xClamp01(v) { return xClamp(v, 0, 1); }
function xLerp(a, b, t) { return a + (b - a) * t; }
function xSemis(r) { return Math.pow(2, r / 12); }
function xSoftClip(x) {
    if (x < -3) return -1;
    if (x > 3) return 1;
    return x * (27 + x * x) / (27 + 9 * x * x);
}
function xThisBlep(t) { return 0.5 * t * t; }
function xNextBlep(t) { t = 1 - t; return -0.5 * t * t; }
function xNextIntBlep(t) {
    const t1 = 0.5 * t, t2 = t1 * t1, t4 = t2 * t2;
    return 0.1875 - t1 + 1.5 * t2 - t4;
}
function xThisIntBlep(t) { return xNextIntBlep(1 - t); }
function xGateCoeff(sec) { return 1 - Math.exp(-1 / (sampleRate * Math.max(0.001, sec))); }
function xSine01(p) { return Math.sin(p * Math.PI * 2); }
function xMidiNote(hz) { return 69 + 12 * Math.log2(Math.max(1e-6, hz / 440)); }
function xRand() { return Math.random(); }
function xNoteToF(note) { return 440 * Math.pow(2, (note - 69) / 12) / sampleRate; }
function xFast2Sin(f) {
    const fpi = f * Math.PI;
    return fpi * (2 - (2 * 0.96 / 6) * fpi * fpi);
}

function xParams(parameters) {
    return {
        freqArr: parameters.frequency,
        detuneArr: parameters.detune,
        gateArr: parameters.gate,
        gate0: parameters.gate[0] ?? 0,
        harmonics: xClamp01(parameters.harmonics[0] ?? 0.5),
        timbre: xClamp01(parameters.morphX[0] ?? 0.5),
        morph: xClamp01(parameters.morphY[0] ?? 0.5),
    };
}

function xFlags(self, parameters) {
    const alt = ((parameters.alt && parameters.alt[0]) ?? (self.alt ? 1 : 0)) >= 0.5;
    const trigPatched = ((parameters.trigPatched && parameters.trigPatched[0]) ?? (self.trigPatched !== false ? 1 : 0)) >= 0.5;
    return { alt, trigPatched };
}

function xEmit(out, main, aux, alt, size) {
    const src = alt ? aux : main;
    if (src !== out) out.set(src.subarray(0, size));
    else if (alt && aux !== out) {
        for (let i = 0; i < size; i++) out[i] = aux[i];
    }
}

function xHz(freqArr, detuneArr, i) {
    const f0 = freqArr.length > 1 ? freqArr[i] : freqArr[0];
    const det = detuneArr.length > 1 ? detuneArr[i] : (detuneArr[0] ?? 0);
    return Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
}

function xApplyGate(self, out, gateArr, gate0) {
    const slewUp = xGateCoeff(X_GATE_UP);
    const slewDown = xGateCoeff(X_GATE_DOWN);
    let gateSm = self.gateSmooth || 0;
    let lp = self.lp || 0;
    for (let i = 0; i < out.length; i++) {
        const gate = gateArr.length > 1 ? gateArr[i] : gate0;
        const slew = gate >= gateSm ? slewUp : slewDown;
        gateSm += slew * (gate - gateSm);
        if (gateSm < 1e-5) {
            lp *= 0.92;
            out[i] = lp * gateSm;
        } else {
            lp = out[i];
            out[i] *= gateSm;
        }
    }
    self.gateSmooth = gateSm;
    self.lp = lp;
    self.prevGate = gate0;
}

function xSquash(x) { return x * x * (3 - 2 * x); }

function xVaDetune(detune) {
    detune = 2.05 * detune - 1.025;
    detune = xClamp(detune, -1, 1);
    const sign = detune < 0 ? -1 : 1;
    detune = detune * sign * 3.9999;
    const di = Math.floor(detune);
    const df = detune - di;
    const a = X_VA_INTERVALS[di];
    const b = X_VA_INTERVALS[di + 1];
    return (a + (b - a) * xSquash(xSquash(df))) * sign;
}

function xChordIndex(h) {
    const n = X_CHORD_SEMIS.length;
    let i = Math.floor(h * 1.02 * n);
    return xClamp(i, 0, n - 1);
}

function xRegistration(table, reg, amps) {
    const n = table.length;
    reg = xClamp(reg, 0, 1) * (n - 1.001);
    const i = Math.floor(reg);
    const f = reg - i;
    const a = table[i];
    const b = table[Math.min(n - 1, i + 1)];
    for (let k = 0; k < 6; k++) amps[k] = a[k] + (b[k] - a[k]) * f;
    amps[6] = 0;
}

function xSampleIntegrated(bank, waveIndex, phase01) {
    const WAVE = 128;
    const base = waveIndex * WAVE;
    const p = ((phase01 % 1) + 1) % 1 * WAVE;
    let i0 = Math.floor(p);
    const f = p - i0;
    i0 = ((i0 % WAVE) + WAVE) % WAVE;
    const a = bank[base + i0];
    const b = bank[base + ((i0 + 1) % WAVE)];
    const c = bank[base + ((i0 + 2) % WAVE)];
    return (b - a) + (c - b - b + a) * f;
}

function xFmRatioSemis(harmonics) {
    const lut = globalThis.FM_RATIO_LUT;
    if (!lut || !lut.length) return (harmonics - 0.5) * 48;
    const idx = harmonics * 128;
    const i0 = Math.min(lut.length - 2, Math.max(0, Math.floor(idx)));
    return lut[i0] + (lut[i0 + 1] - lut[i0]) * (idx - i0);
}

// --- Variable shape / saw (Plaits polyBLEP + output_phase) ---
class XVarShape {
    constructor() { this.init(); }
    init() {
        this.masterPhase = 0; this.slavePhase = 0; this.nextSample = 0;
        this.previousPw = 0.5; this.high = false;
        this.masterFrequency = 0; this.slaveFrequency = 0.01;
        this.pw = 0.5; this.waveshape = 0; this.phaseModulation = 0;
    }
    naive(phase, pw, slopeUp, slopeDown, triAmt, sqAmt) {
        let saw = phase;
        const square = phase < pw ? 0 : 1;
        const triangle = phase < pw ? phase * slopeUp : 1 - (phase - pw) * slopeDown;
        saw += (square - saw) * sqAmt;
        saw += (triangle - saw) * triAmt;
        return saw;
    }
    render(masterF, slaveF, pw, waveshape, out, size, sync, outputPhase, phaseMod) {
        if (slaveF >= X_K_MAX_F) slaveF = X_K_MAX_F;
        if (masterF >= X_K_MAX_F) masterF = X_K_MAX_F;
        if (slaveF >= 0.25) pw = 0.5;
        else pw = xClamp(pw, slaveF * 2, 1 - 2 * slaveF);
        if (phaseMod == null) phaseMod = 0;

        const dMaster = (masterF - this.masterFrequency) / size;
        const dSlave = (slaveF - this.slaveFrequency) / size;
        const dPw = (pw - this.pw) / size;
        const dWs = (waveshape - this.waveshape) / size;
        const dPm = (phaseMod - this.phaseModulation) / size;
        let next = this.nextSample;
        let mF = this.masterFrequency;
        let sF = this.slaveFrequency;
        let pww = this.pw;
        let ws = this.waveshape;
        let pm = this.phaseModulation;

        for (let n = 0; n < size; n++) {
            mF += dMaster; sF += dSlave; pww += dPw; ws += dWs; pm += dPm;
            let thisSample = next; next = 0;
            const sqAmt = Math.max(ws - 0.5, 0) * 2;
            const triAmt = Math.max(1 - ws * 2, 0);
            const slopeUp = 1 / pww;
            const slopeDown = 1 / (1 - pww);
            let reset = false, transitionDuringReset = false, resetTime = 0;

            if (sync) {
                this.masterPhase += mF;
                if (this.masterPhase >= 1) {
                    this.masterPhase -= 1;
                    resetTime = this.masterPhase / mF;
                    let slaveAtReset = this.slavePhase + (1 - resetTime) * sF;
                    reset = true;
                    if (slaveAtReset >= 1) { slaveAtReset -= 1; transitionDuringReset = true; }
                    if (!this.high && slaveAtReset >= pww) transitionDuringReset = true;
                    const value = this.naive(slaveAtReset, pww, slopeUp, slopeDown, triAmt, sqAmt);
                    thisSample -= value * xThisBlep(resetTime);
                    next -= value * xNextBlep(resetTime);
                }
            } else if (outputPhase) {
                this.masterPhase += mF;
                if (this.masterPhase >= 1) this.masterPhase -= 1;
            }

            this.slavePhase += sF;
            while (transitionDuringReset || !reset) {
                if (!this.high) {
                    if (this.slavePhase < pww) break;
                    const t = (this.slavePhase - pww) / (this.previousPw - pww + sF);
                    let triStep = (slopeUp + slopeDown) * sF * triAmt;
                    thisSample += sqAmt * xThisBlep(t);
                    next += sqAmt * xNextBlep(t);
                    thisSample -= triStep * xThisIntBlep(t);
                    next -= triStep * xNextIntBlep(t);
                    this.high = true;
                }
                if (this.high) {
                    if (this.slavePhase < 1) break;
                    this.slavePhase -= 1;
                    const t = this.slavePhase / sF;
                    let triStep = (slopeUp + slopeDown) * sF * triAmt;
                    thisSample -= (1 - triAmt) * xThisBlep(t);
                    next -= (1 - triAmt) * xNextBlep(t);
                    thisSample += triStep * xThisIntBlep(t);
                    next += triStep * xNextIntBlep(t);
                    this.high = false;
                }
            }
            if (sync && reset) {
                this.slavePhase = resetTime * sF;
                this.high = false;
            }
            next += this.naive(this.slavePhase, pww, slopeUp, slopeDown, triAmt, sqAmt);
            this.previousPw = pww;
            if (outputPhase) {
                let phasor = this.masterPhase;
                if (sync) {
                    const w = 4 * (1 - this.masterPhase) * this.masterPhase;
                    thisSample *= w * (2 - w);
                    const p2 = phasor * phasor;
                    phasor += (p2 * p2 - phasor) * Math.abs(pww - 0.5) * 2;
                }
                out[n] = phasor + pm * thisSample;
            } else {
                out[n] = 2 * thisSample - 1;
            }
        }
        this.nextSample = next;
        this.masterFrequency = masterF;
        this.slaveFrequency = slaveF;
        this.pw = pw;
        this.waveshape = waveshape;
        this.phaseModulation = phaseMod;
    }
    renderSimple(f, pw, ws, out, size) {
        this.render(0, f, pw, ws, out, size, false, false, 0);
    }
    renderSync(masterF, slaveF, pw, ws, out, size) {
        this.render(masterF, slaveF, pw, ws, out, size, true, false, 0);
    }
}

class XVarSaw {
    constructor() { this.init(); }
    init() {
        this.phase = 0; this.nextSample = 0; this.previousPw = 0.5; this.high = false;
        this.frequency = 0.01; this.pw = 0.5; this.waveshape = 0;
    }
    naive(phase, pw, slopeUp, slopeDown, triAmt, notchAmt) {
        const notchSaw = phase < pw ? phase : 1 + X_VA_NOTCH;
        const triangle = phase < pw ? phase * slopeUp : 1 - (phase - pw) * slopeDown;
        return notchSaw * notchAmt + triangle * triAmt;
    }
    render(frequency, pw, waveshape, out, size) {
        if (frequency >= X_K_MAX_F) frequency = X_K_MAX_F;
        if (frequency >= 0.25) pw = 0.5;
        else pw = xClamp(pw, frequency * 2, 1 - 2 * frequency);
        const dF = (frequency - this.frequency) / size;
        const dPw = (pw - this.pw) / size;
        const dWs = (waveshape - this.waveshape) / size;
        let next = this.nextSample;
        let f = this.frequency, pww = this.pw, ws = this.waveshape;
        for (let n = 0; n < size; n++) {
            f += dF; pww += dPw; ws += dWs;
            let thisSample = next; next = 0;
            const triAmt = ws;
            const notchAmt = 1 - ws;
            const slopeUp = 1 / pww;
            const slopeDown = 1 / (1 - pww);
            this.phase += f;
            if (!this.high && this.phase >= pww) {
                const triStep = (slopeUp + slopeDown) * f * triAmt;
                const notch = (X_VA_NOTCH + 1 - pww) * notchAmt;
                const t = (this.phase - pww) / (this.previousPw - pww + f);
                thisSample += notch * xThisBlep(t);
                next += notch * xNextBlep(t);
                thisSample -= triStep * xThisIntBlep(t);
                next -= triStep * xNextIntBlep(t);
                this.high = true;
            } else if (this.phase >= 1) {
                this.phase -= 1;
                const triStep = (slopeUp + slopeDown) * f * triAmt;
                const notch = (X_VA_NOTCH + 1) * notchAmt;
                const t = this.phase / f;
                thisSample -= notch * xThisBlep(t);
                next -= notch * xNextBlep(t);
                thisSample += triStep * xThisIntBlep(t);
                next += triStep * xNextIntBlep(t);
                this.high = false;
            }
            next += this.naive(this.phase, pww, slopeUp, slopeDown, triAmt, notchAmt);
            this.previousPw = pww;
            out[n] = (2 * thisSample - 1) / (1 + X_VA_NOTCH);
        }
        this.nextSample = next;
        this.frequency = frequency;
        this.pw = pw;
        this.waveshape = waveshape;
    }
}

/** stmlib ZDF SVF (FREQUENCY_DIRTY tan). */
const X_PI = Math.PI;
const X_DIRTY_A = 0.3736 * X_PI * X_PI * X_PI;
class XZdfSvf {
    constructor() { this.init(); }
    init() {
        this.g = 0.01;
        this.r = 1;
        this.h = 1;
        this.s1 = 0;
        this.s2 = 0;
    }
    setFQ(f, q) {
        f = xClamp(f, 0, 0.49);
        q = Math.max(0.1, q);
        const g = f * (X_PI + X_DIRTY_A * f * f);
        const r = 1 / q;
        this.g = g;
        this.r = r;
        this.h = 1 / (1 + r * g + g * g);
    }
    _tick(x) {
        const g = this.g;
        const hp = (x - this.r * this.s1 - g * this.s1 - this.s2) * this.h;
        const bp = g * hp + this.s1;
        this.s1 = g * hp + bp;
        const lp = g * bp + this.s2;
        this.s2 = g * bp + lp;
        return { lp, bp, hp };
    }
    processBP(x) { return this._tick(x).bp; }
    processLP(x) { return this._tick(x).lp; }
    processHP(x) { return this._tick(x).hp; }
    processLPHP(x) { return this._tick(x); }
    processMode(x, mode) {
        const t = this._tick(x);
        return t.lp + (t.hp - t.lp) * mode;
    }
}

/** Plaits Diffuser: nested allpasses + delay (float, no 12-bit compress). */
const X_DIFF_MASK = 8191;
const X_AP = [
    { base: 0, len: 126 },
    { base: 126, len: 180 },
    { base: 306, len: 269 },
    { base: 575, len: 444 },
];
const X_DAPA = { base: 1019, len: 1653 };
const X_DAPB = { base: 2672, len: 2010 };
const X_DEL = { base: 4682, len: 3411 };
class XDiffuser {
    constructor() { this.init(); }
    init() {
        this.buf = new Float32Array(8192);
        this.wp = 0;
        this.lp = 0;
        this.lfoPhase = 0;
    }
    reset() {
        this.buf.fill(0);
        this.lp = 0;
    }
    process(amount, rt, out, size) {
        const buf = this.buf;
        const kap = 0.625;
        const klp = 0.75;
        const lfoInc = 0.3 / sampleRate;
        let wp = this.wp;
        let lp = this.lp;
        let lfoPhase = this.lfoPhase;
        for (let i = 0; i < size; i++) {
            wp = (wp - 1) & X_DIFF_MASK;
            lfoPhase += lfoInc;
            if (lfoPhase >= 1) lfoPhase -= 1;
            const lfo = Math.sin(lfoPhase * X_PI * 2);
            let acc = out[i];
            for (let a = 0; a < 3; a++) {
                const d = X_AP[a];
                const prev = buf[(wp + d.base + d.len - 1) & X_DIFF_MASK];
                acc += prev * kap;
                buf[(wp + d.base) & X_DIFF_MASK] = acc;
                acc = acc * (-kap) + prev;
            }
            const ap4 = X_AP[3];
            let off = 400 + 43 * lfo;
            let oi = off | 0;
            let of = off - oi;
            let pa = buf[(wp + ap4.base + oi) & X_DIFF_MASK];
            let pb = buf[(wp + ap4.base + oi + 1) & X_DIFF_MASK];
            let prev = pa + (pb - pa) * of;
            acc += prev * kap;
            buf[(wp + ap4.base) & X_DIFF_MASK] = acc;
            acc = acc * (-kap) + prev;

            off = 3070 + 340 * lfo;
            oi = off | 0;
            of = off - oi;
            pa = buf[(wp + X_DEL.base + oi) & X_DIFF_MASK];
            pb = buf[(wp + X_DEL.base + oi + 1) & X_DIFF_MASK];
            prev = pa + (pb - pa) * of;
            acc += prev * rt;
            lp += klp * (acc - lp);
            acc = lp;

            prev = buf[(wp + X_DAPA.base + X_DAPA.len - 1) & X_DIFF_MASK];
            acc += prev * (-kap);
            buf[(wp + X_DAPA.base) & X_DIFF_MASK] = acc;
            acc = acc * kap + prev;

            prev = buf[(wp + X_DAPB.base + X_DAPB.len - 1) & X_DIFF_MASK];
            acc += prev * kap;
            buf[(wp + X_DAPB.base) & X_DIFF_MASK] = acc;
            acc = acc * (-kap) + prev;

            buf[(wp + X_DEL.base) & X_DIFF_MASK] = acc;
            const wet = acc * 2;
            out[i] += amount * (wet - out[i]);
        }
        this.wp = wp;
        this.lp = lp;
        this.lfoPhase = lfoPhase;
    }
}

class XClockedNoise {
    constructor() { this.init(); }
    init() {
        this.phase = 0; this.sample = 0; this.nextSample = 0; this.frequency = 0.001;
    }
    render(sync, frequency, out, size) {
        frequency = Math.min(frequency, 0.5);
        if (sync) this.phase = 1;
        const dF = (frequency - this.frequency) / size;
        let f = this.frequency;
        let next = this.nextSample;
        for (let i = 0; i < size; i++) {
            f += dF;
            let thisSample = next; next = 0;
            this.phase += f;
            if (this.phase >= 1) {
                this.phase -= 1;
                const t = this.phase / f;
                const newSample = xRand() * 2 - 1;
                const disc = newSample - this.sample;
                thisSample += disc * xThisBlep(t);
                next += disc * xNextBlep(t);
                this.sample = newSample;
            }
            next += this.sample;
            out[i] = thisSample;
        }
        this.nextSample = next;
        this.frequency = frequency;
    }
}

/** Plaits StringSynthOscillator: divide-down saw/square with polyBLEP. */
class XDivideDown {
    constructor() { this.init(); }
    init() {
        this.phase = 0;
        this.nextSample = 0;
        this.segment = 0;
        this.frequency = 0.001;
        this.saw8 = 0; this.saw4 = 0; this.saw2 = 0; this.saw1 = 0;
    }
    render(frequency, unshifted, gain, out, size) {
        frequency *= 8;
        let shift = 0;
        while (frequency > 0.5) {
            shift += 2;
            frequency *= 0.5;
        }
        if (shift >= 8) return;
        const reg = [0, 0, 0, 0, 0, 0, 0];
        const nCopy = 7 - shift;
        for (let i = 0; i < nCopy; i++) reg[shift + i] = unshifted[i] || 0;
        const t8 = (reg[0] + 2 * reg[1]) * gain;
        const t4 = (reg[2] - reg[1] + 2 * reg[3]) * gain;
        const t2 = (reg[4] - reg[3] + 2 * reg[5]) * gain;
        const t1 = ((reg[6] || 0) - reg[5]) * gain;
        const dF = (frequency - this.frequency) / size;
        const d8 = (t8 - this.saw8) / size;
        const d4 = (t4 - this.saw4) / size;
        const d2 = (t2 - this.saw2) / size;
        const d1 = (t1 - this.saw1) / size;
        let phase = this.phase;
        let next = this.nextSample;
        let segment = this.segment;
        let f = this.frequency, g8 = this.saw8, g4 = this.saw4, g2 = this.saw2, g1 = this.saw1;
        for (let i = 0; i < size; i++) {
            f += dF; g8 += d8; g4 += d4; g2 += d2; g1 += d1;
            let thisSample = next; next = 0;
            phase += f;
            let nextSeg = phase | 0;
            if (nextSeg !== segment) {
                let disc = 0;
                if (nextSeg === 8) {
                    phase -= 8;
                    nextSeg -= 8;
                    disc -= g8;
                }
                if ((nextSeg & 3) === 0) disc -= g4;
                if ((nextSeg & 1) === 0) disc -= g2;
                disc -= g1;
                if (disc !== 0) {
                    const fraction = phase - nextSeg;
                    const t = fraction / f;
                    thisSample += xThisBlep(t) * disc;
                    next += xNextBlep(t) * disc;
                }
            }
            segment = nextSeg;
            next += (phase - 4) * g8 * 0.125;
            next += (phase - (segment & 4) - 2) * g4 * 0.25;
            next += (phase - (segment & 6) - 1) * g2 * 0.5;
            next += (phase - (segment & 7) - 0.5) * g1;
            out[i] += 2 * thisSample;
        }
        this.nextSample = next;
        this.phase = phase;
        this.segment = segment;
        this.frequency = frequency;
        this.saw8 = t8; this.saw4 = t4; this.saw2 = t2; this.saw1 = t1;
    }
}

class XSuperSquare {
    constructor() { this.init(); }
    init() {
        this.masterPhase = 0; this.slavePhase = 0; this.nextSample = 0;
        this.high = false;
        this.masterFrequency = 0; this.slaveFrequency = 0.01;
    }
    render(frequency, shape, out, size) {
        let masterF = frequency;
        frequency *= shape < 0.5
            ? (0.51 + 0.98 * shape)
            : 1 + 16 * (shape - 0.5) * (shape - 0.5);
        if (masterF >= X_K_MAX_F) masterF = X_K_MAX_F;
        if (frequency >= X_K_MAX_F) frequency = X_K_MAX_F;
        const dM = (masterF - this.masterFrequency) / size;
        const dS = (frequency - this.slaveFrequency) / size;
        let next = this.nextSample;
        let mF = this.masterFrequency, sF = this.slaveFrequency;
        for (let n = 0; n < size; n++) {
            mF += dM; sF += dS;
            let reset = false, transitionDuringReset = false, resetTime = 0;
            let thisSample = next; next = 0;
            this.masterPhase += mF;
            if (this.masterPhase >= 1) {
                this.masterPhase -= 1;
                resetTime = this.masterPhase / mF;
                let slaveAtReset = this.slavePhase + (1 - resetTime) * sF;
                reset = true;
                if (slaveAtReset >= 1) { slaveAtReset -= 1; transitionDuringReset = true; }
                if (!this.high && slaveAtReset >= 0.5) transitionDuringReset = true;
                const value = slaveAtReset < 0.5 ? 0 : 1;
                thisSample -= value * xThisBlep(resetTime);
                next -= value * xNextBlep(resetTime);
            }
            this.slavePhase += sF;
            while (transitionDuringReset || !reset) {
                if (!this.high) {
                    if (this.slavePhase < 0.5) break;
                    const t = (this.slavePhase - 0.5) / sF;
                    thisSample += xThisBlep(t);
                    next += xNextBlep(t);
                    this.high = true;
                }
                if (this.high) {
                    if (this.slavePhase < 1) break;
                    this.slavePhase -= 1;
                    const t = this.slavePhase / sF;
                    thisSample -= xThisBlep(t);
                    next -= xNextBlep(t);
                    this.high = false;
                }
            }
            if (reset) {
                this.slavePhase = resetTime * sF;
                this.high = false;
            }
            next += this.slavePhase < 0.5 ? 0 : 1;
            out[n] = 2 * thisSample - 1;
        }
        this.nextSample = next;
        this.masterFrequency = masterF;
        this.slaveFrequency = frequency;
    }
}

class XNesTriangle {
    constructor() { this.init(); }
    init() {
        this.phase = 0; this.nextSample = 0; this.step = 0;
        this.ascending = true; this.frequency = 0.001;
    }
    render(frequency, out, size) {
        const numSteps = 16;
        const half = 8;
        const top = 15;
        const scale = 4 / 14;
        frequency = Math.min(frequency, 0.25);
        const dF = (frequency - this.frequency) / size;
        let next = this.nextSample;
        let f = this.frequency;
        for (let n = 0; n < size; n++) {
            f += dF;
            this.phase += f;
            let fade = (f - 0.5 / numSteps) * 2 * numSteps;
            fade = xClamp01(fade);
            const nesGain = 1 - fade;
            const triGain = fade * 2 / scale;
            let thisSample = next; next = 0;
            if (this.ascending && this.phase >= 0.5) {
                const disc = 4 * f * triGain;
                if (disc) {
                    const t = (this.phase - 0.5) / f;
                    thisSample -= xThisIntBlep(t) * disc;
                    next -= xNextIntBlep(t) * disc;
                }
                this.ascending = false;
            }
            let nextStep = (this.phase * numSteps) | 0;
            if (nextStep !== this.step) {
                let wrap = false;
                if (nextStep >= numSteps) {
                    this.phase -= 1;
                    nextStep -= numSteps;
                    wrap = true;
                }
                let disc = nextStep < half ? 1 : -1;
                if (nextStep === 0 || nextStep === half) disc = 0;
                disc *= nesGain;
                if (disc) {
                    const frac = this.phase * numSteps - nextStep;
                    const t = frac / (f * numSteps);
                    thisSample += xThisBlep(t) * disc;
                    next += xNextBlep(t) * disc;
                }
                if (wrap) {
                    const d = 4 * f * triGain;
                    if (d) {
                        const t = this.phase / f;
                        thisSample += xThisIntBlep(t) * d;
                        next += xNextIntBlep(t) * d;
                    }
                    this.ascending = true;
                }
            }
            this.step = nextStep;
            next += nesGain * (this.step < half ? this.step : top - this.step);
            next += triGain * (this.phase < 0.5 ? 2 * this.phase : 2 - 2 * this.phase);
            out[n] = thisSample * scale - 1;
        }
        this.nextSample = next;
        this.frequency = frequency;
    }
}

class XGrainlet {
    constructor() { this.init(); }
    init() {
        this.carrierPhase = 0; this.formantPhase = 0; this.nextSample = 0;
        this.carrierF = 0; this.formantF = 0; this.shape = 0; this.bleed = 0;
    }
    carrier(phase, shape) {
        shape *= 3;
        let shapeI = Math.floor(shape);
        let t = 1 - (shape - shapeI);
        if (shapeI <= 0) {
            phase = phase * (1 + t * t * t * 15);
            if (phase >= 1) phase = 1;
            phase += 0.75;
        } else if (shapeI === 1) {
            const breakpoint = 0.001 + 0.499 * t * t * t;
            if (phase < breakpoint) phase *= (0.5 / breakpoint);
            else phase = 0.5 + (phase - breakpoint) * 0.5 / (1 - breakpoint);
            phase += 0.75;
        } else {
            t = 1 - t;
            phase = 0.25 + phase * (0.5 + t * t * t * 14.5);
            if (phase >= 0.75) phase = 0.75;
        }
        return (xSine01(phase) + 1) * 0.25;
    }
    grainlet(cPhase, fPhase, shape, bleed) {
        const carrier = this.carrier(cPhase, shape);
        const formant = xSine01(fPhase);
        return carrier * (formant + bleed) / (1 + bleed);
    }
    render(f0, f1, shape, bleed, out, size) {
        f0 = Math.min(f0, X_K_MAX_F * 0.5);
        f1 = Math.min(f1, X_K_MAX_F);
        const d0 = (f0 - this.carrierF) / size;
        const d1 = (f1 - this.formantF) / size;
        const dS = (shape - this.shape) / size;
        const dB = (bleed - this.bleed) / size;
        let cf = this.carrierF, ff = this.formantF, sh = this.shape, bl = this.bleed;
        let next = this.nextSample;
        for (let i = 0; i < size; i++) {
            cf += d0; ff += d1; sh += dS; bl += dB;
            let thisSample = next; next = 0;
            this.carrierPhase += cf;
            if (this.carrierPhase >= 1) {
                this.carrierPhase -= 1;
                const resetTime = this.carrierPhase / cf;
                const before = this.grainlet(1, this.formantPhase + (1 - resetTime) * ff, sh, bl);
                const after = this.grainlet(0, 0, sh, bl);
                const disc = after - before;
                thisSample += disc * xThisBlep(resetTime);
                next += disc * xNextBlep(resetTime);
                this.formantPhase = resetTime * ff;
            } else {
                this.formantPhase += ff;
                if (this.formantPhase >= 1) this.formantPhase -= 1;
            }
            next += this.grainlet(this.carrierPhase, this.formantPhase, sh, bl);
            out[i] = thisSample;
        }
        this.nextSample = next;
        this.carrierF = f0; this.formantF = f1; this.shape = shape; this.bleed = bleed;
    }
}

class XZOscillator {
    constructor() { this.init(); }
    init() {
        this.carrierPhase = 0; this.discontinuityPhase = 0; this.formantPhase = 0;
        this.nextSample = 0;
        this.carrierF = 0; this.formantF = 0; this.carrierShape = 0; this.mode = 0;
    }
    Z(c, d, f, shape, mode) {
        let rampDown = 0.5 * (1 + xSine01(0.5 * d + 0.25));
        let offset, phaseShift;
        if (mode < 0.333) {
            offset = 1;
            phaseShift = 0.25 + mode * 1.50;
        } else if (mode < 0.666) {
            phaseShift = 0.7495 - (mode - 0.33) * 0.75;
            offset = -xSine01(phaseShift);
        } else {
            phaseShift = 0.7495 - (mode - 0.33) * 0.75;
            offset = 0.001;
        }
        const discontinuity = xSine01(f + phaseShift);
        let contour;
        if (shape < 0.5) {
            shape *= 2;
            if (c >= 0.5) rampDown *= shape;
            contour = 1 + (xSine01(c + 0.25) - 1) * shape;
        } else {
            contour = xSine01(c + shape * 0.5);
        }
        return (rampDown * (offset + discontinuity) - offset) * contour;
    }
    render(carrierF, formantF, carrierShape, mode, out, size) {
        if (carrierF >= X_K_MAX_F * 0.5) carrierF = X_K_MAX_F * 0.5;
        if (formantF >= X_K_MAX_F) formantF = X_K_MAX_F;
        const d0 = (carrierF - this.carrierF) / size;
        const d1 = (formantF - this.formantF) / size;
        const dS = (carrierShape - this.carrierShape) / size;
        const dM = (mode - this.mode) / size;
        let f0 = this.carrierF, f1 = this.formantF, sh = this.carrierShape, md = this.mode;
        let next = this.nextSample;
        for (let i = 0; i < size; i++) {
            f0 += d0; f1 += d1; sh += dS; md += dM;
            let thisSample = next; next = 0;
            this.discontinuityPhase += 2 * f0;
            this.carrierPhase += f0;
            const reset = this.discontinuityPhase >= 1;
            if (reset) {
                this.discontinuityPhase -= 1;
                const resetTime = this.discontinuityPhase / (2 * f0);
                const beforeC = this.carrierPhase >= 1 ? 1 : 0.5;
                const afterC = this.carrierPhase >= 1 ? 0 : 0.5;
                const before = this.Z(beforeC, 1, this.formantPhase + (1 - resetTime) * f1, sh, md);
                const after = this.Z(afterC, 0, 0, sh, md);
                const disc = after - before;
                thisSample += disc * xThisBlep(resetTime);
                next += disc * xNextBlep(resetTime);
                this.formantPhase = resetTime * f1;
                if (this.carrierPhase > 1) this.carrierPhase = this.discontinuityPhase * 0.5;
            } else {
                this.formantPhase += f1;
                if (this.formantPhase >= 1) this.formantPhase -= 1;
            }
            if (this.carrierPhase >= 1) this.carrierPhase -= 1;
            next += this.Z(this.carrierPhase, this.discontinuityPhase, this.formantPhase, sh, md);
            out[i] = thisSample;
        }
        this.nextSample = next;
        this.carrierF = carrierF; this.formantF = formantF;
        this.carrierShape = carrierShape; this.mode = mode;
    }
}

class XChordBank {
    constructor() {
        this.ratios = [];
        this.noteCount = [];
        this.sorted = new Float32Array(X_CHORD_N);
        this.idx = 0;
        this.reset();
    }
    reset() {
        this.ratios = [];
        this.noteCount = [];
        for (let i = 0; i < X_CHORD_SEMIS.length; i++) {
            const row = [];
            let count = 0;
            for (let j = 0; j < X_CHORD_N; j++) {
                const s = X_CHORD_SEMIS[i][j];
                row.push(xSemis(s));
                if (s !== 0.01 && s !== 7.01 && s !== 11.99 && s !== 12.00) count++;
            }
            this.ratios.push(row);
            this.noteCount.push(Math.max(1, count));
        }
        this.sort();
    }
    setChord(h) {
        this.idx = xChordIndex(h);
        this.sort();
    }
    ratio(note) { return this.ratios[this.idx][note]; }
    sortedRatio(note) { return this.sorted[note]; }
    numNotes() { return this.noteCount[this.idx]; }
    sort() {
        for (let i = 0; i < X_CHORD_N; i++) {
            let r = this.ratio(i);
            while (r > 2) r *= 0.5;
            this.sorted[i] = r;
        }
        const a = Array.from(this.sorted);
        a.sort((x, y) => x - y);
        for (let i = 0; i < X_CHORD_N; i++) this.sorted[i] = a[i];
    }
    computeInversion(inversion, ratios, amps) {
        const base = this.ratios[this.idx];
        inversion = inversion * (X_CHORD_N * X_CHORD_V);
        const invI = Math.floor(inversion);
        const invF = inversion - invI;
        const numRot = (invI / X_CHORD_N) | 0;
        const rotated = invI % X_CHORD_N;
        const kBaseGain = 0.25;
        for (let i = 0; i < X_CHORD_V; i++) { ratios[i] = 1; amps[i] = 0; }
        let mask = 0;
        for (let i = 0; i < X_CHORD_N; i++) {
            const transposition = 0.25 * (1 << ((X_CHORD_N - 1 + invI - i) / X_CHORD_N | 0));
            const target = (i - numRot + X_CHORD_V) % X_CHORD_V;
            const prev = (target - 1 + X_CHORD_V) % X_CHORD_V;
            if (i === rotated) {
                ratios[target] = base[i] * transposition;
                ratios[prev] = ratios[target] * 2;
                amps[prev] = kBaseGain * invF;
                amps[target] = kBaseGain * (1 - invF);
            } else if (i < rotated) {
                ratios[prev] = base[i] * transposition;
                amps[prev] = kBaseGain;
            } else {
                ratios[target] = base[i] * transposition;
                amps[target] = kBaseGain;
            }
            if (i === 0) {
                if (i >= rotated) mask |= 1 << target;
                if (i <= rotated) mask |= 1 << prev;
            }
        }
        return mask;
    }
}

class XArp {
    constructor() { this.init(); }
    init() {
        this.mode = 0; this.range = 1;
        this.note = 0; this.octave = 0; this.direction = 1;
    }
    clock(numNotes) {
        if (numNotes === 1 && this.range === 1) {
            this.note = 0; this.octave = 0; return;
        }
        if (this.mode === 3) {
            for (let n = 0; n < 8; n++) {
                const octave = (Math.random() * this.range) | 0;
                const note = (Math.random() * numNotes) | 0;
                if (octave !== this.octave || note !== this.note) {
                    this.octave = octave; this.note = note; return;
                }
            }
            return;
        }
        if (this.mode === 0) this.direction = 1;
        if (this.mode === 1) this.direction = -1;
        this.note += this.direction;
        let done = false;
        while (!done) {
            done = true;
            if (this.note >= numNotes || this.note < 0) {
                this.octave += this.direction;
                this.note = this.direction > 0 ? 0 : numNotes - 1;
            }
            if (this.octave >= this.range || this.octave < 0) {
                this.octave = this.direction > 0 ? 0 : this.range - 1;
                if (this.mode === 2) {
                    this.direction = -this.direction;
                    this.note = this.direction > 0 ? 1 : numNotes - 2;
                    this.octave = this.direction > 0 ? 0 : this.range - 1;
                    done = false;
                }
            }
        }
    }
}

class XEnsemble {
    constructor() { this.init(); }
    init() {
        this.l = new Float32Array(512);
        this.r = new Float32Array(512);
        this.wp = 0;
        this.phase1 = 0;
        this.phase2 = 0;
    }
    reset() { this.l.fill(0); this.r.fill(0); }
    process(amount, depth, left, right, size) {
        const p1inc = 0.75 / sampleRate;
        const p2inc = 6.57 / sampleRate;
        const dry = 1 - amount * 0.5;
        const a = depth * 160;
        const b = depth * 16;
        let wp = this.wp;
        for (let i = 0; i < size; i++) {
            this.phase1 += p1inc; if (this.phase1 >= 1) this.phase1 -= 1;
            this.phase2 += p2inc; if (this.phase2 >= 1) this.phase2 -= 1;
            const s0 = Math.sin(this.phase1 * Math.PI * 2);
            const s120 = Math.sin((this.phase1 + 1 / 3) * Math.PI * 2);
            const s240 = Math.sin((this.phase1 + 2 / 3) * Math.PI * 2);
            const f0 = Math.sin(this.phase2 * Math.PI * 2);
            const f120 = Math.sin((this.phase2 + 1 / 3) * Math.PI * 2);
            const f240 = Math.sin((this.phase2 + 2 / 3) * Math.PI * 2);
            const mod1 = s0 * a + f0 * b;
            const mod2 = s120 * a + f120 * b;
            const mod3 = s240 * a + f240 * b;
            this.l[wp] = left[i];
            this.r[wp] = right[i];
            const tap = (buf, mod) => {
                let d = wp - (192 + mod);
                d = ((d % 512) + 512) % 512;
                const i0 = d | 0;
                const frac = d - i0;
                const a0 = buf[i0];
                const a1 = buf[(i0 + 1) & 511];
                return a0 + (a1 - a0) * frac;
            };
            const wetL = (tap(this.l, mod1) + tap(this.l, mod2) + tap(this.r, mod3)) * 0.33;
            const wetR = (tap(this.r, mod1) + tap(this.r, mod2) + tap(this.l, mod3)) * 0.33;
            left[i] = wetL * amount + left[i] * dry;
            right[i] = wetR * amount + right[i] * dry;
            wp = (wp + 1) & 511;
        }
        this.wp = wp;
    }
}

class XQuadPath {
    constructor() { this.init(); }
    init() { this.x = 1; this.y = 0; this.eps = 0; this.amp = 0; }
    render(freq, amp, xs, ys, size) {
        if (freq >= 0.25) { freq = 0.25; amp = 0; }
        else amp *= 1 - freq * 4;
        const dE = (xFast2Sin(freq) - this.eps) / size;
        const dA = (amp - this.amp) / size;
        let e = this.eps, a = this.amp, x = this.x, y = this.y;
        const nrm = x * x + y * y;
        if (nrm <= 0.5 || nrm >= 2) {
            const s = 1 / Math.sqrt(Math.max(nrm, 1e-12));
            x *= s; y *= s;
        }
        for (let i = 0; i < size; i++) {
            e += dE; a += dA;
            x += e * y;
            y -= e * x;
            xs[i] = x * a;
            ys[i] = y * a;
        }
        this.x = x; this.y = y; this.eps = e; this.amp = amp;
    }
}

class XAddSaw {
    constructor() { this.init(); }
    init() { this.phase = 0; this.nextSample = 0; this.frequency = 0.01; this.gain = 0; }
    render(frequency, level, out, size) {
        if (frequency >= X_K_MAX_F) frequency = X_K_MAX_F;
        const dF = (frequency - this.frequency) / size;
        const dG = (level - this.gain) / size;
        let next = this.nextSample;
        let f = this.frequency, g = this.gain;
        let phase = this.phase;
        for (let i = 0; i < size; i++) {
            f += dF; g += dG;
            let thisSample = next; next = 0;
            phase += f;
            if (phase >= 1) {
                phase -= 1;
                const t = phase / f;
                thisSample -= xThisBlep(t);
                next -= xNextBlep(t);
            }
            next += phase;
            out[i] += (2 * thisSample - 1) * g;
        }
        this.phase = phase;
        this.nextSample = next;
        this.frequency = frequency;
        this.gain = level;
    }
}

function xEnsureVa(self) {
    if (self._xVa && self._xVa.version === 5) return self._xVa;
    self._xVa = {
        version: 5,
        primary: new XVarShape(),
        auxiliary: new XVarShape(),
        sync: new XVarShape(),
        saw: new XVarSaw(),
        temp: null,
        aux: null,
        auxAmt: 0,
        xmodAmt: 0,
    };
    self._xVa.auxiliary.masterPhase = 0.25;
    return self._xVa;
}

function xEnsureVaVcf(self) {
    if (self._xVaVcf && self._xVaVcf.version === 5) return self._xVaVcf;
    self._xVaVcf = {
        version: 5,
        osc: new XVarShape(),
        sub: new XVarShape(),
        svf0: new XZdfSvf(),
        svf1: new XZdfSvf(),
        subGain: 0, cutoff: 0, stage2: 0, q: 0, gain: 0.85,
        aux: null,
    };
    return self._xVaVcf;
}

function xEnsureAdditive(self) {
    if (self._xAdd && self._xAdd.version === 5) return self._xAdd;
    self._xAdd = {
        version: 5,
        amps: new Float32Array(X_ADD_N + 8),
        phases: new Float32Array(X_ADD_N),
        organPhases: new Float32Array(8),
        aux: null,
    };
    return self._xAdd;
}

function xEnsureGrain(self) {
    if (self._xGrain && self._xGrain.version === 5) return self._xGrain;
    self._xGrain = {
        version: 5,
        g0: new XGrainlet(),
        g1: new XGrainlet(),
        z: new XZOscillator(),
        hp: 0,
        hpAux: 0,
        aux: null,
    };
    return self._xGrain;
}

function xEnsureSwarm(self) {
    if (self._xSwarm && self._xSwarm.version === 5) return self._xSwarm;
    const voices = [];
    const n = (X_SWARM_N - 1) / 2;
    for (let i = 0; i < X_SWARM_N; i++) {
        const rank = (i - n) / n;
        voices.push({
            rank,
            from: 0, interval: 1, gPhase: 1, fm: 0.5, amp: 0.5,
            prevSize: 0, fc: 0, sinePhase: xRand(),
            saw: new XAddSaw(),
        });
    }
    self._xSwarm = { version: 5, voices, aux: null };
    return self._xSwarm;
}

function xEnsureNoise(self) {
    if (self._xNoise && self._xNoise.version === 5) return self._xNoise;
    self._xNoise = {
        version: 5,
        n0: new XClockedNoise(),
        n1: new XClockedNoise(),
        svf: new XZdfSvf(),
        bp0: new XZdfSvf(),
        bp1: new XZdfSvf(),
        f0: 0, f1: 0, q: 0.5, mode: 0,
        temp: null, aux: null,
    };
    return self._xNoise;
}

function xEnsureParticle(self) {
    if (self._xPart && self._xPart.version === 5) return self._xPart;
    const parts = [];
    for (let i = 0; i < X_PART_N; i++) {
        parts.push({ preGain: 0, svf: new XZdfSvf() });
    }
    self._xPart = {
        version: 5,
        parts,
        post: new XZdfSvf(),
        diffuser: new XDiffuser(),
        aux: null,
    };
    return self._xPart;
}

function xEnsurePd(self) {
    if (self._xPd && self._xPd.version === 5) return self._xPd;
    self._xPd = {
        version: 5,
        shaper: new XVarShape(),
        mod: new XVarShape(),
        synced: null,
        free: null,
        aux: null,
    };
    return self._xPd;
}

function xEnsureTerrain(self) {
    if (self._xTerrain && self._xTerrain.version === 5) return self._xTerrain;
    self._xTerrain = {
        version: 5,
        path: new XQuadPath(),
        offset: 0, terrain: 0,
        px: null, py: null, aux: null,
    };
    return self._xTerrain;
}

function xEnsureSM(self) {
    if (self._xSm && self._xSm.version === 5) return self._xSm;
    const voices = [];
    for (let i = 0; i < X_CHORD_N; i++) voices.push(new XDivideDown());
    self._xSm = {
        version: 5,
        voices,
        chords: new XChordBank(),
        svf0: new XZdfSvf(),
        svf1: new XZdfSvf(),
        morphLp: 0, timbreLp: 0,
        ensemble: new XEnsemble(),
        aux: null,
        harm: new Float32Array(8),
    };
    return self._xSm;
}

function xEnsureChip(self) {
    if (self._xChip && self._xChip.version === 5) return self._xChip;
    const voices = [];
    for (let i = 0; i < X_CHORD_V; i++) voices.push(new XSuperSquare());
    self._xChip = {
        version: 5,
        voices,
        bass: new XNesTriangle(),
        chords: new XChordBank(),
        arp: new XArp(),
        temp: null,
        aux: null,
        ratios: new Float32Array(X_CHORD_V),
        amps: new Float32Array(X_CHORD_V),
    };
    return self._xChip;
}

function xEnsureChord(self) {
    if (self._xChord && self._xChord.version === 5) return self._xChord;
    const dd = [];
    for (let i = 0; i < X_CHORD_V; i++) dd.push(new XDivideDown());
    self._xChord = {
        version: 5,
        dd,
        chords: new XChordBank(),
        morphLp: 0, timbreLp: 0,
        phases: new Float32Array(X_CHORD_V),
        aux: null,
        ratios: new Float32Array(X_CHORD_V),
        amps: new Float32Array(X_CHORD_V),
        harm: new Float32Array(8),
    };
    return self._xChord;
}

function xTerrainFn(x, y, idx, tables) {
    const k = 4.0;
    const S = (p) => Math.sin(p * Math.PI * 2);
    const squash = (v, a) => { v *= a; return v / (1 + Math.abs(v)); };
    switch (idx | 0) {
        case 0:
            return (squash(S(k + x * 1.273), 2) - S(k + y * (x + 1.571) * 0.637)) * 0.57;
        case 1: {
            const xy = x * y;
            return S(k + S(k + (x + y) * 0.637) / (0.2 + xy * xy) * 0.159);
        }
        case 2: {
            const xy = x * y;
            return S(k + S(k + 2.387 * xy) / (0.350 + xy * xy) * 0.159);
        }
        case 3: {
            const xy = x * y;
            const xys = (x - 0.25) * (y + 0.25);
            return S(k + xy / (2 + Math.abs(5 * xys)) * 6.366);
        }
        case 4:
            return S(0.159 / (0.170 + Math.abs(y - 0.25)) + 0.477 / (0.350 + Math.abs((x + 0.5) * (y + 1.5))) + k);
        default: {
            const bankI = 2 - ((idx | 0) - 5);
            if (tables && tables[bankI] && (idx | 0) >= 5 && (idx | 0) <= 7) {
                const sample = (y + 1) * 0.5 * 128;
                const wt = (x + 1) * 0.5 * 63;
                const si = Math.floor(xClamp(sample, 0, 126));
                const sf = sample - si;
                const wi = Math.floor(xClamp(wt, 0, 62));
                const wf = wt - wi;
                const z0 = xSampleIntegrated(tables[bankI], wi, (si + sf) / 128);
                const z1 = xSampleIntegrated(tables[bankI], Math.min(63, wi + 1), (si + sf) / 128);
                return (z0 + (z1 - z0) * wf) * 4;
            }
            const b = 2 - (idx - 5);
            return 0.5 * S(k + x * (2 + b) + y * (3 - b) * 0.5) + 0.5 * S(k + y * (1.5 + b) - x * b);
        }
    }
}

function xUpdateAddAmps(amps, offset, indices, n, centroid, slope, bumps) {
    const nn = n - 1;
    const margin = (1 / slope - 1) / (1 + bumps);
    const center = centroid * (nn + margin) - 0.5 * margin;
    let sum = 0.001;
    for (let i = 0; i < n; i++) {
        let order = Math.abs(i - center) * slope;
        let gain = 1 - order;
        gain += Math.abs(gain);
        gain *= gain;
        const b = 0.25 + order * bumps;
        gain *= 1 + Math.sin(b * Math.PI * 2);
        gain *= gain; gain *= gain;
        const j = offset + indices[i];
        amps[j] += 0.001 * (gain - amps[j]);
        sum += amps[j];
    }
    const inv = 1 / sum;
    for (let i = 0; i < n; i++) amps[offset + indices[i]] *= inv;
}

export function installExtraEngines(proto) {
    proto.processVa = function processVa(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureVa(this);
        const size = out.length;
        if (!st.temp || st.temp.length !== size) {
            st.temp = new Float32Array(size);
            st.aux = new Float32Array(size);
        }
        const detune = xVaDetune(p.harmonics);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const primaryF = Math.min(X_K_MAX_F, hz / sampleRate);
        const auxF = Math.min(X_K_MAX_F, hz * xSemis(detune) / sampleRate);
        const syncAmt = p.timbre * p.timbre;
        const primarySyncF = Math.min(X_K_MAX_F, hz * xSemis(syncAmt * 48) / sampleRate);
        const auxSyncF = Math.min(X_K_MAX_F, hz * xSemis(detune + syncAmt * 48) / sampleRate);

        let shape = p.morph * 1.5; shape = xClamp01(shape);
        let pw = 0.5 + (p.morph - 0.66) * 1.46; pw = xClamp(pw, 0.5, 0.995);

        st.primary.renderSync(primaryF, primarySyncF, pw, shape, out, size);
        st.auxiliary.renderSync(auxF, auxSyncF, pw, shape, st.aux, size);
        for (let i = 0; i < size; i++) st.aux[i] = (st.aux[i] - out[i]) * 0.5;

        let squarePw = 1.3 * p.timbre - 0.15; squarePw = xClamp(squarePw, 0.005, 0.5);
        const squareSyncRatio = p.timbre < 0.5 ? 0 : (p.timbre - 0.5) * (p.timbre - 0.5) * 4 * 48;
        const squareGain = Math.min(p.timbre * 8, 1);
        let sawPw = p.morph < 0.5 ? p.morph + 0.5 : 1 - (p.morph - 0.5) * 2;
        sawPw *= 1.1; sawPw = xClamp(sawPw, 0.005, 1);
        let sawShape = 10 - 21 * p.morph; sawShape = xClamp01(sawShape);
        let sawGain = 8 * (1 - p.morph); sawGain = xClamp(sawGain, 0.02, 1);
        const squareSyncF = Math.min(X_K_MAX_F, hz * xSemis(squareSyncRatio) / sampleRate);

        st.sync.renderSync(primaryF, squareSyncF, squarePw, 1.0, st.temp, size);
        st.saw.render(auxF, sawPw, sawShape, out, size);
        const norm = 1 / Math.max(squareGain, sawGain);
        const sqG = squareGain * 0.3 * norm;
        const swG = sawGain * 0.5 * norm;
        const dSq = (sqG - st.auxAmt) / size;
        const dSw = (swG - st.xmodAmt) / size;
        let aSq = st.auxAmt, aSw = st.xmodAmt;
        for (let i = 0; i < size; i++) {
            aSq += dSq; aSw += dSw;
            out[i] = out[i] * aSw + aSq * st.temp[i];
        }
        st.auxAmt = sqG; st.xmodAmt = swG;
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processVaVcf = function processVaVcf(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureVaVcf(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = Math.min(X_K_MAX_F, hz / sampleRate);
        let shape = (p.morph - 0.25) * 2 + 0.5; shape = xClamp(shape, 0.5, 1);
        let pw = (p.morph - 0.5) * 2 + 0.5;
        if (p.morph > 0.75) pw = 2.5 - p.morph * 2;
        pw = xClamp(pw, 0.5, 0.98);
        let subGain = Math.max(Math.abs(p.morph - 0.5) - 0.3, 0) * 5;
        st.osc.renderSimple(f0, pw, shape, out, size);
        st.sub.renderSimple(f0 * 0.501, 0.5, 1.0, st.aux, size);
        const cutoffTarget = Math.min(0.25, f0 * xSemis((p.timbre - 0.2) * 120));
        let stage2 = 1 - (p.harmonics - 0.4) * 4; stage2 = xClamp01(stage2);
        const resonance = 2.667 * Math.max(Math.abs(p.harmonics - 0.5) - 0.125, 0);
        const res2 = resonance * resonance;
        const qTarget = res2 * res2 * 48;
        let gainTarget = (p.harmonics - 0.7) + 0.85;
        gainTarget = xClamp(gainTarget, 0.7 - res2 * 0.3, 1);

        const dSub = (subGain - st.subGain) / size;
        const dCut = (cutoffTarget - st.cutoff) / size;
        const dSt2 = (stage2 - st.stage2) / size;
        const dQ = (qTarget - st.q) / size;
        const dG = (gainTarget - st.gain) / size;
        let subG = st.subGain, cut = st.cutoff, st2 = st.stage2, q = st.q, g = st.gain;
        for (let i = 0; i < size; i++) {
            subG += dSub; cut += dCut; st2 += dSt2; q += dQ; g += dG;
            st.svf0.setFQ(Math.min(cut, 0.25), 0.5 + q);
            st.svf1.setFQ(Math.min(cut, 0.25), 0.5 + 0.025 * q);
            const input = xSoftClip((out[i] + st.aux[i] * subG) * g);
            const { lp: lp0, hp } = st.svf0.processLPHP(input);
            let lp = xSoftClip(lp0 * g);
            const lp2 = xSoftClip(st.svf1.processLP(lp));
            lp += st2 * (lp2 - lp);
            out[i] = lp;
            st.aux[i] = xSoftClip(hp * g);
        }
        st.subGain = subGain; st.cutoff = cutoffTarget; st.stage2 = stage2; st.q = qTarget; st.gain = gainTarget;
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processAdditive = function processAdditive(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureAdditive(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = hz / sampleRate;
        const centroid = p.timbre;
        const rawBumps = p.harmonics;
        const rawSlope = (1 - 0.6 * rawBumps) * p.morph;
        const slope = 0.01 + 1.99 * rawSlope * rawSlope * rawSlope;
        const bumps = 16 * rawBumps * rawBumps;
        const n = X_ADD_N;
        const idx24 = [];
        for (let i = 0; i < n; i++) idx24.push(i);
        const idx8 = [0, 1, 2, 3, 4, 5, 6, 7];
        xUpdateAddAmps(st.amps, 0, idx24, n, centroid, slope, bumps);
        xUpdateAddAmps(st.amps, n, idx8, 8, centroid, slope, bumps);

        out.fill(0);
        st.aux.fill(0);
        for (let h = 0; h < n; h++) {
            const fh = f0 * (h + 1);
            if (fh >= 0.5) continue;
            let ph = st.phases[h];
            const a = st.amps[h];
            for (let i = 0; i < size; i++) {
                ph += fh;
                if (ph >= 1) ph -= 1;
                out[i] += Math.sin(ph * Math.PI * 2) * a;
            }
            st.phases[h] = ph;
        }
        for (let h = 0; h < 8; h++) {
            const fh = f0 * (X_ORGAN_H[h] + 1);
            if (fh >= 0.5) continue;
            let ph = st.organPhases[h];
            const a = st.amps[n + h];
            for (let i = 0; i < size; i++) {
                ph += fh;
                if (ph >= 1) ph -= 1;
                st.aux[i] += Math.sin(ph * Math.PI * 2) * a;
            }
            st.organPhases[h] = ph;
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processGrain = function processGrain(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureGrain(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const root = xMidiNote(hz);
        const f0 = Math.min(X_K_MAX_F, hz / sampleRate);
        const f1 = Math.min(X_K_MAX_F, xNoteToF(24 + 84 * p.timbre));
        const ratio = xSemis(-24 + 48 * p.harmonics);
        const carrierBleed = p.harmonics < 0.5 ? 1 - 2 * p.harmonics : 0;
        const bleed = carrierBleed * (2 - carrierBleed);
        let carrierShape = 0.33 + (p.morph - 0.33) * Math.max(1 - f0 * 24, 0);
        st.g0.render(f0, f1, carrierShape, bleed, out, size);
        st.g1.render(f0, f1 * ratio, carrierShape, bleed, st.aux, size);
        const hpF = 0.3 * f0;
        for (let i = 0; i < size; i++) {
            const s = out[i] + st.aux[i];
            st.hp += hpF * (s - st.hp);
            out[i] = s - st.hp;
        }
        const cutoff = xNoteToF(root + 96 * p.timbre);
        st.z.render(f0, cutoff, p.morph, p.harmonics, st.aux, size);
        for (let i = 0; i < size; i++) {
            st.hpAux += hpF * (st.aux[i] - st.hpAux);
            st.aux[i] -= st.hpAux;
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processSwarm = function processSwarm(out, parameters) {
        const p = xParams(parameters);
        const { alt, trigPatched } = xFlags(this, parameters);
        const st = xEnsureSwarm(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = hz / sampleRate;
        const density = xNoteToF(p.timbre * 120) * 0.025 * size;
        const spread = p.harmonics * p.harmonics * p.harmonics;
        let sizeRatio = 0.25 * xSemis((1 - p.morph) * 84);
        const burstMode = trigPatched;
        const startBurst = this.prevGate < 0.0001 && p.gate0 >= 0.0001;
        out.fill(0);
        st.aux.fill(0);
        const scale = 1 / X_SWARM_N;
        for (let v = 0; v < X_SWARM_N; v++) {
            const voice = st.voices[v];
            let randomize = false;
            if (startBurst) {
                voice.gPhase = 0.5; voice.fm = 16; randomize = true;
            } else {
                voice.gPhase += (density / size) * voice.fm;
                if (voice.gPhase >= 1) {
                    voice.gPhase -= Math.floor(voice.gPhase);
                    randomize = true;
                }
            }
            if (randomize) {
                voice.from += voice.interval;
                voice.interval = xRand() - voice.from;
                if (burstMode) voice.fm *= 0.8 + 0.2 * xRand();
                else voice.fm = 0.5 + 1.5 * xRand();
            }
            const freqMod = sizeRatio < 1
                ? 2 * (voice.from + voice.interval * voice.gPhase) - 1
                : voice.from;
            let ff = f0 * xSemis(48 * freqMod * spread * voice.rank);
            const linear = voice.rank * (voice.rank + 0.01) * spread * 0.25;
            ff *= 1 + linear;
            ff = Math.min(X_K_MAX_F, ff);
            let targetAmp = 1;
            if (sizeRatio >= 1) {
                let phase = (voice.gPhase - 0.5) * sizeRatio;
                phase = xClamp(phase, -1, 1);
                const e = Math.sin((0.5 * phase + 1.25) * Math.PI * 2);
                targetAmp = 0.5 * (e + 1);
            }
            if ((sizeRatio >= 1) !== (voice.prevSize >= 1)) voice.fc = 0.5;
            voice.fc *= 0.95;
            voice.prevSize = sizeRatio;
            voice.amp += (0.5 - voice.fc) * (targetAmp - voice.amp);
            const amp = voice.amp * scale;
            voice.saw.render(ff, amp, out, size);
            let ph = voice.sinePhase;
            for (let i = 0; i < size; i++) {
                ph += ff;
                if (ph >= 1) ph -= 1;
                st.aux[i] += Math.sin(ph * Math.PI * 2) * amp;
            }
            voice.sinePhase = ph;
            sizeRatio *= 0.97;
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processNoise = function processNoise(out, parameters) {
        const p = xParams(parameters);
        const { alt, trigPatched } = xFlags(this, parameters);
        const st = xEnsureNoise(this);
        const size = out.length;
        if (!st.temp || st.temp.length !== size) {
            st.temp = new Float32Array(size);
            st.aux = new Float32Array(size);
        }
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = Math.min(0.49, hz / sampleRate);
        const f1 = Math.min(0.49, hz * xSemis(p.harmonics * 48 - 24) / sampleRate);
        const clockLowest = trigPatched ? -24 : 0;
        const clockF = Math.min(0.5, xNoteToF(p.timbre * (128 - clockLowest) + clockLowest));
        const q = 0.5 * xSemis(p.morph * 120);
        const sync = this.prevGate < 0.0001 && p.gate0 >= 0.0001;
        st.n0.render(sync, clockF, st.aux, size);
        st.n1.render(sync, clockF * (f1 / Math.max(1e-6, f0)), st.temp, size);
        const dF0 = (f0 - st.f0) / size;
        const dF1 = (f1 - st.f1) / size;
        const dQ = (q - st.q) / size;
        const dM = (p.harmonics - st.mode) / size;
        let cf0 = st.f0, cf1 = st.f1, cq = st.q, cm = st.mode;
        for (let i = 0; i < size; i++) {
            cf0 += dF0; cf1 += dF1; cq += dQ; cm += dM;
            const gain = 1 / Math.sqrt((0.5 + cq) * 40 * Math.max(cf0, 1e-4));
            st.svf.setFQ(cf0, cq);
            st.bp0.setFQ(cf0, cq);
            st.bp1.setFQ(cf1, cq);
            const in1 = st.aux[i] * gain;
            const in2 = st.temp[i] * gain;
            out[i] = st.svf.processMode(in1, cm);
            st.aux[i] = st.bp0.processBP(in1) + st.bp1.processBP(in2);
        }
        st.f0 = f0; st.f1 = f1; st.q = q; st.mode = p.harmonics;
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processParticle = function processParticle(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureParticle(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = Math.min(0.49, hz / sampleRate);
        const densityNote = 60 + p.timbre * p.timbre * 72;
        const densitySqrt = xNoteToF(densityNote);
        const density = densitySqrt * densitySqrt * (1 / X_PART_N);
        const gain = 1 / Math.max(density, 1e-12);
        const qSqrt = p.morph >= 0.5 ? xSemis((p.morph - 0.5) * 120) : 1;
        const q = 0.5 + qSqrt * qSqrt;
        const spread = 48 * p.harmonics * p.harmonics;
        const rawDiffSqrt = 2 * Math.abs(p.morph - 0.5);
        const rawDiff = rawDiffSqrt * rawDiffSqrt;
        const diffusion = p.morph < 0.5 ? rawDiff : 0;
        const sync = this.prevGate < 0.0001 && p.gate0 >= 0.0001;
        out.fill(0);
        st.aux.fill(0);
        for (let pi = 0; pi < X_PART_N; pi++) {
            const part = st.parts[pi];
            let u = xRand();
            if (sync) u = density;
            let canRandomize = true;
            for (let i = 0; i < size; i++) {
                let s = 0;
                if (u <= density) {
                    s = u * gain;
                    if (canRandomize) {
                        const ru = 2 * xRand() - 1;
                        const f = Math.min(f0 * xSemis(spread * ru), 0.25);
                        const den = Math.max(density, 1e-12);
                        const ff = Math.max(f, 1e-6);
                        part.preGain = 0.5 / Math.sqrt(q * ff * Math.sqrt(den));
                        part.svf.setFQ(ff, q);
                        canRandomize = false;
                    }
                }
                st.aux[i] += s;
                out[i] += part.svf.processBP(part.preGain * s);
                u = xRand();
            }
        }
        st.post.setFQ(Math.min(f0, 0.49), 0.5);
        for (let i = 0; i < size; i++) out[i] = st.post.processLP(out[i]);
        if (diffusion > 1e-5) {
            st.diffuser.process(0.8 * diffusion * diffusion, 0.5 * diffusion + 0.25, out, size);
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processPd = function processPd(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsurePd(this);
        const size = out.length;
        const os = size * 2;
        if (!st.synced || st.synced.length !== os) {
            st.synced = new Float32Array(os);
            st.free = new Float32Array(os);
            st.aux = new Float32Array(size);
        }
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = 0.5 * Math.min(X_K_MAX_F, hz / sampleRate);
        const ratioSemis = xFmRatioSemis(p.harmonics);
        const modF = Math.min(0.25, f0 * xSemis(ratioSemis));
        const pw = 0.5 + p.morph * 0.49;
        const amount = 8 * p.timbre * p.timbre * (1 - modF * 3.8);
        st.shaper.render(f0, modF, pw, 0, st.synced, os, true, true, amount);
        st.mod.render(f0, modF, pw, 0, st.free, os, false, true, amount);
        for (let i = 0; i < size; i++) {
            const a = st.synced[i * 2], b = st.synced[i * 2 + 1];
            const c = st.free[i * 2], d = st.free[i * 2 + 1];
            out[i] = 0.5 * (xSine01(a + 0.25) + xSine01(b + 0.25));
            st.aux[i] = 0.5 * (xSine01(c + 0.25) + xSine01(d + 0.25));
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processTerrain = function processTerrain(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureTerrain(this);
        const size = out.length;
        const os = size * 2;
        if (!st.px || st.px.length !== os) {
            st.px = new Float32Array(os);
            st.py = new Float32Array(os);
            st.aux = new Float32Array(size);
        }
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = Math.min(0.25, hz / sampleRate);
        const attenuation = Math.max(1 - 8 * f0, 0);
        const radius = 0.1 + 0.9 * p.timbre * attenuation * (2 - attenuation);
        st.path.render(f0 * 0.5, radius, st.px, st.py, os);
        const offT = 1.9 * p.morph - 1;
        const terT = Math.min(p.harmonics * 1.05, 1) * 7.0001;
        const dOff = (offT - st.offset) / size;
        const dTer = (terT - st.terrain) / size;
        let off = st.offset, ter = st.terrain;
        const tables = this.tables;
        let ij = 0;
        for (let i = 0; i < size; i++) {
            off += dOff; ter += dTer;
            const zi = Math.floor(ter);
            const zf = ter - zi;
            let outS = 0, auxS = 0;
            for (let j = 0; j < 2; j++) {
                const x = st.px[ij] * (1 - Math.abs(off)) + off;
                const y = st.py[ij];
                ij++;
                const z0 = xTerrainFn(x, y, zi, tables);
                const z1 = xTerrainFn(x, y, Math.min(7, zi + 1), tables);
                const z = z0 + (z1 - z0) * zf;
                outS += z;
                auxS += y + z;
            }
            out[i] = 0.5 * outS;
            st.aux[i] = xSine01(1 + 0.25 * auxS);
        }
        st.offset = offT; st.terrain = terT;
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processStringMachine = function processStringMachine(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureSM(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        st.morphLp += 0.1 * (p.morph - st.morphLp);
        st.timbreLp += 0.1 * (p.timbre - st.timbreLp);
        xRegistration(X_REG_SM, st.morphLp, st.harm);
        st.chords.setChord(p.harmonics);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = (hz * 0.998) / sampleRate;
        const nVoices = this.polyMode ? 2 : X_CHORD_N;
        out.fill(0); st.aux.fill(0);
        for (let note = 0; note < nVoices; note++) {
            const noteF0 = f0 * st.chords.ratio(note);
            let g = 4 - noteF0 * 32; g = xClamp01(g);
            const dest = (note & 1) ? st.aux : out;
            st.voices[note].render(noteF0, st.harm, 0.25 * g, dest, size);
        }
        const cutoff = Math.min(0.49, 2.2 * f0 * xSemis(120 * p.timbre));
        st.svf0.setFQ(cutoff, 1);
        st.svf1.setFQ(Math.min(0.49, cutoff * 1.5), 1);
        for (let i = 0; i < size; i++) {
            const l = st.svf0.processLP(out[i]);
            const r = st.svf1.processLP(st.aux[i]);
            out[i] = 0.66 * l + 0.33 * r;
            st.aux[i] = 0.66 * r + 0.33 * l;
        }
        const amount = Math.abs(p.timbre - 0.5) * 2;
        const depth = 0.35 + 0.65 * p.timbre;
        st.ensemble.process(amount, depth, out, st.aux, size);
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processChiptune = function processChiptune(out, parameters) {
        const p = xParams(parameters);
        const { alt, trigPatched } = xFlags(this, parameters);
        const st = xEnsureChip(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) {
            st.aux = new Float32Array(size);
            st.temp = new Float32Array(size);
        }
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = hz / sampleRate;
        const shape = p.morph * 0.995;
        const rising = this.prevGate < 0.0001 && p.gate0 >= 0.0001;
        let rootX = 1;

        if (trigPatched) {
            if (rising) {
                st.chords.setChord(p.harmonics);
                const pattern = xClamp((p.timbre * 12) | 0, 0, 11);
                st.arp.mode = (pattern / 3) | 0;
                st.arp.range = 1 << (pattern % 3);
                st.arp.clock(st.chords.numNotes());
                st.envState = 1;
            }
            const octave = 1 << st.arp.octave;
            const noteF0 = f0 * st.chords.sortedRatio(st.arp.note) * octave;
            rootX = octave;
            st.voices[0].render(noteF0, shape, out, size);
        } else {
            st.chords.setChord(p.harmonics);
            st.chords.computeInversion(p.timbre, st.ratios, st.amps);
            for (let j = 1; j < X_CHORD_V; j += 2) st.amps[j] = -st.amps[j];
            out.fill(0);
            for (let v = 0; v < X_CHORD_V; v++) {
                if (st.amps[v] === 0) continue;
                st.voices[v].render(f0 * st.ratios[v], shape, st.temp, size);
                const amp = st.amps[v];
                for (let i = 0; i < size; i++) out[i] += st.temp[i] * amp;
            }
        }
        st.bass.render(f0 * 0.5 * rootX, st.aux, size);
        // chiptune_engine.cc envelope: shape from the TIMBRE amount when clocked.
        const envShape = this.chipEnvShape;
        if (envShape != null) {
            const shape = Math.abs(envShape);
            const perHw = 1 - (2 / 48000) * Math.pow(2, (60 * shape) / 12) * shape;
            const decay = Math.pow(Math.max(0, perHw), 47872.34 / sampleRate);
            const auxTarget = xClamp01(envShape * 20);
            let state = st.envState ?? 0;
            let auxAmt = st.envAux ?? 0;
            for (let i = 0; i < size; i++) {
                auxAmt += 0.01 * (auxTarget - auxAmt);
                state *= decay;
                out[i] *= state;
                st.aux[i] *= 1 + auxAmt * (state - 1);
            }
            st.envState = state;
            st.envAux = auxAmt;
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };

    proto.processChord = function processChord(out, parameters) {
        const p = xParams(parameters);
        const { alt } = xFlags(this, parameters);
        const st = xEnsureChord(this);
        const size = out.length;
        if (!st.aux || st.aux.length !== size) st.aux = new Float32Array(size);
        st.morphLp += 0.1 * (p.morph - st.morphLp);
        st.timbreLp += 0.1 * (p.timbre - st.timbreLp);
        let registration = Math.max(1 - st.morphLp * 2.15, 0);
        xRegistration(X_REG_CHORD, registration, st.harm);
        st.chords.setChord(p.harmonics);
        const mask = st.chords.computeInversion(st.timbreLp, st.ratios, st.amps);
        const hz = xHz(p.freqArr, p.detuneArr, 0);
        const f0 = (hz * 0.998) / sampleRate;
        const waveform = Math.max((st.morphLp - 0.535) * 2.15, 0);
        const tables = this.tables;
        out.fill(0);
        st.aux.fill(0);
        for (let note = 0; note < X_CHORD_V; note++) {
            const dest = (1 << note) & mask ? st.aux : out;
            const noteF0 = f0 * st.ratios[note];
            let g = 4 - noteF0 * 32; g = xClamp01(g);
            let wtAmt = 50 * (st.morphLp - X_CHORD_FADE[note]);
            wtAmt = xClamp01(wtAmt);
            if (st.amps[note] < 1e-6) continue;
            let ddAmt = (1 - wtAmt) * g;
            if (ddAmt > 0.001) {
                st.dd[note].render(noteF0, st.harm, st.amps[note] * ddAmt, dest, size);
            }
            if (wtAmt > 0.001) {
                let ph = st.phases[note];
                const amp = st.amps[note] * wtAmt;
                const nf = noteF0 * 1.004;
                for (let i = 0; i < size; i++) {
                    ph += nf;
                    if (ph >= 1) ph -= 1;
                    let w;
                    if (tables && tables[0]) {
                        const x = waveform * 14;
                        const i0 = Math.min(14, Math.floor(x));
                        const fr = x - i0;
                        const a = X_CHORD_WT[i0];
                        const b = X_CHORD_WT[Math.min(14, i0 + 1)];
                        const s0 = xSampleIntegrated(tables[a[0]], a[1], ph);
                        const s1 = xSampleIntegrated(tables[b[0]], b[1], ph);
                        w = (s0 + (s1 - s0) * fr) * 4;
                    } else {
                        const sine = Math.sin(ph * Math.PI * 2);
                        const saw = 2 * ph - 1;
                        const sq = ph < 0.5 ? 1 : -1;
                        w = sine + (saw - sine) * Math.min(waveform * 2, 1);
                        w += (sq - w) * Math.max(waveform * 2 - 1, 0);
                    }
                    dest[i] += w * amp;
                }
                st.phases[note] = ph;
            }
        }
        for (let i = 0; i < size; i++) {
            out[i] += st.aux[i];
            st.aux[i] *= 3;
        }
        xEmit(out, out, st.aux, alt, size);
        xApplyGate(this, out, p.gateArr, p.gate0);
        return true;
    };
}
