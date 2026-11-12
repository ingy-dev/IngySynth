// Arrange recording. Count-in, transpose lane, notes in empty synth space, and
// pad hits. One take is one undo. Quantize is not part of this module.
// Record arms and starts: the count-in (Off, 1 or 2 bars) runs, then the take. A pad
// hit or a key while armed and stopped starts at once from the insert marker.
// Pad hits play like an MPC: each one goes into the song just past what the scheduler
// has already scheduled (up to 300 ms ahead on the web), cuts the previous hit on its
// lane, and snaps to the nearest grid step when the take commits.
// Preview plays pads the same way with Record off: the hits are only heard, and Stop
// (or turning Preview off) takes them back out of the song.

import { state } from './state.js?v=120';
import { getNumber } from './params.js?v=44';
import { setSongRecordGate, togglePlay, uiOutputLatency } from './sequencer.js?v=460';
import { setConductorSong, setSongRecordBridge, songTickAt, homeArrangement } from './song-conductor.js?v=35';
import {
    BAR_TICKS,
    applyTake,
    checkpointUndo,
    createSong,
    findClipById,
    removeLiveClips,
    visibleClips,
    wrapTick,
} from './song-model.js?v=15';
import { setLiveNoteHooks } from './voice.js?v=193';
import { setPolyLiveHook } from './poly-voice.js?v=204';

let countGen = 0;
let countTimer = 0;
/** @type {OscillatorNode[]} */
let clickNodes = [];
let bypassGate = false;
let armTake = false;
/** @type {null | {
 *   events: { tick: number, semi: number }[],
 *   baseline: string,
 *   lastSemi: number,
 *   opens: { cell: number|null, absStart: number, bucket: object, note: object }[],
 *   buckets: Map<number, { start: number, end: number|null, notes: object[] }>,
 *   anchor: number,
 * }} */
let take = null;
/** Pad hits placed before the transport starts (a hit from stopped); the take adopts them. */
let preTake = null;
let padOrder = 0;
/** Preview hits: pads playing over the song without recording. Never saved or undone. */
let preview = null;
/** The arrange view's snap grid in ticks; pad hits land on it when the take commits. */
let padGrid = () => BAR_TICKS / 16;
/** Least lead for a live pad hit, past the time it is pressed. */
const PAD_LEAD_SEC = 0.03;
/** Berlin rows schedule this far ahead (sequencer.js BERLIN_LOOKAHEAD) plus a step's slack. */
const BERLIN_AHEAD_SEC = 0.15;

export function setPadGrid(fn) {
    if (typeof fn === 'function') padGrid = fn;
}

function inArrange() {
    return document.body.classList.contains('is-arrange');
}

/** Count-in length in bars: 0 (off), 1 or 2. */
function countInBars() {
    const n = state.songCountInBars;
    return n === 0 || n === 2 ? n : 1;
}

function tempoNow() {
    const tempoN = getNumber('tempo', 120);
    return Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
}

function heardTick() {
    const ctx = state.audioContext;
    if (!ctx) return null;
    return songTickAt(ctx.currentTime - uiOutputLatency());
}

/**
 * The first song tick nothing has been scheduled for yet, on every lane: a clip that
 * starts here plays from its first step. The synth, drum and Berlin schedulers each run
 * ahead of the clock by their own lookahead.
 */
function unscheduledTick() {
    const ctx = state.audioContext;
    if (!ctx) return null;
    let t = ctx.currentTime + PAD_LEAD_SEC;
    if (state.berlinMode) t = Math.max(t, ctx.currentTime + BERLIN_AHEAD_SEC);
    else if (Number.isFinite(state.nextStepTime)) t = Math.max(t, state.nextStepTime);
    for (const head of state.drumPlayheads || []) {
        if (Number.isFinite(head?.nextStepTime)) t = Math.max(t, head.nextStepTime);
    }
    return songTickAt(t);
}

function patternEdges(song) {
    return (song ? visibleClips(song, 'synth') : [])
        .filter((clip) => clip && (clip.kind === 'n' || clip.kind === 'b'))
        .map((clip) => ({
            start: clip.startTick | 0,
            end: (clip.startTick | 0) + (clip.lengthTick | 0),
        }))
        .sort((a, b) => a.start - b.start);
}

