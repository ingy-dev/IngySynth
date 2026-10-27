// Shared oscillator factory: classic OscillatorNode or OSC1 digital worklet.
// Plaits-style engines share one pooled AudioWorkletNode shell.
// Voices are pooled — creating AudioWorkletNode per note causes crackle.

import { state, OSC_COUNT } from './state.js?v=119';
import { getNumber, getOscType, getString } from './params.js?v=23';
import { isAnalogDrumEngine } from './pattern-bank.js?v=30';
import { applyAnalog808KitToLive, digitalDrumTuneHz } from './analog-808.js?v=20';

/** Slot index for the Analog/Digital engine (OSC 1). */
export const OSC4_INDEX = 0;
export const PLAITS_PROCESSOR = 'plaits-engine-processor';

/**
 * Per-engine output trim vs analog saw (~RMS 0.577).
 * Calibrate via scripts/calibrate-levels.html.
 *
 * History: blanket WT_OUTPUT_GAIN was 0.52 during the click-war (protect shared
 * high-Q soft-clip). Integrated wavetable AA restores level; these trims target
 * ~1 dB of analog saw while staying under ~1.0 so Master-mode 16ths at max
 * cutoff/resonance do not slam the soft-clip. If soft-clip returns, lower
 * wavetable/fm first (0.70–0.75) before touching attack slews.
 */
export const ENGINE_TRIM = {
    wavetable: 0.82,
    fm: 0.68,
    fm6: 1.0,
    waveshaper: 0.72,
    modal: 0.95,
    string: 0.88,
    bass_drum: 0.92,
    snare: 0.85,
    hihat: 0.7,
    open_hat: 0.7,
    va: 0.75,
    va_vcf: 0.7,
    additive: 0.85,
    grain: 0.95,
    swarm: 0.7,
    noise: 0.65,
    particle: 0.7,
    pd: 0.72,
    terrain: 0.8,
    string_machine: 0.75,
    chiptune: 0.62,
    chord: 0.7,
    speech: 0.75,
};

/** Engines that ring after gate-off (trigger/exciter model). */
export const TRIGGERED_ENGINES = new Set([
    'modal', 'string', 'bass_drum', 'snare', 'hihat', 'open_hat', 'fm6',
]);

export const ENGINE_TAIL_SEC = {
    modal: 8,
    string: 8,
    bass_drum: 2.5,
    snare: 2.5,
    hihat: 2.0,
    open_hat: 1.4,
    fm6: 8,
};

export const DRUM_ENGINES = new Set(['bass_drum', 'snare', 'hihat', 'open_hat']);

const WT_POOL_MAX = 16;
const DRUM_POOL_MAX = 6;
/** Idle Plaits shells for Digital / Berlin. */
export const PLAITS_WARM_COUNT = 6;
/** 6-voice Multitudes: live voices + ringing extras so note-on does not construct nodes. */
export const PLAITS_POLY_WARM_COUNT = 12;

const ANALOG_SHELL_UNISON = 3;
const ANALOG_SHELL_OVERLAP = 2;
/** oscs × unison × overlap — no extra burst. Logs: refill-to-72 was 51 creates / 270 ms Safari. */
const ANALOG_SHELL_TARGET = OSC_COUNT * ANALOG_SHELL_UNISON * ANALOG_SHELL_OVERLAP;
const ANALOG_SHELL_WARM = ANALOG_SHELL_TARGET;
const ANALOG_SHELL_REFILL_BUDGET = 3;
let analogShells = [];
let analogShellCtx = null;
let analogRefillTimer = null;
let analogAbxDone = false;

/** Last AudioWorklet process() sample (main thread; posted from the processor). */
let lastWorkletPerf = null;

function poolCounts(pool) {
    let inUse = 0;
    let ringing = 0;
    for (const s of pool) {
        if (s.inUse) inUse += 1;
        if (s.ringing) ringing += 1;
    }
    return { size: pool.length, inUse, ringing };
}

function bindWorkletPort(slot) {
    slot.node.port.onmessage = (ev) => {
        const msg = ev.data;
        if (msg?.silent) slot.ringing = false;
        if (msg?.perf) lastWorkletPerf = msg.perf;
    };
}

export function getWorkletPoolStats() {
    return {
        wt: poolCounts(wtPool),
        drum: {
            ...poolCounts(drumPool),
            overflow: drumPool.length > DRUM_POOL_MAX,
            max: DRUM_POOL_MAX,
        },
        analogShells: analogShells.length,
        analogShellTarget: ANALOG_SHELL_TARGET,
        lastWorklet: lastWorkletPerf,
        wtMax: WT_POOL_MAX,
    };
}

export function engineTrim(model = state.osc4Model) {
    const key = model || 'wavetable';
    return ENGINE_TRIM[key] ?? 0.8;
}

export function isTriggeredEngine(model = state.osc4Model) {
    return TRIGGERED_ENGINES.has(model || 'wavetable');
}

/**
 * Proven click-free attack (restore if a nudge brings clicks back).
 * Active values = default − tiny step; bump WT_ATTACK_NUDGE to try the next step.
 */
export const WT_ATTACK_DEFAULT_SEC = 0.022;
export const WT_ATTACK_RISK_STRETCH_DEFAULT = 0.038;
/** Each step shortens base & risk stretch by 2ms. Step 0 = proven click-free defaults. */
export const WT_ATTACK_NUDGE_STEP = 0;
export const WT_ATTACK_NUDGE_SEC = 0.002;
export const WT_ATTACK_SEC = Math.max(
    0.006,
    WT_ATTACK_DEFAULT_SEC - WT_ATTACK_NUDGE_STEP * WT_ATTACK_NUDGE_SEC,
);
export const WT_ATTACK_RISK_STRETCH = Math.max(
    0.01,
    WT_ATTACK_RISK_STRETCH_DEFAULT - WT_ATTACK_NUDGE_STEP * WT_ATTACK_NUDGE_SEC,
);
export const WT_RELEASE_SEC = 0.04;
/** Digital worklet gate/outGain only — does not affect analog or dark-osc amp floors. */
export const WT_GATE_ATTACK_SCALE = 0.6;

/**
 * Spectrally dark sources (sine/triangle/wavetable) leave a high-Q resonant
 * peak silent, so onset transients ping it audibly. Bright waves (saw/square)
 * mask the same ping — they keep their fast attacks.
 */
export function hasDarkOscActive() {
    if (state.osc4Wavetable && state.oscStates?.[OSC4_INDEX]) return true;
    for (let i = 0; i < (state.oscStates?.length || 0); i++) {
        if (!state.oscStates[i]) continue;
        if (i === OSC4_INDEX && state.osc4Wavetable) continue;
        const wave = getOscType(i);
        if (wave === 'sine' || wave === 'triangle') return true;
    }
    return false;
}

/** How hard the shared filter will ping a WT onset (0..1). */
export function wtFilterClickRisk() {
    const cutoff = getNumber('cutoff', 1000);
    const q = getNumber('resonance', 1);
    const c = Number.isFinite(cutoff) ? cutoff : 1000;
    const res = Number.isFinite(q) ? q : 1;
    const bright = Math.max(0, Math.min(1, (c - 1200) / 8800));
    const scream = Math.max(0, Math.min(1, (res - 1.5) / 18.5));
    // High cut + high Q compound — product captures the worst case
    return Math.max(bright, scream, bright * scream * 1.35);
}

/** Soft gate stretch from filter cut/res for digital worklet onsets. */
export function wtAttackSecForFilter() {
    const risk = wtFilterClickRisk();
    return WT_ATTACK_SEC + risk * WT_ATTACK_RISK_STRETCH;
}

/**
 * Fade a per-voice GainNode in. Wavetable + high-Q filters need a longer ramp
 * than classic OscillatorNode (seq/Berlin previously jumped to full voiceVol).
 */
