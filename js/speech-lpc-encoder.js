// Local mic → TMS5220-style LPC bitstream for Plaits Voice USER bank.
// Packs frames matching plaits-speech-dsp.js BitStream / loadNextWord.

export const SPEECH_LPC_SR = 8000;
export const SPEECH_LPC_FPS = 40;
export const SPEECH_LPC_FRAME = SPEECH_LPC_SR / SPEECH_LPC_FPS; // 200
export const SPEECH_LPC_MAX_SEC = 15;
export const SPEECH_LPC_MAX_WORDS = 32;
export const SPEECH_LPC_MAX_FRAMES = 1024;
export const SPEECH_LPC_SILENCE_SEC = 0.5;
export const SPEECH_LPC_MIN_WORD_SEC = 0.15;

const ENERGY_LUT = [
  0x00, 0x02, 0x03, 0x04, 0x05, 0x07, 0x0a, 0x0f,
  0x14, 0x20, 0x29, 0x39, 0x51, 0x72, 0xa1, 0xff,
];
const PERIOD_LUT = [
  0, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 49, 51, 53,
  54, 57, 59, 61, 63, 66, 69, 71, 73, 77, 79, 81, 85, 87, 92, 95, 99,
  102, 106, 110, 115, 119, 123, 128, 133, 138, 143, 149, 154, 160,
];
const K0_LUT = [
  -32064, -31872, -31808, -31680, -31552, -31424, -31232, -30848,
  -30592, -30336, -30016, -29696, -29376, -28928, -28480, -27968,
  -26368, -24256, -21632, -18368, -14528, -10048, -5184, 0,
  5184, 10048, 14528, 18368, 21632, 24256, 26368, 27968,
];
const K1_LUT = [
  -20992, -19328, -17536, -15552, -13440, -11200, -8768, -6272,
  -3712, -1088, 1536, 4160, 6720, 9216, 11584, 13824,
  15936, 17856, 19648, 21248, 22656, 24000, 25152, 26176,
  27072, 27840, 28544, 29120, 29632, 30080, 30464, 32384,
];
const K2_LUT = [-110, -97, -83, -70, -56, -43, -29, -16, -2, 11, 25, 38, 52, 65, 79, 92];
const K3_LUT = [-82, -68, -54, -40, -26, -12, 1, 15, 29, 43, 57, 71, 85, 99, 113, 126];
const K4_LUT = [-82, -70, -59, -47, -35, -24, -12, -1, 11, 23, 34, 46, 57, 69, 81, 92];
const K5_LUT = [-64, -53, -42, -31, -20, -9, 3, 14, 25, 36, 47, 58, 69, 80, 91, 102];
const K6_LUT = [-77, -65, -53, -41, -29, -17, -5, 7, 19, 31, 43, 55, 67, 79, 90, 102];
const K7_LUT = [-64, -40, -16, 7, 31, 55, 79, 102];
const K8_LUT = [-64, -44, -24, -4, 16, 37, 57, 77];
const K9_LUT = [-51, -33, -15, 4, 22, 32, 59, 77];

function nearestIndex(lut, value) {
  let best = 0;
  let bestD = Math.abs(lut[0] - value);
  for (let i = 1; i < lut.length; i++) {
    const d = Math.abs(lut[i] - value);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Bit packer: field bits MSB-first into LSB of each byte.
 *  Plaits BitStream reverse()s the byte then reads MSB first, so field
 *  MSB must land in byte bit0. */
class BitPacker {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.bits = 0;
  }
  put(value, n) {
    const v = value & ((1 << n) - 1);
    for (let i = n - 1; i >= 0; i--) {
      const bit = (v >> i) & 1;
      this.cur |= bit << this.bits;
      this.bits++;
      if (this.bits === 8) {
        this.bytes.push(this.cur & 0xff);
        this.cur = 0;
        this.bits = 0;
      }
    }
  }
  flush() {
    if (this.bits > 0) {
      this.bytes.push(this.cur & 0xff);
      this.cur = 0;
      this.bits = 0;
    }
  }
  toUint8Array() {
    this.flush();
    return new Uint8Array(this.bytes);
  }
}

function hammingWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

function preEmphasis(samples, a = 0.9) {
  const out = new Float32Array(samples.length);
  out[0] = samples[0];
  for (let i = 1; i < samples.length; i++) {
    out[i] = samples[i] - a * samples[i - 1];
  }
  return out;
}

function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / Math.max(1, frame.length));
}

