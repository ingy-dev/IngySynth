// Copyright 2016 Emilie Gillet.
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
// Mutable Instruments Plaits Speech engine — AudioWorklet port for IngySynth.
// Faithful JS port of speech_engine + naive / SAM / LPC10 synths.

const SP_PI = Math.PI;
const SP_TWO_PI = Math.PI * 2;
const SP_U32 = 4294967296;
const SP_DIRTY_A = 0.3736 * SP_PI * SP_PI * SP_PI;
const SP_GATE_UP = 0.004;
const SP_GATE_DOWN = 0.014;
const SP_LPC_ORDER = 10;
const SP_LPC_DEFAULT_F0 = 100;
const SP_LPC_FPS = 40;
const SP_LPC_MAX_WORDS = 32;
const SP_LPC_MAX_FRAMES = 1024;
const SP_LPC_NUM_VOWELS = 5;
const SP_LPC_NUM_CONSONANTS = 10;
const SP_LPC_NUM_PHONEMES = SP_LPC_NUM_VOWELS + SP_LPC_NUM_CONSONANTS;
const SP_LPC_PULSE_SIZE = 640;
const SP_NAIVE_FORMANTS = 5;
const SP_NAIVE_PHONEMES = 5;
const SP_NAIVE_REGISTERS = 5;
const SP_SAM_FORMANTS = 3;
const SP_SAM_VOWELS = 9;
const SP_SAM_CONSONANTS = 8;

function spClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function spClamp01(v) { return spClamp(v, 0, 1); }
function spSemis(r) { return Math.pow(2, r / 12); }
function spThisBlep(t) { return 0.5 * t * t; }
function spNextBlep(t) { t = 1 - t; return -0.5 * t * t; }
function spSmoothstep(x) { return x * x * (3 - 2 * x); }
function spGateCoeff(sec) { return 1 - Math.exp(-1 / (sampleRate * Math.max(0.001, sec))); }
function spSineRaw(phaseU32) {
  return Math.sin(((phaseU32 >>> 0) / SP_U32) * SP_TWO_PI);
}
function spIntegralFractional(x) {
  const i = Math.floor(x);
  return { i, f: x - i };
}
function spA0Norm() { return (440 / 8) / sampleRate; }

/** Parse little-endian plaits-speech.bin (magic PLSP, version 1). */
export function parseSpeechBin(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 8 + SP_LPC_PULSE_SIZE + 4) return null;
  const view = new DataView(arrayBuffer);
  const b0 = view.getUint8(0);
  const b1 = view.getUint8(1);
  const b2 = view.getUint8(2);
  const b3 = view.getUint8(3);
  if (b0 !== 0x50 || b1 !== 0x4c || b2 !== 0x53 || b3 !== 0x50) return null; // PLSP
  const version = view.getUint32(4, true);
  if (version !== 1) return null;

  const excitation = new Int8Array(SP_LPC_PULSE_SIZE);
  excitation.set(new Int8Array(arrayBuffer, 8, SP_LPC_PULSE_SIZE));

  let o = 8 + SP_LPC_PULSE_SIZE;
  if (o + 4 > arrayBuffer.byteLength) return null;
  const numBanks = view.getUint32(o, true);
  o += 4;
  if (numBanks < 1 || numBanks > 32) return null;
  if (o + numBanks * 4 > arrayBuffer.byteLength) return null;

  const sizes = new Array(numBanks);
  let total = 0;
  for (let i = 0; i < numBanks; i++) {
    sizes[i] = view.getUint32(o, true);
    o += 4;
    total += sizes[i];
  }
  if (o + total > arrayBuffer.byteLength) return null;

  const banks = new Array(numBanks);
  for (let i = 0; i < numBanks; i++) {
    const n = sizes[i];
    const bank = new Uint8Array(n);
    bank.set(new Uint8Array(arrayBuffer, o, n));
    banks[i] = bank;
    o += n;
  }
  return { excitation, banks };
}

// ---------------------------------------------------------------------------
// ZDF SVF (FREQUENCY_DIRTY)
// ---------------------------------------------------------------------------
class SpZdfSvf {
  constructor() { this.init(); }
  init() {
    this.g = 0.01;
    this.r = 1;
    this.h = 1;
    this.s1 = 0;
    this.s2 = 0;
  }
  setFQ(f, q) {
    f = spClamp(f, 0, 0.49);
    q = Math.max(0.1, q);
    const g = f * (SP_PI + SP_DIRTY_A * f * f);
    const r = 1 / q;
    this.g = g;
    this.r = r;
    this.h = 1 / (1 + r * g + g * g);
  }
  processBP(x) {
    const g = this.g;
    const hp = (x - this.r * this.s1 - g * this.s1 - this.s2) * this.h;
    const bp = g * hp + this.s1;
    this.s1 = g * hp + bp;
    const lp = g * bp + this.s2;
    this.s2 = g * bp + lp;
    return bp;
  }
}

// ---------------------------------------------------------------------------
// Impulse-train oscillator (Plaits OSCILLATOR_SHAPE_IMPULSE_TRAIN)
// ---------------------------------------------------------------------------
class SpImpulseTrain {
  constructor() { this.init(); }
  init() {
    this.phase = 0.5;
    this.nextSample = 0;
    this.lpState = 1;
    this.hpState = 0;
    this.frequency = 0.001;
  }
  render(frequency, out, size) {
    frequency = spClamp(frequency, 1e-6, 0.25);
    const dF = (frequency - this.frequency) / Math.max(1, size);
    let f = this.frequency;
    let next = this.nextSample;
    let phase = this.phase;
    let lp = this.lpState;
    let hp = this.hpState;
    for (let n = 0; n < size; n++) {
      f += dF;
      let thisSample = next;
      next = 0;
      phase += f;
      if (phase >= 1) {
        phase -= 1;
        const t = phase / f;
        thisSample -= spThisBlep(t);
        next -= spNextBlep(t);
      }
      next += phase;
      lp += 0.25 * ((hp - thisSample) - lp);
      out[n] = 4 * lp;
      hp = thisSample;
    }
    this.frequency = f;
    this.nextSample = next;
    this.phase = phase;
    this.lpState = lp;
    this.hpState = hp;
  }
}