export function softStartVoiceGain(gainParam, targetVol, when, { wavetable = false, triggered = false } = {}) {
    if (!gainParam) return;
    const t = Math.max(0, when || 0);
    const peak = Math.max(0, Number(targetVol) || 0);
    // Triggered engines need a near-instant onset or plucks/drums die on arrival.
    const attack = triggered
        ? 0.002
        : wavetable
            ? Math.max(0.008, wtAttackSecForFilter() * WT_GATE_ATTACK_SCALE)
            : 0.004;
    try {
        gainParam.cancelScheduledValues(t);
        gainParam.setValueAtTime(0, t);
        // Ease-in: linear to ~70%, then setTarget for a softer knee into the peak
        const mid = t + attack * 0.55;
        gainParam.linearRampToValueAtTime(peak * 0.7, mid);
        gainParam.setTargetAtTime(peak, mid, Math.max(0.003, attack * 0.25));
    } catch (_) {
        try {
            gainParam.setValueAtTime(0, t);
            gainParam.linearRampToValueAtTime(peak, t + attack);
        } catch (__) {
            gainParam.value = peak;
        }
    }
}

/**
 * Hold the automated value at `when`, then ramp. Avoids the classic lookahead
 * bug: reading AudioParam.value (now) and setValueAtTime(that, future) jumps.
 */
function holdThenRamp(param, when, target, endTime) {
    if (!param) return { held: false, lookahead: 0, valueNow: 0 };
    const ctx = state.audioContext;
    const now = ctx?.currentTime || 0;
    const t = Math.max(now, when || 0);
    const end = Math.max(t, endTime || t);
    const valueNow = Number(param.value) || 0;
    const lookahead = t - now;
    let held = false;
    try {
        // Prefer hold-at-t so future note-offs don't jump from a stale .value (often 0)
        if (typeof param.cancelAndHoldAtTime === 'function') {
            param.cancelAndHoldAtTime(t);
            held = true;
        } else if (t <= now + 0.0005) {
            param.cancelScheduledValues(t);
            param.setValueAtTime(Math.max(0.00001, valueNow), t);
        } else {
            // Future schedule without hold API: assume digital gate is open at release
            param.cancelScheduledValues(t);
            param.setValueAtTime(Math.max(0.00001, valueNow > 0.05 ? valueNow : 1), t);
        }
        param.linearRampToValueAtTime(target, end);
    } catch (_) {
        try {
            param.cancelScheduledValues(t);
            param.setValueAtTime(Math.max(0.00001, valueNow > 0.05 ? valueNow : 1), t);
            param.linearRampToValueAtTime(target, end);
        } catch (__) { /* ignore */ }
    }
    return { held, lookahead, valueNow };
}

/**
 * Schedule a click-free teardown. NEVER disconnect synchronously — that cuts
 * the graph before the fade and pops hard into an open filter (seq step changes).
 *
 * @param {{ fadeSec?: number, hard?: boolean }} [opts]
 *   hard=true: for triggered engines (pluck/drums), free the pool after a short
 *   outGain fade instead of an 8s ring. Use when replacing a voice (Master
 *   phase-reset step change, Berlin/ratch dispose). Leave false for keyboard
 *   note-off so the physical model can still ring out.
 */
export function fadeStopOsc(osc, when, { fadeSec = 0.02, hard = false } = {}) {
    if (!osc?.started) return;
    const ctx = state.audioContext;
    if (!ctx) return;
    const tEnd = Math.max(ctx.currentTime, when || ctx.currentTime);
    // Master replaces into an open shared filter — need enough outGain fade to
    // avoid ticks. Berlin dispose already silenced the voice amp (silent cut).
    const fade = hard && osc.isTriggered
        ? Math.max(0.045, fadeSec)
        : Math.max(0.01, fadeSec);
    const t0 = Math.max(ctx.currentTime, tEnd - fade);
    try {
        if (osc.gainNode) {
            holdThenRamp(osc.gainNode.gain, t0, 0.00001, tEnd);
        } else if (osc._outGain?.gain && hard && osc.isTriggered) {
            // Wavetable proxy: no external gainNode — fade the worklet outGain
            // before / as we hard-release so Master step replaces don't click.
            holdThenRamp(osc._outGain.gain, t0, 0.00001, tEnd);
        }
        if (hard && osc.isTriggered) {
            osc.stop(tEnd, { hard: true, fadeSec: fade, silent: false });
        } else {
            osc.stop(tEnd);
        }
        if (!osc.isWavetable) {
            const delayMs = Math.max(0, (tEnd - ctx.currentTime) * 1000) + 30;
            setTimeout(() => {
                const tDisc = performance.now();
                try { osc.disconnect(); } catch (_) { /* ignore */ }
                try { osc.gainNode?.disconnect(); } catch (_) { /* ignore */ }
                const ms = performance.now() - tDisc;
                const p = (window.__ingyProf ||= {});
                p.analogDisconnectN = (p.analogDisconnectN || 0) + 1;
                if (ms > (p.analogDisconnectMax || 0)) p.analogDisconnectMax = ms;
            }, delayMs);
        }
        // Wavetable proxy stop() owns outGain disconnect / pool return
    } catch (_) { /* ignore */ }
}

/** @type {{ ctx: AudioContext, node: AudioWorkletNode, inUse: boolean, gen: number, tablesSent?: boolean, ringing?: boolean, drum?: boolean, engine?: string }[]} */
let wtPool = [];
let wtPoolCtx = null;
/** Dedicated Plaits pool for Berlin D1–D4 — never steal wtPool[0]. */
let drumPool = [];
let drumPoolCtx = null;
/** Official Plaits wavetable ROM (float32 LE, 4×64×128 integrated). */
let plaitsTablesBuffer = null;
let plaitsTablesPromise = null;
/** Waveshaper / fold / stiffness LUTs. */
let plaitsWsBuffer = null;
let plaitsWsPromise = null;
/** Emilie Plaits 1.2 FM banks: 3 × 32 × 128 packed DX7 voices. */
let plaitsFmBanksBuffer = null;
let plaitsFmBanksPromise = null;
/** Active 6-op bank index 0–2 (Bass / Keys / Pads). */
let plaitsFmBankIndex = 0;
/** Stock Plaits speech ROM (excitation + LPC word banks). */
let plaitsSpeechBuffer = null;
let plaitsSpeechPromise = null;
/** Optional USER LPC bank bytes (appended as banks[5] in the worklet). */
let plaitsSpeechUserBank = null;

const SPEECH_USER_STORAGE_KEY = 'ingysynth.speechUserBank.v1';
const SPEECH_USER_ACTIVE_KEY = 'ingysynth.speechUserBankActive.v1';

function u8ToBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
}

function base64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function restoreSpeechUserBankFromStorage() {
    try {
        const b64 = localStorage.getItem(SPEECH_USER_STORAGE_KEY);
        if (b64) {
            plaitsSpeechUserBank = base64ToU8(b64);
        }
        const active = localStorage.getItem(SPEECH_USER_ACTIVE_KEY);
        state.osc4SpeechUserBank = active === '1' && !!(plaitsSpeechUserBank && plaitsSpeechUserBank.length);
    } catch (_) {
        plaitsSpeechUserBank = null;
        state.osc4SpeechUserBank = false;
    }
}

// Hydrate USER bank flag early so REC/USER button is correct before worklet load.
restoreSpeechUserBankFromStorage();

/** Resolve worklets from this module so `/vr/` does not look in `/vr/js/worklets/`. */
const JS_DIR = new URL('./', import.meta.url);
const jsAsset = (rel) => new URL(rel, JS_DIR).href;