function autocorrelation(frame, maxLag) {
  const r = new Float32Array(maxLag + 1);
  const n = frame.length;
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += frame[i] * frame[i + lag];
    r[lag] = s;
  }
  return r;
}

/** Levinson–Durbin → reflection coefficients k[0..order-1] in [-1,1]. */
function levinsonDurbin(r, order) {
  const k = new Float32Array(order);
  const a = new Float32Array(order + 1);
  const aPrev = new Float32Array(order + 1);
  if (r[0] <= 1e-12) return k;
  let e = r[0];
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += aPrev[j] * r[i - j];
    const ki = -acc / e;
    k[i - 1] = Math.max(-0.999, Math.min(0.999, ki));
    a[i] = ki;
    for (let j = 1; j < i; j++) a[j] = aPrev[j] + ki * aPrev[i - j];
    e *= 1 - ki * ki;
    if (e <= 1e-12) break;
    for (let j = 1; j <= i; j++) aPrev[j] = a[j];
  }
  return k;
}

function estimatePeriod(frame, sr = SPEECH_LPC_SR) {
  const minP = 16;
  const maxP = Math.min(160, (frame.length / 2) | 0);
  const r = autocorrelation(frame, maxP);
  if (r[0] < 1e-10) return { lag: 0, corr: 0 };
  let bestLag = 0;
  let bestVal = 0;
  for (let lag = minP; lag <= maxP; lag++) {
    const v = r[lag];
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }
  const corr = bestLag === 0 ? 0 : bestVal / r[0];
  if (bestLag === 0 || corr < 0.3) return { lag: 0, corr, rawLag: bestLag };
  return { lag: bestLag, corr, rawLag: bestLag };
}

function analyzeFrame(empFrame, window, pitchFrame) {
  const n = empFrame.length;
  const framed = new Float32Array(n);
  const pitched = new Float32Array(n);
  const srcPitch = pitchFrame || empFrame;
  for (let i = 0; i < n; i++) {
    framed[i] = empFrame[i] * window[i];
    pitched[i] = srcPitch[i] * window[i];
  }
  const energyRms = rms(framed);
  // Map RMS → energy LUT domain 0..255 (rough Speak & Spell scale)
  const energyVal = Math.min(255, Math.round(energyRms * 1800));
  if (energyVal < 2) {
    return { energyIdx: 0, periodIdx: 0, kIdx: null, pitchCorr: 0 };
  }
  // Pitch on raw (un-preemphasized) window — pre-emphasis kills voicing.
  const est = estimatePeriod(pitched);
  const r = autocorrelation(framed, 10);
  const k = levinsonDurbin(r, 10);
  // Plaits scales: k0/k1 as Q15 (±32768), k2..k9 as ±128
  const kScaled = [
    Math.round(k[0] * 32768),
    Math.round(k[1] * 32768),
    Math.round(k[2] * 128),
    Math.round(k[3] * 128),
    Math.round(k[4] * 128),
    Math.round(k[5] * 128),
    Math.round(k[6] * 128),
    Math.round(k[7] * 128),
    Math.round(k[8] * 128),
    Math.round(k[9] * 128),
  ];
  let energyIdx = nearestIndex(ENERGY_LUT, energyVal);
  if (energyIdx === 0) energyIdx = 1;
  if (energyIdx === 15) energyIdx = 14;
  const periodIdx = est.lag === 0 ? 0 : nearestIndex(PERIOD_LUT, est.lag);
  return {
    energyIdx,
    periodIdx,
    pitchCorr: est.corr,
    kIdx: [
      nearestIndex(K0_LUT, kScaled[0]),
      nearestIndex(K1_LUT, kScaled[1]),
      nearestIndex(K2_LUT, kScaled[2]),
      nearestIndex(K3_LUT, kScaled[3]),
      nearestIndex(K4_LUT, kScaled[4]),
      nearestIndex(K5_LUT, kScaled[5]),
      nearestIndex(K6_LUT, kScaled[6]),
      nearestIndex(K7_LUT, kScaled[7]),
      nearestIndex(K8_LUT, kScaled[8]),
      nearestIndex(K9_LUT, kScaled[9]),
    ],
  };
}

