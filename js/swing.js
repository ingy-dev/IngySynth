// Sequencer swing for the Web Audio scheduler. Same rule as the native sequencer
// (core/seq/Sequencer.cpp swungBeat): MPC-style 16th swing as a time warp over each
// 8th note. SWING s (0.50-0.75) is the share of the 8th the first 16th gets, so the
// off-beat 16th moves to s and everything between stretches to match. 1/8 and slower
// steps sit on 8th boundaries and never move. Triplet divisions (3, 6, 12, 24, 48:
// 1/2T to 1/32T) keep their own grid. The warp only ever delays.
//
// No imports: the scheduler passes tempo and swing in, so this module never loads
// params.js under a second cache-busting URL.

const EIGHTH = 0.5; // beats

export function swingFraction(swingPct) {
    const n = Number(swingPct);
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(50, Math.min(75, n)) / 100;
}

export function swingable(division) {
    const d = Math.round(Number(division));
    return d % 3 !== 0;
}

/** Beats a grid position at `phaseBeat` (beats from the swing grid's zero) is delayed by. */
export function swingOffsetBeats(phaseBeat, s) {
    if (!(s > 0.5) || !(phaseBeat >= 0) || !Number.isFinite(phaseBeat)) return 0;
    const f = (phaseBeat % EIGHTH) / EIGHTH;
    const w = f < 0.5 ? f * (s / 0.5) : s + (f - 0.5) * ((1 - s) / 0.5);
    return (w - f) * EIGHTH;
}

/**
 * Maps AudioContext times to beats from the swing grid's zero. Play start (or a song
 * relocate) resets it; a tempo change re-anchors at the next step it warps.
 */
export function createSwingClock() {
    let anchorTime = 0;
    let anchorBeat = 0;
    let tempo = 120;

    const beatAt = (t) => anchorBeat + (t - anchorTime) * (tempo / 60);

    function reset(time, beat = 0, bpm = tempo) {
        anchorTime = Number.isFinite(time) ? time : 0;
        anchorBeat = Number.isFinite(beat) ? beat : 0;
        if (bpm > 0) tempo = bpm;
    }

    function follow(time, bpm) {
        if (!(bpm > 0) || bpm === tempo) return;
        anchorBeat = beatAt(time);
        anchorTime = time;
        tempo = bpm;
    }

    function warp(t, s) {
        return t + swingOffsetBeats(beatAt(t), s) * (60 / tempo);
    }

    /** Swung start and length of a grid step that starts at `start` and lasts `dur` seconds. */
    function span(start, dur, { swing, tempo: bpm, division }) {
        const s = swingFraction(swing);
        if (s <= 0.5 || !swingable(division) || !(dur > 0)) return { start, dur };
        follow(start, bpm);
        const a = warp(start, s);
        const b = warp(start + dur, s);
        return { start: a, dur: Math.max(1e-4, b - a) };
    }

    return { reset, span };
}