const PLAITS_TABLES_URL = () => jsAsset('worklets/plaits-wavetables.bin?v=2');
const PLAITS_WS_URL = () => jsAsset('worklets/plaits-waveshaper.bin?v=1');
const PLAITS_FM_BANKS_URL = () => jsAsset('worklets/plaits-fm-banks.bin?v=1');
const PLAITS_SPEECH_URL = () => jsAsset('worklets/plaits-speech.bin?v=1');

const FM6_BANK_BYTES = 4096;
const FM6_PATCH_BYTES = 128;

function loadPlaitsTables() {
    if (plaitsTablesBuffer) return Promise.resolve(plaitsTablesBuffer);
    if (plaitsTablesPromise) return plaitsTablesPromise;
    plaitsTablesPromise = fetch(PLAITS_TABLES_URL())
        .then((r) => {
            if (!r.ok) throw new Error(`wavetables HTTP ${r.status}`);
            return r.arrayBuffer();
        })
        .then((buf) => {
            // 4 banks × 64 waves × 128 samples × 4 bytes
            if (buf.byteLength < 4 * 64 * 128 * 4) {
                throw new Error(`wavetables too small: ${buf.byteLength}`);
            }
            plaitsTablesBuffer = buf;
            return buf;
        })
        .catch((err) => {
            console.warn('Plaits wavetable ROM failed to load:', err);
            plaitsTablesPromise = null;
            return null;
        });
    return plaitsTablesPromise;
}

function loadPlaitsWaveshaper() {
    if (plaitsWsBuffer) return Promise.resolve(plaitsWsBuffer);
    if (plaitsWsPromise) return plaitsWsPromise;
    plaitsWsPromise = fetch(PLAITS_WS_URL())
        .then((r) => {
            if (!r.ok) throw new Error(`waveshaper HTTP ${r.status}`);
            return r.arrayBuffer();
        })
        .then((buf) => {
            plaitsWsBuffer = buf;
            return buf;
        })
        .catch((err) => {
            console.warn('Plaits waveshaper LUTs failed to load:', err);
            plaitsWsPromise = null;
            return null;
        });
    return plaitsWsPromise;
}

function loadPlaitsFmBanks() {
    if (plaitsFmBanksBuffer) return Promise.resolve(plaitsFmBanksBuffer);
    if (plaitsFmBanksPromise) return plaitsFmBanksPromise;
    plaitsFmBanksPromise = fetch(PLAITS_FM_BANKS_URL())
        .then((r) => {
            if (!r.ok) throw new Error(`fm-banks HTTP ${r.status}`);
            return r.arrayBuffer();
        })
        .then((buf) => {
            if (buf.byteLength < FM6_BANK_BYTES * 3) {
                throw new Error(`fm-banks too small: ${buf.byteLength}`);
            }
            plaitsFmBanksBuffer = buf;
            return buf;
        })
        .catch((err) => {
            console.warn('Plaits FM banks failed to load:', err);
            plaitsFmBanksPromise = null;
            return null;
        });
    return plaitsFmBanksPromise;
}

function loadPlaitsSpeech() {
    if (plaitsSpeechBuffer) return Promise.resolve(plaitsSpeechBuffer);
    if (plaitsSpeechPromise) return plaitsSpeechPromise;
    plaitsSpeechPromise = fetch(PLAITS_SPEECH_URL())
        .then((r) => {
            if (!r.ok) throw new Error(`speech ROM HTTP ${r.status}`);
            return r.arrayBuffer();
        })
        .then((buf) => {
            if (buf.byteLength < 16) {
                throw new Error(`speech ROM too small: ${buf.byteLength}`);
            }
            plaitsSpeechBuffer = buf;
            restoreSpeechUserBankFromStorage();
            return buf;
        })
        .catch((err) => {
            console.warn('Plaits speech ROM failed to load:', err);
            plaitsSpeechPromise = null;
            return null;
        });
    return plaitsSpeechPromise;
}

function persistSpeechUserBank() {
    try {
        if (plaitsSpeechUserBank && plaitsSpeechUserBank.length) {
            localStorage.setItem(SPEECH_USER_STORAGE_KEY, u8ToBase64(plaitsSpeechUserBank));
        } else {
            localStorage.removeItem(SPEECH_USER_STORAGE_KEY);
        }
        localStorage.setItem(SPEECH_USER_ACTIVE_KEY, state.osc4SpeechUserBank ? '1' : '0');
    } catch (err) {
        console.warn('Could not persist Voice USER bank:', err);
    }
}

export function getSpeechUserBankBytes() {
    return plaitsSpeechUserBank;
}

export function hasSpeechUserBank() {
    return !!(plaitsSpeechUserBank && plaitsSpeechUserBank.length);
}

function postSpeechUserBankToNode(node) {
    if (!node?.port) return;
    try {
        if (plaitsSpeechUserBank && plaitsSpeechUserBank.length) {
            node.port.postMessage({
                userBank: plaitsSpeechUserBank.slice(0).buffer,
                userBankActive: !!state.osc4SpeechUserBank,
            });
        } else {
            node.port.postMessage({ userBank: null, userBankActive: false });
        }
    } catch (_) { /* ignore */ }
}

/** Push USER bank (or clear) into every pooled + live digital worklet. */
export function applySpeechUserBankToLive({
    bytes = plaitsSpeechUserBank,
    active = state.osc4SpeechUserBank,
    persist = true,
} = {}) {
    if (bytes && bytes.length) {
        plaitsSpeechUserBank = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        state.osc4SpeechUserBank = !!active;
    } else {
        plaitsSpeechUserBank = null;
        state.osc4SpeechUserBank = false;
    }
    if (persist) persistSpeechUserBank();

    wtPool.forEach((slot) => postSpeechUserBankToNode(slot?.node));

    const touch = (osc) => {
        if (!osc?.isWavetable || !osc._worklet) return;
        postSpeechUserBankToNode(osc._worklet);
    };
    if (Array.isArray(state.activeOscillators)) state.activeOscillators.forEach(touch);
    if (state.oscillators?.[OSC4_INDEX]) touch(state.oscillators[OSC4_INDEX]);
    if (Array.isArray(state.berlinOscVoices)) {
        state.berlinOscVoices.forEach((voice) => {
            voice?.oscs?.forEach(({ osc }) => touch(osc));
        });
    }
    try { osc4MorphLiveHook?.(touch); } catch (_) { /* ignore */ }
}

export function clearSpeechUserBank() {
    applySpeechUserBankToLive({ bytes: null, active: false, persist: true });
}

/** Keep packed bytes; toggle whether Voice pins the USER bank vs factory MODEL. */
export function setSpeechUserBankActive(active) {
    if (!plaitsSpeechUserBank || !plaitsSpeechUserBank.length) {
        state.osc4SpeechUserBank = false;
        applySpeechUserBankToLive({ bytes: null, active: false, persist: true });
        return false;
    }
    applySpeechUserBankToLive({
        bytes: plaitsSpeechUserBank,
        active: !!active,
        persist: true,
    });
    return !!state.osc4SpeechUserBank;
}

/** Slice of factory ROM for bank 0–2 (4096 bytes). */
export function getFm6BankBytes(bankIndex = plaitsFmBankIndex) {
    if (!plaitsFmBanksBuffer) return null;
    const i = Math.max(0, Math.min(2, bankIndex | 0));
    return plaitsFmBanksBuffer.slice(i * FM6_BANK_BYTES, (i + 1) * FM6_BANK_BYTES);
}

/** 10-char DX patch name from packed voice bytes. */
export function readFm6PatchName(bankIndex, patchIndex) {
    const bank = getFm6BankBytes(bankIndex);
    if (!bank) return '';
    const p = Math.max(0, Math.min(31, patchIndex | 0));
    const bytes = new Uint8Array(bank, p * FM6_PATCH_BYTES + 118, 10);
    let s = '';
    for (let i = 0; i < 10; i++) {
        const c = bytes[i] & 0x7f;
        if (c >= 32 && c < 127) s += String.fromCharCode(c);
    }
    return s.trim();
}

