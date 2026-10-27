import { state } from './state.js?v=119';
import { get, getNumber, getString } from './params.js?v=23';
import { getLiveStep } from './pattern-bank.js?v=30';

// Base reference frequency: C4.
export const BASE_FREQ = 261.63;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Note name for a semitone offset from C4 (e.g. 0 → "C4", 2 → "D4").
export function semitonesToNoteName(semitones, cents = 0) {
    let noteIndex = semitones % 12;
    if (noteIndex < 0) noteIndex += 12;
    const octave = 4 + Math.floor(semitones / 12);
    let name = NOTE_NAMES[noteIndex] + octave;
    if (cents) {
        name += ` ${cents > 0 ? '+' : ''}${cents}\u00A2`;
    }
    return name;
}

// Master Tune + Octave Switch + Semitone Switch (never scale-quantized).
export function getGlobalTune() {
    const masterTune = getNumber('masterTune');
    const octaveSwitch = getNumber('octaveSwitch') * 12;
    const semitoneShift = calculateSemitoneShift();
    return masterTune + octaveSwitch + semitoneShift;
}

// Frequency for an absolute semitone offset from C4 (plus optional per-osc detune).
export function semitonesToFrequency(semitones, oscIndex) {
    const total = semitones
        + (oscIndex !== undefined ? state.oscTunes[oscIndex] : 0);
    return BASE_FREQ * Math.pow(2, total / 12);
}