/** Empty synth stretch containing tick, or null when a pattern clip covers it. */
function stretchAt(song, tick) {
    const t = Number(tick);
    if (!Number.isFinite(t)) return null;
    let start = 0;
    for (const edge of patternEdges(song)) {
        if (t < edge.start) return { start, end: edge.start };
        if (t < edge.end) return null;
        start = edge.end;
    }
    return { start, end: null };
}

function bucketFor(stretch) {
    if (!take) return null;
    let bucket = take.buckets.get(stretch.start);
    if (!bucket) {
        // A take in empty space starts at the bar recording began, not at the stretch start.
        const start = Math.max(stretch.start, take.anchor);
        if (stretch.end != null && start >= stretch.end) return null;
        bucket = { start, end: stretch.end, notes: [] };
        take.buckets.set(stretch.start, bucket);
    }
    if (stretch.end != null) bucket.end = stretch.end;
    return bucket;
}

function recording() {
    return !!take && !!state.songPlaying && !state.berlinMode;
}

function closeOpen(open, absEnd) {
    let dur = Math.max(1, Math.round(absEnd - open.absStart));
    if (open.bucket.end != null) {
        dur = Math.min(dur, open.bucket.end - open.absStart);
    }
    if (!(dur > 0)) {
        const idx = open.bucket.notes.indexOf(open.note);
        if (idx >= 0) open.bucket.notes.splice(idx, 1);
        return;
    }
    open.note.durTick = dur;
}

function closeOpens(absEnd, cell) {
    if (!take || absEnd == null) return;
    const keep = [];
    for (const open of take.opens) {
        const match = cell == null || open.cell === cell;
        if (!match) {
            keep.push(open);
            continue;
        }
        closeOpen(open, absEnd);
    }
    take.opens = keep;
}

// `atStart`: the key that started the take. The web clock reads just before the start
// for the first moments, so that note is held to it.
function openNote(semi, cell, forceLegato, atStart = false) {
    if (!recording() || !state.songLiveKeys) return;
    let abs = heardTick();
    if (atStart) abs = Math.max(abs ?? take.startTick, take.startTick);
    if (abs == null || !state.song) return;
    const stretch = stretchAt(state.song, abs);
    if (!stretch) return;
    const bucket = bucketFor(stretch);
    if (!bucket || abs < bucket.start) return;
    const legato = !!forceLegato || take.opens.length > 0;
    const note = {
        semi: Math.round(Number(semi) || 0),
        fine: 0,
        startTick: Math.max(0, Math.round(abs - bucket.start)),
        durTick: 1,
        vel: 0.8,
        legato,
    };
    bucket.notes.push(note);
    take.opens.push({
        cell: cell == null ? null : cell,
        absStart: abs,
        bucket,
        note,
    });
}

function onVoiceOn(semi, cell = null) {
    // A key while armed and stopped starts the take at once, from the insert marker.
    const starting = state.songRecordArmed && inArrange() && !state.isPlaying;
    if (starting) startFromHit();
    openNote(semi, cell, false, starting && !!take);
}

function onVoiceOff(cell = null) {
    if (!take) return;
    const abs = heardTick();
    closeOpens(abs == null ? 0 : abs, cell);
}

function onVoiceRetune(semi) {
    if (!recording() || !state.songLiveKeys) return;
    const had = take.opens.length > 0;
    const abs = heardTick();
    if (abs == null) return;
    closeOpens(abs, null);
    openNote(semi, null, had);
}

function barFloor(tick) {
    return Math.floor(Math.max(0, Number(tick) || 0) / BAR_TICKS) * BAR_TICKS;
}

