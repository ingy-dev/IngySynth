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
const HALF_BAR = 1920;
const MIN_NOTE_GRID = 240;

const DIVISIONS = new Set([2, 4, 8, 16]);
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
    const d = clampInt(division, 2, 16, 8);
    return DIVISIONS.has(d) ? BAR_TICKS / d : BAR_TICKS / 8;
}

function normalizeDivision(division) {
    const d = clampInt(division, 2, 16, 8);
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

function snapLengthTicks(clip, lengthTick) {
    const grid = clipStepTicks(clip);
    const raw = Math.max(grid, Number(lengthTick) || grid);
    const steps = Math.max(1, Math.floor(raw / grid));
    return steps * grid;
}

function snapStartTick(song, track, excludeId, pointerStart) {
    const start = Math.max(0, Number(pointerStart) || 0);
    const barCandidate = Math.round(start / BAR_TICKS) * BAR_TICKS;
    const clips = trackClips(song, track);
    let bestEnd = null;
    let bestDist = HALF_BAR + 1;
    for (const c of clips) {
        if (c.id === excludeId) continue;
        const end = c.startTick + c.lengthTick;
        const dist = Math.abs(start - end);
        if (dist <= HALF_BAR && dist < bestDist) {
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

export function placeClip(song, spec) {
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

    const snappedStart = snapStartTick(song, spec.track, null, spec.startTick);
    if (wouldOverlap(song, spec.track, null, snappedStart, draft.lengthTick)) {
        return false;
    }

    pushUndo(song);
    draft.startTick = snappedStart;
    trackClips(song, spec.track).push(draft);
    return draft;
}

export function moveClip(song, id, startTick) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const snapped = snapStartTick(song, clip.track, id, startTick);
    if (wouldOverlap(song, clip.track, id, snapped, clip.lengthTick)) {
        return false;
    }
    if (snapped === clip.startTick) return true;
    pushUndo(song);
    clip.startTick = snapped;
    return true;
}

export function resizeClip(song, id, lengthTick) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const snappedLen = snapLengthTicks(clip, lengthTick);
    if (wouldOverlap(song, clip.track, id, clip.startTick, snappedLen)) {
        return false;
    }
    if (snappedLen === clip.lengthTick) return true;
    pushUndo(song);
    clip.lengthTick = snappedLen;
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

export function duplicateClip(song, id) {
    const clip = findClipById(song, id);
    if (!clip) return false;
    const start = clip.startTick + clip.lengthTick;
    const spec = {
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
    };
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

export function retargetClip(song, id, slot, hash, extra) {
    const clip = findClipById(song, id);
    if (!clip || clip.kind === 'notes') return null;
    const s = slot | 0;
    if (s < 0 || s > 7) return null;
    pushUndo(song, extra ?? null);
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

        if (clips.length === 0 || clips[0].startTick > 0) {
            events.push({ tick: 0, kind: 'lead', clip: null });
        }

        for (const clip of clips) {
            events.push({
                tick: clip.startTick,
                kind: 'start',
                clip: cueClipForMode(clip, mode),
            });
            events.push({
                tick: clip.startTick + clip.lengthTick,
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
