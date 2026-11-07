// Ramp an AudioParam from wherever it is at time t, without the cancelAndHoldAtTime trap.
//
// Measured in Chromium 152 (and Safari is known to do the same): after
// cancelAndHoldAtTime(t), a following linearRamp/exponentialRamp starts from the
// param's previous event, which is in the past, not from the hold. The ramp is
// already almost finished at t, so it lands as a one-sample step: a click on a
// release, a thump on an attack. setTargetAtTime after a hold is correct.
//
// So: a ramp due now reads .value and pins it (exact). A ramp scheduled ahead (the
// sequencer's lookahead) holds and approaches the target with setTargetAtTime,
// reaching ~95% of the way by t + duration.

const LIVE_WINDOW_SEC = 0.01;

/** True when `t` is due now (live input), false when it is scheduled ahead. */
export function isLiveTime(ctx, t) {
    return !!ctx && (Number(t) || 0) <= ctx.currentTime + LIVE_WINDOW_SEC;
}

/**
 * Move `param` from its level at `t` to `target` over `duration` seconds.
 * @param {AudioParam} param
 * @param {number} t start time (seconds, context time)
 * @param {number} target
 * @param {number} duration
 * @param {{ ctx: BaseAudioContext, curve?: 'linear' | 'exp' }} opts
 * @returns {number} the time the move is (effectively) done
 */
export function rampFromHere(param, t, target, duration, { ctx, curve = 'linear' } = {}) {
    if (!param || !ctx) return t;
    const now = ctx.currentTime;
    const start = Math.max(now, Number(t) || now);
    const dur = Math.max(0.0005, Number(duration) || 0);
    const end = start + dur;
    const exp = curve === 'exp';
    const safeTarget = exp ? Math.max(0.00001, target) : target;
    try {
        if (isLiveTime(ctx, start)) {
            const level = Number(param.value);
            param.cancelScheduledValues(start);
            param.setValueAtTime(exp ? Math.max(0.00001, level || 0) : (Number.isFinite(level) ? level : 0), start);
            if (exp) param.exponentialRampToValueAtTime(safeTarget, end);
            else param.linearRampToValueAtTime(safeTarget, end);
            return end;
        }
        if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(start);
        else param.cancelScheduledValues(start);
        // tau = dur / 3 covers 95% by `end`, like the sequencer's own envelopes.
        param.setTargetAtTime(safeTarget, start, dur / 3);
    } catch (_) { /* ignore */ }
    return end;
}