/** Preset index 0–31 from harmonics knob (matches worklet quantizer). */
export function fm6PresetFromHarmonics(harmonics = state.osc4Harmonics) {
    const h = Number.isFinite(harmonics) ? Math.max(0, Math.min(1, harmonics)) : 0.5;
    let idx = Math.floor(h * 1.02 * 32);
    if (idx > 31) idx = 31;
    if (idx < 0) idx = 0;
    return idx;
}

export function getFm6BankIndex() {
    return plaitsFmBankIndex;
}

function injectPlaitsAssets(node) {
    if (!node) return;
    try {
        if (plaitsTablesBuffer) {
            node.port.postMessage({ tables: plaitsTablesBuffer.slice(0) });
        }
        if (plaitsWsBuffer) {
            node.port.postMessage({ waveshaper: plaitsWsBuffer.slice(0) });
        }
        const fmBank = getFm6BankBytes(plaitsFmBankIndex);
        if (fmBank) {
            node.port.postMessage({ fmBank: fmBank.slice(0) });
        }
        if (plaitsSpeechBuffer) {
            node.port.postMessage({ speech: plaitsSpeechBuffer.slice(0) });
        }
        postSpeechUserBankToNode(node);
    } catch (err) {
        console.warn('Failed to inject Plaits assets into worklet:', err);
    }
}

/** Push current FM6 bank into every pooled worklet (+ optional live voices). */
export function applyFm6BankToLive(bankIndex = plaitsFmBankIndex) {
    plaitsFmBankIndex = Math.max(0, Math.min(2, bankIndex | 0));
    const bank = getFm6BankBytes(plaitsFmBankIndex);
    if (!bank) return;
    wtPool.forEach((slot) => {
        if (!slot?.node?.port || slot.drum) return;
        try {
            slot.node.port.postMessage({ fmBank: bank.slice(0) });
        } catch (_) { /* ignore */ }
    });
}

export function isOsc4Wavetable() {
    return !!state.osc4Wavetable && !!state.plaitsWorkletReady;
}

export function readOsc4Morph() {
    const x = getNumber('osc4MorphX', state.osc4MorphX);
    const y = getNumber('osc4MorphY', state.osc4MorphY);
    return {
        x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5,
        y: Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5,
    };
}

export function readOsc4Harmonics() {
    const v = getNumber('osc4Harmonics', state.osc4Harmonics);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

function resetDrumPoolIfNeeded(ctx) {
    if (drumPoolCtx === ctx) return;
    drumPool.forEach((slot) => {
        try { slot.node.disconnect(); } catch (_) { /* ignore */ }
    });
    drumPool = [];
    drumPoolCtx = ctx;
}

function resetWtPoolIfNeeded(ctx) {
    if (wtPoolCtx !== ctx) {
        wtPool.forEach((slot) => {
            try { slot.node.disconnect(); } catch (_) { /* ignore */ }
        });
        wtPool = [];
        wtPoolCtx = ctx;
    }
    resetDrumPoolIfNeeded(ctx);
}

/** Load AudioWorklet + Plaits ROM assets once per AudioContext. */
export function ensurePlaitsWorklet(ctx = state.audioContext) {
    if (!ctx?.audioWorklet) {
        state.plaitsWorkletReady = false;
        return Promise.resolve(false);
    }
    if (state.plaitsWorkletReady && state.plaitsWorkletCtx === ctx && plaitsTablesBuffer) {
        warmPlaitsPool(ctx, PLAITS_WARM_COUNT);
        return Promise.resolve(true);
    }
    if (state.plaitsWorkletPromise && state.plaitsWorkletCtx === ctx) {
        return state.plaitsWorkletPromise;
    }

    state.plaitsWorkletCtx = ctx;
    const url = jsAsset('worklets/plaits-engine-processor.js?v=43');
    state.plaitsWorkletPromise = Promise.all([
        ctx.audioWorklet.addModule(url),
        loadPlaitsTables(),
        loadPlaitsWaveshaper(),
        loadPlaitsFmBanks(),
        loadPlaitsSpeech(),
    ])
        .then(([, tables]) => {
            if (!tables) {
                state.plaitsWorkletReady = false;
                return false;
            }
            state.plaitsWorkletReady = true;
            resetWtPoolIfNeeded(ctx);
            warmPlaitsPool(ctx, PLAITS_WARM_COUNT);
            return true;
        })
        .catch((err) => {
            console.warn('Plaits engine worklet failed to load:', err);
            state.plaitsWorkletReady = false;
            return false;
        });
    return state.plaitsWorkletPromise;
}

function bumpWorkletCreate(ms) {
    const p = (window.__ingyProf ||= {});
    if (ms > (p.workletCreateMax || 0)) p.workletCreateMax = ms;
    p.workletCreateN = (p.workletCreateN || 0) + 1;
}

function makePlaitsWorkletNode(ctx) {
    const t0 = performance.now();
    const node = new AudioWorkletNode(ctx, PLAITS_PROCESSOR, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        parameterData: {
            frequency: 440,
            detune: 0,
            morphX: 0.5,
            morphY: 0.5,
            harmonics: 0.5,
            bank: -1,
            gate: 0,
        },
    });
    bumpWorkletCreate(performance.now() - t0);
    return node;
}

/** Pre-create idle Plaits shells so the first notes do not construct AudioWorkletNode. */
export function warmPlaitsPool(ctx, count = PLAITS_WARM_COUNT) {
    if (!ctx || !state.plaitsWorkletReady) return 0;
    resetWtPoolIfNeeded(ctx);
    let made = 0;
    while (wtPool.length < count && wtPool.length < WT_POOL_MAX) {
        const node = makePlaitsWorkletNode(ctx);
        const slot = { ctx, node, inUse: false, gen: 0, tablesSent: true, ringing: false };
        bindWorkletPort(slot);
        injectPlaitsAssets(node);
        wtPool.push(slot);
        made += 1;
    }
    return made;
}

function acquirePoolSlot(ctx) {
    resetWtPoolIfNeeded(ctx);
    let slot = wtPool.find((s) => !s.inUse && !s.ringing);
    if (!slot) {
        if (wtPool.length >= WT_POOL_MAX) {
            // Prefer idle non-ringing; never steal a ringing physical-model voice
            slot = wtPool.find((s) => !s.inUse && !s.ringing);
            if (!slot) slot = wtPool.find((s) => !s.inUse);
            if (!slot) {
                slot = wtPool[0];
                try {
                    const g = slot.node.parameters.get('gate');
                    const t = ctx.currentTime;
                    g.cancelScheduledValues(t);
                    g.setValueAtTime(Math.max(0, g.value || 0), t);
                    g.linearRampToValueAtTime(0, t + 0.012);
                } catch (_) { /* ignore */ }
                slot.inUse = false;
                slot.ringing = false;
            }
        } else {
            const node = makePlaitsWorkletNode(ctx);
            slot = { ctx, node, inUse: false, gen: 0, tablesSent: true, ringing: false };
            bindWorkletPort(slot);
            injectPlaitsAssets(node);
            wtPool.push(slot);
        }
    }
    slot.inUse = true;
    slot.ringing = false;
    slot.gen += 1;
    if (!slot.tablesSent) {
        injectPlaitsAssets(slot.node);
        slot.tablesSent = true;
    }
    return slot;
}