function packWord(frames) {
  const pack = new BitPacker();
  let prevK = null;
  for (const f of frames) {
    if (f.energyIdx === 0) {
      pack.put(0, 4);
      continue;
    }
    pack.put(f.energyIdx, 4);
    const repeat = !!(prevK && f.kIdx
      && prevK.every((v, i) => v === f.kIdx[i]));
    pack.put(repeat ? 1 : 0, 1);
    pack.put(f.periodIdx & 0x3f, 6);
    if (!repeat && f.kIdx) {
      pack.put(f.kIdx[0], 5);
      pack.put(f.kIdx[1], 5);
      pack.put(f.kIdx[2], 4);
      pack.put(f.kIdx[3], 4);
      if (f.periodIdx !== 0) {
        pack.put(f.kIdx[4], 4);
        pack.put(f.kIdx[5], 4);
        pack.put(f.kIdx[6], 4);
        pack.put(f.kIdx[7], 3);
        pack.put(f.kIdx[8], 3);
        pack.put(f.kIdx[9], 3);
      }
      prevK = f.kIdx.slice();
    }
  }
  pack.put(0xf, 4); // stop
  return { bytes: pack.toUint8Array(), frameCount: frames.length };
}

/** Peak-normalize toward Speak & Spell-ish input level; report gain in dB. */
function matchLevel(samples, targetPeak = 0.65, maxBoostDb = 24) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-6) return { samples, gainDb: 0 };
  const maxGain = Math.pow(10, maxBoostDb / 20);
  const gain = Math.min(maxGain, targetPeak / peak);
  if (Math.abs(gain - 1) < 0.01) return { samples, gainDb: 0 };
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return { samples: out, gainDb: 20 * Math.log10(gain) };
}

/** LSB-first packed bytes → TMS5220 getBits (byte bit-reverse, MSB first). */
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

function emptyFrame() {
  return {
    energy: 0, period: 0,
    k0: 0, k1: 0, k2: 0, k3: 0, k4: 0,
    k5: 0, k6: 0, k7: 0, k8: 0, k9: 0,
  };
}

function copyFrame(src) {
  return {
    energy: src.energy, period: src.period,
    k0: src.k0, k1: src.k1, k2: src.k2, k3: src.k3, k4: src.k4,
    k5: src.k5, k6: src.k6, k7: src.k7, k8: src.k8, k9: src.k9,
  };
}

/** Parse packed USER bank into word frame lists (same bitstream as the worklet). */
export function parseUserBank(bytes) {
  const words = [];
  if (!bytes || !bytes.length) return words;
  let offset = 0;
  while (offset < bytes.length && words.length < SPEECH_LPC_MAX_WORDS) {
    const bitstream = new BitStream();
    bitstream.init(bytes, offset);
    const frame = emptyFrame();
    const frames = [];
    let guard = 0;
    while (guard++ < SPEECH_LPC_MAX_FRAMES + 4) {
      if (bitstream.ptr() > bytes.length + 1) break;
      const energy = bitstream.getBits(4);
      if (energy === 0) {
        frame.energy = 0;
      } else if (energy === 0xf) {
        bitstream.flush();
        break;
      } else {
        frame.energy = ENERGY_LUT[energy] || 0;
        const repeat = bitstream.getBits(1);
        frame.period = PERIOD_LUT[bitstream.getBits(6)] || 0;
        if (!repeat) {
          frame.k0 = K0_LUT[bitstream.getBits(5)];
          frame.k1 = K1_LUT[bitstream.getBits(5)];
          frame.k2 = K2_LUT[bitstream.getBits(4)];
          frame.k3 = K3_LUT[bitstream.getBits(4)];
          if (frame.period) {
            frame.k4 = K4_LUT[bitstream.getBits(4)];
            frame.k5 = K5_LUT[bitstream.getBits(4)];
            frame.k6 = K6_LUT[bitstream.getBits(4)];
            frame.k7 = K7_LUT[bitstream.getBits(3)];
            frame.k8 = K8_LUT[bitstream.getBits(3)];
            frame.k9 = K9_LUT[bitstream.getBits(3)];
          }
        }
      }
      frames.push(copyFrame(frame));
    }
    const consumed = bitstream.ptr() - offset;
    if (consumed <= 0) break;
    if (frames.length) words.push(frames);
    offset += consumed;
  }
  return words;
}

export function inspectUserBank(bytes) {
  const words = parseUserBank(bytes);
  let frameCount = 0;
  for (const w of words) frameCount += w.length;
  return { wordCount: words.length, frameCount, words };
}

/**
 * Offline LPC preview at 8 kHz (impulse + noise lattice).
 * Natural keeps recorded pitch; Flat pins voiced frames to ~100 Hz.
 */
