// Notes clip → 1/16 synth pattern. No DOM.
// One sixteenth is 240 ticks. Onset maps to the step that contains it.

import { chordFromCellNotes } from './pattern-bank.js?v=31';

const SIXTEENTH = 240;
const STEP_SLOTS = 32;
const REPEAT_MAX = 8;

function restStep() {
    return { tune: 0, fine: 0, on: false, accent: false, slide: false, ratch: 1, chord: [] };
}

function noteFine(note) {
    const fine = Number(note?.fine);
    return Number.isFinite(fine) ? fine : 0;
}

function notePitch(note) {
    const semi = Math.round(Number(note?.semi));
    return Number.isFinite(semi) ? semi : null;
}

function sameFine(group) {
    let fine = null;
    for (const note of group) {
        const value = noteFine(note);
        if (fine === null) fine = value;
        else if (value !== fine) return 0;
    }
    return fine === null ? 0 : fine;
}

function stepAccent(group) {
    return group.some((note) => Number(note?.vel) > 0.8);
}

function stepRatch(group) {
    const counts = new Map();
    for (const note of group) {
        const pitch = notePitch(note);
        if (pitch === null) continue;
        counts.set(pitch, (counts.get(pitch) || 0) + 1);
    }
    let best = 1;
    for (const count of counts.values()) {
        if (count > best) best = count;
    }
    if (best <= 1) return 1;
    return Math.min(4, best);
}

function nextOnset(note, sorted) {
    const onset = Number(note?.startTick);
    if (!Number.isFinite(onset)) return null;
    let next = null;
    for (const other of sorted) {
        const tick = Number(other?.startTick);
        if (!Number.isFinite(tick) || tick <= onset) continue;
        if (next === null || tick < next) next = tick;
    }
    return next;
}

function stepSlide(group, sorted) {
    for (const note of group) {
        if (note?.legato) return true;
        const onset = Number(note?.startTick);
        const dur = Number(note?.durTick);
        if (!Number.isFinite(onset) || !Number.isFinite(dur)) continue;
        const next = nextOnset(note, sorted);
        if (next !== null && onset + dur >= next) return true;
    }
    return false;
}

function noteStep(group, sorted) {
    const pitches = [];
    for (const note of group) {
        const pitch = notePitch(note);
        if (pitch !== null) pitches.push(pitch);
    }
    const formed = chordFromCellNotes(pitches);
    return {
        tune: formed.tune,
        fine: sameFine(group),
        on: true,
        accent: stepAccent(group),
        slide: stepSlide(group, sorted),
        ratch: stepRatch(group),
        chord: formed.chord.slice(),
    };
}

function sameChord(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function sameStep(a, b) {
    return a.on === b.on
        && a.tune === b.tune
        && a.fine === b.fine
        && a.accent === b.accent
        && a.slide === b.slide
        && a.ratch === b.ratch
        && sameChord(a.chord, b.chord);
}

function repeatsEvery(steps, period) {
    for (let i = period; i < steps.length; i += 1) {
        if (!sameStep(steps[i], steps[i % period])) return false;
    }
    return true;
}

function resolvePeriod(steps) {
    const n = steps.length;
    const maxPeriod = Math.min(STEP_SLOTS, n);
    for (let period = 1; period <= maxPeriod; period += 1) {
        if (n % period !== 0) continue;
        const repeat = n / period;
        if (repeat < 1 || repeat > REPEAT_MAX) continue;
        if (repeatsEvery(steps, period)) {
            return { stepCount: period, repeat, truncated: false };
        }
    }
    if (n > STEP_SLOTS) {
        return { stepCount: STEP_SLOTS, repeat: 1, truncated: true };
    }
    return { stepCount: Math.max(1, n), repeat: 1, truncated: false };
}

function rangeTicks(range) {
    const start = Number(range?.startTick);
    const end = Number(range?.endTick);
    const startTick = Number.isFinite(start) ? start : 0;
    const endTick = Number.isFinite(end) ? end : startTick;
    return { startTick, endTick };
}

function stepSpan(startTick, endTick) {
    const origin = Math.floor(startTick / SIXTEENTH) * SIXTEENTH;
    let count = 1;
    if (endTick > origin) {
        const span = (endTick - origin) / SIXTEENTH;
        count = Math.ceil(span - 1e-9);
        if (!Number.isFinite(count) || count < 1) count = 1;
        count = Math.trunc(count);
    }
    return { origin, count };
}

/**
 * Quantize absolute note onsets in [startTick, endTick) onto a normal pattern.
 * @param {Array<{ semi: number, fine: number, startTick: number, durTick: number, vel: number, legato: boolean }>} notes
 * @param {{ startTick: number, endTick: number }} range
 * @returns {{ data: object, truncated: boolean }}
 */
export function quantizeToPattern(notes, range) {
    const { startTick, endTick } = rangeTicks(range);
    const { origin, count } = stepSpan(startTick, endTick);
    const source = Array.isArray(notes) ? notes : [];
    const inRange = [];
    for (const note of source) {
        if (!note) continue;
        const onset = Number(note.startTick);
        if (!Number.isFinite(onset) || onset < startTick || onset >= endTick) continue;
        inRange.push(note);
    }
    const sorted = inRange.slice().sort((a, b) => Number(a.startTick) - Number(b.startTick));
    const buckets = Array.from({ length: count }, () => []);
    for (const note of inRange) {
        const index = Math.floor((Number(note.startTick) - origin) / SIXTEENTH);
        if (index < 0 || index >= count) continue;
        buckets[index].push(note);
    }
    const built = buckets.map((group) => (group.length ? noteStep(group, sorted) : restStep()));
    const { stepCount, repeat, truncated } = resolvePeriod(built);
    const keep = truncated ? STEP_SLOTS : stepCount;
    const steps = Array.from({ length: STEP_SLOTS }, restStep);
    for (let i = 0; i < keep && i < built.length && i < STEP_SLOTS; i += 1) {
        steps[i] = built[i];
    }
    return {
        data: {
            steps,
            stepCount,
            division: 16,
            reverse: false,
            gate: 0.9,
            repeat,
            enabled: true,
        },
        truncated,
    };
}
