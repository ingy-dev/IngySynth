/**
 * Pure arrangement song model (no DOM, no app imports).
 *
 * Undo `extra` convention: only `undo()` returns `{ ok: true, extra }` where
 * `extra` is the opaque bank payload stored by `retargetClip` or
 * `checkpointUndo`. `checkpointUndo` only pushes that snapshot; it does not
 * edit clips. `redo()` always returns `{ ok: true, extra: null }` — callers
 * that need the bank slot again must keep it from undo.
 *
 * Clips stack. Each track's `clips` is a stack, bottom first, and clips may overlap:
 * a clip placed, moved or trimmed goes on top, and covers what is under it without
 * cutting it. Move it away (or delete it) and the clip underneath shows and plays
 * again. `visibleClips` gives the pieces that are actually heard and drawn; playback,
 * cues and the native player only ever see those.
 *
 * Berlin oscillator rows. Each oscillator lane (O1..O4) has its own track, `o1`..`o4`
 * (`song.lanes[row].clips`). A Berlin pattern dropped on the timeline becomes one clip
 * per oscillator it uses, each free to move, trim, mute or go on its own. A row clip is
 * an ordinary Berlin clip (`kind: 'b'`, the whole pattern in `data`) with `row` saying
 * which oscillator it plays, so it keeps its pattern's length and its mod lanes.
 */

export const PPQ = 960;
export const BAR_TICKS = 3840;
const MIN_NOTE_GRID = 240;

// Steps per bar. Triplets: 3 = 1/2T, 6 = 1/4T, 12 = 1/8T, 24 = 1/16T, 48 = 1/32T. All divide BAR_TICKS.
const DIVISIONS = new Set([2, 3, 4, 6, 8, 12, 16, 24, 48]);
const UNDO_CAP = 100;

/** @type {WeakMap<object, { undo: object[], redo: object[] }>} */
const history = new WeakMap();

let idCounter = 0;

function songHistory(song) {
    let h = history.get(song);
    if (!h) {
        h = { undo: [], redo: [] };
        history.set(song, h);
    }
    return h;
}

function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    idCounter += 1;
    return `clip-${idCounter}-${Date.now()}`;
}

function deepClone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
}

function clampInt(n, min, max, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(v)));
}

function divisionTicks(division) {
    const d = clampInt(division, 2, 48, 8);
    return DIVISIONS.has(d) ? BAR_TICKS / d : BAR_TICKS / 8;
}

function normalizeDivision(division) {
    const d = clampInt(division, 2, 48, 8);
    return DIVISIONS.has(d) ? d : 8;
}

/** Tracks of the Berlin oscillator rows, O1 first. */
export const LANE_TRACKS = ['o1', 'o2', 'o3', 'o4'];
const ALL_TRACKS = ['synth', ...LANE_TRACKS, 'drums'];

/** 0..3 for an oscillator row track, -1 for any other track. */
export function laneTrackRow(track) {
    return LANE_TRACKS.indexOf(track);
}

// Songs made before the rows existed have no `lanes`: give them empty ones on first use.
function laneClips(song, row) {
    if (!Array.isArray(song.lanes)) song.lanes = [];
    while (song.lanes.length < LANE_TRACKS.length) song.lanes.push({ clips: [] });
    if (!Array.isArray(song.lanes[row].clips)) song.lanes[row].clips = [];
    return song.lanes[row].clips;
}

/** A track's clip stack, bottom first (the live array). */
export function trackClips(song, track) {
    const row = laneTrackRow(track);
    if (row >= 0) return laneClips(song, row);
    return track === 'synth' ? song.synth.clips : song.drums.clips;
}

export function findClipById(song, id) {
    for (const track of ALL_TRACKS) {
        for (const clip of trackClips(song, track)) {
            if (clip.id === id) return clip;
        }
    }
    return null;
}

function rangesOverlap(aStart, aLen, bStart, bLen) {
    const aEnd = aStart + aLen;
    const bEnd = bStart + bLen;
    return aStart < bEnd && bStart < aEnd;
}

/**
 * The parts of a track's clips that show and play: each clip minus whatever is
 * stacked above it, as pieces sorted by start. A piece is a shallow copy of its clip
 * cropped the way a trim crops it (`startTick`, `lengthTick`, `startOffset`), with
 * the clip's `id`. `cropL` / `cropR` are true where the piece edge is a cover, not
 * the clip's own edge. A clip covered completely has no piece.
 */
export function visibleClips(song, track) {
    const list = trackClips(song, track);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
        const c = list[i];
        const cEnd = c.startTick + c.lengthTick;
        let parts = [[c.startTick, cEnd]];
        for (let j = i + 1; j < list.length && parts.length; j += 1) {
            const a = list[j].startTick;
            const b = a + list[j].lengthTick;
            const next = [];
            for (const [lo, hi] of parts) {
                if (b <= lo || a >= hi) {
                    next.push([lo, hi]);
                    continue;
                }
                if (a > lo) next.push([lo, a]);
                if (b < hi) next.push([b, hi]);
            }
            parts = next;
        }
        for (const [lo, hi] of parts) {
            out.push(lo === c.startTick && hi === cEnd ? c : cropClip(c, lo, hi));
        }
    }
    return out.sort((x, y) => x.startTick - y.startTick);
}

/** A clip shown only over [lo, hi), cropped the way a trim crops it. Same id. */
export function cropClip(clip, lo, hi) {
    const end = clip.startTick + clip.lengthTick;
    const piece = { ...clip, startTick: lo, lengthTick: hi - lo, cropL: lo > clip.startTick, cropR: hi < end };
    const offset = clipStartOffset(clip) + (lo - clip.startTick);
    if (offset) piece.startOffset = offset;
    else delete piece.startOffset;
    return piece;
}

/** True when part of another clip is hidden under this one. */
export function coversClip(song, id) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const list = trackClips(song, clip.track);
    const idx = list.indexOf(clip);
    for (let i = 0; i < idx; i += 1) {
        if (rangesOverlap(clip.startTick, clip.lengthTick, list[i].startTick, list[i].lengthTick)) return true;
    }
    return false;
}

/** Put a clip on top of its track's stack. */
function raiseClip(song, clip) {
    const list = trackClips(song, clip.track);
    const idx = list.indexOf(clip);
    if (idx >= 0 && idx < list.length - 1) {
        list.splice(idx, 1);
        list.push(clip);
    }
}

function snapshotSong(song) {
    return {
        synth: { clips: deepClone(song.synth.clips) },
        drums: { clips: deepClone(song.drums.clips) },
        lanes: LANE_TRACKS.map((track) => ({ clips: deepClone(trackClips(song, track)) })),
        transpose: deepClone(song.transpose),
        loop: deepClone(song.loop),
        playheadTick: song.playheadTick,
    };
}

function applySnapshot(song, snap) {
    song.synth.clips = deepClone(snap.synth.clips);
    song.drums.clips = deepClone(snap.drums.clips);
    song.lanes = LANE_TRACKS.map((_, row) => ({ clips: deepClone(snap.lanes?.[row]?.clips || []) }));
    song.transpose = deepClone(snap.transpose);
    song.loop = deepClone(snap.loop);
    song.playheadTick = snap.playheadTick;
}