export function renderLpcPreview(bytes, { flat = false } = {}) {
  const words = parseUserBank(bytes);
  const hop = SPEECH_LPC_FRAME;
  const gapFrames = 6;
  let nFrames = 0;
  for (const w of words) nFrames += w.length + gapFrames;
  const out = new Float32Array(Math.max(hop, nFrames * hop));
  const k = new Float32Array(10);
  const s = new Float32Array(11);
  const e = new Float32Array(11);
  let o = 0;
  let phase = 0;

  const runFrame = (fr) => {
    const period = flat && fr.period ? 80 : fr.period;
    const energy = (fr.energy || 0) / 256;
    const noiseE = period === 0 ? energy : 0;
    const pulseE = period !== 0 ? energy : 0;
    k[0] = fr.k0 / 32768; k[1] = fr.k1 / 32768;
    k[2] = fr.k2 / 128; k[3] = fr.k3 / 128; k[4] = fr.k4 / 128;
    k[5] = fr.k5 / 128; k[6] = fr.k6 / 128; k[7] = fr.k7 / 128;
    k[8] = fr.k8 / 128; k[9] = fr.k9 / 128;
    for (let n = 0; n < hop; n++) {
      let exc = Math.random() > 0.5 ? noiseE : -noiseE;
      if (period > 0) {
        phase += 1;
        if (phase >= period) {
          phase -= period;
          exc += pulseE;
        }
      }
      e[10] = exc * 1.5;
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
      if (e[0] > 2) e[0] = 2;
      else if (e[0] < -2) e[0] = -2;
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
      if (o < out.length) out[o++] = e[0];
    }
  };

  const silent = emptyFrame();
  for (const w of words) {
    phase = 0;
    for (const fr of w) runFrame(fr);
    for (let g = 0; g < gapFrames; g++) runFrame(silent);
  }

  let peak = 1e-6;
  for (let i = 0; i < o; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const g = 0.55 / peak;
  for (let i = 0; i < o; i++) out[i] *= g;
  return o === out.length ? out : out.subarray(0, o);
}

/**
 * Downsample Float32 mono buffer to 8 kHz.
 * @param {Float32Array} input
 * @param {number} inputRate
 */
export function resampleTo8k(input, inputRate) {
  if (!input?.length || !inputRate) return new Float32Array(0);
  if (Math.abs(inputRate - SPEECH_LPC_SR) < 1) return input.slice(0);
  const outLen = Math.max(1, Math.floor(input.length * SPEECH_LPC_SR / inputRate));
  const out = new Float32Array(outLen);
  const ratio = inputRate / SPEECH_LPC_SR;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

/**
 * Split 8 kHz mono into words on ~0.5 s silence.
 * @param {Float32Array} samples8k
 */
export function splitWordsOnSilence(samples8k, {
  silenceSec = SPEECH_LPC_SILENCE_SEC,
  maxWords = SPEECH_LPC_MAX_WORDS,
} = {}) {
  const silenceSamples = Math.round(silenceSec * SPEECH_LPC_SR);
  const win = 160; // 20 ms
  const thresh = 0.012;
  const isSilent = new Uint8Array(Math.ceil(samples8k.length / win));
  for (let b = 0; b < isSilent.length; b++) {
    const start = b * win;
    const end = Math.min(samples8k.length, start + win);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples8k[i]);
      if (a > peak) peak = a;
    }
    isSilent[b] = peak < thresh ? 1 : 0;
  }
  const words = [];
  let i = 0;
  // skip leading silence
  while (i < isSilent.length && isSilent[i]) i++;
  while (i < isSilent.length && words.length < maxWords) {
    const startBlock = i;
    while (i < isSilent.length && !isSilent[i]) i++;
    const speechEnd = i;
    let silentRun = 0;
    while (i < isSilent.length && isSilent[i]) {
      silentRun++;
      i++;
      if (silentRun * win >= silenceSamples) break;
    }
    const start = startBlock * win;
    const end = Math.min(samples8k.length, speechEnd * win);
    if (end - start >= Math.round(SPEECH_LPC_MIN_WORD_SEC * SPEECH_LPC_SR)) {
      words.push(samples8k.subarray(start, end));
    }
    // consume remaining silence of the gap
    while (i < isSilent.length && isSilent[i]) i++;
  }
  return words;
}

/**
 * Encode one word (8 kHz Float32) to TMS5220 bitstream bytes.
 * @param {Float32Array} wordSamples
 */
