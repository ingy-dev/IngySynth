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
