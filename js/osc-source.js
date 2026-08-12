// Shared oscillator factory: classic OscillatorNode or OSC1 digital worklet.
// Plaits-style engines share one pooled AudioWorkletNode shell.
// Voices are pooled — creating AudioWorkletNode per note causes crackle.

import { state } from './state.js?v=109';

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
    fm: 0.78,
    waveshaper: 0.72,
    modal: 0.95,
    string: 0.88,
    bass_drum: 1.0,
    snare: 0.85,
    hihat: 0.7,
};

/** Engines that ring after gate-off (trigger/exciter model). */
export const TRIGGERED_ENGINES = new Set([
    'modal', 'string', 'bass_drum', 'snare', 'hihat',
]);

export const ENGINE_TAIL_SEC = {
    modal: 8,
    string: 8,
    bass_drum: 2.5,
    snare: 2.5,
    hihat: 2.0,
};

export const DRUM_ENGINES = new Set(['bass_drum', 'snare', 'hihat']);

const WT_POOL_MAX = 16;

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
        const wave = document.querySelector(`.osc-type[data-osc="${i}"]`)?.value;
        if (wave === 'sine' || wave === 'triangle') return true;
    }
    return false;
}

/** How hard the shared filter will ping a WT onset (0..1). */
export function wtFilterClickRisk() {
    const cutoff = parseFloat(document.getElementById('cutoff')?.value);
    const q = parseFloat(document.getElementById('resonance')?.value);
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
                try { osc.disconnect(); } catch (_) { /* ignore */ }
            }, delayMs);
        }
        // Wavetable proxy stop() owns outGain disconnect / pool return
    } catch (_) { /* ignore */ }
}

/** @type {{ ctx: AudioContext, node: AudioWorkletNode, inUse: boolean, gen: number, tablesSent?: boolean, ringing?: boolean }[]} */
let wtPool = [];
let wtPoolCtx = null;
/** Official Plaits wavetable ROM (float32 LE, 4×64×128 integrated). */
let plaitsTablesBuffer = null;
let plaitsTablesPromise = null;
/** Waveshaper / fold / stiffness LUTs. */
let plaitsWsBuffer = null;
let plaitsWsPromise = null;

const PLAITS_TABLES_URL = () =>
    new URL(`js/worklets/plaits-wavetables.bin?v=2`, window.location.href).href;
const PLAITS_WS_URL = () =>
    new URL(`js/worklets/plaits-waveshaper.bin?v=1`, window.location.href).href;

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

function injectPlaitsAssets(node) {
    if (!node) return;
    try {
        if (plaitsTablesBuffer) {
            node.port.postMessage({ tables: plaitsTablesBuffer.slice(0) });
        }
        if (plaitsWsBuffer) {
            node.port.postMessage({ waveshaper: plaitsWsBuffer.slice(0) });
        }
    } catch (err) {
        console.warn('Failed to inject Plaits assets into worklet:', err);
    }
}

export function isOsc4Wavetable() {
    return !!state.osc4Wavetable && !!state.plaitsWorkletReady;
}

export function readOsc4Morph() {
    const xEl = document.getElementById('osc4MorphX');
    const yEl = document.getElementById('osc4MorphY');
    const x = xEl ? parseFloat(xEl.value) : state.osc4MorphX;
    const y = yEl ? parseFloat(yEl.value) : state.osc4MorphY;
    return {
        x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5,
        y: Number.isFinite(y) ? Math.max(0, Math.min(1, y)) : 0.5,
    };
}

