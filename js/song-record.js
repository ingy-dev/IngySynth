// Arrange recording. Count-in, transpose lane, and notes in empty synth space.
// One take is one applyTake undo. Quantize is not part of this module.

import { state } from './state.js?v=120';
import { getNumber } from './params.js?v=44';
import { setSongRecordGate, togglePlay, uiOutputLatency } from './sequencer.js?v=456';
import { setSongRecordBridge, songTickAt, homeArrangement } from './song-conductor.js?v=29';
import { BAR_TICKS, applyTake } from './song-model.js?v=9';
import { setLiveNoteHooks } from './voice.js?v=191';
import { setPolyLiveHook } from './poly-voice.js?v=200';

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

function tempoNow() {
    const tempoN = getNumber('tempo', 120);
    return Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
}

function heardTick() {
    const ctx = state.audioContext;
    if (!ctx) return null;
    return songTickAt(ctx.currentTime - uiOutputLatency());
}

function patternEdges(song) {
    return (song?.synth?.clips || [])
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

function openNote(semi, cell, forceLegato) {
    if (!recording() || !state.songLiveKeys) return;
    const abs = heardTick();
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
    openNote(semi, cell, false);
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
    };
    // Recording begins on the bar under the playhead; a loop that starts earlier pulls it back.
    let from = Number(state.song?.playheadTick) || 0;
    const loop = state.song?.loop;
    if (loop?.on && (loop.endTick | 0) > (loop.startTick | 0)) from = Math.min(from, loop.startTick | 0);
    take.anchor = barFloor(from);
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
    if (!current || !state.song) return;
    const end = Math.max(0, Number(endTick) || 0);
    for (const open of current.opens) closeOpen(open, end);
    current.opens = [];
    const regions = [];
    for (const bucket of current.buckets.values()) {
        let stop = bucket.end;
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
    if (!transposeChanged && !regions.length) return;
    applyTake(state.song, { transpose: current.events, regions });
    document.dispatchEvent(new CustomEvent('ingysynth:song-changed'));
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
    const t0 = ctx.currentTime + 0.05;
    const gen = ++countGen;
    state.songCountIn = true;
    clickNodes = [];
    for (let i = 0; i < 4; i += 1) clickAt(t0 + i * beat);
    const wait = (t0 + 4 * beat - ctx.currentTime) * 1000;
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
    if (state.songCountIn) {
        cancelArrangeCountIn();
        return true;
    }
    if (!document.body.classList.contains('is-arrange')) return false;
    if (!state.songRecordArmed || state.isPlaying) return false;
    beginCountIn();
    return true;
}

export function arrangeStop() {
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
    state.songRecordArmed = !!state.songRecordArmed;
    state.songCountIn = false;
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
        commit: (endTick) => commitTake(endTick),
    });
}