// Scale definitions: pitch-class sets (semitones from the root).
export const SCALE_BANKS = [
    {
        name: 'Bank 1: Major Scale & Modes',
        scales: [
            { id: 'ionian',           name: 'Ionian (Natural Major)',        degrees: [0, 2, 4, 5, 7, 9, 11] },
            { id: 'dorian',           name: 'Dorian',                        degrees: [0, 2, 3, 5, 7, 9, 10] },
            { id: 'phrygian',         name: 'Phrygian',                      degrees: [0, 1, 3, 5, 7, 8, 10] },
            { id: 'lydian',           name: 'Lydian',                        degrees: [0, 2, 4, 6, 7, 9, 11] },
            { id: 'mixolydian',       name: 'Mixolydian',                    degrees: [0, 2, 4, 5, 7, 9, 10] },
            { id: 'aeolian',          name: 'Aeolian (Natural Minor)',       degrees: [0, 2, 3, 5, 7, 8, 10] },
            { id: 'locrian',          name: 'Locrian',                       degrees: [0, 1, 3, 5, 6, 8, 10] },
        ],
    },
    {
        name: 'Bank 2: Melodic Minor & Modes',
        scales: [
            { id: 'melodic-minor',    name: 'Melodic Minor',                 degrees: [0, 2, 3, 5, 7, 9, 11] },
            { id: 'dorian-b2',        name: 'Dorian \u266D2',                degrees: [0, 1, 3, 5, 7, 9, 10] },
            { id: 'lydian-aug',       name: 'Lydian Augmented',              degrees: [0, 2, 4, 6, 8, 9, 11] },
            { id: 'lydian-dom',       name: 'Lydian Dominant',               degrees: [0, 2, 4, 6, 7, 9, 10] },
            { id: 'mixolydian-b6',    name: 'Mixolydian \u266D6',            degrees: [0, 2, 4, 5, 7, 8, 10] },
            { id: 'locrian-nat2',     name: 'Locrian \u266E2',               degrees: [0, 2, 3, 5, 6, 8, 10] },
            { id: 'altered',          name: 'Altered (Super Locrian)',       degrees: [0, 1, 3, 4, 6, 8, 10] },
        ],
    },
    {
        name: 'Bank 3: Harmonic Minor & Modes',
        scales: [
            { id: 'harmonic-minor',   name: 'Harmonic Minor',                degrees: [0, 2, 3, 5, 7, 8, 11] },
            { id: 'locrian-nat6',     name: 'Locrian \u266E6',               degrees: [0, 1, 3, 5, 6, 9, 10] },
            { id: 'ionian-aug',       name: 'Ionian Augmented',              degrees: [0, 2, 4, 5, 8, 9, 11] },
            { id: 'romanian-minor',   name: 'Romanian Minor (Dorian \u266F4)', degrees: [0, 2, 3, 6, 7, 9, 10] },
            { id: 'phrygian-dom',     name: 'Phrygian Dominant',             degrees: [0, 1, 4, 5, 7, 8, 10] },
            { id: 'lydian-sharp2',    name: 'Lydian \u266F2',                degrees: [0, 3, 4, 6, 7, 9, 11] },
            { id: 'ultralocrian',     name: 'Ultralocrian',                  degrees: [0, 1, 3, 4, 6, 8, 9] },
        ],
    },
    {
        name: 'Bank 4: Special Scales',
        scales: [
            { id: 'major-pent',       name: 'Major Pentatonic',              degrees: [0, 2, 4, 7, 9] },
            { id: 'minor-pent',       name: 'Minor Pentatonic',              degrees: [0, 3, 5, 7, 10] },
            { id: 'blues',            name: 'Blues Scale',                   degrees: [0, 3, 5, 6, 7, 10] },
            { id: 'whole-tone',       name: 'Whole Tone',                    degrees: [0, 2, 4, 6, 8, 10] },
            { id: 'half-whole-dim',   name: 'Half-Whole Diminished',         degrees: [0, 1, 3, 4, 6, 7, 9, 10] },
            { id: 'whole-half-dim',   name: 'Whole-Half Diminished',         degrees: [0, 2, 3, 5, 6, 8, 9, 11] },
            { id: 'chromatic',        name: 'Chromatic (All 12 notes)',      degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
        ],
    },
    {
        name: 'Bank 5: World Scales',
        scales: [
            { id: 'double-harmonic',  name: 'Gypsy / Double Harmonic Major', degrees: [0, 1, 4, 5, 7, 8, 11] },
            { id: 'hungarian-minor',  name: 'Hungarian Minor',               degrees: [0, 2, 3, 6, 7, 8, 11] },
            { id: 'bhairav',          name: 'Phrygian Major (Bhairav)',      degrees: [0, 1, 4, 5, 7, 8, 11] },
            { id: 'iwato',            name: 'Iwato',                         degrees: [0, 1, 5, 6, 10] },
            { id: 'in-sen',           name: 'In Sen',                        degrees: [0, 1, 5, 7, 10] },
            { id: 'hirajoshi',        name: 'Hirajoshi',                     degrees: [0, 2, 3, 7, 8] },
            { id: 'pelog',            name: 'Pelog',                         degrees: [0, 1, 3, 7, 8] },
        ],
    },
];

const SCALE_MAP = {};
for (const bank of SCALE_BANKS) {
    for (const scale of bank.scales) SCALE_MAP[scale.id] = scale;
}

// The active scale object, or null when scale mode is off.
// Catalog default is off — missing Map flag must not snap notes.
export function getActiveScale() {
    if (!get('scaleToggle')) return null;
    return SCALE_MAP[getString('scaleSelect')] || null;
}

// Snap a semitone offset to the nearest scale tone (ties resolve downward).
// Works across octaves and for negative offsets.
export function quantizeToScale(semitones, degrees) {
    for (let d = 0; d <= 11; d++) {
        for (const candidate of [semitones - d, semitones + d]) {
            const pitchClass = ((candidate % 12) + 12) % 12;
            if (degrees.includes(pitchClass)) return candidate;
        }
    }
    return semitones;
}

// The step slider value after scale quantization (raw value when scale is off).
export function quantizeStepTune(raw) {
    const n = Math.round(Number(raw) || 0);
    const scale = getActiveScale();
    return scale ? quantizeToScale(n, scale.degrees) : n;
}

export function getQuantizedStepTune(step) {
    return quantizeStepTune(getLiveStep(step).tune);
}

// Calculate current note shift from the semitone switch controls
export function calculateSemitoneShift() {
    const semitoneAmount = getNumber('semitoneAmount');
    const switchPosition = getNumber('semitoneSwitch');
    return switchPosition * semitoneAmount;
}

function keyboardTransposeOffset() {
    return state.isArping
        ? (state.arpTranspose || 0)
        : (state.keyboardTranspose || 0);
}

export function getStepTotalTuneFromRaw(raw) {
    return quantizeStepTune(raw) + getGlobalTune() + keyboardTransposeOffset();
}

// Total tune in semitones for a sequencer step (before per-osc detune).
// The step's own offset is scale-quantized when scale mode is on; the global
// tuning controls transpose the scale root and are never quantized.
// While arping: use temporary arpTranspose (KB-gated). Otherwise: sticky
// keyboardTranspose from play-mode key presses.
export function getStepTotalTune(step) {
    return getStepTotalTuneFromRaw(getLiveStep(step).tune);
}

// Per-step microtuning offset in cents (-100..+100).
// Lock mode snaps only when a fine slider is moved — stored values are used as-is.
export function getStepFineCents(step) {
    return Math.round(Number(getLiveStep(step).fine) || 0);
}

export function frequencyFromStepData(data, oscIndex) {
    const totalTune = getStepTotalTuneFromRaw(data?.tune)
        + (oscIndex !== undefined ? state.oscTunes[oscIndex] : 0)
        + (Math.round(Number(data?.fine) || 0) / 100);
    return BASE_FREQ * Math.pow(2, totalTune / 12);
}

export function midiNoteFromStepData(data) {
    const midiNote = state.midiBaseNote + getStepTotalTuneFromRaw(data?.tune);
    return Math.min(127, Math.max(0, midiNote));
}

// Frequency for a step and oscillator index, including the per-step cents
// offset. This is the single seam where a future scale/tuning system
// (EDO, Scala, just intonation) can plug in.
export function stepToFrequency(step, oscIndex) {
    return frequencyFromStepData(getLiveStep(step), oscIndex);
}

// MIDI note number for a step (clamped to 0-127). Cents ride separately on
// pitch bend - see midiPitchBendValue.
export function stepToMidiNote(step) {
    return midiNoteFromStepData(getLiveStep(step));
}

// 14-bit pitch bend value (0-16383, center 8192) for a cents offset given the
// receiver's bend range in semitones.
export function midiPitchBendValue(cents, bendRangeSemitones) {
    const bend = 8192 + Math.round((cents / 100) / bendRangeSemitones * 8192);
    return Math.min(16383, Math.max(0, bend));
}