// ---------------------------------------------------------------------------
// HysteresisQuantizer2 (num_steps=6, hysteresis=0.1, symmetric=false)
// ---------------------------------------------------------------------------
class SpHysteresisQuantizer {
  constructor(numSteps, hysteresis, symmetric) {
    this.numSteps = numSteps;
    this.hysteresis = hysteresis;
    this.scale = symmetric ? (numSteps - 1) : numSteps;
    this.offset = symmetric ? 0 : -0.5;
    this.quantized = 0;
  }
  reset() { this.quantized = 0; }
  process(value) {
    value = value * this.scale + this.offset;
    const sign = value > this.quantized ? -1 : 1;
    let q = (value + sign * this.hysteresis + 0.5) | 0;
    if (q < 0) q = 0;
    else if (q > this.numSteps - 1) q = this.numSteps - 1;
    this.quantized = q;
    return q;
  }
}

// ---------------------------------------------------------------------------
// NaiveSpeechSynth
// phonemes_[phoneme][register].formant[i] = { frequency, amplitude }
// ---------------------------------------------------------------------------
const NAIVE_PHONEMES = [
  // phoneme 0
  [
    [[74, 255], [83, 114], [97, 90], [98, 90], [100, 25]],
    [[75, 255], [84, 128], [100, 114], [101, 101], [103, 20]],
    [[76, 255], [85, 128], [100, 18], [102, 16], [104, 3]],
    [[79, 255], [85, 161], [101, 25], [104, 4], [110, 0]],
    [[79, 255], [85, 128], [101, 6], [106, 25], [110, 0]],
  ],
  // phoneme 1
  [
    [[67, 255], [91, 64], [98, 90], [101, 64], [102, 32]],
    [[67, 255], [92, 51], [99, 64], [103, 51], [105, 25]],
    [[69, 255], [93, 51], [100, 32], [102, 25], [103, 25]],
    [[67, 255], [91, 16], [100, 8], [103, 4], [110, 0]],
    [[65, 255], [95, 25], [101, 45], [105, 2], [110, 0]],
  ],
  // phoneme 2
  [
    [[59, 255], [92, 8], [99, 40], [102, 20], [104, 10]],
    [[61, 255], [94, 45], [101, 32], [103, 25], [105, 8]],
    [[60, 255], [93, 16], [101, 16], [104, 4], [105, 4]],
    [[65, 255], [92, 25], [100, 8], [105, 4], [110, 0]],
    [[60, 255], [96, 64], [101, 12], [106, 12], [110, 1]],
  ],
  // phoneme 3
  [
    [[67, 255], [78, 72], [98, 22], [99, 25], [101, 2]],
    [[67, 255], [79, 80], [99, 64], [101, 64], [102, 12]],
    [[68, 255], [79, 80], [100, 12], [102, 20], [103, 5]],
    [[69, 255], [79, 90], [101, 40], [104, 10], [110, 0]],
    [[69, 255], [79, 72], [101, 20], [106, 20], [110, 0]],
  ],
  // phoneme 4
  [
    [[65, 255], [74, 25], [98, 6], [100, 10], [101, 4]],
    [[65, 255], [74, 25], [100, 36], [101, 51], [103, 12]],
    [[66, 255], [75, 25], [100, 18], [102, 8], [104, 5]],
    [[63, 255], [77, 64], [99, 8], [104, 2], [110, 0]],
    [[63, 255], [77, 40], [100, 4], [106, 2], [110, 0]],
  ],
];