function startTake() {
    const existing = (state.song?.transpose || []).map((event) => ({
        tick: event.tick | 0,
        semi: event.semi | 0,
    }));
    take = {
        events: existing,
        baseline: JSON.stringify(existing),
        lastSemi: state.keyboardTranspose || 0,
        opens: [],
        buckets: new Map(),
        anchor: 0,
        pads: preTake ? preTake.pads : [],
        padUndo: !!preTake?.padUndo,
    };
    preTake = null;
    // Recording begins on the bar under the playhead; a loop that starts earlier pulls it back.
    let from = Number(state.song?.playheadTick) || 0;
    const loop = state.song?.loop;
    if (loop?.on && (loop.endTick | 0) > (loop.startTick | 0)) from = Math.min(from, loop.startTick | 0);
    take.anchor = barFloor(from);
    take.startTick = Math.max(0, Math.round(Number(state.song?.playheadTick) || 0));
    // Show the take from its first moment when it starts in empty space.
    const stretch = state.song && !state.berlinMode ? stretchAt(state.song, take.anchor) : null;
    if (stretch) bucketFor(stretch);
}

/**
 * The take as it grows, for the arrange view to draw live. Absolute ticks.
 * Open notes run to the heard tick. Empty when nothing is recording.
 * @returns {{ startTick: number, endTick: number, notes: { semi: number, startTick: number, durTick: number }[] }[]}
 */
export function liveTakeRegions() {
    if (!recording()) return [];
    const now = heardTick();
    if (now == null) return [];
    const open = new Map(take.opens.map((o) => [o.note, o.absStart]));
    const out = [];
    for (const bucket of take.buckets.values()) {
        let end = now;
        for (const note of bucket.notes) {
            end = Math.max(end, bucket.start + note.startTick + (open.has(note) ? 0 : note.durTick));
        }
        if (bucket.end != null) end = Math.min(end, bucket.end);
        if (!(end > bucket.start)) continue;
        const notes = bucket.notes.map((note) => ({
            semi: note.semi,
            startTick: note.startTick,
            durTick: open.has(note) ? Math.max(1, now - open.get(note)) : note.durTick,
        }));
        out.push({ startTick: bucket.start, endTick: end, notes });
    }
    return out;
}

function commitTake(endTick) {
    const current = take;
    take = null;
    armTake = false;
    preTake = null;
    if (!current || !state.song) return;
    const end = Math.max(0, Number(endTick) || 0);
    const padsChanged = settlePads(current.pads, end);
    // A free keyboard take ends where the first pad clip after it begins.
    const padStarts = [];
    for (const hit of current.pads) {
        if (hit.lane !== 'synth') continue;
        const clip = findClipById(state.song, hit.ids[0]);
        if (clip) padStarts.push(clip.startTick);
    }
    for (const open of current.opens) closeOpen(open, end);
    current.opens = [];
    const regions = [];
    for (const bucket of current.buckets.values()) {
        let stop = bucket.end;
        for (const at of padStarts) {
            if (at > bucket.start && (stop == null || at < stop)) stop = at;
        }
        if (stop == null) {
            let maxAbs = Math.max(bucket.start, end);
            for (const note of bucket.notes) {
                maxAbs = Math.max(maxAbs, bucket.start + note.startTick + note.durTick);
            }
            stop = Math.max(bucket.start + 1, Math.round(maxAbs));
            // Close a free take on a bar line so it loops and lines up cleanly.
            stop = Math.ceil(stop / BAR_TICKS) * BAR_TICKS;
        }
        const length = stop - bucket.start;
        if (!(length > 0)) continue;
        const notes = [];
        for (const note of bucket.notes) {
            const room = length - note.startTick;
            if (!(room > 0) || !(note.durTick > 0)) continue;
            notes.push({
                semi: note.semi | 0,
                fine: 0,
                startTick: note.startTick | 0,
                durTick: Math.min(note.durTick | 0, room),
                vel: 0.8,
                legato: !!note.legato,
            });
        }
        if (!notes.length) continue;
        regions.push({ startTick: bucket.start, lengthTick: length, notes });
    }
    const transposeChanged = JSON.stringify(current.events) !== current.baseline;
    if (transposeChanged || regions.length) {
        applyTake(state.song, { transpose: current.events, regions, undo: !current.padUndo });
    } else if (!padsChanged) {
        return;
    }
    document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
}