function pushUndo(song, extra = null) {
    const h = songHistory(song);
    h.undo.push({ snap: snapshotSong(song), extra });
    if (h.undo.length > UNDO_CAP) {
        h.undo.shift();
    }
    h.redo.length = 0;
}

function berlinLanes(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.lanes)) return data.lanes;
    return [];
}

function drumLanes(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.lanes)) return data.lanes;
    return [];
}

function laneCounts(clip) {
    const mask = clip.laneMask;
    const rows = [];
    if (clip.kind === 'b') {
        const lanes = berlinLanes(clip.data);
        const oscCount = clampInt(clip.data?.oscCount, 1, 4, 3);
        const modCount = clampInt(clip.data?.modCount, 1, 4, 1);
        for (let r = 0; r < oscCount; r += 1) rows.push({ lane: lanes[r], row: r });
        for (let m = 0; m < modCount; m += 1) {
            const row = 4 + m;
            rows.push({ lane: lanes[row], row });
        }
    } else if (clip.kind === 'd') {
        const lanes = drumLanes(clip.data);
        for (let i = 0; i < 4; i += 1) rows.push({ lane: lanes[i], row: i });
    }
    return rows.filter(({ lane, row }) => {
        if (lane && lane.enabled === false) return false;
        if (mask != null && mask[row] === false) return false;
        return true;
    });
}

function lanePassTicks(lane) {
    const stepCount = clampInt(lane?.stepCount, 1, 32, 8);
    const div = normalizeDivision(lane?.division);
    return stepCount * divisionTicks(div);
}

function laneStepTicks(lane) {
    return divisionTicks(lane?.division);
}

export function createSong() {
    return {
        synth: { clips: [] },
        drums: { clips: [] },
        lanes: LANE_TRACKS.map(() => ({ clips: [] })),
        transpose: [],
        loop: { on: false, startTick: 0, endTick: 0 },
        playheadTick: 0,
    };
}

export function clipCycleTicks(clip) {
    if (!clip) return BAR_TICKS;
    if (clip.kind === 'n') {
        const stepCount = clampInt(clip.data?.stepCount, 1, 32, 8);
        const div = normalizeDivision(clip.data?.division);
        const repeat = clampInt(clip.data?.repeat, 1, 8, 1);
        return stepCount * divisionTicks(div) * repeat;
    }
    if (clip.kind === 'b') {
        const repeat = clampInt(clip.data?.repeat, 1, 8, 1);
        const rows = laneCounts(clip);
        if (rows.length === 0) return BAR_TICKS * repeat;
        let maxPass = 0;
        for (const { lane } of rows) {
            maxPass = Math.max(maxPass, lanePassTicks(lane));
        }
        return maxPass * repeat;
    }
    if (clip.kind === 'd') {
        const rows = laneCounts(clip);
        if (rows.length === 0) return BAR_TICKS;
        let maxPass = 0;
        for (const { lane } of rows) {
            maxPass = Math.max(maxPass, lanePassTicks(lane));
        }
        return maxPass;
    }
    if (clip.kind === 'notes') {
        let maxEnd = 0;
        for (const n of clip.notes || []) {
            const start = Number(n.startTick) || 0;
            const dur = Number(n.durTick) || 0;
            maxEnd = Math.max(maxEnd, start + dur);
        }
        const len = Number(clip.lengthTick);
        if (Number.isFinite(len)) maxEnd = Math.max(maxEnd, len);
        return Math.max(MIN_NOTE_GRID, maxEnd);
    }
    return BAR_TICKS;
}

export function clipStepTicks(clip) {
    if (!clip) return MIN_NOTE_GRID;
    if (clip.kind === 'n') {
        return divisionTicks(clip.data?.division);
    }
    if (clip.kind === 'b' || clip.kind === 'd') {
        const rows = laneCounts(clip);
        if (rows.length === 0) return MIN_NOTE_GRID;
        let minStep = Infinity;
        for (const { lane } of rows) {
            minStep = Math.min(minStep, laneStepTicks(lane));
        }
        return Number.isFinite(minStep) ? minStep : MIN_NOTE_GRID;
    }
    if (clip.kind === 'notes') return MIN_NOTE_GRID;
    return MIN_NOTE_GRID;
}

/**
 * Ticks trimmed off the front of a clip's pattern. Positive: the clip starts that far
 * into its pattern. Negative: the clip starts with that much silence before the pattern.
 */
export function clipStartOffset(clip) {
    const v = Math.round(Number(clip?.startOffset));
    return Number.isFinite(v) ? v : 0;
}

/** How long one play-through of the clip's content is: its cycle, or a take's last note end. */
export function clipPatternTicks(clip) {
    if (clip?.kind !== 'notes') return clipCycleTicks(clip);
    let end = 0;
    for (const n of clip.notes || []) {
        end = Math.max(end, (Number(n.startTick) || 0) + (Number(n.durTick) || 0));
    }
    return Math.max(MIN_NOTE_GRID, end);
}

/**
 * Where a clip sounds. Clips play their pattern once from `origin` (the clip start
 * minus any start trim); the edges crop it, and space past the pattern is silent.
 * `from`..`to` is the audible part (empty when to <= from).
 */
export function clipPlaySpan(clip) {
    const start = Number(clip?.startTick) || 0;
    const end = start + (Number(clip?.lengthTick) || 0);
    const origin = start - clipStartOffset(clip);
    return {
        origin,
        from: Math.max(start, origin),
        to: Math.min(end, origin + clipPatternTicks(clip)),
    };
}

/** True when the clip's edges no longer match its pattern (start or end trimmed, or space added). */
export function clipIsTrimmed(clip) {
    if (!clip || clip.kind === 'notes') return false;
    return clipStartOffset(clip) !== 0 || (Number(clip.lengthTick) || 0) !== clipCycleTicks(clip);
}

const STEP_SLOTS = 32;
const REPEAT_MAX = 8;

function restStep() {
    return { tune: 0, fine: 0, on: false, accent: false, slide: false, ratch: 1, chord: [] };
}

/**
 * The steps a lane plays over the clip, in time order: one per lane step line inside
 * [offset, offset + length). `loopTicks` is where the lane starts over (null: it only
 * loops on itself); past `totalTicks`, or before the pattern starts, the clip is silent.
 */
function laneStepsOver(lane, offset, length, loopTicks, totalTicks) {
    const step = laneStepTicks(lane);
    const count = clampInt(lane?.stepCount, 1, STEP_SLOTS, 8);
    const first = Math.ceil(offset / step) * step;
    const n = Math.max(1, Math.ceil((offset + length - first) / step));
    const seq = [];
    for (let i = 0; i < n; i += 1) {
        const t = first + i * step;
        if (t < 0 || t >= totalTicks) {
            seq.push(restStep());
            continue;
        }
        const k = Math.floor((loopTicks ? t % loopTicks : t) / step) % count;
        const src = lane?.steps?.[lane?.reverse ? count - 1 - k : k];
        seq.push(src ? deepClone(src) : restStep());
    }
    return seq;
}