class NaiveSpeechSynth {
  constructor() { this.init(); }
  init() {
    this.pulse = new SpImpulseTrain();
    this.pulse.init();
    this.clickDuration = 0;
    this.filters = [];
    for (let i = 0; i < SP_NAIVE_FORMANTS; i++) {
      this.filters.push(new SpZdfSvf());
    }
    this.pulseColoration = new SpZdfSvf();
    this.pulseColoration.setFQ(800 / sampleRate, 0.5);
  }
  render(click, frequency, phoneme, vocalRegister, excitation, output, size) {
    if (click) this.clickDuration = (sampleRate * 0.05) | 0;
    this.clickDuration -= Math.min(this.clickDuration, size);
    if (this.clickDuration) frequency *= 0.5;

    this.pulse.render(frequency, excitation, size);
    this.pulseColoration.setFQ(800 / sampleRate, 0.5);
    for (let i = 0; i < size; i++) {
      excitation[i] = this.pulseColoration.processBP(excitation[i]) * 4;
    }

    const p = phoneme * (SP_NAIVE_PHONEMES - 1.001);
    const r = vocalRegister * (SP_NAIVE_REGISTERS - 1.001);
    const pi = spIntegralFractional(p);
    const ri = spIntegralFractional(r);
    const a0 = spA0Norm();

    output.fill(0, 0, size);
    for (let fi = 0; fi < SP_NAIVE_FORMANTS; fi++) {
      const p0r0 = NAIVE_PHONEMES[pi.i][ri.i][fi];
      const p0r1 = NAIVE_PHONEMES[pi.i][ri.i + 1][fi];
      const p1r0 = NAIVE_PHONEMES[pi.i + 1][ri.i][fi];
      const p1r1 = NAIVE_PHONEMES[pi.i + 1][ri.i + 1][fi];

      let p0rF = p0r0[0] + (p0r1[0] - p0r0[0]) * ri.f;
      let p1rF = p1r0[0] + (p1r1[0] - p1r0[0]) * ri.f;
      let f = p0rF + (p1rF - p0rF) * pi.f;

      const p0rA = p0r0[1] + (p0r1[1] - p0r0[1]) * ri.f;
      const p1rA = p1r0[1] + (p1r1[1] - p1r0[1]) * ri.f;
      const a = (p0rA + (p1rA - p0rA) * pi.f) / 256;

      if (f >= 160) f = 160;
      f = a0 * spSemis(f - 33);
      if (this.clickDuration && fi === 0) f *= 0.5;

      this.filters[fi].setFQ(f, 20);
      for (let n = 0; n < size; n++) {
        output[n] += this.filters[fi].processBP(excitation[n]) * a;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SAMSpeechSynth
// ---------------------------------------------------------------------------
const SAM_PHONEMES = [
  [[60, 15], [90, 13], [200, 1]],
  [[40, 13], [114, 12], [139, 6]],
  [[33, 14], [155, 12], [209, 7]],
  [[22, 13], [189, 10], [247, 8]],
  [[51, 15], [99, 12], [195, 1]],
  [[29, 13], [65, 8], [180, 0]],
  [[13, 12], [103, 3], [182, 0]],
  [[20, 15], [114, 3], [213, 0]],
  [[13, 7], [164, 3], [222, 14]],
  [[13, 9], [121, 9], [254, 0]],
  [[40, 12], [112, 10], [114, 5]],
  [[24, 13], [54, 8], [157, 0]],
  [[33, 14], [155, 12], [166, 7]],
  [[36, 14], [83, 8], [249, 1]],
  [[40, 14], [114, 12], [139, 6]],
  [[13, 5], [58, 5], [182, 5]],
  [[13, 7], [164, 10], [222, 14]],
  [[13, 7], [164, 10], [222, 14]], // GUARD
];

const SAM_FORMANT_AMP_LUT = [
  0.03125000, 0.03756299, 0.04515131, 0.05427259, 0.06523652,
  0.07841532, 0.09425646, 0.11329776, 0.13618570, 0.16369736,
  0.19676682, 0.23651683, 0.28429697, 0.34172946, 0.41076422,
  0.49374509,
];

class SAMSpeechSynth {
  constructor() { this.init(); }
  init() {
    this.phase = 0;
    this.frequency = 0;
    this.pulseNextSample = 0;
    this.pulseLp = 0;
    this.formantPhase = [0, 0, 0];
    this.consonantSamples = 0;
    this.consonantIndex = 0;
  }
  interpolatePhonemeData(phoneme, formantShift, formantFrequency, formantAmplitude) {
    const pi = spIntegralFractional(phoneme);
    const p1 = SAM_PHONEMES[pi.i];
    const p2 = SAM_PHONEMES[pi.i + 1];
    formantShift = 1 + formantShift * 2.5;
    const scale = 8 * formantShift * SP_U32 / sampleRate;
    for (let i = 0; i < SP_SAM_FORMANTS; i++) {
      const f1 = p1[i][0];
      const f2 = p2[i][0];
      let f = f1 + (f2 - f1) * pi.f;
      f *= scale;
      formantFrequency[i] = (f >>> 0);
      const a1 = SAM_FORMANT_AMP_LUT[p1[i][1]];
      const a2 = SAM_FORMANT_AMP_LUT[p2[i][1]];
      formantAmplitude[i] = a1 + (a2 - a1) * pi.f;
    }
  }
  render(consonant, frequency, vowel, formantShift, excitation, output, size) {
    if (frequency >= 0.0625) frequency = 0.0625;

    if (consonant) {
      this.consonantSamples = (sampleRate * 0.05) | 0;
      const r = ((vowel + 3 * frequency + 7 * formantShift) * 8) | 0;
      this.consonantIndex = ((r % SP_SAM_CONSONANTS) + SP_SAM_CONSONANTS) % SP_SAM_CONSONANTS;
    }
    this.consonantSamples -= Math.min(this.consonantSamples, size);

    const phoneme = this.consonantSamples
      ? (this.consonantIndex + SP_SAM_VOWELS)
      : vowel * (SP_SAM_VOWELS - 1.0001);

    const formantFrequency = [0, 0, 0];
    const formantAmplitude = [0, 0, 0];
    this.interpolatePhonemeData(phoneme, formantShift, formantFrequency, formantAmplitude);

    const dF = (frequency - this.frequency) / Math.max(1, size);
    let f = this.frequency;
    let pulseNext = this.pulseNextSample;
    let phase = this.phase;
    let pulseLp = this.pulseLp;
    let fp0 = this.formantPhase[0] >>> 0;
    let fp1 = this.formantPhase[1] >>> 0;
    let fp2 = this.formantPhase[2] >>> 0;

    for (let n = 0; n < size; n++) {
      f += dF;
      let pulseThis = pulseNext;
      pulseNext = 0;
      phase += f;

      if (phase >= 1) {
        phase -= 1;
        const t = phase / f;
        fp0 = (t * formantFrequency[0]) >>> 0;
        fp1 = (t * formantFrequency[1]) >>> 0;
        fp2 = (t * formantFrequency[2]) >>> 0;
        pulseThis -= spThisBlep(t);
        pulseNext -= spNextBlep(t);
      } else {
        fp0 = (fp0 + formantFrequency[0]) >>> 0;
        fp1 = (fp1 + formantFrequency[1]) >>> 0;
        fp2 = (fp2 + formantFrequency[2]) >>> 0;
      }
      pulseNext += phase;

      let d = pulseThis - 0.5 - pulseLp;
      pulseLp += Math.min(16 * f, 1) * d;
      excitation[n] = d;

      let s = 0;
      s += spSineRaw(fp0) * formantAmplitude[0];
      s += spSineRaw(fp1) * formantAmplitude[1];
      s += spSineRaw(fp2) * formantAmplitude[2];
      s *= (1 - phase);
      output[n] = s;
    }

    this.frequency = f;
    this.pulseNextSample = pulseNext;
    this.phase = phase;
    this.pulseLp = pulseLp;
    this.formantPhase[0] = fp0;
    this.formantPhase[1] = fp1;
    this.formantPhase[2] = fp2;
  }
}

// ---------------------------------------------------------------------------
// LPCSpeechSynth — lattice order 10
// ---------------------------------------------------------------------------
function spEmptyFrame() {
  return {
    energy: 0, period: 0,
    k0: 0, k1: 0, k2: 0, k3: 0, k4: 0,
    k5: 0, k6: 0, k7: 0, k8: 0, k9: 0,
  };
}

function spMakeFrame(energy, period, k0, k1, k2, k3, k4, k5, k6, k7, k8, k9) {
  return { energy, period, k0, k1, k2, k3, k4, k5, k6, k7, k8, k9 };
}

class LPCSpeechSynth {
  constructor() {
    this.excitation = null;
    this.init();
  }
  init() {
    this.phase = 0;
    this.frequency = 0.0125;
    this.noiseEnergy = 0;
    this.pulseEnergy = 0;
    this.nextSample = 0;
    this.excitationPulseSampleIndex = 0;
    this.k = new Float32Array(SP_LPC_ORDER);
    this.s = new Float32Array(SP_LPC_ORDER + 1);
    this._e = new Float32Array(11);
  }
  setExcitation(arr) {
    this.excitation = arr;
  }
  blendCoefficient(a, b, blend, scale) {
    const af = a / scale;
    const bf = b / scale;
    return af + (bf - af) * blend;
  }
  playFramePair(f1, f2, blend) {
    const frequency1 = f1.period === 0 ? this.frequency : 1 / f1.period;
    const frequency2 = f2.period === 0 ? this.frequency : 1 / f2.period;
    this.frequency = frequency1 + (frequency2 - frequency1) * blend;

    const energy1 = f1.energy / 256;
    const energy2 = f2.energy / 256;
    const noise1 = f1.period === 0 ? energy1 : 0;
    const noise2 = f2.period === 0 ? energy2 : 0;
    this.noiseEnergy = noise1 + (noise2 - noise1) * blend;

    const pulse1 = f1.period !== 0 ? energy1 : 0;
    const pulse2 = f2.period !== 0 ? energy2 : 0;
    this.pulseEnergy = pulse1 + (pulse2 - pulse1) * blend;

    this.k[0] = this.blendCoefficient(f1.k0, f2.k0, blend, 32768);
    this.k[1] = this.blendCoefficient(f1.k1, f2.k1, blend, 32768);
    this.k[2] = this.blendCoefficient(f1.k2, f2.k2, blend, 128);
    this.k[3] = this.blendCoefficient(f1.k3, f2.k3, blend, 128);
    this.k[4] = this.blendCoefficient(f1.k4, f2.k4, blend, 128);
    this.k[5] = this.blendCoefficient(f1.k5, f2.k5, blend, 128);
    this.k[6] = this.blendCoefficient(f1.k6, f2.k6, blend, 128);
    this.k[7] = this.blendCoefficient(f1.k7, f2.k7, blend, 128);
    this.k[8] = this.blendCoefficient(f1.k8, f2.k8, blend, 128);
    this.k[9] = this.blendCoefficient(f1.k9, f2.k9, blend, 128);
  }
  playFrame(frames, frame, interpolate) {
    if (!frames || frames.length < 1) return;
    const fi = spIntegralFractional(frame);
    let i1 = fi.i | 0;
    if (i1 < 0) i1 = 0;
    if (i1 >= frames.length) i1 = frames.length - 1;
    const f1 = frames[i1];
    const f2 = frames[Math.min(frames.length - 1, i1 + 1)] || f1;
    if (!f1) return;
    this.playFramePair(f1, f2, interpolate ? fi.f : 0);
  }
  render(prosodyAmount, pitchShift, excitation, output, size) {
    const pulse = this.excitation;
    const baseF0 = SP_LPC_DEFAULT_F0 / 8000;
    let d = this.frequency - baseF0;
    let f = (baseF0 + d * prosodyAmount) * pitchShift;
    f = spClamp(f, 0, 0.5);

    let nextSample = this.nextSample;
    let phase = this.phase;
    let pulseIdx = this.excitationPulseSampleIndex;
    const k = this.k;
    const s = this.s;
    const noiseE = this.noiseEnergy;
    const pulseE = this.pulseEnergy;

    for (let n = 0; n < size; n++) {
      phase += f;
      let thisSample = nextSample;
      nextSample = 0;

      if (phase >= 1) {
        phase -= 1;
        const resetTime = phase / f;
        const resetSample = (32 * resetTime) | 0;

        let discontinuity = 0;
        if (pulse && pulseIdx < SP_LPC_PULSE_SIZE) {
          pulseIdx -= resetSample;
          // Guard negative index (C++ would be undefined; avoid NaN in JS)
          if (pulseIdx >= 0) {
            discontinuity = ((pulse[pulseIdx] | 0) / 128) * pulseE;
          }
        }
        thisSample += -discontinuity * spThisBlep(resetTime);
        nextSample += -discontinuity * spNextBlep(resetTime);
        pulseIdx = resetSample;
      }

      const e = this._e;
      e[10] = Math.random() > 0.5 ? noiseE : -noiseE;
      if (pulse && pulseIdx < SP_LPC_PULSE_SIZE) {
        const sample = pulse[pulseIdx] | 0;
        nextSample += (sample / 128) * pulseE;
        pulseIdx += 32;
      }
      e[10] += thisSample;
      e[10] *= 1.5;

      e[9] = e[10] - k[9] * s[9];
      e[8] = e[9] - k[8] * s[8];
      e[7] = e[8] - k[7] * s[7];
      e[6] = e[7] - k[6] * s[6];
      e[5] = e[6] - k[5] * s[5];
      e[4] = e[5] - k[4] * s[4];
      e[3] = e[4] - k[3] * s[3];
      e[2] = e[3] - k[2] * s[2];
      e[1] = e[2] - k[1] * s[1];
      e[0] = e[1] - k[0] * s[0];
      e[0] = spClamp(e[0], -2, 2);

      s[9] = s[8] + k[8] * e[8];
      s[8] = s[7] + k[7] * e[7];
      s[7] = s[6] + k[6] * e[6];
      s[6] = s[5] + k[5] * e[5];
      s[5] = s[4] + k[4] * e[4];
      s[4] = s[3] + k[3] * e[3];
      s[3] = s[2] + k[2] * e[2];
      s[2] = s[1] + k[1] * e[1];
      s[1] = s[0] + k[0] * e[0];
      s[0] = e[0];

      excitation[n] = e[10];
      output[n] = e[0];
    }

    this.nextSample = nextSample;
    this.phase = phase;
    this.excitationPulseSampleIndex = pulseIdx;
  }
}

// ---------------------------------------------------------------------------
// BitStream / WordBank LUTs + Controller phonemes
// ---------------------------------------------------------------------------
const LPC_ENERGY_LUT = [
  0x00, 0x02, 0x03, 0x04, 0x05, 0x07, 0x0a, 0x0f,
  0x14, 0x20, 0x29, 0x39, 0x51, 0x72, 0xa1, 0xff,
];
const LPC_PERIOD_LUT = [
  0, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 49, 51, 53,
  54, 57, 59, 61, 63, 66, 69, 71, 73, 77, 79, 81, 85, 87, 92, 95, 99,
  102, 106, 110, 115, 119, 123, 128, 133, 138, 143, 149, 154, 160,
];
const LPC_K0_LUT = [
  -32064, -31872, -31808, -31680, -31552, -31424, -31232, -30848,
  -30592, -30336, -30016, -29696, -29376, -28928, -28480, -27968,
  -26368, -24256, -21632, -18368, -14528, -10048, -5184, 0,
  5184, 10048, 14528, 18368, 21632, 24256, 26368, 27968,
];
const LPC_K1_LUT = [
  -20992, -19328, -17536, -15552, -13440, -11200, -8768, -6272,
  -3712, -1088, 1536, 4160, 6720, 9216, 11584, 13824,
  15936, 17856, 19648, 21248, 22656, 24000, 25152, 26176,
  27072, 27840, 28544, 29120, 29632, 30080, 30464, 32384,
];
const LPC_K2_LUT = [-110, -97, -83, -70, -56, -43, -29, -16, -2, 11, 25, 38, 52, 65, 79, 92];
const LPC_K3_LUT = [-82, -68, -54, -40, -26, -12, 1, 15, 29, 43, 57, 71, 85, 99, 113, 126];
const LPC_K4_LUT = [-82, -70, -59, -47, -35, -24, -12, -1, 11, 23, 34, 46, 57, 69, 81, 92];
const LPC_K5_LUT = [-64, -53, -42, -31, -20, -9, 3, 14, 25, 36, 47, 58, 69, 80, 91, 102];
const LPC_K6_LUT = [-77, -65, -53, -41, -29, -17, -5, 7, 19, 31, 43, 55, 67, 79, 90, 102];
const LPC_K7_LUT = [-64, -40, -16, 7, 31, 55, 79, 102];
const LPC_K8_LUT = [-64, -44, -24, -4, 16, 37, 57, 77];
const LPC_K9_LUT = [-51, -33, -15, 4, 22, 32, 59, 77];

const LPC_PHONEMES = [
  spMakeFrame(192, 80, -18368, 11584, 52, 29, 23, 14, -17, 79, 37, 4),
  spMakeFrame(192, 80, -14528, 1536, 38, 29, 11, 14, -41, 79, 57, 4),
  spMakeFrame(192, 80, 14528, 9216, 25, -54, -70, 36, 19, 79, 57, 22),
  spMakeFrame(192, 80, -14528, -13440, 38, 57, 57, 14, -53, 7, 37, 77),
  spMakeFrame(192, 80, -26368, 4160, 11, 15, -1, 36, -41, 31, 77, 22),
  spMakeFrame(15, 0, 5184, 9216, -29, -12, 0, 0, 0, 0, 0, 0),
  spMakeFrame(10, 0, 27968, 17856, 25, 43, -24, -20, -53, 55, -4, -51),
  spMakeFrame(128, 160, 14528, -3712, -43, -26, -24, -20, -53, 55, -4, -51),
  spMakeFrame(128, 160, 10048, 11584, -16, 15, 0, 0, 0, 0, 0, 0),
  spMakeFrame(224, 100, 18368, -13440, -97, -26, -12, -53, -41, 7, 57, 32),
  spMakeFrame(192, 80, -10048, 9216, -70, 15, 34, -20, -17, 31, -24, 22),
  spMakeFrame(96, 160, -18368, 17856, -29, -12, -35, 3, -5, 7, 37, 22),
  spMakeFrame(64, 80, -21632, -6272, -83, 29, 57, 3, -5, 7, 16, 32),
  spMakeFrame(192, 80, 0, -1088, 11, -26, -24, -9, -5, 55, 37, 22),
  spMakeFrame(64, 80, 21632, -17536, -97, 85, 57, -20, -17, 31, -4, 59),
];

class BitStream {
  constructor() {
    this.p = 0;
    this.data = null;
    this.available = 0;
    this.bits = 0;
  }
  init(data, offset) {
    this.data = data;
    this.p = offset | 0;
    this.available = 0;
    this.bits = 0;
  }
  reverse(b) {
    b = ((b >>> 4) | (b << 4)) & 0xff;
    b = (((b & 0xcc) >>> 2) | ((b & 0x33) << 2)) & 0xff;
    b = (((b & 0xaa) >>> 1) | ((b & 0x55) << 1)) & 0xff;
    return b;
  }
  getBits(numBits) {
    let shift = numBits;
    if (numBits > this.available) {
      this.bits = (this.bits << this.available) & 0xffff;
      shift -= this.available;
      const byte = this.data[this.p++] | 0;
      this.bits |= this.reverse(byte);
      this.available += 8;
    }
    this.bits = (this.bits << shift) & 0xffff;
    const result = (this.bits >>> 8) & 0xff;
    this.bits &= 0xff;
    this.available -= numBits;
    return result;
  }
  flush() {
    while (this.available) this.getBits(1);
  }
  ptr() { return this.p; }
}

class LPCSpeechSynthWordBank {
  constructor() {
    this.banks = null;
    this.numBanks = 0;
    this.loadedBank = -1;
    this.numFrames = 0;
    this.numWords = 0;
    this.wordBoundaries = new Int32Array(SP_LPC_MAX_WORDS + 1);
    this.frames = new Array(SP_LPC_MAX_FRAMES);
    for (let i = 0; i < SP_LPC_MAX_FRAMES; i++) this.frames[i] = spEmptyFrame();
  }
  setBanks(banks) {
    if (banks === this.banks) return;
    this.banks = banks || null;
    this.numBanks = banks ? banks.length : 0;
    this.loadedBank = -1;
  }
  reset() {
    this.loadedBank = -1;
    this.numFrames = 0;
    this.numWords = 0;
    this.wordBoundaries.fill(0);
  }
  loadNextWord(data, offset) {
    const bitstream = new BitStream();
    bitstream.init(data, offset);
    const frame = spEmptyFrame();

    while (true) {
      const energy = bitstream.getBits(4);
      if (energy === 0) {
        frame.energy = 0;
      } else if (energy === 0xf) {
        bitstream.flush();
        break;
      } else {
        frame.energy = LPC_ENERGY_LUT[energy];
        const repeat = bitstream.getBits(1);
        frame.period = LPC_PERIOD_LUT[bitstream.getBits(6)];
        if (!repeat) {
          frame.k0 = LPC_K0_LUT[bitstream.getBits(5)];
          frame.k1 = LPC_K1_LUT[bitstream.getBits(5)];
          frame.k2 = LPC_K2_LUT[bitstream.getBits(4)];
          frame.k3 = LPC_K3_LUT[bitstream.getBits(4)];
          if (frame.period) {
            frame.k4 = LPC_K4_LUT[bitstream.getBits(4)];
            frame.k5 = LPC_K5_LUT[bitstream.getBits(4)];
            frame.k6 = LPC_K6_LUT[bitstream.getBits(4)];
            frame.k7 = LPC_K7_LUT[bitstream.getBits(3)];
            frame.k8 = LPC_K8_LUT[bitstream.getBits(3)];
            frame.k9 = LPC_K9_LUT[bitstream.getBits(3)];
          }
        }
      }
      if (this.numFrames < SP_LPC_MAX_FRAMES) {
        const dst = this.frames[this.numFrames++];
        dst.energy = frame.energy;
        dst.period = frame.period;
        dst.k0 = frame.k0; dst.k1 = frame.k1;
        dst.k2 = frame.k2; dst.k3 = frame.k3;
        dst.k4 = frame.k4; dst.k5 = frame.k5;
        dst.k6 = frame.k6; dst.k7 = frame.k7;
        dst.k8 = frame.k8; dst.k9 = frame.k9;
      }
    }
    return bitstream.ptr() - offset;
  }
  load(bank) {
    if (!this.banks || bank === this.loadedBank || bank >= this.numBanks || bank < 0) {
      return false;
    }
    this.numFrames = 0;
    this.numWords = 0;
    const data = this.banks[bank];
    let size = data.length;
    let offset = 0;
    while (size > 0 && this.numWords < SP_LPC_MAX_WORDS) {
      this.wordBoundaries[this.numWords] = this.numFrames;
      const consumed = this.loadNextWord(data, offset);
      if (consumed <= 0) break;
      offset += consumed;
      size -= consumed;
      this.numWords++;
    }
    this.wordBoundaries[this.numWords] = this.numFrames;
    this.loadedBank = bank;
    return true;
  }
  getWordBoundaries(address, out) {
    if (this.numWords === 0) {
      out.start = -1;
      out.end = -1;
      return;
    }
    let word = (address * this.numWords) | 0;
    if (word >= this.numWords) word = this.numWords - 1;
    out.start = this.wordBoundaries[word];
    out.end = this.wordBoundaries[word + 1] - 1;
  }
}

class LPCSpeechSynthController {
  constructor(wordBank) {
    this.wordBank = wordBank;
    this.synth = new LPCSpeechSynth();
    this.init();
  }
  init() {
    this.clockPhase = 0;
    this.playbackFrame = -1;
    this.lastPlaybackFrame = -1;
    this.remainingFrameSamples = 0;
    this.sample = [0, 0];
    this.nextSample = [0, 0];
    this.gain = 0;
    this._lpcBank = -2;
    this.synth.init();
  }
  reset() {
    this.init();
  }
  render(
    freeRunning,
    trigger,
    bank,
    frequency,
    prosodyAmount,
    speed,
    address,
    formantShift,
    gain,
    excitation,
    output,
    size
  ) {
    const rateRatio = spSemis((formantShift - 0.5) * 36);
    const rate = rateRatio / 6;
    // pitch_shift = f0Norm / (rate_ratio * 100 / sampleRate)
    const pitchShift = frequency / (rateRatio * SP_LPC_DEFAULT_F0 / sampleRate);
    let stretchExtra = 0;
    if (formantShift < 0.4) stretchExtra = (formantShift - 0.4) * -45;
    else if (formantShift > 0.6) stretchExtra = (formantShift - 0.6) * -45;
    const timeStretch = spSemis(-speed * 24 + stretchExtra);

    if (bank !== -1) {
      const resetEverything = this.wordBank.load(bank);
      if (resetEverything) {
        this.playbackFrame = -1;
        this.lastPlaybackFrame = -1;
      }
    }

    const numFrames = bank === -1
      ? SP_LPC_NUM_VOWELS
      : this.wordBank.numFrames;
    const frames = bank === -1
      ? LPC_PHONEMES
      : this.wordBank.frames;
    const tableLen = bank === -1
      ? LPC_PHONEMES.length
      : Math.max(0, this.wordBank.numFrames | 0);

    // HARMONICS crossing phoneme LPC ↔ word banks leaves playbackFrame on the
    // other table; JS throws (C++ would be OOB) and kills the AudioWorklet.
    if (this._lpcBank !== bank && (bank === -1 || this._lpcBank === -1)) {
      this.playbackFrame = -1;
      this.lastPlaybackFrame = -1;
      this.remainingFrameSamples = 0;
    }
    this._lpcBank = bank;
    if (this.playbackFrame >= tableLen || this.playbackFrame < -1) {
      this.playbackFrame = -1;
      this.lastPlaybackFrame = -1;
      this.remainingFrameSamples = 0;
    }

    if (trigger) {
      if (bank === -1) {
        let r = ((address + 3 * formantShift + 7 * frequency) * 8) | 0;
        this.playbackFrame = ((r % SP_LPC_NUM_CONSONANTS) + SP_LPC_NUM_CONSONANTS) % SP_LPC_NUM_CONSONANTS;
        this.playbackFrame += SP_LPC_NUM_VOWELS;
        this.lastPlaybackFrame = this.playbackFrame + 1;
      } else {
        const bounds = { start: -1, end: -1 };
        this.wordBank.getWordBoundaries(address, bounds);
        this.playbackFrame = bounds.start;
        this.lastPlaybackFrame = bounds.end;
      }
      this.remainingFrameSamples = 0;
    }

    if (this.playbackFrame === -1 && this.remainingFrameSamples === 0) {
      this.synth.playFrame(frames, address * (numFrames - 1.0001), true);
    } else {
      if (this.remainingFrameSamples === 0) {
        this.synth.playFrame(frames, this.playbackFrame, false);
        this.remainingFrameSamples = ((sampleRate / SP_LPC_FPS) * timeStretch) | 0;
        if (this.remainingFrameSamples < 1) this.remainingFrameSamples = 1;
        this.playbackFrame++;
        if (this.playbackFrame >= this.lastPlaybackFrame) {
          const backToScan = bank === -1 || freeRunning;
          this.playbackFrame = backToScan ? -1 : this.lastPlaybackFrame;
        }
      }
      this.remainingFrameSamples -= Math.min(size, this.remainingFrameSamples);
    }

    const dGain = (gain - this.gain) / Math.max(1, size);
    let g = this.gain;
    let clockPhase = this.clockPhase;
    const sample = this.sample;
    const nextSample = this.nextSample;
    const scratchExc = [0];
    const scratchOut = [0];

    for (let n = 0; n < size; n++) {
      const thisSample0 = nextSample[0];
      const thisSample1 = nextSample[1];
      nextSample[0] = 0;
      nextSample[1] = 0;

      clockPhase += rate;
      let s0 = thisSample0;
      let s1 = thisSample1;
      if (clockPhase >= 1) {
        clockPhase -= 1;
        const resetTime = clockPhase / rate;
        this.synth.render(prosodyAmount, pitchShift, scratchExc, scratchOut, 1);
        const disc0 = scratchExc[0] - sample[0];
        const disc1 = scratchOut[0] - sample[1];
        s0 += disc0 * spThisBlep(resetTime);
        nextSample[0] += disc0 * spNextBlep(resetTime);
        s1 += disc1 * spThisBlep(resetTime);
        nextSample[1] += disc1 * spNextBlep(resetTime);
        sample[0] = scratchExc[0];
        sample[1] = scratchOut[0];
      }
      nextSample[0] += sample[0];
      nextSample[1] += sample[1];
      g += dGain;
      excitation[n] = s0 * g;
      output[n] = s1 * g;
    }

    this.gain = g;
    this.clockPhase = clockPhase;
  }
}

// ---------------------------------------------------------------------------
// Processor state + install
// ---------------------------------------------------------------------------
function spEnsureBuffers(st, size) {
  if (!st.temp0 || st.temp0.length < size) {
    st.temp0 = new Float32Array(size);
    st.temp1 = new Float32Array(size);
    st.aux = new Float32Array(size);
    st.main = new Float32Array(size);
  }
}

function spEnsureSpeech(self) {
  if (!self._speech) {
    const wordBank = new LPCSpeechSynthWordBank();
    const lpcController = new LPCSpeechSynthController(wordBank);
    self._speech = {
      naive: new NaiveSpeechSynth(),
      sam: new SAMSpeechSynth(),
      wordBank,
      lpcController,
      quantizer: new SpHysteresisQuantizer(6, 0.1, false),
      temp0: null,
      temp1: null,
      aux: null,
      main: null,
      romSynced: false,
      userBankBytes: null,
      userBankActive: false,
    };
  }
  const st = self._speech;
  const rom = self.speechRom;
  if (rom && rom.excitation && !st.romSynced) {
    st.lpcController.synth.setExcitation(rom.excitation);
    const banks = rom.banks ? rom.banks.slice() : [];
    if (st.userBankBytes && st.userBankBytes.length) {
      banks.push(st.userBankBytes);
    }
    st.wordBank.setBanks(banks.length ? banks : null);
    st.romSynced = true;
  }
  return st;
}

/** Attach or clear USER LPC bank (index = factory banks length). */
export function applySpeechUserBank(self, bytesOrNull, active = true) {
  const st = spEnsureSpeech(self);
  if (bytesOrNull && bytesOrNull.byteLength) {
    st.userBankBytes = bytesOrNull instanceof Uint8Array
      ? bytesOrNull
      : new Uint8Array(bytesOrNull);
  } else {
    st.userBankBytes = null;
  }
  st.userBankActive = !!(active && st.userBankBytes && st.userBankBytes.length);
  st.romSynced = false;
  spEnsureSpeech(self);
  st.wordBank.reset();
  st.lpcController.reset();
}

function spReadFlags(self, parameters) {
  const alt = ((parameters.alt && parameters.alt[0]) ?? (self.alt ? 1 : 0)) >= 0.5;
  const trigPatched = ((parameters.trigPatched && parameters.trigPatched[0]) ??
    (self.trigPatched !== false ? 1 : 0)) >= 0.5;
  return { alt, trigPatched };
}

function spHz(freqArr, detuneArr, i) {
  const f0 = freqArr.length > 1 ? freqArr[i] : freqArr[0];
  const det = detuneArr.length > 1 ? detuneArr[i] : (detuneArr[0] ?? 0);
  return Math.max(1, Math.min(14000, f0 * Math.pow(2, det / 1200)));
}

function spEmit(out, main, aux, alt, size) {
  const src = alt ? aux : main;
  if (src !== out) {
    for (let i = 0; i < size; i++) out[i] = src[i];
  } else if (alt && aux !== out) {
    for (let i = 0; i < size; i++) out[i] = aux[i];
  }
}

function spApplyGate(self, out, gateArr, gate0) {
  const slewUp = spGateCoeff(SP_GATE_UP);
  const slewDown = spGateCoeff(SP_GATE_DOWN);
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

export function installSpeechEngine(proto) {
  proto.resetSpeechState = function resetSpeechState() {
    const st = spEnsureSpeech(this);
    const keepUser = st.userBankBytes;
    const keepActive = st.userBankActive;
    st.naive.init();
    st.sam.init();
    st.wordBank.reset();
    st.lpcController.reset();
    st.quantizer.reset();
    st.romSynced = false;
    st.userBankBytes = keepUser;
    st.userBankActive = keepActive;
    const rom = this.speechRom;
    if (rom && rom.excitation) {
      st.lpcController.synth.setExcitation(rom.excitation);
      const banks = rom.banks ? rom.banks.slice() : [];
      if (st.userBankBytes && st.userBankBytes.length) {
        banks.push(st.userBankBytes);
      }
      st.wordBank.setBanks(banks.length ? banks : null);
      st.romSynced = true;
    }
  };

  proto.processSpeech = function processSpeech(out, parameters) {
    try {
      const st = spEnsureSpeech(this);
      const size = out.length;
      spEnsureBuffers(st, size);

      const freqArr = parameters.frequency;
      const detuneArr = parameters.detune || [0];
      const gateArr = parameters.gate;
      const gate0 = gateArr[0] ?? 0;
      const harmonics = spClamp01(parameters.harmonics[0] ?? 0.5);
      // morphX = Plaits TIMBRE (formant / register), morphY = Plaits MORPH (phoneme / address)
      const timbre = spClamp01(parameters.morphX[0] ?? 0.5);
      const morph = spClamp01(parameters.morphY[0] ?? 0.5);
      const { alt, trigPatched } = spReadFlags(this, parameters);

      const rising = (this.prevGate || 0) < 0.0001 && gate0 >= 0.0001;
      const freeRunning = !trigPatched;
      const hz = spHz(freqArr, detuneArr, 0);
      const f0 = hz / sampleRate;
      const group = harmonics * 6;

      const aux = st.aux;
      const main = st.main;
      const temp0 = st.temp0;
      const temp1 = st.temp1;

      // USER bank: skip factory MODEL blend; pin last bank index.
      const userOn = !!(st.userBankActive && st.userBankBytes && st.userBankBytes.length);
      const userBankIndex = userOn
        ? Math.max(0, (st.wordBank.numBanks | 0) - 1)
        : -1;

      if (userOn && userBankIndex >= 0) {
        st.lpcController.render(
          freeRunning,
          rising,
          userBankIndex,
          f0,
          0,
          0,
          morph,
          timbre,
          1,
          aux,
          main,
          size
        );
      } else if (group <= 2) {
        let blend = group;
        if (group <= 1) {
          st.naive.render(rising, f0, morph, timbre, aux, main, size);
        } else {
          st.lpcController.render(
            freeRunning,
            rising,
            -1,
            f0,
            0,
            0,
            morph,
            timbre,
            1,
            aux,
            main,
            size
          );
          blend = 2 - blend;
        }

        st.sam.render(rising, f0, morph, timbre, temp0, temp1, size);

        blend = spSmoothstep(blend);
        blend = spSmoothstep(blend);
        for (let i = 0; i < size; i++) {
          aux[i] += (temp0[i] - aux[i]) * blend;
          main[i] += (temp1[i] - main[i]) * blend;
        }
      } else {
        const wordBank = st.quantizer.process((group - 2) * 0.275) - 1; // -1..4
        const replayProsody = wordBank >= 0 && trigPatched;
        // Prosody / speed come from the note envelope's PITCH / MORPH amounts
        // (voice.cc, TRIG patched); gain always 1 (accent unused without CV knobs).
        st.lpcController.render(
          freeRunning,
          rising,
          wordBank,
          f0,
          this.intEnvProsody || 0,
          this.intEnvSpeed || 0,
          morph,
          timbre,
          replayProsody ? 1 : 1,
          aux,
          main,
          size
        );
      }

      spEmit(out, main, aux, alt, size);
      spApplyGate(this, out, gateArr, gate0);
      return true;
    } catch (err) {
      if (out && out.fill) out.fill(0);
      return true;
    }
  };
}
