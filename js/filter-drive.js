// Filter headroom for Web Audio BiquadFilter:
// pad + mild pre-limit → LP → post soft-clip → makeup.
// Chord intervals also soft-scale Q (biquad rails at high Q + multi-pitch).

import { state, OSC_COUNT } from './state.js?v=104';

/** Soft-clip / peak-limit curve (drive↑ = more compression of peaks). */
export function makeFilterInputCurve(drive = 2.0) {
    const d = Math.max(0.8, Number(drive) || 2);
    const n = 2048;
    const curve = new Float32Array(n);
    const norm = Math.tanh(d);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * d) / norm;
    }
    return curve;
}

/**
 * How "chord-like" the active OSC tunes are.
 * Unison / same tune → 1. Spread intervals (Chord Mem) → higher.
 */
export function chordSpreadFactor() {
    const tunes = [];
    for (let i = 0; i < OSC_COUNT; i++) {
        if (!state.oscStates[i]) continue;
        const t = Number(state.oscTunes[i]);
        tunes.push(Number.isFinite(t) ? t : 0);
    }
    if (tunes.length < 2) return 1;

    const min = Math.min(...tunes);
    const max = Math.max(...tunes);
    const span = Math.max(0, max - min);
    const unique = new Set(tunes.map((t) => Math.round(t))).size;

    return 1
        + Math.min(1.35, span / 10)
        + Math.min(0.55, Math.max(0, unique - 1) * 0.2);
}

/**
 * Map UI resonance → stable biquad Q (chord stacks need lower Q than unison).
 * UI still shows the full scream range; audio soft-scales when oscTunes diverge.
 */
export function applyFilterResonance(rampTime = 0.03) {
    if (!state.audioContext || !state.filter) return;

    const ui = parseFloat(document.getElementById('resonance')?.value);
    const cutoff = parseFloat(document.getElementById('cutoff')?.value) || 1000;
    let q = Number.isFinite(ui) ? ui : 1;
    if (cutoff < 200) q = Math.min(5, q);

    const spread = chordSpreadFactor();
    if (spread > 1.05) {
        // Soft-scale Q; keep some peak so post-clip still screams
        const scale = 1 / (1 + (spread - 1) * 1.1);
        q *= scale;
        // Hard ceiling — Web Audio biquads get nasty above this with multi-pitch
        q = Math.min(q, 9.5);
    }

    q = Math.max(0.0001, Math.min(20, q));
    const now = state.audioContext.currentTime;
    const t = Math.max(0.01, rampTime);
    const param = state.filter.Q;
    param.cancelScheduledValues(now);
    param.setValueAtTime(Math.max(0.0001, param.value || q), now);
    param.linearRampToValueAtTime(q, now + t);
}

/**
 * Scale pre-filter pad + post-clip makeup; re-apply chord-aware Q.
 */
export function refreshFilterInputDrive(rampTime = 0.04) {
    if (!state.audioContext || !state.filterInputPad || !state.filterMakeup) return;

    let sum = 0;
    let active = 0;
    for (let i = 0; i < OSC_COUNT; i++) {
        if (!state.oscStates[i]) continue;
        active += 1;
        const v = parseFloat(document.querySelector(`.osc-vol[data-osc="${i}"]`)?.value ?? '0.33');
        if (Number.isFinite(v) && v > 0) sum += v;
    }
    if (state.noiseState) {
        const nv = parseFloat(document.getElementById('noiseVol')?.value || '0');
        if (Number.isFinite(nv) && nv > 0) sum += nv;
    }

    const spread = chordSpreadFactor();
    // Multi-pitch + level: keep coherent peak into the biquad low
    const TARGET_PEAK = 0.16 / Math.max(1, spread * 0.95);
    let pad = sum > 0.02
        ? Math.max(0.08, Math.min(0.55, TARGET_PEAK / sum))
        : 0.45;
    // Extra headroom whenever 2+ OSCs are on with any tune spread
    if (active >= 2 && spread > 1.08) {
        pad = Math.min(pad, 0.22);
    }
    const makeup = Math.max(1.15, Math.min(3.8, 0.72 / pad));

    const now = state.audioContext.currentTime;
    const t = Math.max(0.01, rampTime);
    const padParam = state.filterInputPad.gain;
    const makeParam = state.filterMakeup.gain;
    padParam.cancelScheduledValues(now);
    padParam.setValueAtTime(padParam.value, now);
    padParam.linearRampToValueAtTime(pad, now + t);
    makeParam.cancelScheduledValues(now);
    makeParam.setValueAtTime(makeParam.value, now);
    makeParam.linearRampToValueAtTime(makeup, now + t);

    applyFilterResonance(t);
}