/** Lay time-ordered steps into a lane's 32 slots (a reversed lane plays them back to front). */
function laneFromSteps(lane, seq) {
    const n = Math.min(STEP_SLOTS, seq.length);
    const steps = Array.from({ length: STEP_SLOTS }, restStep);
    for (let i = 0; i < n; i += 1) steps[lane?.reverse ? n - 1 - i : i] = seq[i];
    return { ...deepClone(lane), steps, stepCount: n };
}

/** A lane with its steps in the order they play; a reversed lane comes back unreversed. */
function forwardLane(lane) {
    if (!lane) return lane;
    const out = deepClone(lane);
    if (!lane.reverse) return out;
    const count = clampInt(lane.stepCount, 1, STEP_SLOTS, 8);
    for (let i = 0; i < count; i += 1) {
        const src = lane.steps?.[count - 1 - i];
        out.steps[i] = src ? deepClone(src) : restStep();
    }
    out.reverse = false;
    return out;
}

/**
 * Pattern data as a timeline clip holds it: the notes in the order they sound. A
 * reversed pattern (or lane) is flipped and its Reverse turned off, so the clip
 * draws, edits and plays left to right. It sounds the same.
 */
export function playOrderData(kind, data) {
    if (!data) return data;
    if (kind === 'n') return forwardLane(data);
    if (kind === 'b' || kind === 'd') {
        const lanes = (kind === 'b' ? berlinLanes(data) : drumLanes(data)).map(forwardLane);
        return Array.isArray(data) ? lanes : { ...deepClone(data), lanes };
    }
    return data;
}

/** Shortest phrase that repeats to make `seq` (up to 8 times), so long clips still fit 32 steps. */
function foldSteps(seq) {
    const keys = seq.map((step) => JSON.stringify(step));
    for (let period = 1; period <= Math.min(STEP_SLOTS, seq.length); period += 1) {
        const repeat = seq.length / period;
        if (!Number.isInteger(repeat) || repeat > REPEAT_MAX) continue;
        if (keys.every((key, i) => key === keys[i % period])) return { count: period, repeat };
    }
    return { count: Math.min(STEP_SLOTS, seq.length), repeat: 1 };
}

/**
 * The pattern a trimmed clip actually plays: only the steps inside its edges, with rests
 * where the clip runs past (or starts before) its pattern. Automation is not cropped.
 * `truncated` is true when the clip is longer than 32 steps and its tail did not fit.
 * @returns {{ data: object, truncated: boolean } | null}
 */
export function trimmedClipData(clip) {
    if (!clip || clip.kind === 'notes' || !clip.data) return null;
    const offset = clipStartOffset(clip);
    const length = Math.max(0, Number(clip.lengthTick) || 0);
    const total = clipCycleTicks(clip);
    if (clip.kind === 'n') {
        const pass = clampInt(clip.data.stepCount, 1, STEP_SLOTS, 8) * laneStepTicks(clip.data);
        const seq = laneStepsOver(clip.data, offset, length, pass, total);
        const { count, repeat } = foldSteps(seq);
        const data = laneFromSteps(clip.data, seq.slice(0, count));
        data.repeat = repeat;
        return { data, truncated: count * repeat < seq.length };
    }
    let truncated = false;
    const crop = (lane, loopTicks) => {
        if (!lane) return lane;
        const seq = laneStepsOver(lane, offset, length, loopTicks, total);
        if (seq.length > STEP_SLOTS) truncated = true;
        return laneFromSteps(lane, seq);
    };
    if (clip.kind === 'b') {
        // Berlin lanes all start over at the longest lane's loop point.
        const repeat = clampInt(clip.data.repeat, 1, REPEAT_MAX, 1);
        const lanes = berlinLanes(clip.data).map((lane) => crop(lane, total / repeat));
        return { data: { ...deepClone(clip.data), lanes, repeat: 1 }, truncated };
    }
    if (clip.kind === 'd') {
        const lanes = drumLanes(clip.data).map((lane) => crop(lane, null));
        return { data: { ...deepClone(clip.data), lanes }, truncated };
    }
    return null;
}

/**
 * A lane's steps mirrored in time. Slide moves with the join it belongs to: it goes on
 * the step that now leads into the same pair of notes, so a tied note stays one note.
 */
function mirrorLane(lane) {
    if (!lane) return lane;
    const out = forwardLane(lane);
    const count = clampInt(out.stepCount, 1, STEP_SLOTS, 8);
    const src = Array.from({ length: count }, (_, i) => out.steps?.[i] || restStep());
    for (let i = 0; i < count; i += 1) {
        const k = count - 1 - i;
        const before = src[(k - 1 + count) % count];
        out.steps[i] = { ...src[k], slide: src[k].on !== false && !!before.slide };
    }
    return out;
}

function mirrorData(kind, data) {
    if (kind === 'n') return mirrorLane(data);
    const lanes = (kind === 'b' ? berlinLanes(data) : drumLanes(data)).map(mirrorLane);
    return Array.isArray(data) ? lanes : { ...deepClone(data), lanes };
}

/**
 * Play a clip backwards: its notes are mirrored inside its edges, so what was last is
 * first. A trimmed pattern clip takes what it plays as its own pattern first (and loses
 * the trim); one too long for that (over 32 steps) has its whole pattern mirrored instead.
 * Pattern clips are marked edited.
 */
export function reverseClip(song, id) {
    const clip = findClipById(song, id);
    if (!clip) return null;
    if (clip.kind === 'notes') {
        const notes = clip.notes || [];
        if (!notes.length) return null;
        pushUndo(song);
        const edge = 2 * clipStartOffset(clip) + (Number(clip.lengthTick) || 0);
        const order = notes.slice().sort((a, b) => a.startTick - b.startTick);
        // Legato marks the note a held key moved to: mirrored, that is the earlier one.
        const legato = order.map((note) => !!note.legato);
        order.forEach((note, i) => {
            note.startTick = Math.round(edge - (Number(note.startTick) || 0) - (Number(note.durTick) || 0));
            note.legato = !!legato[i + 1];
        });
        notes.sort((a, b) => a.startTick - b.startTick);
        return clip;
    }
    if (!clip.data) return null;
    // An untrimmed single-row clip mirrors as it is; lanes of different lengths, and
    // trimmed clips, are first laid out over the whole clip.
    const cut = clip.kind === 'n' && !clipIsTrimmed(clip) ? null : trimmedClipData(clip);
    const whole = !!cut && !cut.truncated;
    pushUndo(song);
    clip.data = mirrorData(clip.kind, playOrderData(clip.kind, whole ? cut.data : clip.data));
    if (whole) delete clip.startOffset;
    clip.edited = true;
    return clip;
}

function stepPitches(step) {
    const root = Math.round(Number(step?.tune) || 0);
    const chord = Array.isArray(step?.chord) ? step.chord : [];
    return [root, ...chord.map((iv) => root + (Math.round(Number(iv)) || 0))];
}

/** The lanes of a pattern clip that hold pitches: the one row, or Berlin's oscillator lanes. */
function pitchLanes(clip) {
    if (clip.kind === 'n') return [clip.data];
    if (clip.kind !== 'b') return [];
    const oscCount = clampInt(clip.data?.oscCount, 1, 4, 3);
    return berlinLanes(clip.data).slice(0, oscCount).filter(Boolean);
}