/**
 * Pad hits as they land for good: each on the nearest grid step (MPC timing correct; a
 * hit from stopped is already on the insert marker), cut by the next hit on its lane and
 * by Stop. A hit that ends up with no length is dropped. True when any pad clip exists.
 */
function settlePads(pads, endTick) {
    if (!pads.length || !state.song) return false;
    const grid = Math.max(1, Math.round(Number(padGrid()) || 0));
    const lanes = new Map();
    for (const hit of pads) {
        if (!lanes.has(hit.lane)) lanes.set(hit.lane, []);
        lanes.get(hit.lane).push(hit);
    }
    for (const hits of lanes.values()) {
        hits.sort((a, b) => a.order - b.order);
        for (const hit of hits) {
            hit.start = hit.exact ? hit.at : Math.max(0, Math.round(hit.at / grid) * grid);
        }
        hits.forEach((hit, i) => {
            const next = hits[i + 1];
            let stop = hit.start + hit.full;
            // A later hit in the same pass cuts this one; after a loop wrap it does not.
            if (next && next.at > hit.at) stop = Math.min(stop, next.start);
            // Stop cuts on the grid step after it, so the clip keeps what was heard.
            if (endTick >= hit.at) stop = Math.min(stop, Math.max(hit.start, Math.ceil(endTick / grid) * grid));
            const length = stop - hit.start;
            if (!(length > 0)) {
                removeLiveClips(state.song, hit.ids);
                return;
            }
            for (const id of hit.ids) {
                const clip = findClipById(state.song, id);
                if (!clip) continue;
                clip.startTick = hit.start;
                clip.lengthTick = length;
            }
        });
    }
    return true;
}

function ticksPerSecond() {
    return (tempoNow() / 60) * (BAR_TICKS / 4);
}

/**
 * Put one pad hit in the song. `place(tick)` adds its clips (one, or one per Berlin
 * row) with no undo step and returns them. The previous hit on the lane still sounding
 * is cut here, so the engine stops it now.
 */
function addHit(list, meta, at, place, exact) {
    // Two hits before the engine reaches them land on the same tick: the later one wins.
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const prev = list[i];
        if (prev.lane !== meta.lane || prev.at !== at) continue;
        removeLiveClips(state.song, prev.ids);
        list.splice(i, 1);
    }
    const cuts = [];
    for (const prev of list) {
        if (prev.lane !== meta.lane || !(prev.at < at) || !(prev.at + prev.full > at)) continue;
        for (const id of prev.ids) {
            const clip = findClipById(state.song, id);
            if (!clip || clip.startTick + clip.lengthTick <= at) continue;
            cuts.push({ id, length: clip.lengthTick });
            clip.lengthTick = Math.max(1, at - clip.startTick);
        }
    }
    const clips = place(at);
    if (!Array.isArray(clips) || !clips.length) {
        for (const cut of cuts) {
            const clip = findClipById(state.song, cut.id);
            if (clip) clip.lengthTick = cut.length;
        }
        return null;
    }
    const hit = {
        ...meta,
        ids: clips.map((clip) => clip.id),
        at,
        full: Math.max(1, clips[0].lengthTick | 0),
        exact: !!exact,
        cuts,
        order: ++padOrder,
    };
    list.push(hit);
    return hit;
}

/**
 * A pad hit while Record is armed. `meta` is { lane: 'synth' | 'drums', slot, kind }.
 * From stopped (or during the count-in) the clip lands on the insert marker and the
 * transport starts; while the take runs it lands just ahead of the engine.
 * Returns the hit (for arrangePadUndo) or null.
 */
/** Where a live hit goes so it sounds now: just ahead of what the engine has played. */
function liveHitTick() {
    return unscheduledTick();
}

/**
 * Preview with the song stopped: the pad plays its pattern once on its own. The song,
 * the playhead and the timeline are left alone and the transport shows stopped
 * (state.songOneShot). The conductor plays a song of its own for it (one clip at tick 0,
 * no loop) until its end. A new press restarts it or switches to the other pad. Play
 * starts the song instead; Stop, arming Record, turning Preview off or leaving Arrange end it.
 */
let oneShot = null;
let oneShotRaf = 0;