function acquireDrumPoolSlot(ctx) {
    resetDrumPoolIfNeeded(ctx);
    let slot = drumPool.find((s) => !s.inUse && !s.ringing);
    if (!slot) {
        if (drumPool.length >= DRUM_POOL_MAX) {
            slot = drumPool.find((s) => !s.inUse && !s.ringing);
            if (!slot) slot = drumPool.find((s) => !s.inUse);
            if (!slot) {
                // Cap at DRUM_POOL_MAX — overflow-grow leaked worklets on Safari.
                slot = drumPool.find((s) => !s.inUse) || drumPool[0];
            }
        } else {
            const node = makePlaitsWorkletNode(ctx);
            slot = {
                ctx, node, inUse: false, gen: 0, tablesSent: true, ringing: false, drum: true,
            };
            bindWorkletPort(slot);
            injectPlaitsAssets(node);
            drumPool.push(slot);
        }
    }
    slot.inUse = true;
    slot.ringing = false;
    slot.drum = true;
    slot.gen += 1;
    if (!slot.tablesSent) {
        injectPlaitsAssets(slot.node);
        slot.tablesSent = true;
    }
    return slot;
}

function releasePoolSlot(slot, gen) {
    if (!slot || slot.gen !== gen) return;
    try {
        slot.node.parameters.get('gate').value = 0;
    } catch (_) { /* ignore */ }
    try { slot.node.disconnect(); } catch (_) { /* ignore */ }
    try {
        slot.node.port.postMessage({
            reset: true,
            engine: slot.engine || 'wavetable',
        });
    } catch (_) { /* ignore */ }
    slot.inUse = false;
    slot.ringing = false;
}