export function readOsc4Harmonics() {
    const el = document.getElementById('osc4Harmonics');
    const v = el ? parseFloat(el.value) : state.osc4Harmonics;
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

function resetWtPoolIfNeeded(ctx) {
    if (wtPoolCtx === ctx) return;
    wtPool.forEach((slot) => {
        try { slot.node.disconnect(); } catch (_) { /* ignore */ }
    });
    wtPool = [];
    wtPoolCtx = ctx;
}

/** Load AudioWorklet + Plaits ROM assets once per AudioContext. */
export function ensurePlaitsWorklet(ctx = state.audioContext) {
    if (!ctx?.audioWorklet) {
        state.plaitsWorkletReady = false;
        return Promise.resolve(false);
    }
    if (state.plaitsWorkletReady && state.plaitsWorkletCtx === ctx && plaitsTablesBuffer) {
        return Promise.resolve(true);
    }
    if (state.plaitsWorkletPromise && state.plaitsWorkletCtx === ctx) {
        return state.plaitsWorkletPromise;
    }

    state.plaitsWorkletCtx = ctx;
    const url = new URL(`js/worklets/plaits-engine-processor.js?v=23`, window.location.href).href;
    state.plaitsWorkletPromise = Promise.all([
        ctx.audioWorklet.addModule(url),
        loadPlaitsTables(),
        loadPlaitsWaveshaper(),
    ])
        .then(([, tables]) => {
            if (!tables) {
                state.plaitsWorkletReady = false;
                return false;
            }
            state.plaitsWorkletReady = true;
            resetWtPoolIfNeeded(ctx);
            return true;
        })
        .catch((err) => {
            console.warn('Plaits engine worklet failed to load:', err);
            state.plaitsWorkletReady = false;
            return false;
        });
    return state.plaitsWorkletPromise;
}

function acquirePoolSlot(ctx) {
    resetWtPoolIfNeeded(ctx);
    let slot = wtPool.find((s) => !s.inUse && !s.ringing);
    if (!slot) {
        if (wtPool.length >= WT_POOL_MAX) {
            // Prefer idle non-ringing; never steal a ringing physical-model voice
            slot = wtPool.find((s) => !s.inUse && !s.ringing);
            if (!slot) {
                slot = wtPool.find((s) => !s.inUse);
            }
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
            injectPlaitsAssets(node);
            slot = { ctx, node, inUse: false, gen: 0, tablesSent: true, ringing: false };
            // Silence / ring-end from triggered engines
            node.port.onmessage = (ev) => {
                const msg = ev.data;
                if (msg?.silent) {
                    slot.ringing = false;
                }
            };
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

function releasePoolSlot(slot, gen) {
    if (!slot || slot.gen !== gen) return;
    try {
        slot.node.parameters.get('gate').value = 0;
    } catch (_) { /* ignore */ }
    try { slot.node.disconnect(); } catch (_) { /* ignore */ }
    try {
        slot.node.port.postMessage({ reset: true, engine: state.osc4Model || 'wavetable' });
    } catch (_) { /* ignore */ }
    slot.inUse = false;
    slot.ringing = false;
}

function createWavetableProxy(ctx, frequency) {
    const { x, y } = readOsc4Morph();
    const harmonics = readOsc4Harmonics();
    const model = state.osc4Model || 'wavetable';
    const triggered = isTriggeredEngine(model);
    const trim = engineTrim(model);
    const slot = acquirePoolSlot(ctx);
    const node = slot.node;
    const gen = slot.gen;
    const now = ctx.currentTime;

    const frequencyParam = node.parameters.get('frequency');
    const detuneParam = node.parameters.get('detune');
    const gateParam = node.parameters.get('gate');
    const morphXParam = node.parameters.get('morphX');
    const morphYParam = node.parameters.get('morphY');
    const harmonicsParam = node.parameters.get('harmonics');

    const bankRaw = Number(state.osc4Bank);
    const bank = Number.isFinite(bankRaw) ? Math.max(-1, Math.min(3, bankRaw)) : -1;

    try {
        gateParam.cancelScheduledValues(now);
        gateParam.setValueAtTime(0, now);
        frequencyParam.setValueAtTime(Math.max(20, frequency || 440), now);
        detuneParam.setValueAtTime(0, now);
        morphXParam.setValueAtTime(x, now);
        morphYParam.setValueAtTime(y, now);
        if (harmonicsParam) harmonicsParam.setValueAtTime(harmonics, now);
        node.parameters.get('bank').setValueAtTime(bank, now);
        // Idle reset only — note-on phase reset is edge-triggered in the worklet
        node.port.postMessage({ reset: true, engine: model });
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
export function createOscSource(ctx, {
    oscIndex = 0,
    wave = 'sawtooth',
    frequency = 440,
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
    const osc = ctx.createOscillator();
    osc.type = wave || 'sawtooth';
    osc.frequency.value = Math.max(20, frequency || 440);
    return osc;
}

/** Push current OSC1 digital tone params onto all live digital voices. */
export function applyOsc4MorphToLive() {
    const { x, y } = readOsc4Morph();
    const harmonics = readOsc4Harmonics();
    state.osc4MorphX = x;
    state.osc4MorphY = y;
    state.osc4Harmonics = harmonics;
    const bankEl = document.getElementById('osc4Bank');
    const bankFromUi = bankEl ? parseInt(bankEl.value, 10) : state.osc4Bank;
    // -1 = Scan (Harmonics); 0–3 = pinned bank
    const bank = Number.isFinite(bankFromUi)
        ? Math.max(-1, Math.min(3, bankFromUi))
        : -1;
    state.osc4Bank = bank;
    const now = state.audioContext?.currentTime ?? 0;

    const touch = (osc) => {
        if (!osc?.isWavetable) return;
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
}