function oneShotLoop() {
    oneShotRaf = 0;
    if (!oneShot) return;
    if (!state.isPlaying || !state.songOneShot) {
        stopPadOneShot();
        return;
    }
    const tick = heardTick();
    if (tick != null && tick >= oneShot.end) {
        stopPadOneShot();
        return;
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pad-oneshot'));
    oneShotRaf = requestAnimationFrame(oneShotLoop);
}

function runTransport() {
    bypassGate = true;
    try {
        togglePlay();
    } finally {
        bypassGate = false;
    }
}

function startPadOneShot(meta, placeInto) {
    if (!state.audioContext) return null;
    const song = createSong();
    const clips = placeInto(song);
    if (!Array.isArray(clips) || !clips.length) return null;
    const end = Math.max(...clips.map((clip) => (clip.startTick | 0) + Math.max(1, clip.lengthTick | 0)));
    // A new press starts over: end the one playing first.
    stopPadOneShot();
    oneShot = { ...meta, end, order: ++padOrder, oneShot: true };
    state.songOneShot = true;
    setConductorSong(song);
    runTransport();
    if (!state.isPlaying) {
        oneShot = null;
        state.songOneShot = false;
        setConductorSong(null);
        return null;
    }
    oneShotRaf = requestAnimationFrame(oneShotLoop);
    document.dispatchEvent(new CustomEvent('ingysynth:pad-oneshot'));
    return oneShot;
}

/** End a pad one-shot now (silences it). */
export function stopPadOneShot() {
    if (!oneShot && !state.songOneShot) return;
    oneShot = null;
    if (oneShotRaf) cancelAnimationFrame(oneShotRaf);
    oneShotRaf = 0;
    if (state.isPlaying && state.songOneShot) runTransport();
    state.songOneShot = false;
    setConductorSong(null);
    document.dispatchEvent(new CustomEvent('ingysynth:pad-oneshot'));
}

/**
 * A pad hit with Preview on and Record off. From stopped the pad plays once on its own
 * (startPadOneShot); while the song plays the hit lands just ahead of the engine. Its
 * clips are marked preview so undo and saving leave them out.
 */
function previewHit(meta, place, placeInto) {
    const mark = (at) => {
        const clips = place(at);
        if (Array.isArray(clips)) for (const clip of clips) clip.preview = true;
        return clips;
    };
    if (!state.isPlaying || state.songOneShot) return placeInto ? startPadOneShot(meta, placeInto) : null;
    if (!preview) preview = { pads: [] };
    if (!state.songPlaying) return null;
    const ahead = liveHitTick();
    if (ahead == null) return null;
    const hit = addHit(preview.pads, meta, Math.round(wrapTick(state.song, ahead)), mark, false);
    if (!hit) return null;
    document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
    return hit;
}

/** Take every preview hit back out of the song. */
function clearPreview() {
    if (!preview) return;
    const ids = preview.pads.flatMap((hit) => hit.ids);
    preview = null;
    if (!state.song || !ids.length) return;
    removeLiveClips(state.song, ids);
    document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
}

/** The Preview button under the pads. Off takes any preview hits back out now. */
export function setArrangePreview(on) {
    state.songPreview = !!on;
    if (!on) {
        stopPadOneShot();
        clearPreview();
    }
}

/**
 * `place(tick)` adds the pad's clips to the song at `tick`; `placeInto(song)` adds them
 * at tick 0 of another song (the Preview one-shot).
 */
export function arrangePadHit(meta, place, placeInto) {
    if (!inArrange() || !state.song) return null;
    if (!state.songRecordArmed) return state.songPreview ? previewHit(meta, place, placeInto) : null;
    if (!state.isPlaying) {
        const at = Math.round(wrapTick(state.song, Math.max(0, Number(state.song.playheadTick) || 0)));
        if (!preTake) {
            checkpointUndo(state.song);
            preTake = { pads: [], padUndo: true };
        }
        const hit = addHit(preTake.pads, meta, at, place, true);
        if (hit) startFromHit();
        if (!state.isPlaying) preTake = null;
        document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
        return hit;
    }
    if (!state.songPlaying || !take) return null;
    const ahead = unscheduledTick();
    if (ahead == null) return null;
    const at = Math.round(wrapTick(state.song, ahead));
    if (!take.padUndo) {
        checkpointUndo(state.song);
        take.padUndo = true;
    }
    const hit = addHit(take.pads, meta, at, place, false);
    if (!hit) return null;
    document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
    return hit;
}

/** Take a hit back out (the press became a drag): its clips go, the clip it cut is whole again. */
export function arrangePadUndo(hit) {
    if (hit?.oneShot) {
        if (hit === oneShot) stopPadOneShot();
        return;
    }
    if (!hit || !state.song) return;
    const list = [take?.pads, preTake?.pads, preview?.pads].find((pads) => pads?.includes(hit)) || null;
    if (!list) return;
    list.splice(list.indexOf(hit), 1);
    removeLiveClips(state.song, hit.ids);
    for (const cut of hit.cuts) {
        const clip = findClipById(state.song, cut.id);
        if (clip) clip.lengthTick = cut.length;
    }
    document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
}

/**
 * The hit sounding on a lane, for the pad's progress sweep: { slot, kind, remaining }
 * with remaining 1 at its start and 0 at its end, or null when nothing plays there.
 */
export function arrangePadProgress(lane) {
    if (oneShot && state.songOneShot) {
        if (oneShot.lane !== lane) return null;
        const tick = Math.max(0, heardTick() ?? 0);
        if (tick >= oneShot.end) return null;
        return { slot: oneShot.slot, kind: oneShot.kind, remaining: Math.max(0, Math.min(1, 1 - tick / oneShot.end)) };
    }
    const pads = state.songRecordArmed ? take?.pads : state.songPreview ? preview?.pads : null;
    if (!pads || !state.songPlaying) return null;
    const now = heardTick();
    if (now == null) return null;
    let hit = null;
    for (const h of pads) {
        if (h.lane === lane && (!hit || h.order > hit.order)) hit = h;
    }
    if (!hit) return null;
    const clip = findClipById(state.song, hit.ids[0]);
    const end = clip ? clip.startTick + clip.lengthTick : hit.at + hit.full;
    if (now < hit.at) {
        // Just pressed, not yet reached by the scheduler lead: show it full.
        return hit.at - now < 0.6 * ticksPerSecond()
            ? { slot: hit.slot, kind: hit.kind, remaining: 1 }
            : null;
    }
    if (now >= end) return null;
    const remaining = Math.max(0, Math.min(1, (hit.at + hit.full - now) / hit.full));
    return { slot: hit.slot, kind: hit.kind, remaining };
}

/** Start the transport (and the take, when `record`) now, skipping any count-in still running. */
function startFromHit(record = true) {
    if (state.songCountIn || countTimer) {
        countGen += 1;
        if (countTimer) clearTimeout(countTimer);
        countTimer = 0;
        state.songCountIn = false;
        stopClicks();
    }
    if (state.isPlaying) return;
    armTake = record;
    bypassGate = true;
    try {
        togglePlay();
    } finally {
        bypassGate = false;
    }
    document.dispatchEvent(new CustomEvent('ingysynth:arrange-transport'));
}

/**
 * The Record button. Arming from stopped runs the count-in (or starts at once when it
 * is off); arming while the song plays starts a take now. Disarming cancels the
 * count-in, or commits the take and keeps playing.
 */
export function setArrangeRecordArmed(on) {
    state.songRecordArmed = !!on;
    if (on) stopPadOneShot();
    // Preview hits are not part of a take: clear them before the take's undo checkpoint.
    if (on) clearPreview();
    if (!inArrange()) return;
    if (on) {
        if (state.isPlaying && state.songPlaying) {
            if (!take) startTake();
        } else if (!state.isPlaying && !state.songCountIn) {
            if (countInBars() > 0) beginCountIn();
            else startFromHit();
        }
    } else {
        if (state.songCountIn) cancelArrangeCountIn();
        if (take && state.songPlaying) {
            const end = heardTick();
            commitTake(end == null ? Number(state.song?.playheadTick) || 0 : end);
        }
    }
    document.dispatchEvent(new CustomEvent('ingysynth:arrange-transport'));
}

function observeTranspose(tick) {
    if (!take) return;
    const semi = state.keyboardTranspose || 0;
    if (semi === take.lastSemi) return;
    const at = Math.max(0, Math.round(Number(tick) || 0));
    take.events = take.events.filter((event) => (event.tick | 0) < at);
    take.events.push({ tick: at, semi });
    take.lastSemi = semi;
}

function clickAt(when) {
    const ctx = state.audioContext;
    if (!ctx || !state.masterGain) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1760, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.18, when + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.045);
    osc.connect(gain);
    gain.connect(state.masterGain);
    osc.start(when);
    osc.stop(when + 0.06);
    clickNodes.push(osc);
}

