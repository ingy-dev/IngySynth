import { state } from './state.js?v=114';
import { getNumber } from './params.js?v=13';

/** Keep in sync with getLfoAmountAudio() in lfo-strip.js (avoid circular import). */
function softKneeLfoAmount(a) {
    const x = Math.max(0, Math.min(1, Number(a) || 0));
    return x * (0.95 - 0.30 * x);
}

/**
 * Worst-case |ΔHz| from CUT LFO before the safety pad (env floor must leave room).
 */
export function getCutoffLfoPeakDemand() {
    if (!state.lfoState) return 0;
    const modAbs = Math.abs(getNumber('cutoffMod', 0));
    if (modAbs < 1) return 0;
    const audioAmt = softKneeLfoAmount(state.lfoAmount);
    if (audioAmt < 0.01) return 0;
    // Soft-clip shaper peak ~0.9
    return modAbs * 0.9 * audioAmt;
}

export function getFilterEnvAmount() {
    if (!state.filterEnvState) return 0;
    const v = getNumber('filterEnvAmount', NaN);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v / 100)) : 1;
}

export function getFilterCutoffRange(baseCutoff, amount) {
    const safeBase = Math.max(40, baseCutoff);
    let minFreq = Math.max(20, safeBase * (1 - amount));
    const maxFreq = Math.max(20, safeBase);

    // When env is on, closed cutoff sits at minFreq while CUT LFO still sums in.
    // Raise the floor so negative LFO swings can't rail filter.frequency into ~0Hz.
    if (amount > 0) {
        const peak = getCutoffLfoPeakDemand();
        if (peak > 0) {
            const floorHz = 90;
            const needMin = floorHz + peak * 0.7;
            minFreq = Math.max(minFreq, needMin);
            // Keep some envelope sweep left
            minFreq = Math.min(minFreq, maxFreq * 0.82);
        }
    }

    const depth = Math.max(0, maxFreq - minFreq);
    // Invert: idle at open (max), env pulls down. Normal: idle at closed (min), env opens up.
    const inverted = amount > 0 && !!state.filterEnvInvert;
    const baseFreq = inverted ? maxFreq : minFreq;
    const signedDepth = inverted ? -depth : depth;

    return { minFreq, maxFreq, depth, baseFreq, signedDepth };
}

// Update the filter floor and envelope depth without disturbing the ADSR gain schedule.
export function updateFilterCutoffRange(baseCutoff, now, rampTime = 0.03) {
    if (!state.filterCutoffMin || !state.filterEnvDepth) return;

    const amount = getFilterEnvAmount();
    const { baseFreq, signedDepth } = getFilterCutoffRange(baseCutoff, amount);
    const safeRamp = Math.max(0.002, rampTime);

    const minParam = state.filterCutoffMin.offset;
    minParam.cancelScheduledValues(now);
    minParam.setValueAtTime(Math.max(20, minParam.value), now);
    minParam.exponentialRampToValueAtTime(Math.max(20, baseFreq), now + safeRamp);

    const depthParam = state.filterEnvDepth.gain;
    depthParam.cancelScheduledValues(now);
    depthParam.setValueAtTime(depthParam.value, now);
    depthParam.linearRampToValueAtTime(signedDepth, now + safeRamp);
}

/** Re-apply floor/depth from current cutoff + LFO (call when CUT mod / strip / On change). */
export function refreshFilterCutoffRange(rampTime = 0.05) {
    if (!state.audioContext) return;
    const cutoff = Math.max(40, getNumber('cutoff', 1000));
    updateFilterCutoffRange(cutoff, state.audioContext.currentTime, rampTime);
}