function createWavetableProxy(ctx, frequency, patchOverride = null, { drum = false } = {}) {
    let model;
    let openHat = false;
    let x;
    let y;
    let harmonics;
    let alt;
    let trigPatched;
    let velocity;
    let bank;
    if (patchOverride) {
        model = patchOverride.model || 'hihat';
        openHat = model === 'open_hat';
        if (openHat) model = 'hihat';
        x = Math.max(0, Math.min(1, Number(patchOverride.morphX) || 0.5));
        y = Math.max(0, Math.min(1, Number(patchOverride.morphY) || 0.5));
        harmonics = Math.max(0, Math.min(1, Number(patchOverride.harmonics) || 0.5));
        alt = !!patchOverride.alt;
        trigPatched = patchOverride.trigPatched !== false;
        velocity = Math.max(0, Math.min(1, Number(patchOverride.velocity)));
        if (!Number.isFinite(Number(patchOverride.velocity))) velocity = 0.8;
        bank = -1;
    } else {
        const morph = readOsc4Morph();
        x = morph.x;
        y = morph.y;
        harmonics = readOsc4Harmonics();
        model = getString('osc4Model', '') || state.osc4Model || 'wavetable';
        state.osc4Model = model;
        const bankFromStore = getNumber('osc4Bank', state.osc4Bank);
        const bankRaw = Number.isFinite(bankFromStore) ? bankFromStore : Number(state.osc4Bank);
        bank = Number.isFinite(bankRaw) ? Math.max(-1, Math.min(3, bankRaw)) : -1;
        alt = !!state.osc4Alt;
        trigPatched = state.osc4TrigPatched !== false;
        velocity = Number.isFinite(state.lastVelocity) ? state.lastVelocity : 0.8;
    }
    const triggered = isTriggeredEngine(model);
    const trim = engineTrim(model);
    const slot = drum ? acquireDrumPoolSlot(ctx) : acquirePoolSlot(ctx);
    slot.engine = model;
    slot.drum = !!drum;
    const node = slot.node;
    const gen = slot.gen;
    const now = ctx.currentTime;

    const frequencyParam = node.parameters.get('frequency');
    const detuneParam = node.parameters.get('detune');
    const gateParam = node.parameters.get('gate');
    const morphXParam = node.parameters.get('morphX');
    const morphYParam = node.parameters.get('morphY');
    const harmonicsParam = node.parameters.get('harmonics');

    if (model === 'fm6' && !drum) {
        const fmBank = Math.max(0, Math.min(2, bank >= 0 ? bank : 0));
        if (fmBank !== plaitsFmBankIndex) {
            applyFm6BankToLive(fmBank);
        } else {
            try {
                const bytes = getFm6BankBytes(fmBank);
                if (bytes) node.port.postMessage({ fmBank: bytes.slice(0) });
            } catch (_) { /* ignore */ }
        }
    }

    try {
        gateParam.cancelScheduledValues(now);
        gateParam.setValueAtTime(0, now);
        frequencyParam.setValueAtTime(Math.max(20, frequency || 440), now);
        detuneParam.setValueAtTime(0, now);
        morphXParam.setValueAtTime(x, now);
        morphYParam.setValueAtTime(y, now);
        if (harmonicsParam) harmonicsParam.setValueAtTime(harmonics, now);
        node.parameters.get('bank').setValueAtTime(bank, now);
        const velParam = node.parameters.get('velocity');
        if (velParam) velParam.setValueAtTime(Math.max(0, Math.min(1, velocity)), now);
        const altParam = node.parameters.get('alt');
        if (altParam) altParam.setValueAtTime(alt ? 1 : 0, now);
        const trigParam = node.parameters.get('trigPatched');
        if (trigParam) trigParam.setValueAtTime(trigPatched ? 1 : 0, now);
        const openParam = node.parameters.get('openHat');
        if (openParam) openParam.setValueAtTime(openHat ? 1 : 0, now);
        node.port.postMessage({
            reset: true,
            engine: model,
            polyMode: drum ? false : !!(state.keyboardMultitudes || state.keyboardPoly),
            alt,
            trigPatched,
            openHat,
        });
    } catch (_) { /* ignore */ }

    const outGain = ctx.createGain();
    outGain.gain.value = 0;
    node.connect(outGain);

    let stopped = false;
    let releaseTimer = 0;

    const proxy = {
        frequency: frequencyParam,
        detune: detuneParam,
        morphX: morphXParam,
        morphY: morphYParam,
        harmonics: harmonicsParam,
        isWavetable: true,
        isTriggered: triggered,
        isDrum: DRUM_ENGINES.has(model),
        isBerlinDrum: !!drum,
        engineModel: model,
        _worklet: node,
        _outGain: outGain,
        _slot: slot,
        started: false,
        connect(...args) {
            return outGain.connect(...args);
        },
        disconnect(...args) {
            // After stop(), teardown is owned by the pool release timer.
            if (stopped) return;
            try { outGain.disconnect(...args); } catch (_) { /* ignore */ }
        },
        start(when = 0) {
            if (stopped) return;
            // Slot was stolen for another voice — do not touch the shared worklet.
            if (slot.gen !== gen) return;
            const t = Math.max(ctx.currentTime, when || 0);
            const attack = triggered
                ? 0.002
                : Math.max(0.008, wtAttackSecForFilter() * WT_GATE_ATTACK_SCALE);
            const attackEnd = t + attack;
            gateParam.cancelScheduledValues(t);
            gateParam.setValueAtTime(0, t);
            gateParam.linearRampToValueAtTime(1, attackEnd);
            outGain.gain.cancelScheduledValues(t);
            outGain.gain.setValueAtTime(0, t);
            const mid = t + attack * 0.55;
            outGain.gain.linearRampToValueAtTime(trim * 0.7, mid);
            outGain.gain.setTargetAtTime(trim, mid, Math.max(0.001, attack * 0.25));
            if (triggered) slot.ringing = true;
            proxy.started = true;
        },
        /**
         * Master phase-reset: pulse gate on the same worklet instead of
         * stop+spawn. Avoids outGain cuts into the open shared filter (kick/modal clicks).
         */
        retrigger(when = 0, frequency = null) {
            if (stopped) return false;
            if (slot.gen !== gen) return false;
            const t = Math.max(ctx.currentTime, when || 0);
            try {
                // The worklet samples gate at block starts (parameters.gate[0]),
                // so the zero must HOLD for ≥1 render block (128/44100 ≈ 2.9ms)
                // or the rising edge is never seen and the exciter never refires
                // (symptom: one droning note). Open the gap ahead of the hit —
                // the scheduler runs with lookahead, so the attack lands on time.
                // Sustained engines (fm/wavetable/waveshaper) are still sounding
                // when the gate falls: give them a ramped release into the gap so
                // the 14ms in-worklet slew tracks it (phase resets on the edge).
                let gapStart;
                let holdEnd;
                if (triggered) {
                    gapStart = Math.max(ctx.currentTime, t - 0.008);
                    holdEnd = Math.max(t, gapStart + 0.004);
                } else {
                    const relStart = Math.max(ctx.currentTime, t - 0.05);
                    const relLen = Math.min(0.02, Math.max(0.004, (t - relStart) * 0.5));
                    gateParam.cancelScheduledValues(relStart);
                    gateParam.setValueAtTime(1, relStart);
                    gateParam.linearRampToValueAtTime(0, relStart + relLen);
                    gapStart = relStart + relLen;
                    holdEnd = Math.max(t, gapStart + 0.004);
                }
                if (frequency != null && Number.isFinite(frequency)) {
                    frequencyParam.cancelScheduledValues(gapStart);
                    frequencyParam.setValueAtTime(Math.max(20, frequency), gapStart);
                }
                if (triggered) {
                    gateParam.cancelScheduledValues(gapStart);
                    gateParam.setValueAtTime(0, gapStart);
                }
                gateParam.setValueAtTime(0, holdEnd);
                gateParam.linearRampToValueAtTime(1, holdEnd + 0.003);
                // Keep outGain at trim — ducking a kick/modal into an open filter clicks.
                outGain.gain.cancelScheduledValues(t);
                const cur = Math.max(0.00001, Number(outGain.gain.value) || trim);
                outGain.gain.setValueAtTime(cur, t);
                outGain.gain.setTargetAtTime(trim, t, 0.004);
                if (triggered) slot.ringing = true;
                proxy.started = true;
                return true;
            } catch (_) {
                return false;
            }
        },
        /**
         * Sequencer ratch: short 0→1 edge the worklet can see (≥1 render block).
         * Do not use retrigger() here — sustained engines spend ~50ms falling
         * and smear subdivisions.
         */
        pulseSeqGate(when = 0) {
            if (stopped) return false;
            if (slot.gen !== gen) return false;
            const t = Math.max(ctx.currentTime, when || 0);
            const gapStart = Math.max(ctx.currentTime, t - 0.006);
            const holdEnd = Math.max(t, gapStart + 0.003);
            try {
                gateParam.cancelScheduledValues(gapStart);
                gateParam.setValueAtTime(0, gapStart);
                gateParam.setValueAtTime(0, holdEnd);
                gateParam.linearRampToValueAtTime(1, holdEnd + 0.002);
                if (triggered) slot.ringing = true;
                proxy.started = true;
                return true;
            } catch (_) {
                return false;
            }
        },
        /** Sequencer gate-off: drop worklet gate without releasing the pool slot. */
        releaseSeqGate(offAt = 0) {
            if (stopped) return;
            if (slot.gen !== gen) return;
            const t = Math.max(ctx.currentTime, offAt || 0);
            try {
                if (typeof gateParam.cancelAndHoldAtTime === 'function') {
                    try { gateParam.cancelAndHoldAtTime(t); } catch (_) { /* ignore */ }
                } else {
                    gateParam.cancelScheduledValues(t);
                }
                gateParam.setTargetAtTime(0, t, 0.008);
            } catch (_) { /* ignore */ }
        },
        /**
         * @param {number} [when]
         * @param {{ hard?: boolean, fadeSec?: number, silent?: boolean }} [opts]
         *   hard: free pool after a short fade instead of ENGINE_TAIL_SEC.
         *   silent: external VCA already closed (Berlin) — short fade OK.
         *   audible Master replaces need a longer outGain fade into open filter.
         */
        stop(when = 0, opts = {}) {
            if (stopped) return;
            const hard = !!opts?.hard;
            const silent = !!opts?.silent;
            // Stale after pool steal: never gate-kill the new owner's worklet.
            if (slot.gen !== gen) {
                stopped = true;
                proxy.started = false;
                clearTimeout(releaseTimer);
                try { outGain.disconnect(); } catch (_) { /* ignore */ }
                return;
            }
            const t = Math.max(ctx.currentTime, when || 0);
            if (triggered) {
                // Hard: free CPU/pool after a short fade (not the 8s physical tail).
                if (hard) {
                    const fade = silent
                        ? Math.max(0.015, Number(opts.fadeSec) || 0.02)
                        : Math.max(0.045, Number(opts.fadeSec) || WT_RELEASE_SEC);
                    const gateFade = silent ? 0.005 : Math.min(0.014, fade * 0.35);
                    holdThenRamp(gateParam, t, 0, t + gateFade);
                    holdThenRamp(outGain.gain, t, 0, t + fade);
                    proxy.started = false;
                    stopped = true;
                    // Keep ringing=true until release so we don't steal mid-fade
                    slot.ringing = true;
                    clearTimeout(releaseTimer);
                    const delayMs = Math.max(0, (t + fade - ctx.currentTime) * 1000) + 12;
                    releaseTimer = setTimeout(() => {
                        try { outGain.disconnect(); } catch (_) { /* ignore */ }
                        releasePoolSlot(slot, gen);
                    }, delayMs);
                    return;
                }
                // Soft: gate-off ends excitation only; audio must ring out.
                holdThenRamp(gateParam, t, 0, t + 0.005);
                const tail = ENGINE_TAIL_SEC[model] || 4;
                const relEnd = t + tail;
                // Keep outGain open; fade only as a safety near timeout
                holdThenRamp(outGain.gain, Math.max(t, relEnd - 0.08), 0, relEnd);
                proxy.started = false;
                stopped = true;
                clearTimeout(releaseTimer);
                const delayMs = Math.max(0, (relEnd - ctx.currentTime) * 1000) + 8;
                releaseTimer = setTimeout(() => {
                    if (slot.gen !== gen) return;
                    try { outGain.disconnect(); } catch (_) { /* ignore */ }
                    releasePoolSlot(slot, gen);
                }, delayMs);
                // Early release if worklet reports silence
                const onSilent = (ev) => {
                    if (!ev.data?.silent) return;
                    if (slot.gen !== gen) return;
                    try { node.port.removeEventListener('message', onSilent); } catch (_) { /* ignore */ }
                    clearTimeout(releaseTimer);
                    try {
                        const nowT = ctx.currentTime;
                        outGain.gain.cancelScheduledValues(nowT);
                        outGain.gain.setValueAtTime(Math.max(0, outGain.gain.value || 0), nowT);
                        outGain.gain.linearRampToValueAtTime(0, nowT + 0.02);
                    } catch (_) { /* ignore */ }
                    releaseTimer = setTimeout(() => {
                        try { outGain.disconnect(); } catch (_) { /* ignore */ }
                        releasePoolSlot(slot, gen);
                    }, 30);
                };
                try { node.port.addEventListener('message', onSilent); } catch (_) { /* ignore */ }
                return;
            }
            const relEnd = t + WT_RELEASE_SEC;
            holdThenRamp(gateParam, t, 0, relEnd);
            holdThenRamp(outGain.gain, t, 0, relEnd);
            proxy.started = false;
            stopped = true;
            clearTimeout(releaseTimer);
            const delayMs = Math.max(0, (relEnd - ctx.currentTime) * 1000) + 8;
            releaseTimer = setTimeout(() => {
                if (slot.gen !== gen) return;
                try { outGain.disconnect(); } catch (_) { /* ignore */ }
                releasePoolSlot(slot, gen);
            }, delayMs);
        },
        set type(_v) { /* classic-only */ },
        get type() { return 'custom'; },
    };

    return proxy;
}