function stopClicks() {
    const now = state.audioContext?.currentTime ?? 0;
    for (const osc of clickNodes) {
        try { osc.stop(now); } catch (_) { /* already stopped */ }
    }
    clickNodes = [];
}

export function cancelArrangeCountIn() {
    if (!state.songCountIn && !countTimer) return;
    countGen += 1;
    if (countTimer) clearTimeout(countTimer);
    countTimer = 0;
    state.songCountIn = false;
    armTake = false;
    stopClicks();
    document.dispatchEvent(new CustomEvent('ingysynth:arrange-transport'));
}

function beginCountIn() {
    const ctx = state.audioContext;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const beat = 60 / tempoNow();
    const beats = countInBars() * 4;
    const t0 = ctx.currentTime + 0.05;
    const gen = ++countGen;
    state.songCountIn = true;
    clickNodes = [];
    for (let i = 0; i < beats; i += 1) clickAt(t0 + i * beat);
    const wait = (t0 + beats * beat - ctx.currentTime) * 1000;
    countTimer = setTimeout(() => {
        if (gen !== countGen) return;
        countTimer = 0;
        state.songCountIn = false;
        if (state.isPlaying) return;
        if (!document.body.classList.contains('is-arrange')) return;
        armTake = !!state.songRecordArmed;
        bypassGate = true;
        try {
            togglePlay();
        } finally {
            bypassGate = false;
        }
        document.dispatchEvent(new CustomEvent('ingysynth:arrange-transport'));
    }, Math.max(0, wait));
    document.dispatchEvent(new CustomEvent('ingysynth:arrange-transport'));
}

