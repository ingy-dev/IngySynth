// Pitch-class chord names for the note VFD. Lowest note = root.
import { NOTE_NAMES, semitonesToNoteName } from './tuning.js?v=104';
import { NOTE_VFD_COLS } from './vfd-matrix.js?v=6';

/** Unique sorted integer semitones. */
export function uniqueSortedNotes(notes) {
    const seen = new Set();
    const out = [];
    for (const raw of notes || []) {
        const n = Math.round(Number(raw));
        if (!Number.isFinite(n) || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    out.sort((a, b) => a - b);
    return out;
}

function pitchClassName(semi) {
    let pc = semi % 12;
    if (pc < 0) pc += 12;
    return NOTE_NAMES[pc];
}

/** Pitch classes relative to lowest, as a canonical "0,3,7" key. */
function pcsKeyFromLowest(sorted) {
    const root = sorted[0];
    const pcs = [...new Set(sorted.map((n) => {
        let d = (n - root) % 12;
        if (d < 0) d += 12;
        return d;
    }))].sort((a, b) => a - b);
    return { root, key: pcs.join(',') };
}

// VFD-safe qualities (no spaces, no Δ/ø). Lowest-note bass.
// Shells without 3 or 5 keep the same quality as the full chord.
const QUALITY_BY_PCS = {
    '0,2': 'sus2',
    '0,3': 'min',
    '0,4': 'maj',
    '0,5': 'sus4',
    '0,6': 'b5',
    '0,7': '5',
    '0,8': '#5',
    '0,9': '6',
    '0,10': '7',
    '0,11': 'maj7',

    '0,2,3': 'madd9',
    '0,2,4': 'add9',
    '0,2,5': 'sus24',
    '0,2,7': 'sus2',
    '0,2,10': '7sus2',
    '0,2,11': 'maj7sus2',
    '0,3,5': 'madd11',
    '0,3,6': 'dim',
    '0,3,7': 'min',
    '0,3,8': 'min#5',
    '0,3,9': 'min6',
    '0,3,10': 'min7',
    '0,3,11': 'minmaj7',
    '0,4,5': 'add11',
    '0,4,6': 'majb5',
    '0,4,7': 'maj',
    '0,4,8': 'aug',
    '0,4,9': '6',
    '0,4,10': '7',
    '0,4,11': 'maj7',
    '0,5,7': 'sus4',
    '0,5,9': '6sus4',
    '0,5,10': '7sus4',
    '0,5,11': 'maj7sus4',
    '0,6,7': 'add#11',
    '0,6,9': 'dim7',
    '0,6,10': '7b5',
    '0,6,11': 'maj7b5',
    '0,7,9': '6',
    '0,7,10': '7',
    '0,7,11': 'maj7',
    '0,8,10': '7#5',
    '0,8,11': 'maj7#5',

    '0,1,3,7': 'minb9',
    '0,1,4,7': 'addb9',
    '0,1,5,7': 'sus4b9',
    '0,1,7,10': '7b9',
    '0,2,3,7': 'madd9',
    '0,2,3,9': 'min6add9',
    '0,2,3,10': 'min9',
    '0,2,3,11': 'minmaj9',
    '0,2,4,6': 'add9#11',
    '0,2,4,7': 'add9',
    '0,2,4,9': '6add9',
    '0,2,4,10': '9',
    '0,2,4,11': 'maj9',
    '0,2,5,7': 'sus24',
    '0,2,5,10': '9sus4',
    '0,2,6,10': '9b5',
    '0,2,7,9': '6add9',
    '0,2,7,10': '7sus2',
    '0,2,7,11': 'maj7sus2',
    '0,3,4,7': 'add#9',
    '0,3,5,7': 'madd11',
    '0,3,5,10': 'min11',
    '0,3,6,9': 'dim7',
    '0,3,6,10': 'min7b5',
    '0,3,6,11': 'minmaj7b5',
    '0,3,7,8': 'minb6',
    '0,3,7,9': 'min6',
    '0,3,7,10': 'min7',
    '0,3,7,11': 'minmaj7',
    '0,3,8,10': 'min7#5',
    '0,3,8,11': 'minmaj7#5',
    '0,3,9,10': 'min13',
    '0,4,5,7': 'add11',
    '0,4,5,10': '11',
    '0,4,6,7': 'maj#11',
    '0,4,6,9': '6#11',
    '0,4,6,10': '7b5',
    '0,4,6,11': 'maj7b5',
    '0,4,7,8': 'majb13',
    '0,4,7,9': '6',
    '0,4,7,10': '7',
    '0,4,7,11': 'maj7',
    '0,4,8,9': 'aug6',
    '0,4,8,10': '7#5',
    '0,4,8,11': 'maj7#5',
    '0,4,9,10': '13',
    '0,4,9,11': 'maj13',
    '0,5,7,9': '6sus4',
    '0,5,7,10': '7sus4',
    '0,5,7,11': 'maj7sus4',
    '0,5,9,10': '13sus4',
    '0,6,7,10': '7#11',
    '0,6,7,11': 'maj7#11',
    '0,7,9,10': '13',
    '0,7,9,11': 'maj13',

    '0,1,3,7,10': 'min7b9',
    '0,1,4,6,10': '7b9b5',
    '0,1,4,7,10': '7b9',
    '0,1,4,8,10': '7b9#5',
    '0,1,5,7,10': '7sus4b9',
    '0,2,3,5,7': 'min11',
    '0,2,3,5,10': 'min11',
    '0,2,3,6,10': 'min9b5',
    '0,2,3,7,9': 'min6add9',
    '0,2,3,7,10': 'min9',
    '0,2,3,7,11': 'minmaj9',
    '0,2,4,5,7': '11',
    '0,2,4,5,10': '11',
    '0,2,4,6,7': 'add9#11',
    '0,2,4,6,10': '9b5',
    '0,2,4,6,11': 'maj9b5',
    '0,2,4,7,9': '6add9',
    '0,2,4,7,10': '9',
    '0,2,4,7,11': 'maj9',
    '0,2,4,8,10': '9#5',
    '0,2,4,9,10': '13',
    '0,2,4,9,11': 'maj13',
    '0,2,5,7,9': '6sus4',
    '0,2,5,7,10': '9sus4',
    '0,2,5,7,11': 'maj9sus4',
    '0,2,6,7,10': '9#11',
    '0,2,6,7,11': 'maj9#11',
    '0,2,7,9,10': '13sus2',
    '0,3,4,6,10': '7#9b5',
    '0,3,4,7,10': '7#9',
    '0,3,4,8,10': '7#9#5',
    '0,3,5,6,10': 'min11b5',
    '0,3,5,7,10': 'min11',
    '0,3,7,8,10': 'min7b13',
    '0,3,7,9,10': 'min13',
    '0,3,7,9,11': 'minmaj13',
    '0,4,5,7,10': '11',
    '0,4,5,7,11': 'maj11',
    '0,4,6,7,10': '7#11',
    '0,4,6,7,11': 'maj7#11',
    '0,4,6,9,10': '13#11',
    '0,4,7,8,10': '7b13',
    '0,4,7,9,10': '13',
    '0,4,7,9,11': 'maj13',
    '0,5,7,9,10': '13sus4',
    '0,5,7,9,11': 'maj13sus4',

    '0,1,4,6,8,10': '7alt',
    '0,1,4,7,9,10': '13b9',
    '0,2,3,5,7,10': 'min11',
    '0,2,3,5,7,11': 'minmaj11',
    '0,2,3,7,9,10': 'min13',
    '0,2,3,7,9,11': 'minmaj13',
    '0,2,4,5,7,10': '11',
    '0,2,4,5,7,11': 'maj11',
    '0,2,4,6,7,10': '9#11',
    '0,2,4,6,7,11': 'maj9#11',
    '0,2,4,7,8,10': '9b13',
    '0,2,4,7,9,10': '13',
    '0,2,4,7,9,11': 'maj13',
    '0,2,5,7,9,10': '13sus4',
    '0,2,6,7,9,10': '13#11',
    '0,3,4,7,9,10': '13#9',
    '0,3,5,7,9,10': 'min13',
    '0,4,6,7,9,10': '13#11',
    '0,4,6,7,9,11': 'maj13#11',

    '0,2,3,5,7,9,10': 'min13',
    '0,2,3,5,7,9,11': 'minmaj13',
    '0,2,4,5,7,9,10': '13',
    '0,2,4,5,7,9,11': 'maj13',
    '0,2,4,6,7,9,10': '13#11',
    '0,2,4,6,7,9,11': 'maj13#11',
};

/**
 * Chord label without cents. Empty string if no notes.
 * One pitch returns null so the caller can use the octave note name.
 */
export function chordNameFromNotes(notes) {
    const sorted = uniqueSortedNotes(notes);
    if (!sorted.length) return '';
    if (sorted.length === 1) return null;
    const { root, key } = pcsKeyFromLowest(sorted);
    const rootName = pitchClassName(root);
    const quality = QUALITY_BY_PCS[key];
    if (quality) return `${rootName}${quality}`;
    const seen = new Set();
    const parts = [];
    for (const n of sorted) {
        const name = pitchClassName(n);
        if (seen.has(name)) continue;
        seen.add(name);
        parts.push(name);
    }
    return parts.join(' ');
}

function centsSuffix(cents) {
    const c = Math.round(Number(cents) || 0);
    if (!c) return '';
    return ` ${c > 0 ? '+' : ''}${c}¢`;
}

/** Single note (with octave) or chord name, optional cents if they fit. */
export function formatNoteOrChord(notes, cents = 0) {
    const sorted = uniqueSortedNotes(notes);
    if (!sorted.length) return '';
    if (sorted.length === 1) return semitonesToNoteName(sorted[0], cents);
    let name = chordNameFromNotes(sorted) || pitchClassName(sorted[0]);
    const suffix = centsSuffix(cents);
    if (suffix && name.length + suffix.length <= NOTE_VFD_COLS) name += suffix;
    if (name.length > NOTE_VFD_COLS) return name.slice(0, NOTE_VFD_COLS);
    return name;
}