/**
 * Turn a clip's melody upside down: every pitch is mirrored about the middle of the
 * clip's range, so its highest note becomes its lowest and the range stays the same.
 * Fine tune flips sign. Chords are mirrored note by note. Drum clips and Berlin mod
 * lanes have no melody and are left alone. Pattern clips are marked edited.
 * Returns null when there is nothing to invert (no notes, or one pitch only).
 */
export function invertClip(song, id) {
    const clip = findClipById(song, id);
    if (!clip) return null;
    let lo = Infinity;
    let hi = -Infinity;
    const span = (pitch) => {
        lo = Math.min(lo, pitch);
        hi = Math.max(hi, pitch);
    };
    const flipFine = (fine) => (Number(fine) ? -Number(fine) : 0);
    if (clip.kind === 'notes') {
        const notes = clip.notes || [];
        // The range is what the clip plays; notes trimmed off still turn with it.
        const from = clipStartOffset(clip);
        const to = from + (Number(clip.lengthTick) || 0);
        const heard = notes.filter((n) => n.startTick < to && n.startTick + (Number(n.durTick) || 0) > from);
        for (const note of heard.length ? heard : notes) span(Math.round(Number(note.semi) || 0));
        if (!(hi > lo)) return null;
        pushUndo(song);
        for (const note of notes) {
            note.semi = lo + hi - Math.round(Number(note.semi) || 0);
            note.fine = flipFine(note.fine);
        }
        return clip;
    }
    if (!clip.data) return null;
    const sounding = (lane) => {
        const count = clampInt(lane.stepCount, 1, STEP_SLOTS, 8);
        return (lane.steps || []).slice(0, count).filter((step) => step && step.on !== false);
    };
    const lanes = pitchLanes(clip);
    for (const lane of lanes) {
        for (const step of sounding(lane)) stepPitches(step).forEach(span);
    }
    if (!(hi > lo)) return null;
    pushUndo(song);
    for (const lane of pitchLanes(clip)) {
        for (const step of sounding(lane)) {
            const turned = stepPitches(step).map((pitch) => lo + hi - pitch).sort((a, b) => a - b);
            step.tune = turned[0];
            step.chord = turned.slice(1).map((pitch) => pitch - turned[0]);
            step.fine = flipFine(step.fine);
        }
    }
    clip.edited = true;
    return clip;
}

// The lowest and highest pitch a step or note can hold: the keyboard's span, which is
// also the piano roll's rows.
const PITCH_MIN = -39;
const PITCH_MAX = 48;

/** An off step still at the default rest is empty; any other step holds notes. */
function holdsNotes(step) {
    if (!step) return false;
    if (step.on !== false) return true;
    return Math.round(Number(step.tune) || 0) !== 0
        || (Array.isArray(step.chord) && step.chord.length > 0)
        || !!step.accent || !!step.slide
        || Math.round(Number(step.ratch) || 1) > 1;
}

/**
 * What a transpose moves, and the range those pitches span. `lane` picks one Berlin lane
 * (default: every oscillator lane); `notes` picks notes of a notes clip (default: all).
 * A step switched off but still holding notes moves with the rest.
 */
function transposeTargets(clip, { lane = null, notes = null } = {}) {
    if (!clip || clip.kind === 'd') return null;
    const out = { notes: [], steps: [], lo: Infinity, hi: -Infinity };
    const span = (pitch) => {
        out.lo = Math.min(out.lo, pitch);
        out.hi = Math.max(out.hi, pitch);
    };
    if (clip.kind === 'notes') {
        const picked = notes ? new Set(notes) : null;
        for (const note of clip.notes || []) {
            if (picked && !picked.has(note)) continue;
            out.notes.push(note);
            span(Math.round(Number(note.semi) || 0));
        }
        return out;
    }
    if (!clip.data) return null;
    const lanes = clip.kind === 'b' && Number.isInteger(lane)
        ? [berlinLanes(clip.data)[lane]].filter(Boolean)
        : pitchLanes(clip);
    for (const one of lanes) {
        const count = clampInt(one.stepCount, 1, STEP_SLOTS, 8);
        for (const step of (one.steps || []).slice(0, count)) {
            if (!holdsNotes(step)) continue;
            out.steps.push(step);
            stepPitches(step).forEach(span);
        }
    }
    return out;
}

/** Semitones a clip can still be transposed down and up before a note leaves the keyboard. */
export function clipTransposeRoom(song, id, options) {
    const targets = transposeTargets(findClipById(song, id), options);
    if (!targets || !(targets.hi >= targets.lo)) return { down: 0, up: 0 };
    return { down: Math.max(0, targets.lo - PITCH_MIN), up: Math.max(0, PITCH_MAX - targets.hi) };
}

/**
 * Move a clip's notes up or down by `semis` semitones. Chords and fine tune move with
 * their note. Nothing moves when any note would leave the keyboard, so a melody never
 * flattens against the top or bottom. Drum clips have no pitch. Pattern clips are marked
 * edited. Options as transposeTargets. Returns null when nothing moved.
 */
export function transposeClip(song, id, semis, options) {
    const clip = findClipById(song, id);
    const by = Math.round(Number(semis) || 0);
    const targets = transposeTargets(clip, options);
    if (!by || !targets || !(targets.hi >= targets.lo)) return null;
    if (by > 0 ? targets.hi + by > PITCH_MAX : targets.lo + by < PITCH_MIN) return null;
    pushUndo(song);
    for (const note of targets.notes) note.semi = Math.round(Number(note.semi) || 0) + by;
    for (const step of targets.steps) step.tune = Math.round(Number(step.tune) || 0) + by;
    if (clip.kind !== 'notes') clip.edited = true;
    return clip;
}

function snapLengthTicks(clip, lengthTick) {
    const grid = clipStepTicks(clip);
    const raw = Math.max(grid, Number(lengthTick) || grid);
    const steps = Math.max(1, Math.floor(raw / grid));
    return steps * grid;
}

// `grid` is the start snap (a bar, or a beat when the view shows beats). A
// neighbouring clip's end wins within half a grid step, so clips butt up even
// when that end is off the grid.
function snapStartTick(song, track, excludeId, pointerStart, grid = BAR_TICKS) {
    const start = Math.max(0, Number(pointerStart) || 0);
    const unit = grid > 0 ? grid : BAR_TICKS;
    const barCandidate = Math.round(start / unit) * unit;
    const reach = unit / 2;
    const clips = visibleClips(song, track);
    let bestEnd = null;
    let bestDist = reach + 1;
    for (const c of clips) {
        if (c.id === excludeId) continue;
        const end = c.startTick + c.lengthTick;
        const dist = Math.abs(start - end);
        if (dist <= reach && dist < bestDist) {
            bestDist = dist;
            bestEnd = end;
        }
    }
    return bestEnd != null ? bestEnd : barCandidate;
}

function wouldOverlap(song, track, excludeId, startTick, lengthTick) {
    const clips = trackClips(song, track);
    for (const c of clips) {
        if (c.id === excludeId) continue;
        if (rangesOverlap(startTick, lengthTick, c.startTick, c.lengthTick)) {
            return true;
        }
    }
    return false;
}

