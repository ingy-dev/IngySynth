// Repeat Pattern cycle math. One cycle is `repeat` passes of a pattern.
// A pass boundary is the only time this runs, so a repeat change never
// cuts a pattern off mid-pass.

export const REPEAT_MIN = 1;
export const REPEAT_MAX = 8;

export function clampRepeat(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < REPEAT_MIN) return REPEAT_MIN;
    return Math.min(REPEAT_MAX, v);
}

/** Same press cycle as ratchet: ×1 → ×2 → … → ×8 → ×1. */
export function nextRepeat(n) {
    const r = clampRepeat(n);
    return r >= REPEAT_MAX ? REPEAT_MIN : r + 1;
}

/**
 * Advance the pass counter at a pattern boundary.
 * `isFirst` is the downbeat that starts playback (always a cycle start).
 * Returns the pass index to store (0-based) and whether this boundary
 * starts a cycle (automation punch-out + queued pattern switch).
 */
export function nextCyclePass(cyclePass, repeat, isFirst) {
    const n = clampRepeat(repeat);
    const pass = Math.max(0, Math.round(Number(cyclePass)) || 0);
    if (isFirst || pass + 1 >= n) {
        return { cyclePass: 0, isCycleStart: true };
    }
    return { cyclePass: pass + 1, isCycleStart: false };
}
