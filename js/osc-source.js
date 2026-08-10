// Shared oscillator factory: classic OscillatorNode or OSC4 wavetable worklet.
// Built so additional Plaits-style engines (pluck, etc.) can share the same shell.
// Wavetable voices are pooled — creating AudioWorkletNode per note causes crackle.

import { state } from './state.js?v=106';

export const OSC4_INDEX = 3;
export const PLAITS_PROCESSOR = 'plaits-engine-processor';

/** Soften WT into the shared filter so resonance/soft-clip stay usable when mixed. */
const WT_OUTPUT_GAIN = 0.52;
const WT_POOL_MAX = 16;

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

export function wtAttackTuningSnapshot() {
    return {
        nudgeStep: WT_ATTACK_NUDGE_STEP,
        nudgeSec: WT_ATTACK_NUDGE_SEC,
        defaultBase: WT_ATTACK_DEFAULT_SEC,
        defaultStretch: WT_ATTACK_RISK_STRETCH_DEFAULT,
        activeBase: WT_ATTACK_SEC,
        activeStretch: WT_ATTACK_RISK_STRETCH,
        defaultMax: WT_ATTACK_DEFAULT_SEC + WT_ATTACK_RISK_STRETCH_DEFAULT,
        activeMax: WT_ATTACK_SEC + WT_ATTACK_RISK_STRETCH,
    };
}

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

/** Soft gate stretch from filter cut/res. Defaults logged via wtAttackTuningSnapshot. */
export function wtAttackSecForFilter() {
    const risk = wtFilterClickRisk();
    return WT_ATTACK_SEC + risk * WT_ATTACK_RISK_STRETCH;
}

/**
 * Fade a per-voice GainNode in. Wavetable + high-Q filters need a longer ramp
 * than classic OscillatorNode (seq/Berlin previously jumped to full voiceVol).
 */
export function softStartVoiceGain(gainParam, targetVol, when, { wavetable = false } = {}) {
    if (!gainParam) return;
    const t = Math.max(0, when || 0);
    const peak = Math.max(0, Number(targetVol) || 0);
    const attack = wavetable ? wtAttackSecForFilter() : 0.004;
    // #region agent log
    if (wavetable) {
        fetch('http://127.0.0.1:7606/ingest/097204ca-714f-4954-a0f8-6c2082d733f7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5a7886'},body:JSON.stringify({sessionId:'5a7886',runId:'defaults-restored',hypothesisId:'A',location:'osc-source.js:softStartVoiceGain',message:'voice gain attack',data:{attack,peak,...wtAttackTuningSnapshot()},timestamp:Date.now()})}).catch(()=>{});
    }
    // #endregion
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
    const t = Math.max(ctx?.currentTime || 0, when || 0);
    const end = Math.max(t, endTime || t);
    const valueNow = Number(param.value) || 0;
    const lookahead = t - (ctx?.currentTime || 0);
    let held = false;
    try {
        if (typeof param.cancelAndHoldAtTime === 'function') {
            param.cancelAndHoldAtTime(t);
            held = true;
        } else {
            param.cancelScheduledValues(t);
            param.setValueAtTime(Math.max(0.00001, valueNow), t);
        }
        param.linearRampToValueAtTime(target, end);
    } catch (_) {
        try {
            param.cancelScheduledValues(t);
            param.setValueAtTime(Math.max(0.00001, valueNow), t);
            param.linearRampToValueAtTime(target, end);
        } catch (__) { /* ignore */ }
    }
    return { held, lookahead, valueNow };
}

/**
 * Schedule a click-free teardown. NEVER disconnect synchronously — that cuts
 * the graph before the fade and pops hard into an open filter (seq step changes).
 */
export function fadeStopOsc(osc, when, { fadeSec = 0.02 } = {}) {
    if (!osc?.started) return;
    const ctx = state.audioContext;
    if (!ctx) return;
    const tEnd = Math.max(ctx.currentTime, when || ctx.currentTime);
    const fade = Math.max(0.01, fadeSec);
    const t0 = Math.max(ctx.currentTime, tEnd - fade);
    try {
        if (osc.gainNode) {
            holdThenRamp(osc.gainNode.gain, t0, 0.00001, tEnd);
        }
        osc.stop(tEnd);
        if (!osc.isWavetable) {
            const delayMs = Math.max(0, (tEnd - ctx.currentTime) * 1000) + 30;
            setTimeout(() => {
                try { osc.disconnect(); } catch (_) { /* ignore */ }
            }, delayMs);
        }
        // Wavetable proxy stop() owns outGain disconnect / pool return
    } catch (_) { /* ignore */ }
}

/** @type {{ ctx: AudioContext, node: AudioWorkletNode, inUse: boolean, gen: number }[]} */
let wtPool = [];
let wtPoolCtx = null;

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

function resetWtPoolIfNeeded(ctx) {
    if (wtPoolCtx === ctx) return;
    wtPool.forEach((slot) => {
        try { slot.node.disconnect(); } catch (_) { /* ignore */ }
    });
    wtPool = [];
    wtPoolCtx = ctx;
}