function validatePlaceSpec(spec) {
    if (!spec || typeof spec !== 'object') return false;
    const { track, kind } = spec;
    if (track === 'drums' && kind !== 'd') return false;
    if (track === 'synth' && kind !== 'n' && kind !== 'b' && kind !== 'notes') return false;
    if (laneTrackRow(track) >= 0 && kind !== 'b') return false;
    if (!ALL_TRACKS.includes(track)) return false;
    if (kind !== 'notes' && (spec.source == null || spec.source < 0 || spec.source > 7)) return false;
    return true;
}

function buildClipFromSpec(spec, startTick, lengthTick) {
    const base = {
        id: newId(),
        track: spec.track,
        kind: spec.kind,
        startTick,
        lengthTick,
    };
    const offset = clipStartOffset(spec);
    if (offset) base.startOffset = offset;
    if (spec.kind === 'notes') {
        const clip = { ...base, notes: deepClone(spec.notes || []) };
        // Imported MIDI keeps its file name as the clip label.
        if (typeof spec.name === 'string' && spec.name) clip.name = spec.name;
        return clip;
    }
    // An oscillator row clip plays the one lane its track stands for.
    const row = laneTrackRow(spec.track);
    if (row >= 0) base.row = row;
    if (spec.mute === true) base.mute = true;
    return {
        ...base,
        source: spec.source | 0,
        data: deepClone(spec.data ?? {}),
        automation: deepClone(spec.automation ?? null),
        laneMask: spec.laneMask != null ? deepClone(spec.laneMask) : null,
        edited: spec.edited === true,
        copiedHash: spec.copiedHash ?? null,
        keptHash: spec.keptHash ?? null,
    };
}

export function placeClip(song, spec, grid = BAR_TICKS) {
    if (!validatePlaceSpec(spec)) return false;
    const draft = buildClipFromSpec(
        spec,
        0,
        spec.lengthTick != null ? spec.lengthTick : 0,
    );
    if (spec.lengthTick == null) {
        draft.lengthTick = clipCycleTicks(draft);
    } else {
        draft.lengthTick = snapLengthTicks(draft, spec.lengthTick);
    }
    draft.edited = spec.edited === true;
    if (spec.kind !== 'notes') {
        draft.keptHash = spec.keptHash ?? null;
    }

    // Dropping over clips covers them; they stay underneath (see visibleClips).
    const snappedStart = snapStartTick(song, spec.track, null, spec.startTick, grid);
    pushUndo(song);
    draft.startTick = snappedStart;
    trackClips(song, spec.track).push(draft);
    return draft;
}

/**
 * Drop a Berlin pattern on the timeline: one clip per oscillator it uses (and has
 * switched on), each in its own row, all at the same start, as one undo step.
 * `spec.track` is the row the drop is over; the start snaps against that row.
 * Returns the clips placed, or false.
 */
export function placeBerlinRows(song, spec, grid = BAR_TICKS) {
    const base = { ...spec, kind: 'b' };
    const anchor = laneTrackRow(spec?.track) >= 0 ? spec.track : LANE_TRACKS[0];
    if (!validatePlaceSpec({ ...base, track: anchor })) return false;
    const oscCount = clampInt(spec.data?.oscCount, 1, 4, 3);
    const lanes = berlinLanes(spec.data);
    const rows = [];
    for (let row = 0; row < oscCount; row += 1) {
        if (lanes[row] && lanes[row].enabled === false) continue;
        rows.push(row);
    }
    if (!rows.length) return false;
    const start = snapStartTick(song, anchor, null, spec.startTick, grid);
    pushUndo(song);
    return rows.map((row) => {
        const draft = buildClipFromSpec({ ...base, track: LANE_TRACKS[row] }, start, 0);
        draft.lengthTick = spec.lengthTick != null
            ? snapLengthTicks(draft, spec.lengthTick)
            : clipCycleTicks(draft);
        draft.edited = spec.edited === true;
        draft.keptHash = spec.keptHash ?? null;
        trackClips(song, draft.track).push(draft);
        return draft;
    });
}

/**
 * Songs made before the oscillator rows kept a Berlin pattern as one clip on the synth
 * track. Move each to its rows: one clip per oscillator in use, a lane that was muted in
 * the clip arriving muted. No undo step. Returns true when anything moved.
 */
export function splitBerlinClips(song) {
    const stay = [];
    let moved = false;
    for (const clip of song.synth.clips) {
        if (clip.kind !== 'b') {
            stay.push(clip);
            continue;
        }
        moved = true;
        const oscCount = clampInt(clip.data?.oscCount, 1, 4, 3);
        const lanes = berlinLanes(clip.data);
        for (let row = 0; row < oscCount; row += 1) {
            if (lanes[row] && lanes[row].enabled === false) continue;
            const piece = { ...deepClone(clip), id: newId(), track: LANE_TRACKS[row], row, laneMask: null };
            if (clip.laneMask && clip.laneMask[row] === false) piece.mute = true;
            trackClips(song, piece.track).push(piece);
        }
    }
    if (moved) song.synth.clips = stay;
    return moved;
}

/**
 * Move several clips together by the same amount, each staying on its own track.
 * `leadId` is the one being dragged: it snaps as a single move would and the rest follow.
 * `rowDelta` also moves the oscillator row clips among them that many rows down (or up,
 * when negative), as far as all of them fit. One undo step. Returns true when the clips
 * are where they should be.
 */
export function moveClips(song, ids, leadId, startTick, grid = BAR_TICKS, rowDelta = 0) {
    const lead = findClipById(song, leadId);
    if (!lead) return false;
    const clips = [...new Set(ids)].map((id) => findClipById(song, id)).filter(Boolean);
    if (!clips.includes(lead)) clips.push(lead);
    const shift = rowShiftFor(clips, rowDelta);
    const leadTrack = isRowClip(lead) ? LANE_TRACKS[lead.row + shift] : lead.track;
    let delta = snapStartTick(song, leadTrack, leadId, startTick, grid) - lead.startTick;
    // Nothing may start before the song does.
    const first = clips.reduce((m, c) => Math.min(m, c.startTick), Infinity);
    if (first + delta < 0) delta = -first;
    if (delta === 0 && shift === 0) return true;
    pushUndo(song);
    for (const clip of clips) {
        if (shift && isRowClip(clip)) {
            const list = trackClips(song, clip.track);
            const idx = list.indexOf(clip);
            if (idx >= 0) list.splice(idx, 1);
            setClipRow(clip, clip.row + shift);
            trackClips(song, clip.track).push(clip);
        } else {
            raiseClip(song, clip);
        }
        clip.startTick += delta;
    }
    return true;
}

function isRowClip(clip) {
    return !!clip && clip.kind === 'b' && Number.isInteger(clip.row);
}

// How many rows a group of clips can move up or down together: every oscillator row clip
// has to stay within O1..O4. Other clips do not change track.
function rowShiftFor(clips, rowDelta) {
    let shift = Math.trunc(Number(rowDelta) || 0);
    for (const clip of clips) {
        if (isRowClip(clip)) shift = Math.max(-clip.row, Math.min(LANE_TRACKS.length - 1 - clip.row, shift));
    }
    return shift;
}