function recordGate() {
    if (bypassGate) return false;
    // Play (or Space) during a pad one-shot: it ends, and the song starts as usual.
    if (state.songOneShot) stopPadOneShot();
    if (state.songCountIn) {
        cancelArrangeCountIn();
        return true;
    }
    if (!inArrange()) return false;
    if (!state.songRecordArmed || state.isPlaying) return false;
    if (countInBars() === 0) {
        armTake = true;
        return false;
    }
    beginCountIn();
    return true;
}

export function arrangeStop() {
    if (state.songOneShot) {
        stopPadOneShot();
        return;
    }
    const wasRunning = !!state.isPlaying || !!state.songCountIn;
    cancelArrangeCountIn();
    if (state.isPlaying) {
        togglePlay();
        return;
    }
    if (!wasRunning) homeArrangement();
}

export function initSongRecord() {
    state.songLiveKeys = false;
    state.songCountInBars = countInBars();
    state.songRecordArmed = !!state.songRecordArmed;
    state.songCountIn = false;
    state.songPreview = false;
    setSongRecordGate(recordGate);
    setLiveNoteHooks({
        on: onVoiceOn,
        off: () => onVoiceOff(null),
        retune: onVoiceRetune,
    });
    setPolyLiveHook({
        on: (semi, cell) => onVoiceOn(semi, cell),
        off: (cell) => onVoiceOff(cell),
    });
    setSongRecordBridge({
        recording: () => !!take,
        observe: observeTranspose,
        onBegin: () => {
            if (!armTake || !state.songRecordArmed) {
                armTake = false;
                return;
            }
            armTake = false;
            startTake();
        },
        commit: (endTick) => {
            commitTake(endTick);
            clearPreview();
        },
    });
}