/**
 * Create a voice source for one OSC slot.
 * Returns an OscillatorNode or a wavetable proxy with frequency/detune/start/stop/connect.
 */
function bumpAnalogOscCreate(ms) {
    const p = (window.__ingyProf ||= {});
    if (ms > (p.analogOscCreateMax || 0)) p.analogOscCreateMax = ms;
    p.analogOscCreateN = (p.analogOscCreateN || 0) + 1;
}

function bumpAnalogOscStart(ms) {
    const p = (window.__ingyProf ||= {});
    if (ms > (p.analogOscStartMax || 0)) p.analogOscStartMax = ms;
    p.analogOscStartN = (p.analogOscStartN || 0) + 1;
}

function makeIdleAnalogOsc(ctx) {
    const t0 = performance.now();
    const osc = ctx.createOscillator();
    bumpAnalogOscCreate(performance.now() - t0);
    return osc;
}

function benchAnalogStartVsCreate(ctx) {
    const n = 6;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const tCreate0 = performance.now();
    const fresh = [];
    for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator();
        o.connect(mute);
        fresh.push(o);
    }
    const createMs = performance.now() - tCreate0;
    const when = ctx.currentTime + 0.08;
    const tStart0 = performance.now();
    fresh.forEach((o) => {
        try { o.start(when); o.stop(when + 0.02); } catch (_) { /* ignore */ }
    });
    const startMs = performance.now() - tStart0;
    const pooled = [];
    for (let i = 0; i < n; i++) pooled.push(ctx.createOscillator());
    const tPool0 = performance.now();
    pooled.forEach((o) => {
        o.connect(mute);
        try { o.start(when + 0.05); o.stop(when + 0.07); } catch (_) { /* ignore */ }
    });
    const poolStartMs = performance.now() - tPool0;
    const p = (window.__ingyProf ||= {});
    p.analogAbx = {
        n,
        createMs: Math.round(createMs * 10) / 10,
        startMs: Math.round(startMs * 10) / 10,
        poolStartMs: Math.round(poolStartMs * 10) / 10,
    };
}

function scheduleAnalogShellRefill() {
    if (analogRefillTimer != null || !analogShellCtx) return;
    analogRefillTimer = setTimeout(() => {
        analogRefillTimer = null;
        const ctx = analogShellCtx;
        if (!ctx || ctx.state === 'closed') return;
        const t0 = performance.now();
        let made = 0;
        while (analogShells.length < ANALOG_SHELL_TARGET && made < ANALOG_SHELL_REFILL_BUDGET) {
            analogShells.push(makeIdleAnalogOsc(ctx));
            made += 1;
        }
        const ms = performance.now() - t0;
        const p = (window.__ingyProf ||= {});
        p.refillN = (p.refillN || 0) + 1;
        if (ms > (p.refillMaxMs || 0)) p.refillMaxMs = ms;
        if (made > (p.refillMadeMax || 0)) p.refillMadeMax = made;
        if (analogShells.length < ANALOG_SHELL_TARGET) scheduleAnalogShellRefill();
    }, 40);
}

/** Pre-create unstarted analog OscillatorNodes. Disconnected until take. */
export function warmAnalogShells(ctx, count = ANALOG_SHELL_WARM) {
    if (!ctx) return 0;
    if (analogShellCtx !== ctx) {
        analogShells = [];
        analogShellCtx = ctx;
        analogAbxDone = false;
    }
    let made = 0;
    const target = Math.min(Math.max(1, count | 0), ANALOG_SHELL_TARGET);
    while (analogShells.length < target) {
        analogShells.push(makeIdleAnalogOsc(ctx));
        made += 1;
    }
    if (!analogAbxDone) {
        analogAbxDone = true;
        const wantAbx = new URLSearchParams(location.search).get('abx') === '1';
        if (wantAbx) {
            try { benchAnalogStartVsCreate(ctx); } catch (_) { /* ignore */ }
        }
    }
    return made;
}

export function takeAnalogShell(ctx, wave, frequency) {
    if (!ctx) return null;
    if (analogShellCtx !== ctx) warmAnalogShells(ctx, ANALOG_SHELL_WARM);
    let osc = analogShells.pop();
    if (!osc) {
        const p = (window.__ingyProf ||= {});
        p.analogShellMissN = (p.analogShellMissN || 0) + 1;
        osc = makeIdleAnalogOsc(ctx);
    }
    try { osc.type = wave || 'sawtooth'; } catch (_) { /* ignore */ }
    try { osc.frequency.value = Math.max(20, frequency || 440); } catch (_) { /* ignore */ }
    scheduleAnalogShellRefill();
    return osc;
}

/** Meter analog OscillatorNode.start separately from create. */
export function startAnalogOsc(osc, when) {
    if (!osc) return;
    const t0 = performance.now();
    if (when == null) osc.start();
    else osc.start(when);
    bumpAnalogOscStart(performance.now() - t0);
}

export function createOscSource(ctx, {
    oscIndex = 0,
    wave = 'sawtooth',
    frequency = 440,
    pooled = false,
} = {}) {
    if (
        oscIndex === OSC4_INDEX
        && state.osc4Wavetable
        && state.plaitsWorkletReady
        && ctx
    ) {
        try {
            const proxy = createWavetableProxy(ctx, frequency);
            return proxy;
        } catch (err) {
            console.warn('Wavetable source failed; falling back to classic osc:', err);
        }
    }
    if (pooled) return takeAnalogShell(ctx, wave, frequency);
    const osc = makeIdleAnalogOsc(ctx);
    osc.type = wave || 'sawtooth';
    osc.frequency.value = Math.max(20, frequency || 440);
    return osc;
}

/** Berlin D-lanes: Plaits drum worklet from an explicit patch. No OSC1 globals. */
export function createPlaitsSource(ctx, frequency, patch = {}) {
    if (!ctx || !state.plaitsWorkletReady) return null;
    const model = DRUM_ENGINES.has(patch.model) ? patch.model : 'hihat';
    try {
        return createWavetableProxy(ctx, frequency, { ...patch, model }, { drum: true });
    } catch (err) {
        console.warn('Plaits drum source failed:', err);
        return null;
    }
}

/** Push one Berlin drum-lane kit onto ringing hits for that lane. */
export function applyBerlinDrumKitToLive(lane) {
    const i = lane | 0;
    const patch = state.berlinDrum?.[i];
    if (!patch || !state.audioContext) return;
    const now = state.audioContext.currentTime;
    const panner = state.berlinDrumPanners?.[i];
    if (panner) {
        try {
            panner.pan.setValueAtTime(Math.max(-1, Math.min(1, Number(patch.pan) || 0)), now);
        } catch (_) { /* ignore */ }
    }
    if (isAnalogDrumEngine(patch)) {
        applyAnalog808KitToLive(i);
        return;
    }
    const touch = (osc) => {
        if (!osc?.isBerlinDrum || !osc._worklet) return;
        try {
            osc.morphX?.setValueAtTime(patch.morphX, now);
            osc.morphY?.setValueAtTime(patch.morphY, now);
            osc.harmonics?.setValueAtTime(patch.harmonics, now);
            const altP = osc._worklet.parameters?.get('alt');
            if (altP) altP.setValueAtTime(patch.alt ? 1 : 0, now);
            const trigP = osc._worklet.parameters?.get('trigPatched');
            if (trigP) trigP.setValueAtTime(patch.trigPatched !== false ? 1 : 0, now);
            const openP = osc._worklet.parameters?.get('openHat');
            if (openP) openP.setValueAtTime(patch.model === 'open_hat' ? 1 : 0, now);
            osc._worklet.port.postMessage({
                alt: !!patch.alt,
                trigPatched: patch.trigPatched !== false,
                openHat: patch.model === 'open_hat',
            });
        } catch (_) { /* ignore */ }
    };
    const tunedHz = (stepHz) => digitalDrumTuneHz(stepHz, patch.tune);
    state.berlinDrumVoices?.forEach((voice) => {
        if (voice?.lane !== i || voice.isAnalog) return;
        if (voice.amp) {
            try {
                const g = voice.amp.gain;
                g.setValueAtTime(Math.max(0.00001, Number(g.value) || 0.00001), now);
                g.linearRampToValueAtTime(Math.max(0.00001, patch.vol), now + 0.012);
            } catch (_) { /* ignore */ }
        }
        touch(voice.osc);
        if (voice.osc?.frequency && Number.isFinite(voice.stepHz)) {
            try {
                voice.osc.frequency.setValueAtTime(tunedHz(voice.stepHz), now);
            } catch (_) { /* ignore */ }
        }
    });
}