/**
 * Put an oscillator row clip on another oscillator: the same notes, played by that one.
 * Inside the clip's own copy of its pattern the part changes lanes with whatever was in
 * the new lane. A lane the pattern was not using stays out of the clip's length, so the
 * clip plays for as long as it did. The caller moves it between the track lists.
 */
function setClipRow(clip, row) {
    const from = clip.row;
    if (from === row) return;
    const lanes = berlinLanes(clip.data);
    const used = clampInt(clip.data?.oscCount, 1, 4, 3);
    const part = lanes[from];
    const other = lanes[row];
    lanes[row] = part ? { ...part, destination: `osc${row + 1}Pitch` } : part;
    lanes[from] = other ? { ...other, destination: `osc${from + 1}Pitch` } : other;
    if (row >= used) {
        if (lanes[from]) lanes[from].enabled = false;
        for (let r = used; r < row; r += 1) {
            if (lanes[r]) lanes[r].enabled = false;
        }
        if (clip.data && !Array.isArray(clip.data)) clip.data.oscCount = row + 1;
    }
    clip.row = row;
    clip.track = LANE_TRACKS[row];
}

/**
 * Copies of several clips, dropped where moveClips would have moved the originals, which
 * stay where they are (a drag with the copy key held). `leadId` is the clip being dragged.
 * One undo step. Returns the copies, in the order of `ids` with the lead's copy first,
 * or an empty list when the drop is where the clips already are.
 */
export function copyClipsTo(song, ids, leadId, startTick, grid = BAR_TICKS, rowDelta = 0) {
    const lead = findClipById(song, leadId);
    if (!lead) return [];
    const rest = [...new Set(ids)].map((id) => findClipById(song, id)).filter((clip) => clip && clip !== lead);
    const clips = [lead, ...rest];
    const shift = rowShiftFor(clips, rowDelta);
    const leadTrack = isRowClip(lead) ? LANE_TRACKS[lead.row + shift] : lead.track;
    // The originals stay, so a copy may butt up against the clip it came from.
    let delta = snapStartTick(song, leadTrack, null, startTick, grid) - lead.startTick;
    const first = clips.reduce((m, c) => Math.min(m, c.startTick), Infinity);
    if (first + delta < 0) delta = -first;
    if (delta === 0 && shift === 0) return [];
    pushUndo(song);
    return clips.map((clip) => {
        const start = clip.startTick + delta;
        const draft = buildClipFromSpec(copySpec(clip, start), start, clip.lengthTick);
        draft.edited = clip.edited === true;
        if (shift && isRowClip(draft)) setClipRow(draft, draft.row + shift);
        trackClips(song, draft.track).push(draft);
        return draft;
    });
}

/** Delete several clips as one undo step. Returns how many went. */
export function deleteClips(song, ids) {
    const clips = [...new Set(ids)].map((id) => findClipById(song, id)).filter(Boolean);
    if (!clips.length) return 0;
    pushUndo(song);
    for (const clip of clips) {
        const list = trackClips(song, clip.track);
        const idx = list.indexOf(clip);
        if (idx >= 0) list.splice(idx, 1);
    }
    return clips.length;
}

/** Mute or unmute several oscillator row clips as one undo step. */
export function setClipsMute(song, ids, mute) {
    const clips = [...new Set(ids)].map((id) => findClipById(song, id))
        .filter((clip) => clip && Number.isInteger(clip.row) && !!clip.mute !== !!mute);
    if (!clips.length) return false;
    pushUndo(song);
    for (const clip of clips) {
        if (mute) clip.mute = true;
        else delete clip.mute;
    }
    return true;
}

/** Mute or unmute one clip (an oscillator row clip). Does not mark the clip edited. */
export function setClipMute(song, id, mute) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    if (!!clip.mute === !!mute) return true;
    pushUndo(song);
    if (mute) clip.mute = true;
    else delete clip.mute;
    return true;
}

export function moveClip(song, id, startTick, grid = BAR_TICKS) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const snapped = snapStartTick(song, clip.track, id, startTick, grid);
    if (snapped === clip.startTick) return true;
    pushUndo(song);
    // A moved clip lands on top, covering (not cutting) what it lands on.
    raiseClip(song, clip);
    clip.startTick = snapped;
    return true;
}

/**
 * What a clip at [start, end) would cover: ids of clips it would hide completely and
 * clips it would hide in part. Nothing is cut; this is for the drag preview.
 */
export function overwritePreview(song, track, excludeId, start, end) {
    const removed = [];
    const cut = [];
    const seen = new Map();
    for (const p of visibleClips(song, track)) {
        if (p.id === excludeId) continue;
        const pEnd = p.startTick + p.lengthTick;
        const hit = !(pEnd <= start || p.startTick >= end);
        const inside = p.startTick >= start && pEnd <= end;
        const was = seen.get(p.id) || { hit: false, all: true };
        seen.set(p.id, { hit: was.hit || hit, all: was.all && inside });
    }
    for (const [id, v] of seen) {
        if (v.all) removed.push(id);
        else if (v.hit) cut.push(id);
    }
    return { removed, cut };
}

/** Right edge. The trimmed clip goes on top, so lengthening covers the next clip. */
export function resizeClip(song, id, lengthTick) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const snappedLen = snapLengthTicks(clip, lengthTick);
    if (snappedLen === clip.lengthTick) return true;
    pushUndo(song);
    raiseClip(song, clip);
    clip.lengthTick = snappedLen;
    return true;
}

/**
 * Move a clip's left edge, keeping its right edge. The pattern stays where it is in
 * time: dragging in cuts the start off, dragging out past the pattern start adds
 * silence before it, and dragging over the previous clip covers it. Snaps to the
 * clip's step grid.
 */
export function trimClipStart(song, id, startTick) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const next = trimmedStart(clip, startTick);
    if (next === clip.startTick) return true;
    pushUndo(song);
    applyTrimStart(song, clip, next);
    return true;
}

// Where a left-edge trim to `startTick` lands: whole steps, at least one step left, never before 0.
function trimmedStart(clip, startTick) {
    const grid = clipStepTicks(clip);
    const start0 = clip.startTick;
    const end = start0 + clip.lengthTick;
    let steps = Math.round(((Number(startTick) || 0) - start0) / grid);
    steps = Math.min(steps, Math.floor((end - start0) / grid) - 1);
    steps = Math.max(steps, -Math.floor(start0 / grid));
    return start0 + steps * grid;
}

function applyTrimStart(song, clip, next) {
    const end = clip.startTick + clip.lengthTick;
    raiseClip(song, clip);
    const offset = clipStartOffset(clip) + (next - clip.startTick);
    if (offset) clip.startOffset = offset;
    else delete clip.startOffset;
    clip.startTick = next;
    clip.lengthTick = end - next;
}

function clipsById(song, ids, lead) {
    const clips = [...new Set(ids)].map((id) => findClipById(song, id)).filter(Boolean);
    if (!clips.includes(lead)) clips.push(lead);
    return clips;
}

