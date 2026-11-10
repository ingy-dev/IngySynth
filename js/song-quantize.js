// Notes clip → synth pattern. No DOM.
//
// Grid: straight 1/16 unless the onsets clearly sit on a triplet grid (1/8T or 1/16T).
// A range longer than 32 sixteenths uses 1/8 or 1/4 steps when every note starts on one.
// Onset: snaps to the nearest step, so a note played a little early stays on its beat.
// Length: a note fills every step it covers (end snapped to the nearest step line). Each
// step but its last carries Slide, so the sequencer holds the gate and the note plays as
// one tied note. A note shorter than a step and a half is one plain step.
// Slide into a new note: the note before it overlaps it, or the new note is flagged
// legato (recorded with a key still held) and starts where the old one ends.
// Notes that only touch (end = next start) do not slide.
// A note held over the range start plays from the first step.

import { chordFromCellNotes } from './pattern-bank.js?v=51';

const BAR_TICKS = 3840;
const STEP_SLOTS = 32;
const REPEAT_MAX = 8;
const STRAIGHT = 16;
const TRIPLETS = [12, 24]; // 1/8T, 1/16T
const WIDER = [8, 4]; // tried in turn when the range is too long for 32 sixteenths
const GRID_TIGHT = 12; // mean onset error (ticks) that already counts as on the 1/16 grid
const RATCHET_LATEST = 0.8; // a same-pitch hit later in the step than this is an early next note
const OVERLAP_MIN = 4; // ticks two notes must share to count as played legato
const LEGATO_SLACK = 30; // ticks a legato-flagged note may start after the old one ends
const COVER_SLACK = 0.125; // steps a held note may fall short of a step's end and still fill it
const ACCENT_VEL = 0.8;
const EDGE_SLACK = 2; // ticks a range edge may sit off a step line and still count as on it
const EPS = 1e-9;

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

function sameFine(voices) {
    let fine = null;
    for (const voice of voices) {
        if (fine === null) fine = voice.fine;
        else if (voice.fine !== fine) return 0;
    }
    return fine === null ? 0 : fine;
}

function gridError(onsets, ticks) {
    if (!onsets.length) return 0;
    let sum = 0;
    for (const onset of onsets) {
        sum += Math.abs(onset - Math.round(onset / ticks) * ticks);
    }
    return sum / onsets.length;
}

// Steps per bar. Triplets win only when they fit at least twice as well as 1/16; the
// coarser 1/8T is kept when 1/16T adds nothing.
function pickDivision(onsets, spanTicks) {
    const straight = gridError(onsets, BAR_TICKS / STRAIGHT);
    if (straight > GRID_TIGHT) {
        const [coarse, fine] = TRIPLETS.map((division) => gridError(onsets, BAR_TICKS / division));
        if (fine < straight * 0.5) return coarse <= fine + 4 ? TRIPLETS[0] : TRIPLETS[1];
    }
    return widenGrid(onsets, spanTicks);
}

// A range too long for 32 sixteenths would lose its tail. Use 1/8 (then 1/4) steps
// when every note already starts on one, so the whole range fits.
function widenGrid(onsets, spanTicks) {
    const sixteenth = BAR_TICKS / STRAIGHT;
    let division = STRAIGHT;
    for (const wider of WIDER) {
        if (spanTicks <= STEP_SLOTS * (BAR_TICKS / division)) break;
        const every = STRAIGHT / wider;
        if (!onsets.every((onset) => Math.round(onset / sixteenth) % every === 0)) break;
        division = wider;
    }
    return division;
}

// One voice = one pitch starting on one step. Extra same-pitch hits inside the step
// are ratchet hits of that voice.
function placeVoices(notes, origin, stepTicks, count) {
    const starts = Array.from({ length: count }, () => new Map());
    const voices = [];
    for (const note of notes) {
        const pos = (note.onset - origin) / stepTicks;
        const base = Math.floor(pos + EPS);
        const frac = pos - base;
        let index = frac >= 0.5 - EPS ? base + 1 : base;
        const ratchet = index !== base && frac <= RATCHET_LATEST + EPS
            && base >= 0 && base < count && starts[base].has(note.pitch);
        if (ratchet) index = base;
        if (index < 0 || index >= count) continue;
        const held = starts[index].get(note.pitch);
        if (held) {
            held.hits += 1;
            held.end = Math.max(held.end, note.end);
            held.vel = Math.max(held.vel, note.vel);
            if (note.fine !== held.fine) held.fine = 0;
            continue;
        }
        const voice = {
            pitch: note.pitch,
            fine: note.fine,
            vel: note.vel,
            legato: note.legato,
            onset: note.onset,
            end: note.end,
            hits: 1,
            first: index,
            last: index,
        };
        starts[index].set(note.pitch, voice);
        voices.push(voice);
    }
    return { starts, voices };
}

// Last step each voice fills. A new note cuts the held one unless the held one lasts
// through that whole step (then both sound there as a chord).
function spanVoices(starts, voices, origin, stepTicks, count) {
    for (const voice of voices) {
        if (voice.hits > 1) continue; // a ratchet roll is one step
        const endStep = Math.round((voice.end - origin) / stepTicks - EPS);
        let stop = Math.min(count, Math.max(voice.first + 1, endStep));
        for (let k = voice.first + 1; k < stop; k += 1) {
            if (!starts[k].size) continue;
            const covers = (voice.end - origin) / stepTicks >= k + 1 - COVER_SLACK;
            if (starts[k].has(voice.pitch) || !covers) {
                stop = k;
                break;
            }
        }
        voice.last = stop - 1;
    }
}