export function routeBerlinDrumPanners() {
    if (!Array.isArray(state.berlinDrumPanners)) return;
    state.berlinDrumPanners.forEach((panner, i) => {
        if (!panner) return;
        const analog = isAnalogDrumEngine(state.berlinDrum?.[i]);
        const dest = state.berlinDrumFilt
            ? state.ringModInput
            : (analog ? state.analogDrumInput : state.drumFxInput);
        if (!dest) return;
        const mute = state.drumMuteGains?.[i];
        try { panner.disconnect(); } catch (_) { /* ignore */ }
        try { mute?.disconnect(); } catch (_) { /* ignore */ }
        if (mute) {
            try { panner.connect(mute); } catch (_) { /* ignore */ }
            try { mute.connect(dest); } catch (_) { /* ignore */ }
        } else {
            try { panner.connect(dest); } catch (_) { /* ignore */ }
        }
    });
}

/** Optional live-morph hook for poly/other voice pools (avoids circular imports). */
let osc4MorphLiveHook = null;
export function setOsc4MorphLiveHook(fn) {
    osc4MorphLiveHook = typeof fn === 'function' ? fn : null;
}

/** Push ALT / TRIG-patched (Mode) onto all live digital voices. */
export function applyOsc4AltModeToLive() {
    const now = state.audioContext?.currentTime ?? 0;
    const alt = !!state.osc4Alt;
    const trigPatched = state.osc4TrigPatched !== false;
    const touch = (osc) => {
        if (!osc?.isWavetable || !osc._worklet || osc.isBerlinDrum) return;
        try {
            const altP = osc._worklet.parameters?.get('alt');
            if (altP) altP.setValueAtTime(alt ? 1 : 0, now);
            const trigP = osc._worklet.parameters?.get('trigPatched');
            if (trigP) trigP.setValueAtTime(trigPatched ? 1 : 0, now);
            osc._worklet.port.postMessage({ alt, trigPatched });
        } catch (_) { /* ignore */ }
    };
    if (Array.isArray(state.activeOscillators)) state.activeOscillators.forEach(touch);
    if (state.oscillators?.[OSC4_INDEX]) touch(state.oscillators[OSC4_INDEX]);
    if (Array.isArray(state.berlinOscVoices)) {
        state.berlinOscVoices.forEach((voice) => {
            voice?.oscs?.forEach(({ osc }) => touch(osc));
        });
    }
    try {
        // poly-voice registers this hook to reach Multitudes / Ingy-6 voices
        osc4MorphLiveHook?.(touch);
    } catch (_) { /* ignore */ }
}

/**
 * Live OSC volume: shared oscGains + per-voice gainNodes for phase-reset /
 * Multitudes / poly digital stacks (oscGains alone does not move those).
 * Pass `extraOscs` for poly-pool voices (avoids circular import with poly-voice).
 */
export function applyLiveOscVolume(oscIndex, volRaw, extraOscs = null) {
    if (!state.audioContext) return;
    const oscIndexN = Number(oscIndex);
    if (!Number.isFinite(oscIndexN)) return;
    const vol = Math.max(0, Math.min(1, Number(volRaw) || 0));
    const now = state.audioContext.currentTime;
    const on = !!state.oscStates?.[oscIndexN];
    const level = on ? vol : 0;
    const rampGain = (node, target, ms) => {
        if (!node) return;
        try {
            const g = node.gain;
            g.cancelScheduledValues(now);
            g.setValueAtTime(Math.max(0.00001, Number(g.value) || 0.00001), now);
            g.linearRampToValueAtTime(Math.max(0.00001, target), now + ms);
        } catch (_) { /* ignore */ }
    };

    // Independent Berlin/ratch voices own the bus; restoring oscGains here
    // would unmute persistent oscs through the held-open VCA.
    if (!state.berlinSharedPathArmed && state.oscGains?.[oscIndexN]) {
        rampGain(state.oscGains[oscIndexN], level, level < 0.0001 ? 0.025 : 0.012);
    }

    const list = [];
    const push = (osc) => {
        if (!osc || osc.oscIndex !== oscIndexN || !osc.gainNode) return;
        list.push(osc);
    };
    if (Array.isArray(state.activeOscillators)) state.activeOscillators.forEach(push);
    if (Array.isArray(extraOscs)) extraOscs.forEach(push);

    const n = Math.max(1, list.length || 1);
    const voiceVol = level / n;
    list.forEach((osc) => rampGain(osc.gainNode, voiceVol, 0.012));

    // Per independent voice (overlapping ratches): each stack still sums to `level`.
    state.berlinOscVoices?.forEach((voice) => {
        if (voice?.oscIndex !== oscIndexN) return;
        const stack = voice.oscs || [];
        if (!stack.length) return;
        const laneVol = level / stack.length;
        stack.forEach(({ osc, gain }) => rampGain(gain || osc?.gainNode, laneVol, 0.012));
    });
}

/** Push current OSC1 digital tone params onto all live digital voices. */
export function applyOsc4MorphToLive() {
    const { x, y } = readOsc4Morph();
    const harmonics = readOsc4Harmonics();
    state.osc4MorphX = x;
    state.osc4MorphY = y;
    state.osc4Harmonics = harmonics;
    const bankFromUi = getNumber('osc4Bank', state.osc4Bank);
    // -1 = Scan (Harmonics); 0–3 = pinned bank
    const bank = Number.isFinite(bankFromUi)
        ? Math.max(-1, Math.min(3, bankFromUi))
        : -1;
    state.osc4Bank = bank;
    const now = state.audioContext?.currentTime ?? 0;

    const touch = (osc) => {
        if (!osc?.isWavetable || osc.isBerlinDrum) return;
        try {
            if (osc.morphX) {
                osc.morphX.setValueAtTime(x, now);
            }
            if (osc.morphY) {
                osc.morphY.setValueAtTime(y, now);
            }
            if (osc.harmonics) {
                osc.harmonics.setValueAtTime(harmonics, now);
            }
            const bankParam = osc._worklet?.parameters?.get('bank');
            if (bankParam) {
                bankParam.setValueAtTime(bank, now);
            }
        } catch (_) { /* ignore */ }
    };

    if (Array.isArray(state.activeOscillators)) {
        state.activeOscillators.forEach(touch);
    }
    if (state.oscillators?.[OSC4_INDEX]) {
        touch(state.oscillators[OSC4_INDEX]);
    }
    if (Array.isArray(state.berlinOscVoices)) {
        state.berlinOscVoices.forEach((voice) => {
            voice?.oscs?.forEach(({ osc }) => touch(osc));
        });
    }
    try {
        osc4MorphLiveHook?.(touch);
    } catch (_) { /* ignore */ }
}
