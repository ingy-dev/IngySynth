import { state, OSC_COUNT } from './state.js?v=113';

/** Active held cell-semitones (insertion / press order preserved in pressOrder). */
const held = new Set();
const pressOrder = [];

/** Peak chord for the current Arp Chord gesture (survives staggered key-ups). */
let arpChordSessionNotes = [];
let arpChordSessionOrder = [];

export function clearHeldNotes() {
    held.clear();
    pressOrder.length = 0;
}

export function clearArpChordSession() {
    arpChordSessionNotes = [];
    arpChordSessionOrder = [];
}

/** Record a note into the current Arp Chord hold gesture. */
export function recordArpChordSessionNote(semi) {
    if (!Number.isFinite(semi)) return;
    if (!arpChordSessionNotes.includes(semi)) {
        arpChordSessionNotes.push(semi);
        arpChordSessionOrder.push(semi);
    }
}

export function getArpChordSessionNotes() {
    return [...arpChordSessionNotes];
}

export function getArpChordSessionOrder() {
    return [...arpChordSessionOrder];
}

export function addHeldNote(semi) {
    if (!Number.isFinite(semi)) return false;
    if (held.has(semi)) return false;
    held.add(semi);
    pressOrder.push(semi);
    return true;
}

export function removeHeldNote(semi) {
    if (!held.has(semi)) return false;
    held.delete(semi);
    const idx = pressOrder.indexOf(semi);
    if (idx >= 0) pressOrder.splice(idx, 1);
    return true;
}

export function getHeldNotes() {
    return [...held];
}

export function getHeldPressOrder() {
    return [...pressOrder];
}

export function heldNoteCount() {
    return held.size;
}

/** True when multi-note hold tracking should be used (not during sequencer play). */
export function needsHeldNoteSet() {
    if (state.isPlaying) return false;
    if (state.chordMemoryLearning) return true;
    if (state.keyboardPoly || state.keyboardMultitudes) return true;
    return !!(state.keyboardArp && state.keyboardArpChord);
}

/** Pitch-sorted unique notes currently driving chord arp (live or latch-frozen). */
export function getChordArpSourceNotes() {
    if (held.size > 0) return [...held];
    if (state.arpFrozenNotes && state.arpFrozenNotes.length) {
        return [...state.arpFrozenNotes];
    }
    return [];
}

export function getChordArpPressOrder() {
    if (held.size > 0) return [...pressOrder];
    if (state.arpFrozenPressOrder && state.arpFrozenPressOrder.length) {
        return [...state.arpFrozenPressOrder];
    }
    return [];
}

/** Freeze the peak chord from this gesture (Latch). */
export function freezeArpChordSession() {
    if (!arpChordSessionNotes.length) return false;
    state.arpFrozenNotes = [...arpChordSessionNotes];
    state.arpFrozenPressOrder = [...arpChordSessionOrder];
    return true;
}

export function clearFrozenArpNotes() {
    state.arpFrozenNotes = null;
    state.arpFrozenPressOrder = null;
}

/**
 * Expand a held-note pool across 1–3 octaves (Juno-60 Range).
 * @param {number[]} notes
 * @param {number} range 1 | 2 | 3
 */
export function expandArpNotesByRange(notes, range = 1) {
    const base = [...new Set((notes || []).filter(Number.isFinite))];
    const octaves = Math.max(1, Math.min(3, Math.floor(Number(range)) || 1));
    if (octaves <= 1 || base.length === 0) return base;
    const out = [];
    for (let o = 0; o < octaves; o++) {
        const shift = o * 12;
        for (const n of base) out.push(n + shift);
    }
    return out;
}

/**
 * Build one cycle of note order for classic chord arp.
 * @param {number[]} notes
 * @param {'up'|'down'|'upDown'|'random'} mode
 */
export function buildOrderList(notes, mode) {
    const unique = [...new Set(notes.filter(Number.isFinite))];
    if (unique.length === 0) return [];
    if (unique.length === 1) return [unique[0]];

    const up = [...unique].sort((a, b) => a - b);

    switch (mode) {
        case 'down':
            return [...up].reverse();
        case 'upDown': {
            if (up.length === 2) return [up[0], up[1]];
            return [...up, ...up.slice(1, -1).reverse()];
        }
        case 'random': {
            const shuffled = [...up];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            return shuffled;
        }
        case 'up':
        default:
            return up;
    }
}

/**
 * Map held notes → up to OSC_COUNT osc tune intervals relative to lowest pitch.
 * Clamped to −12…+12.
 */
export function intervalsFromHeldNotes(notes) {
    const sorted = [...new Set(notes.filter(Number.isFinite))].sort((a, b) => a - b);
    const intervals = Array(OSC_COUNT).fill(0);
    if (sorted.length === 0) return intervals;
    const root = sorted[0];
    for (let i = 0; i < Math.min(OSC_COUNT, sorted.length); i++) {
        intervals[i] = Math.max(-12, Math.min(12, sorted[i] - root));
    }
    return intervals;
}

/**
 * Alpha Juno-style stack for Ingy-6 / Multitudes: intervals from lowest note.
 * Up to 6 voices; no ±12 clamp (octave stacks need +12 / +24).
 */
export function polyChordIntervalsFromNotes(notes, maxNotes = 6) {
    const sorted = [...new Set(notes.filter(Number.isFinite))].sort((a, b) => a - b);
    if (!sorted.length) return [];
    const root = sorted[0];
    const cap = Math.max(1, Math.min(maxNotes, sorted.length));
    const out = [];
    for (let i = 0; i < cap; i++) out.push(sorted[i] - root);
    return out;
}