export function encodeWordLpc(wordSamples) {
  const emphasized = preEmphasis(wordSamples);
  const window = hammingWindow(SPEECH_LPC_FRAME);
  const frames = [];
  const hop = SPEECH_LPC_FRAME;
  for (let off = 0; off + hop <= emphasized.length; off += hop) {
    if (frames.length >= SPEECH_LPC_MAX_FRAMES) break;
    const rawSlice = wordSamples.subarray(off, off + hop);
    const slice = emphasized.subarray(off, off + hop);
    frames.push(analyzeFrame(slice, window, rawSlice));
  }
  if (frames.length === 0) {
    frames.push({ energyIdx: 0, periodIdx: 0, kIdx: null, pitchCorr: 0 });
  }
  // Factory unvoiced energy never exceeds 10; energy 11–14 + weak pitch is a
  // dropped vowel (hiss). Hold pitch if corr is close, else cap unvoiced energy.
  let lastPeriodIdx = 0;
  for (const f of frames) {
    const corr = f.pitchCorr || 0;
    if (f.periodIdx === 0 && lastPeriodIdx > 0 && corr >= 0.16) {
      f.periodIdx = lastPeriodIdx;
    }
    if (f.periodIdx === 0 && f.energyIdx > 10) {
      f.energyIdx = 10;
    }
    lastPeriodIdx = f.periodIdx > 0 ? f.periodIdx : 0;
  }
  return packWord(frames);
}

/**
 * Full pipeline: AudioBuffer or Float32+rate → packed USER bank bytes.
 * @param {{ samples: Float32Array, sampleRate: number }} audio
 * @param {{ onProgress?: (p: number, msg: string) => void }} [opts]
 * @returns {{ bytes: Uint8Array, wordCount: number, frameCount: number, durationSec: number, gainDb: number, source8k: Float32Array }}
 */
export function encodeRecordingToUserBank(audio, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  onProgress(0.05, 'Resampling to 8 kHz…');
  let samples = resampleTo8k(audio.samples, audio.sampleRate);
  const maxSamples = SPEECH_LPC_MAX_SEC * SPEECH_LPC_SR;
  if (samples.length > maxSamples) samples = samples.subarray(0, maxSamples);

  onProgress(0.1, 'Matching level…');
  const matched = matchLevel(samples);
  samples = matched.samples;
  const gainDb = matched.gainDb;
  const durationSec = samples.length / SPEECH_LPC_SR;

  onProgress(0.15, 'Splitting words on silence…');
  const words = splitWordsOnSilence(samples);
  if (!words.length) {
    throw new Error('No speech detected. Speak closer to the mic and leave pauses between words.');
  }

  const parts = [];
  let frameCount = 0;
  for (let w = 0; w < words.length; w++) {
    onProgress(0.2 + 0.7 * (w / words.length), `Encoding word ${w + 1} of ${words.length}…`);
    const packed = encodeWordLpc(words[w]);
    if (frameCount + packed.frameCount > SPEECH_LPC_MAX_FRAMES) {
      break;
    }
    frameCount += packed.frameCount;
    parts.push(packed.bytes);
  }
  if (!parts.length) {
    throw new Error('Encoding produced an empty bank.');
  }

  onProgress(0.95, 'Packing bank…');
  let total = 0;
  for (const p of parts) total += p.length;
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  onProgress(1, `Ready — ${parts.length} word${parts.length === 1 ? '' : 's'}.`);
  return {
    bytes,
    wordCount: parts.length,
    frameCount,
    durationSec,
    gainDb,
    source8k: samples,
  };
}

/** Decode a recorded Blob (webm/wav/ogg) to mono Float32 + sampleRate. */
export async function decodeBlobToMono(blob, audioContext) {
  const ctx = audioContext || new AudioContext();
  const own = !audioContext;
  try {
    const ab = await blob.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab.slice(0));
    const ch0 = buf.getChannelData(0);
    let samples = ch0;
    if (buf.numberOfChannels > 1) {
      const mixed = new Float32Array(buf.length);
      const n = buf.numberOfChannels;
      for (let c = 0; c < n; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < buf.length; i++) mixed[i] += ch[i] / n;
      }
      samples = mixed;
    }
    return { samples, sampleRate: buf.sampleRate };
  } finally {
    if (own) {
      try { await ctx.close(); } catch (_) { /* ignore */ }
    }
  }
}