/**
 * Drag the right edge of several clips as one. `leadId` is the one being dragged: the
 * others change by the same amount, each snapping to its own steps. One undo step.
 */
export function resizeClips(song, ids, leadId, lengthTick) {
    const lead = findClipById(song, leadId);
    if (!lead) return false;
    const delta = snapLengthTicks(lead, lengthTick) - lead.lengthTick;
    if (delta === 0) return true;
    pushUndo(song);
    for (const clip of clipsById(song, ids, lead)) {
        const next = snapLengthTicks(clip, clip.lengthTick + delta);
        if (next === clip.lengthTick) continue;
        raiseClip(song, clip);
        clip.lengthTick = next;
    }
    return true;
}

/** Drag the left edge of several clips as one (see resizeClips and trimClipStart). */
export function trimClipsStart(song, ids, leadId, startTick) {
    const lead = findClipById(song, leadId);
    if (!lead) return false;
    const delta = trimmedStart(lead, startTick) - lead.startTick;
    if (delta === 0) return true;
    pushUndo(song);
    for (const clip of clipsById(song, ids, lead)) {
        const next = trimmedStart(clip, clip.startTick + delta);
        if (next !== clip.startTick) applyTrimStart(song, clip, next);
    }
    return true;
}

/** Berlin or drum lane mute. Null clears the mask. Does not mark the clip edited. */
export function setLaneMask(song, id, mask) {
    const clip = findClipById(song, id);
    if (!clip || (clip.kind !== 'b' && clip.kind !== 'd')) return null;
    pushUndo(song);
    clip.laneMask = mask == null ? null : deepClone(mask);
    return clip;
}

export function deleteClip(song, id) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    pushUndo(song);
    const list = trackClips(song, clip.track);
    const idx = list.indexOf(clip);
    if (idx >= 0) list.splice(idx, 1);
    return true;
}

function copySpec(clip, start) {
    return {
        track: clip.track,
        kind: clip.kind,
        source: clip.source,
        startTick: start,
        data: clip.kind === 'notes' ? undefined : deepClone(clip.data),
        automation: clip.kind === 'notes' ? undefined : deepClone(clip.automation),
        laneMask: clip.kind === 'notes' ? undefined : deepClone(clip.laneMask),
        copiedHash: clip.copiedHash,
        keptHash: clip.keptHash,
        edited: clip.edited,
        notes: clip.kind === 'notes' ? deepClone(clip.notes) : undefined,
        name: clip.kind === 'notes' ? clip.name : undefined,
        mute: clip.mute === true,
        lengthTick: clip.lengthTick,
        startOffset: clipStartOffset(clip),
    };
}

export function duplicateClip(song, id) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const start = clip.startTick + clip.lengthTick;
    const spec = copySpec(clip, start);
    const snapped = snapStartTick(song, clip.track, null, start);
    const draft = buildClipFromSpec(spec, snapped, clip.lengthTick);
    if (wouldOverlap(song, clip.track, null, snapped, draft.lengthTick)) {
        return false;
    }
    pushUndo(song);
    draft.startTick = snapped;
    trackClips(song, clip.track).push(draft);
    return draft;
}

/** How many whole copies of a clip fit back to back after it before the next clip. */
export function repeatRoom(song, id, max = 64) {
    const clip = findClipById(song, id);
    if (!clip) return 0;
    let n = 0;
    while (n < max && !wouldOverlap(song, clip.track, null, clip.startTick + (n + 1) * clip.lengthTick, clip.lengthTick)) n += 1;
    return n;
}

/**
 * Drop `count` copies of a clip back to back after it (as many as fit), as one undo
 * step. Each copy is its own clip with the same pattern, trims and lane mutes.
 * Returns the new clips.
 */
export function repeatClip(song, id, count) {
    const clip = findClipById(song, id);
    if (!clip) return [];
    const n = Math.min(Math.max(0, count | 0), repeatRoom(song, id));
    if (n === 0) return [];
    pushUndo(song);
    const made = [];
    for (let k = 1; k <= n; k += 1) {
        const start = clip.startTick + k * clip.lengthTick;
        const draft = buildClipFromSpec(copySpec(clip, start), start, clip.lengthTick);
        draft.edited = clip.edited === true;
        trackClips(song, clip.track).push(draft);
        made.push(draft);
    }
    return made;
}

/** The stretch of time several clips cover between them: first start to last end. */
export function clipsSpan(clips) {
    let start = Infinity;
    let end = 0;
    for (const clip of clips) {
        start = Math.min(start, clip.startTick);
        end = Math.max(end, clip.startTick + clip.lengthTick);
    }
    if (!Number.isFinite(start)) return { start: 0, end: 0, length: 0 };
    return { start, end, length: end - start };
}

/**
 * How many copies of a group of clips fit after it. The group repeats as one block: each
 * copy sits one block length (first start to last end) further on, every clip keeping
 * its own track and its place in the block. A copy fits when none of its clips would land
 * on another clip.
 */
export function repeatRoomFor(song, ids, max = 64) {
    const clips = [...new Set(ids)].map((id) => findClipById(song, id)).filter(Boolean);
    const span = clipsSpan(clips).length;
    if (!clips.length || !(span > 0)) return 0;
    let n = 0;
    while (n < max && clips.every((clip) => !wouldOverlap(
        song, clip.track, null, clip.startTick + (n + 1) * span, clip.lengthTick,
    ))) n += 1;
    return n;
}

/**
 * Drop `count` copies of a group of clips after it, block by block (see repeatRoomFor),
 * as one undo step. Returns the copies, one array of new clips per block.
 */
export function repeatClips(song, ids, count) {
    const clips = [...new Set(ids)].map((id) => findClipById(song, id)).filter(Boolean);
    const n = Math.min(Math.max(0, count | 0), repeatRoomFor(song, ids));
    if (n === 0) return [];
    const span = clipsSpan(clips).length;
    pushUndo(song);
    const blocks = [];
    for (let k = 1; k <= n; k += 1) {
        blocks.push(clips.map((clip) => {
            const start = clip.startTick + k * span;
            const draft = buildClipFromSpec(copySpec(clip, start), start, clip.lengthTick);
            draft.edited = clip.edited === true;
            trackClips(song, clip.track).push(draft);
            return draft;
        }));
    }
    return blocks;
}

export function markEdited(song, id) {
    const clip = findClipById(song, id);
    if (!clip || clip.kind === 'notes') return null;
    pushUndo(song);
    clip.edited = true;
    return clip;
}

export function clipShowsUpdate(clip, sourceHash) {
    if (!clip || clip.kind === 'notes') return false;
    if (clip.edited) return false;
    const copied = clip.copiedHash;
    const kept = clip.keptHash;
    if (sourceHash === copied) return false;
    if (sourceHash === kept) return false;
    return true;
}

export function updateFromSource(song, id, data, automation, hash) {
    const clip = findClipById(song, id);
    if (!clip || clip.kind === 'notes') return null;
    pushUndo(song);
    clip.data = deepClone(data);
    clip.automation = deepClone(automation);
    clip.copiedHash = hash;
    clip.keptHash = null;
    clip.edited = false;
    return clip;
}