/** Load AudioWorklet once per AudioContext. Safe to call repeatedly. */
export function ensurePlaitsWorklet(ctx = state.audioContext) {
    if (!ctx?.audioWorklet) {
        state.plaitsWorkletReady = false;
        return Promise.resolve(false);
    }
    if (state.plaitsWorkletReady && state.plaitsWorkletCtx === ctx) {
        return Promise.resolve(true);
    }
    if (state.plaitsWorkletPromise && state.plaitsWorkletCtx === ctx) {
        return state.plaitsWorkletPromise;
    }

    state.plaitsWorkletCtx = ctx;
    const url = new URL(`js/worklets/plaits-engine-processor.js?v=7`, window.location.href).href;
    state.plaitsWorkletPromise = ctx.audioWorklet
        .addModule(url)
        .then(() => {
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
    let slot = wtPool.find((s) => !s.inUse);
    if (!slot) {
        if (wtPool.length >= WT_POOL_MAX) {
            // Prefer a free slot; never hard-disconnect an in-use node (filterIn 0.09→0 click)
            slot = wtPool.find((s) => !s.inUse);
            if (!slot) {
                // Force-fade oldest, then reuse after a short settle — better than a hard cut
                slot = wtPool[0];
                try {
                    const g = slot.node.parameters.get('gate');
                    const t = ctx.currentTime;
                    g.cancelScheduledValues(t);
                    g.setValueAtTime(Math.max(0, g.value || 0), t);
                    g.linearRampToValueAtTime(0, t + 0.012);
                } catch (_) { /* ignore */ }
                slot.inUse = false;
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
                    bank: 0,
                    gate: 0,
                },
            });
            slot = { ctx, node, inUse: false, gen: 0 };
            wtPool.push(slot);
        }
    }
    slot.inUse = true;
    slot.gen += 1;
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
}

function createWavetableProxy(ctx, frequency) {
    const { x, y } = readOsc4Morph();
    const slot = acquirePoolSlot(ctx);
    const node = slot.node;
    const gen = slot.gen;
    const now = ctx.currentTime;

    const frequencyParam = node.parameters.get('frequency');
    const detuneParam = node.parameters.get('detune');
    const gateParam = node.parameters.get('gate');
    const morphXParam = node.parameters.get('morphX');
    const morphYParam = node.parameters.get('morphY');

    try {
        gateParam.cancelScheduledValues(now);
        gateParam.setValueAtTime(0, now);
        frequencyParam.setValueAtTime(Math.max(20, frequency || 440), now);
        detuneParam.setValueAtTime(0, now);
        morphXParam.setValueAtTime(x, now);
        morphYParam.setValueAtTime(y, now);
        node.parameters.get('bank').setValueAtTime(state.osc4Bank || 0, now);
        // Idle reset only — note-on phase reset is edge-triggered in the worklet
        node.port.postMessage({ reset: true, engine: state.osc4Model || 'wavetable' });
    } catch (_) { /* ignore */ }

    // Fixed trim so WT doesn't slam the shared soft-clip / kill resonance
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
        isWavetable: true,
        _worklet: node,
        _outGain: outGain,
        started: false,
        connect(...args) {
            return outGain.connect(...args);
        },
        disconnect(...args) {
            // After stop(), teardown is owned by the pool release timer.
            // Sync disconnect here was cutting audio mid-fade → open-filter clicks.
            if (stopped) return;
            try { outGain.disconnect(...args); } catch (_) { /* ignore */ }
        },
        start(when = 0) {
            if (stopped) return;
            const t = Math.max(ctx.currentTime, when || 0);
            const attack = wtAttackSecForFilter();
            const attackEnd = t + attack;
            gateParam.cancelScheduledValues(t);
            gateParam.setValueAtTime(0, t);
            gateParam.linearRampToValueAtTime(1, attackEnd);
            outGain.gain.cancelScheduledValues(t);
            outGain.gain.setValueAtTime(0, t);
            const mid = t + attack * 0.55;
            outGain.gain.linearRampToValueAtTime(WT_OUTPUT_GAIN * 0.7, mid);
            outGain.gain.setTargetAtTime(WT_OUTPUT_GAIN, mid, Math.max(0.003, attack * 0.25));
            proxy.started = true;
        },
        stop(when = 0) {
            if (stopped) return;
            const t = Math.max(ctx.currentTime, when || 0);
            const relEnd = t + WT_RELEASE_SEC;
            holdThenRamp(gateParam, t, 0, relEnd);
            holdThenRamp(outGain.gain, t, 0, relEnd);
            proxy.started = false;
            stopped = true;
            clearTimeout(releaseTimer);
            const delayMs = Math.max(0, (relEnd - ctx.currentTime) * 1000) + 8;
            releaseTimer = setTimeout(() => {
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

/** Push current OSC4 digital tone params onto all live wavetable voices. */
export function applyOsc4MorphToLive() {
    const { x, y } = readOsc4Morph();
    state.osc4MorphX = x;
    state.osc4MorphY = y;
    const bankEl = document.getElementById('osc4Bank');
    const bankFromUi = bankEl ? parseInt(bankEl.value, 10) : state.osc4Bank;
    const bank = Math.max(0, Math.min(3, Number.isFinite(bankFromUi) ? bankFromUi : 0));
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