function slidesInto(ending, starting) {
    for (const from of ending) {
        for (const to of starting) {
            const overlap = from.end - to.onset;
            if (overlap >= OVERLAP_MIN) return true;
            if (to.legato && -overlap <= LEGATO_SLACK) return true;
        }
    }
    return false;
}

function buildSteps(starts, voices, count) {
    const sounding = Array.from({ length: count }, () => []);
    for (const voice of voices) {
        for (let k = voice.first; k <= voice.last; k += 1) sounding[k].push(voice);
    }
    return sounding.map((group, k) => {
        if (!group.length) return restStep();
        const fresh = group.filter((voice) => voice.first === k);
        const next = k + 1 < count ? sounding[k + 1] : [];
        let slide = false;
        if (next.length) {
            const starting = next.filter((voice) => voice.first === k + 1);
            // Nothing new on the next step: it is the same note still held, so tie into it.
            if (!starting.length) slide = true;
            else slide = slidesInto(group.filter((voice) => voice.last === k), starting);
        }
        const formed = chordFromCellNotes(group.map((voice) => voice.pitch));
        let ratch = 1;
        for (const voice of fresh) ratch = Math.max(ratch, Math.min(4, voice.hits));
        return {
            tune: formed.tune,
            fine: sameFine(group),
            on: true,
            accent: fresh.some((voice) => voice.vel > ACCENT_VEL),
            slide,
            ratch,
            chord: formed.chord.slice(),
        };
    });
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

function onLine(tick, stepTicks) {
    return Math.abs(tick - Math.round(tick / stepTicks) * stepTicks) <= EDGE_SLACK;
}

// Both range edges snap to the nearest step line: a range drawn by hand a little over
// or under a bar is still a bar.
function stepSpan(startTick, endTick, stepTicks) {
    const origin = Math.round(startTick / stepTicks) * stepTicks;
    let count = Math.round((endTick - origin) / stepTicks);
    if (!Number.isFinite(count) || count < 1) count = 1;
    return { origin, count };
}

function readNotes(notes) {
    const out = [];
    for (const note of Array.isArray(notes) ? notes : []) {
        if (!note) continue;
        const onset = Number(note.startTick);
        const pitch = notePitch(note);
        if (!Number.isFinite(onset) || pitch === null) continue;
        const dur = Number(note.durTick);
        const vel = Number(note.vel);
        out.push({
            pitch,
            fine: noteFine(note),
            vel: Number.isFinite(vel) ? vel : 0,
            legato: !!note.legato,
            onset,
            end: onset + (Number.isFinite(dur) && dur > 0 ? dur : 1),
        });
    }
    return out.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
}

// Notes the range plays. A note already sounding at the range start (the clip was
// trimmed through it) starts on the first step with the length it has left, as song
// playback chases it (Sequencer startNotes). It needs half a step left to count, and a
// whole step when another note starts there, so the tail of a trimmed-off note does not
// turn the first step into a chord.
function chaseNotes(notes, startTick, endTick, origin, stepTicks) {
    // A note played just ahead of a start that sits on the grid belongs to its first
    // step. A start drawn by hand is taken as drawn.
    const lead = onLine(startTick, stepTicks) ? stepTicks / 2 : 0;
    const from = startTick - lead;
    const inside = notes.filter((note) => note.onset >= from && note.onset < endTick);
    const crowded = inside.some((note) => note.onset < origin + stepTicks / 2);
    const need = stepTicks * (crowded ? 1 - COVER_SLACK : 0.5);
    const held = notes
        .filter((note) => note.onset < from && note.end - origin >= need)
        .map((note) => ({ ...note, onset: origin, legato: false }));
    return held.concat(inside).sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
}

// An end drawn by hand may stop short of the line after its last note: keep that note.
function lastStep(notes, origin, stepTicks) {
    let last = 0;
    for (const note of notes) {
        last = Math.max(last, Math.round((note.onset - origin) / stepTicks));
    }
    return last;
}

/**
 * Quantize absolute notes in [startTick, endTick) onto a normal pattern.
 * @param {Array<{ semi: number, fine: number, startTick: number, durTick: number, vel: number, legato: boolean }>} notes
 * @param {{ startTick: number, endTick: number }} range
 * @returns {{ data: object, truncated: boolean }}
 */
export function quantizeToPattern(notes, range) {
    const { startTick, endTick } = rangeTicks(range);
    const all = readNotes(notes);
    const rough = all.filter((note) => note.onset >= startTick - BAR_TICKS / STRAIGHT / 2 && note.onset < endTick);
    const division = pickDivision(rough.map((note) => note.onset), endTick - startTick);
    const stepTicks = BAR_TICKS / division;
    const { origin, count: span } = stepSpan(startTick, endTick, stepTicks);
    const near = chaseNotes(all, startTick, endTick, origin, stepTicks);
    const count = onLine(endTick, stepTicks) ? span : Math.max(span, lastStep(near, origin, stepTicks) + 1);
    const { starts, voices } = placeVoices(near, origin, stepTicks, count);
    spanVoices(starts, voices, origin, stepTicks, count);
    const built = buildSteps(starts, voices, count);
    const { stepCount, repeat, truncated } = resolvePeriod(built);
    const keep = truncated ? STEP_SLOTS : stepCount;
    const steps = Array.from({ length: STEP_SLOTS }, restStep);
    for (let i = 0; i < keep && i < built.length && i < STEP_SLOTS; i += 1) {
        steps[i] = built[i];
    }
    // A cut pattern loops at step 32: its last step has no held note to tie into.
    if (truncated) steps[STEP_SLOTS - 1].slide = false;
    return {
        data: {
            steps,
            stepCount,
            division,
            reverse: false,
            gate: 0.9,
            repeat,
            enabled: true,
        },
        truncated,
    };
}