export function keepClip(song, id, hash) {
    const clip = findClipById(song, id);
    if (!clip || clip.kind === 'notes') return null;
    pushUndo(song);
    clip.keptHash = hash;
    return clip;
}

/** `baked`: the clip's trimmed pattern, now its own pattern, so the trim is dropped. */
export function retargetClip(song, id, slot, hash, extra, baked = null) {
    const clip = findClipById(song, id);
    if (!clip || clip.kind === 'notes') return null;
    const s = slot | 0;
    if (s < 0 || s > 7) return null;
    pushUndo(song, extra ?? null);
    if (baked) {
        clip.data = deepClone(baked);
        delete clip.startOffset;
    }
    clip.source = s;
    clip.edited = false;
    clip.copiedHash = hash;
    clip.keptHash = null;
    return clip;
}

/**
 * Oscillator row clips dropped on a pad, as one undo step that carries the pad's old
 * contents (`extra`, see retargetClip). Each item `{ id, bake }` takes the pad as its
 * source; with `bake` it also takes `data` (the pad's pattern as it now is) as its own,
 * with any start trim folded in. An empty list still records the step, so the pad write
 * can be undone.
 */
export function retargetClips(song, items, slot, hash, extra, data = null) {
    const s = slot | 0;
    if (s < 0 || s > 7) return false;
    pushUndo(song, extra ?? null);
    for (const item of items || []) {
        const clip = findClipById(song, item.id);
        if (!clip || clip.kind === 'notes') continue;
        if (item.bake && data) {
            clip.data = deepClone(data);
            delete clip.startOffset;
        }
        clip.source = s;
        clip.edited = false;
        clip.copiedHash = hash;
        clip.keptHash = null;
    }
    return true;
}

function cueClipForMode(clip, mode) {
    if (!clip) return null;
    if (clip.track === 'drums') {
        return clip.kind === 'd' ? clip : null;
    }
    if (mode === 'n') {
        if (clip.kind === 'n' || clip.kind === 'notes') return clip;
        return null;
    }
    if (mode === 'b') {
        return clip.kind === 'b' && !clip.mute ? clip : null;
    }
    return null;
}

export function buildCues(song, mode) {
    /** @type {{ tick: number, track: string, clip: object|null }[]} */
    const out = [];

    for (const track of ALL_TRACKS) {
        const clips = visibleClips(song, track);
        /** @type {{ tick: number, kind: 'start'|'end'|'lead', clip: object|null }[]} */
        const events = [];

        const first = clips.map((c) => clipPlaySpan(c)).filter((sp) => sp.to > sp.from)
            .reduce((m, sp) => Math.min(m, sp.from), Infinity);
        if (!(first <= 0)) {
            events.push({ tick: 0, kind: 'lead', clip: null });
        }

        for (const clip of clips) {
            const span = clipPlaySpan(clip);
            if (!(span.to > span.from)) continue;
            const cued = cueClipForMode(clip, mode);
            events.push({
                tick: span.from,
                kind: 'start',
                // Players read startTick as where the pattern begins and startTick + lengthTick
                // as where sound stops, so hand them the span rather than the clip edges.
                clip: cued && { ...cued, startTick: span.origin, lengthTick: span.to - span.origin },
            });
            events.push({
                tick: span.to,
                kind: 'end',
                clip: null,
            });
        }

        /** @type {Map<number, typeof events>} */
        const byTick = new Map();
        for (const ev of events) {
            if (!byTick.has(ev.tick)) byTick.set(ev.tick, []);
            byTick.get(ev.tick).push(ev);
        }

        for (const [tick, evs] of byTick) {
            const starts = evs.filter((e) => e.kind === 'start');
            if (starts.length > 0) {
                out.push({ tick, track, clip: starts[starts.length - 1].clip });
            } else {
                out.push({ tick, track, clip: null });
            }
        }
    }

    out.sort((a, b) => {
        if (a.tick !== b.tick) return a.tick - b.tick;
        return ALL_TRACKS.indexOf(a.track) - ALL_TRACKS.indexOf(b.track);
    });

    return out;
}

/** The clip heard at a tick: the top one, cropped as a visible piece. */
export function clipAt(song, track, tick) {
    const t = Number(tick) || 0;
    for (const clip of visibleClips(song, track)) {
        if (t >= clip.startTick && t < clip.startTick + clip.lengthTick) {
            return clip;
        }
    }
    return null;
}

export function wrapTick(song, tick) {
    let t = Number(tick) || 0;
    if (t < 0) t = 0;
    const { loop } = song;
    if (!loop?.on) return t;
    const start = loop.startTick | 0;
    const end = loop.endTick | 0;
    const span = end - start;
    if (span <= 0) return t;
    if (t === end) return start;
    if (t >= start && t < end) return t;
    const wrapped = start + ((t - start) % span + span) % span;
    return wrapped;
}

export function setLoop(song, loop) {
    pushUndo(song);
    song.loop = {
        on: !!loop?.on,
        startTick: loop?.startTick | 0,
        endTick: loop?.endTick | 0,
    };
}

export function setPlayhead(song, tick) {
    song.playheadTick = Math.max(0, Number(tick) || 0);
}

export function setTranspose(song, events) {
    pushUndo(song);
    song.transpose = deepClone(events ?? []);
}

/**
 * One recorded take. A single undo snapshot, then the transpose lane is
 * replaced and each region overwrites overlapping notes clips only.
 * Pattern clips on the synth track are left in place.
 * Does not call placeClip or setTranspose.
 */
export function applyTake(song, { transpose, regions } = {}) {
    if (!song) return false;
    pushUndo(song);
    song.transpose = deepClone(transpose ?? []);
    const list = song.synth.clips;
    for (const region of regions || []) {
        const start = Math.max(0, region.startTick | 0);
        const length = Math.max(0, region.lengthTick | 0);
        if (!(length > 0)) continue;
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const clip = list[i];
            if (!clip || clip.kind !== 'notes') continue;
            if (rangesOverlap(start, length, clip.startTick, clip.lengthTick)) {
                list.splice(i, 1);
            }
        }
        list.push({
            id: newId(),
            track: 'synth',
            kind: 'notes',
            startTick: start,
            lengthTick: length,
            notes: deepClone(region.notes || []),
        });
    }
    return true;
}

/** One arrangement undo plus a bank payload. Does not edit clips. */
export function checkpointUndo(song, extra = null) {
    pushUndo(song, extra ?? null);
}

export function canUndo(song) {
    return songHistory(song).undo.length > 0;
}

export function canRedo(song) {
    return songHistory(song).redo.length > 0;
}

export function undo(song) {
    const h = songHistory(song);
    if (h.undo.length === 0) return { ok: false };
    const entry = h.undo.pop();
    h.redo.push({ snap: snapshotSong(song), extra: null });
    applySnapshot(song, entry.snap);
    return { ok: true, extra: entry.extra ?? null };
}

export function redo(song) {
    const h = songHistory(song);
    if (h.redo.length === 0) return { ok: false };
    const entry = h.redo.pop();
    h.undo.push({ snap: snapshotSong(song), extra: null });
    applySnapshot(song, entry.snap);
    return { ok: true, extra: null };
}
