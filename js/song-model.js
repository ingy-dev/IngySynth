/**
 * Pure arrangement song model (no DOM, no app imports).
 *
 * Undo `extra` convention: only `undo()` returns `{ ok: true, extra }` where
 * `extra` is the opaque bank payload stored by `retargetClip` or
 * `checkpointUndo`. `checkpointUndo` only pushes that snapshot; it does not
 * edit clips. `redo()` always returns `{ ok: true, extra: null }` — callers
 * that need the bank slot again must keep it from undo.
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

function trackClips(song, track) {
    return track === 'synth' ? song.synth.clips : song.drums.clips;
}

function findClipById(song, id) {
    for (const clip of song.synth.clips) {
        if (clip.id === id) return clip;
    }
    for (const clip of song.drums.clips) {
        if (clip.id === id) return clip;
    }
    return null;
}

function rangesOverlap(aStart, aLen, bStart, bLen) {
    const aEnd = aStart + aLen;
    const bEnd = bStart + bLen;
    return aStart < bEnd && bStart < aEnd;
}

function snapshotSong(song) {
    return {
        synth: { clips: deepClone(song.synth.clips) },
        drums: { clips: deepClone(song.drums.clips) },
        transpose: deepClone(song.transpose),
        loop: deepClone(song.loop),
        playheadTick: song.playheadTick,
    };
}

function applySnapshot(song, snap) {
    song.synth.clips = deepClone(snap.synth.clips);
    song.drums.clips = deepClone(snap.drums.clips);
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
    const clips = trackClips(song, track);
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
        return {
            ...base,
            notes: deepClone(spec.notes || []),
        };
    }
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

    const snappedStart = snapStartTick(song, spec.track, null, spec.startTick, grid);
    if (wouldOverlap(song, spec.track, null, snappedStart, draft.lengthTick)) {
        return false;
    }

    pushUndo(song);
    draft.startTick = snappedStart;
    trackClips(song, spec.track).push(draft);
    return draft;
}

export function moveClip(song, id, startTick, grid = BAR_TICKS) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const snapped = snapStartTick(song, clip.track, id, startTick, grid);
    if (wouldOverlap(song, clip.track, id, snapped, clip.lengthTick)) {
        return false;
    }
    if (snapped === clip.startTick) return true;
    pushUndo(song);
    clip.startTick = snapped;
    return true;
}

/**
 * Make room for [start, end) on a track by cutting into other clips: a clip that
 * starts inside loses its covered start (it keeps its place in time, like a left-edge
 * trim), one that ends inside loses its covered end, and one fully covered is removed.
 * Does not push undo. Returns true when anything changed.
 */
function overwriteRange(song, track, excludeId, start, end) {
    const list = trackClips(song, track);
    let changed = false;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const c = list[i];
        if (c.id === excludeId) continue;
        const cEnd = c.startTick + c.lengthTick;
        if (cEnd <= start || c.startTick >= end) continue;
        changed = true;
        if (c.startTick >= start && cEnd <= end) {
            list.splice(i, 1);
        } else if (c.startTick >= start) {
            const cut = end - c.startTick;
            const offset = clipStartOffset(c) + cut;
            if (offset) c.startOffset = offset;
            else delete c.startOffset;
            c.startTick = end;
            c.lengthTick = cEnd - end;
        } else {
            c.lengthTick = start - c.startTick;
        }
    }
    return changed;
}

/** What an edge drag to [start, end) would cut: ids of clips removed and clips cut. */
export function overwritePreview(song, track, excludeId, start, end) {
    const removed = [];
    const cut = [];
    for (const c of trackClips(song, track)) {
        if (c.id === excludeId) continue;
        const cEnd = c.startTick + c.lengthTick;
        if (cEnd <= start || c.startTick >= end) continue;
        if (c.startTick >= start && cEnd <= end) removed.push(c.id);
        else cut.push(c.id);
    }
    return { removed, cut };
}

/** Right edge. Lengthening over the next clip writes over it (see overwriteRange). */
export function resizeClip(song, id, lengthTick) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const snappedLen = snapLengthTicks(clip, lengthTick);
    if (snappedLen === clip.lengthTick) return true;
    pushUndo(song);
    if (snappedLen > clip.lengthTick) {
        overwriteRange(song, clip.track, id, clip.startTick + clip.lengthTick, clip.startTick + snappedLen);
    }
    clip.lengthTick = snappedLen;
    return true;
}

/**
 * Move a clip's left edge, keeping its right edge. The pattern stays where it is in
 * time: dragging in cuts the start off, dragging out past the pattern start adds
 * silence before it, and dragging over the previous clip writes over it. Snaps to the
 * clip's step grid.
 */
export function trimClipStart(song, id, startTick) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const grid = clipStepTicks(clip);
    const start0 = clip.startTick;
    const end = start0 + clip.lengthTick;
    let steps = Math.round(((Number(startTick) || 0) - start0) / grid);
    steps = Math.min(steps, Math.floor((end - start0) / grid) - 1);
    steps = Math.max(steps, -Math.floor(start0 / grid));
    const next = start0 + steps * grid;
    if (next === start0) return true;
    pushUndo(song);
    // Pulling the left edge back over the previous clip writes over it.
    if (next < start0) overwriteRange(song, clip.track, id, next, start0);
    const offset = clipStartOffset(clip) + (next - start0);
    if (offset) clip.startOffset = offset;
    else delete clip.startOffset;
    clip.startTick = next;
    clip.lengthTick = end - next;
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
        return clip.kind === 'b' ? clip : null;
    }
    return null;
}

export function buildCues(song, mode) {
    /** @type {{ tick: number, track: string, clip: object|null }[]} */
    const out = [];

    for (const track of ['synth', 'drums']) {
        const clips = [...trackClips(song, track)].sort((a, b) => a.startTick - b.startTick);
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
        if (a.track === b.track) return 0;
        return a.track === 'synth' ? -1 : 1;
    });

    return out;
}

export function clipAt(song, track, tick) {
    const t = Number(tick) || 0;
    for (const clip of trackClips(song, track)) {
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
