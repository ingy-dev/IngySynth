// Arrangement playback. Registers with the sequencer through setSongConductor
// so sequencer.js does not import this file.
// Song mode is body.is-arrange and play started here (state.songPlaying).
// When songPlaying is false the sequencer never calls these methods.
// The insert marker is where Play starts. Stop returns there. Stop while
// already stopped returns the marker to bar 1. Shift+Play continues from
// the position where playback last stopped.

import { state } from './state.js?v=120';
import { getNumber } from './params.js?v=44';
import { setSongConductor, uiOutputLatency } from './sequencer.js?v=455';
import { semitonesToNoteName } from './tuning.js?v=108';
import { scheduleMonoNote } from './voice.js?v=191';
import { schedulePolySeqVoicing } from './poly-voice.js?v=200';
import { applyBankAutomation, notifyAutomationLoopAnchor, useAutomationBank } from './automation.js?v=101';
import {
    DRUM_LANE_COUNT,
    PATTERN_COUNT,
    SONG_SLOT,
    clearDrumBank,
    getBerlinLane,
    getDrumPattern,
    loadSongSlot,
    selectBerlinSlot,
    selectSlot,
    setDrumSlot,
} from './pattern-bank.js?v=50';
import {
    BAR_TICKS,
    PPQ,
    buildCues,
    clipAt,
    setPlayhead,
    wrapTick,
} from './song-model.js?v=4';

const SIXTEENTH = 240;
const DIVS = new Set([2, 4, 8, 16]);

/** @type {{ tick: number, audioTime: number, tps: number, loop?: boolean }[]} */
let anchors = [];
/** @type {null | { editSlot: number, berlinSlot: number, drumSlot: number, bankKey: string }} */
let saved = null;
/** Clip id currently loaded in the normal scratch, or 'silence'. */
let activeSynthId = null;
/** Clip id currently loaded in the drum scratch, or 'silence'. */
let activeDrumKey = null;
/** Clip id currently loaded in the Berlin scratch, or 'silence'. */
let activeBerlinKey = null;
let berlinSilent = false;
let rearmSynth = false;
let lastDrumArrived = null;
let raf = 0;
let savedTranspose = 0;
let hasSavedTranspose = false;
/** Note identities already handed to the voice scheduler this pass. */
const scheduledNotes = new Set();
/** Tick Stop returns to while transport is running. */
let returnTick = 0;
/** Tick Shift+Play resumes. Null until the first stop. */
let continueTick = null;
let pendingContinue = false;
let hasReturn = false;

const recordBridge = {
    recording: () => false,
    observe: () => {},
    onBegin: () => {},
    commit: () => {},
};

export function setSongRecordBridge(bridge) {
    if (!bridge) return;
    if (typeof bridge.recording === 'function') recordBridge.recording = bridge.recording;
    if (typeof bridge.observe === 'function') recordBridge.observe = bridge.observe;
    if (typeof bridge.onBegin === 'function') recordBridge.onBegin = bridge.onBegin;
    if (typeof bridge.commit === 'function') recordBridge.commit = bridge.commit;
}

/** Song tick for an audio time, or null when the arrangement clock is stopped. */
export function songTickAt(audioTime) {
    if (!state.songPlaying || !anchors.length) return null;
    const t = Number(audioTime);
    if (!Number.isFinite(t)) return null;
    return tickAt(t);
}

function clampInt(n, min, max, fallback) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

function normDiv(division) {
    const d = Math.round(Number(division));
    return DIVS.has(d) ? d : 8;
}

function clampSlot(n) {
    const s = n | 0;
    return s >= 0 && s <= 7 ? s : 0;
}

function ticksPerSecondNow() {
    const tempoN = getNumber('tempo', 120);
    const tempo = Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
    return (tempo / 60) * PPQ;
}

function sixteenthSec() {
    const tps = ticksPerSecondNow();
    return tps > 0 ? SIXTEENTH / tps : 0.125;
}

function tickAt(audioTime) {
    if (!anchors.length) return 0;
    let a = anchors[0];
    for (const item of anchors) {
        if (item.audioTime <= audioTime + 1e-9) a = item;
        else break;
    }
    return a.tick + (audioTime - a.audioTime) * a.tps;
}

function audioTimeForTick(tick) {
    const a = anchors[anchors.length - 1];
    if (!a || !(a.tps > 0)) return 0;
    return a.audioTime + (tick - a.tick) / a.tps;
}

function syncTempo(audioTime) {
    const tps = ticksPerSecondNow();
    const last = anchors[anchors.length - 1];
    if (!last || Math.abs(last.tps - tps) < 1e-9) return;
    const tick = last.tick + (audioTime - last.audioTime) * last.tps;
    anchors.push({ tick, audioTime, tps });
}

function pruneAnchors() {
    const now = state.audioContext?.currentTime ?? 0;
    while (anchors.length > 2 && anchors[1].audioTime < now - 1) anchors.shift();
}

function loopEndTick() {
    const loop = state.song?.loop;
    if (!loop?.on) return null;
    const start = loop.startTick | 0;
    const end = loop.endTick | 0;
    if (!(end > start)) return null;
    return end;
}

function pushLoopAnchor(atEnd) {
    const start = state.song?.loop?.startTick | 0;
    const last = anchors[anchors.length - 1];
    if (!last) return false;
    if (last.loop && Math.abs(last.audioTime - atEnd) < 1e-5 && last.tick === start) return false;
    anchors.push({ tick: start, audioTime: atEnd, tps: last.tps, loop: true });
    scheduledNotes.clear();
    pruneAnchors();
    return true;
}

function paintTransposeReadout() {
    const t = state.keyboardTranspose || 0;
    const name = semitonesToNoteName(t).replace(/\d+$/, '');
    const num = t > 0 ? `+${t}` : `${t}`;
    const label = `T: ${num} (${name})`;
    for (const id of ['keyboardTransposeReadout', 'kbXyTransposeReadout']) {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    }
    const kb = document.querySelectorAll('#chromaticKeyboard .piano-key');
    kb.forEach((key) => key.classList.toggle('key-transpose', parseInt(key.dataset.semitone, 10) === t));
}

function updateLiveKeys(tick) {
    if (!state.songPlaying || state.berlinMode || !state.song) {
        state.songLiveKeys = false;
        return;
    }
    const clip = clipAt(state.song, 'synth', tick);
    state.songLiveKeys = !clip || clip.kind === 'notes';
}

function laneSemi(tick) {
    const events = state.song?.transpose;
    if (!Array.isArray(events) || !events.length) return null;
    let semi = null;
    for (const event of events) {
        if ((event.tick | 0) <= tick + 0.5) semi = event.semi | 0;
    }
    return semi;
}

function applyLane(tick) {
    const semi = laneSemi(tick);
    if (semi == null) return;
    if ((state.keyboardTranspose || 0) === semi) return;
    state.keyboardTranspose = semi;
    paintTransposeReadout();
}

function preparePitch(audioTime) {
    if (!anchors.length || !state.songPlaying) return;
    syncTempo(audioTime);
    const tick = tickAt(audioTime);
    if (recordBridge.recording()) recordBridge.observe(tick);
    else applyLane(tick);
}

function gateSec(tps, ticks) {
    return Math.max(0.03, tps > 0 ? ticks / tps : 0.05);
}

function scheduleNotesWindow(clip, audioTime) {
    if (!clip || clip.kind !== 'notes' || !anchors.length) return;
    const horizon = audioTime + 0.35;
    const groups = new Map();
    (clip.notes || []).forEach((note, index) => {
        const key = String(Math.round(Number(note.startTick) || 0));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ note, index });
    });
    const poly = !!(state.keyboardPoly || state.keyboardMultitudes);
    const tps = ticksPerSecondNow();
    const origin = clip.startTick | 0;
    const relNow = tickAt(audioTime) - origin;
    const ordered = [...groups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [key, group] of ordered) {
        const id = `${clip.id}:${key}`;
        if (scheduledNotes.has(id)) continue;
        const rel = Number(group[0].note.startTick) || 0;
        const abs = origin + rel;
        const atAbs = audioTimeForTick(abs);
        const upcoming = atAbs >= audioTime - 0.03 && atAbs <= horizon;
        const remainingOf = (note) => (Number(note.durTick) || 240) - (relNow - rel);
        const chased = !upcoming && group.some((item) => remainingOf(item.note) > 1 && rel <= relNow + 0.5);
        if (!upcoming && !chased) continue;
        scheduledNotes.add(id);
        const at = chased ? audioTime : atAbs;
        const durTicks = (note) => {
            const ticks = Number(note.durTick) || 240;
            return chased ? Math.max(1, remainingOf(note)) : ticks;
        };
        if (poly && group.length > 1) {
            const semis = group.map((item) => Number(item.note.semi) || 0);
            const root = Math.min(...semis);
            const dur = Math.max(...group.map((item) => gateSec(tps, durTicks(item.note))));
            schedulePolySeqVoicing({
                startTime: at,
                gateSec: dur,
                soundingRoot: root,
                intervals: semis.map((semi) => semi - root),
                cellRoot: Math.round(root),
                accentScale: Number(group[0].note.vel) || 0.8,
                engineGen: state.seqEngineGeneration,
            });
        } else {
            for (const item of group) {
                scheduleMonoNote({
                    semi: Number(item.note.semi) || 0,
                    fine: Number(item.note.fine) || 0,
                    at,
                    dur: gateSec(tps, durTicks(item.note)),
                    vel: Number(item.note.vel) || 0.8,
                    legato: !!item.note.legato,
                });
            }
        }
        document.dispatchEvent(new CustomEvent('ingysynth:song-note', {
            detail: { at, poly: poly && group.length > 1, n: group.length },
        }));
    }
}

function isLoopAnchorTime(audioTime) {
    for (let i = anchors.length - 1; i >= 0; i--) {
        const a = anchors[i];
        if (!a.loop) continue;
        if (Math.abs(a.audioTime - audioTime) < 1e-4) return true;
        if (a.audioTime < audioTime - 1e-3) break;
    }
    return false;
}

function mode() {
    return state.berlinMode ? 'b' : 'n';
}

function trackCues(track) {
    if (!state.song) return [];
    return buildCues(state.song, mode()).filter((cue) => cue.track === track);
}

function cueAtTick(track, tick) {
    const list = trackCues(track);
    let current = null;
    for (const cue of list) {
        if (cue.tick <= tick + 0.5) current = cue;
        else break;
    }
    return current;
}

function nextBoundaryTick(track, tick) {
    let cap = null;
    for (const cue of trackCues(track)) {
        if (cue.tick > tick + 0.5) {
            cap = cue.tick;
            break;
        }
    }
    const end = loopEndTick();
    if (end != null && tick < end - 0.5) {
        cap = cap == null ? end : Math.min(cap, end);
    }
    return cap;
}

function nextCueCap(track, audioTime) {
    if (!anchors.length) return Infinity;
    syncTempo(audioTime);
    const next = nextBoundaryTick(track, tickAt(audioTime));
    if (next == null) return Infinity;
    const at = audioTimeForTick(next);
    if (!(at > audioTime + 1e-4)) return Infinity;
    return at;
}

function applySongAutomation(snap) {
    const empty = !snap || typeof snap !== 'object';
    applyBankAutomation('s', empty ? { lanes: {}, offsets: {} } : snap);
    useAutomationBank('s');
}

function normalPosition(clip, tick) {
    const data = clip.data || {};
    const stepCount = clampInt(data.stepCount, 1, 32, 8);
    const stepTicks = BAR_TICKS / normDiv(data.division);
    const repeat = clampInt(data.repeat, 1, 8, 1);
    const reverse = !!data.reverse;
    const passTicks = stepCount * stepTicks;
    const cycleTicks = passTicks * repeat;
    let into = Math.max(0, tick - (clip.startTick | 0));
    if (cycleTicks > 0) into %= cycleTicks;
    const pass = Math.min(repeat - 1, Math.floor(into / Math.max(1, passTicks)));
    const intoPass = into - pass * passTicks;
    let forward = Math.floor(intoPass / stepTicks);
    if (forward >= stepCount) forward = stepCount - 1;
    if (forward < 0) forward = 0;
    const stepIndex = reverse ? (stepCount - 1 - forward) : forward;
    const isLoopStart = reverse ? stepIndex === stepCount - 1 : stepIndex === 0;
    if (isLoopStart && pass === 0) {
        return { stepIndex, cyclePass: 0, cycleFirstPass: true };
    }
    if (isLoopStart) {
        return { stepIndex, cyclePass: pass - 1, cycleFirstPass: false };
    }
    return { stepIndex, cyclePass: pass, cycleFirstPass: false };
}

function nextStepCap(audioTime) {
    const tick = tickAt(audioTime);
    const cue = cueAtTick('synth', tick);
    const clip = cue?.clip;
    if (!clip || clip.kind !== 'n') return Infinity;
    const end = (clip.startTick | 0) + (clip.lengthTick | 0);
    const stepTicks = BAR_TICKS / normDiv(clip.data?.division);
    const into = tick - (clip.startTick | 0);
    const idx = Math.floor(into / stepTicks + 1e-6);
    const nextTick = (clip.startTick | 0) + (idx + 1) * stepTicks;
    if (!(nextTick + 0.5 < end)) return Infinity;
    const at = audioTimeForTick(nextTick);
    if (!(at > audioTime + 1e-4)) return Infinity;
    return at;
}

function rememberPerform() {
    const editSlot = clampSlot(state.editSlot);
    const berlinSlot = clampSlot(state.berlinSlot);
    const drumSlot = clampSlot(state.drumSlot);
    saved = {
        editSlot,
        berlinSlot,
        drumSlot,
        bankKey: state.berlinMode ? `b${berlinSlot}` : `n${editSlot}`,
    };
}

function restorePerformSlots() {
    if (!saved) return;
    if (state.berlinMode) {
        selectBerlinSlot(saved.berlinSlot, { followDrums: false });
    } else {
        selectSlot(saved.editSlot, { flush: true, followDrums: false });
    }
    setDrumSlot(saved.drumSlot);
}

function publishPlayhead() {
    if (!state.song) return;
    document.dispatchEvent(new CustomEvent('ingysynth:song-tick', {
        detail: { tick: state.song.playheadTick },
    }));
}

function finishSong() {
    stopRaf();
    let endTick = 0;
    if (anchors.length && state.audioContext) {
        endTick = Math.max(0, tickAt(state.audioContext.currentTime - uiOutputLatency()));
    }
    recordBridge.commit(endTick);
    if (hasReturn) continueTick = endTick;
    state.songLiveKeys = false;
    if (hasSavedTranspose) {
        state.keyboardTranspose = savedTranspose;
        hasSavedTranspose = false;
        paintTransposeReadout();
    }
    scheduledNotes.clear();
    if (saved) {
        useAutomationBank(saved.bankKey);
        saved = null;
    }
    activeSynthId = null;
    activeDrumKey = null;
    activeBerlinKey = null;
    berlinSilent = false;
    rearmSynth = false;
    lastDrumArrived = null;
    anchors = [];
    state.songSynthSilent = false;
    state.songDrumSilent = false;
    if (hasReturn && state.song) {
        setPlayhead(state.song, Math.max(0, returnTick || 0));
        publishPlayhead();
    }
}

function muteBerlinScratch() {
    for (let i = 0; i < PATTERN_COUNT; i++) {
        getBerlinLane(i, SONG_SLOT).enabled = false;
    }
}

function applyBerlinMask(mask) {
    if (!mask) return;
    for (let i = 0; i < PATTERN_COUNT; i++) {
        if (mask[i] === false) getBerlinLane(i, SONG_SLOT).enabled = false;
    }
}

function applyDrumMask(mask) {
    if (!mask) return;
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        if (mask[i] === false) {
            const lane = getDrumPattern(i);
            if (lane) lane.enabled = false;
        }
    }
}

function positionBerlin(clip, tick) {
    const lanes = Array.isArray(clip.data?.lanes) ? clip.data.lanes : [];
    const mask = clip.laneMask;
    const oscCount = clampInt(clip.data?.oscCount, 1, 4, 3);
    const modCount = clampInt(clip.data?.modCount, 1, 4, 1);
    const rows = [];
    for (let r = 0; r < oscCount; r++) rows.push(r);
    for (let m = 0; m < modCount; m++) rows.push(4 + m);
    let master = 0;
    for (const i of rows) {
        const lane = lanes[i];
        if (!lane) continue;
        const n = clampInt(lane.stepCount, 1, 32, 8);
        master = Math.max(master, n * (BAR_TICKS / normDiv(lane.division)));
    }
    if (!(master > 0)) master = BAR_TICKS;
    const repeat = clampInt(clip.data?.repeat, 1, 8, 1);
    const into = Math.max(0, tick - (clip.startTick | 0));
    const cycle = master * repeat;
    const intoCycle = cycle > 0 ? into % cycle : 0;
    const pass = Math.min(repeat - 1, Math.floor(intoCycle / master));
    const intoMaster = intoCycle - pass * master;
    state.berlinCyclePass = pass;
    state.berlinCycleFirstPass = false;
    for (let i = 0; i < PATTERN_COUNT; i++) {
        const lane = lanes[i];
        const ph = state.berlinPlayheads?.[i];
        if (!lane || !ph) continue;
        if (mask && mask[i] === false) continue;
        const n = clampInt(lane.stepCount, 1, 32, 8);
        const stepTicks = BAR_TICKS / normDiv(lane.division);
        const passTicks = Math.max(1, n * stepTicks);
        const laneInto = intoMaster % passTicks;
        let forward = Math.floor(laneInto / stepTicks);
        if (forward >= n) forward = n - 1;
        if (forward < 0) forward = 0;
        ph.currentStep = lane.reverse ? (n - 1 - forward) : forward;
    }
}

function positionDrum(clip, tick) {
    const lanes = Array.isArray(clip.data) ? clip.data : (clip.data?.lanes || []);
    const intoSong = Math.max(0, tick - (clip.startTick | 0));
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        const lane = lanes[i];
        const ph = state.drumPlayheads?.[i];
        if (!lane || !ph) continue;
        if (clip.laneMask && clip.laneMask[i] === false) continue;
        const n = clampInt(lane.stepCount, 1, 32, 8);
        const stepTicks = BAR_TICKS / normDiv(lane.division);
        const pass = Math.max(1, n * stepTicks);
        const into = intoSong % pass;
        let forward = Math.floor(into / stepTicks);
        if (forward >= n) forward = n - 1;
        if (forward < 0) forward = 0;
        ph.currentStep = lane.reverse ? (n - 1 - forward) : forward;
    }
}

function applyDrumCue(clip, audioTime, force) {
    if (!clip) {
        if (activeDrumKey === 'silence' && !force) return;
        clearDrumBank(SONG_SLOT);
        setDrumSlot(SONG_SLOT, { startTime: audioTime });
        activeDrumKey = 'silence';
        state.songDrumSilent = true;
        return;
    }
    if (!force && clip.id === activeDrumKey) return;
    loadSongSlot('d', clip.data);
    setDrumSlot(SONG_SLOT, { startTime: audioTime });
    applyDrumMask(clip.laneMask);
    positionDrum(clip, tickAt(audioTime));
    activeDrumKey = clip.id;
    state.songDrumSilent = false;
}

function armDrumsAt(audioTime) {
    const cue = cueAtTick('drums', tickAt(audioTime));
    const clip = cue?.clip?.kind === 'd' ? cue.clip : null;
    applyDrumCue(clip, audioTime, true);
}

function applyBerlinClip(clip, audioTime, force) {
    if (!clip) {
        if (berlinSilent && activeBerlinKey === 'silence' && !force) {
            return { silent: true, armed: false };
        }
        muteBerlinScratch();
        berlinSilent = true;
        activeBerlinKey = 'silence';
        selectBerlinSlot(SONG_SLOT, { followDrums: false, startTime: audioTime });
        applySongAutomation(null);
        return { silent: true, armed: true };
    }
    if (!force && clip.id === activeBerlinKey) {
        return { silent: false, armed: false, same: true };
    }
    loadSongSlot('b', clip.data);
    applyBerlinMask(clip.laneMask);
    berlinSilent = false;
    activeBerlinKey = clip.id;
    selectBerlinSlot(SONG_SLOT, { followDrums: false, startTime: audioTime });
    positionBerlin(clip, tickAt(audioTime));
    applySongAutomation(clip.automation);
    notifyAutomationLoopAnchor(audioTime);
    return { silent: false, armed: true };
}

function berlinClipAt(audioTime) {
    const cue = cueAtTick('synth', tickAt(audioTime));
    return cue?.clip?.kind === 'b' ? cue.clip : null;
}

function startRaf() {
    if (raf) return;
    const loop = () => {
        if (!state.songPlaying || !state.isPlaying || !state.audioContext || !state.song) {
            raf = 0;
            return;
        }
        pruneAnchors();
        const tick = Math.max(0, tickAt(state.audioContext.currentTime - uiOutputLatency()));
        updateLiveKeys(tick);
        setPlayhead(state.song, tick);
        document.dispatchEvent(new CustomEvent('ingysynth:song-tick', {
            detail: { tick: state.song.playheadTick },
        }));
        raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
}

function stopRaf() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
}

function begin(audioTime, opts = {}) {
    const useContinue = !!opts.allowContinue && pendingContinue && continueTick != null;
    pendingContinue = false;
    if (!state.song) return;
    if (!hasSavedTranspose) {
        savedTranspose = state.keyboardTranspose || 0;
        hasSavedTranspose = true;
    }
    scheduledNotes.clear();
    const tps = ticksPerSecondNow();
    const insert = Math.max(0, Math.round(Number(state.song.playheadTick) || 0));
    let tick = useContinue ? Math.max(0, Math.round(continueTick)) : insert;
    tick = Math.round(wrapTick(state.song, tick));
    returnTick = useContinue ? insert : tick;
    hasReturn = true;
    anchors = [{ tick, audioTime, tps }];
    activeSynthId = null;
    activeDrumKey = null;
    activeBerlinKey = null;
    berlinSilent = false;
    rearmSynth = false;
    lastDrumArrived = null;
    state.songSynthSilent = false;
    state.songDrumSilent = false;
    setPlayhead(state.song, tick);
    armDrumsAt(audioTime);
    if (!state.berlinMode) {
        const cue = cueAtTick('synth', tick);
        const clip = cue?.clip?.kind === 'n' ? cue.clip : null;
        applySongAutomation(clip ? clip.automation : null);
        if (!clip) {
            activeSynthId = 'silence';
            state.songSynthSilent = true;
        }
    }
    updateLiveKeys(tick);
    if (!recordBridge.recording()) applyLane(tick);
    recordBridge.onBegin();
    startRaf();
}

function placeArrangementInsert(tick) {
    const t = Math.max(0, Math.round(Number(tick) || 0));
    if (!state.song) return;
    if (state.songPlaying && state.isPlaying) returnTick = t;
    else setPlayhead(state.song, t);
    hasReturn = true;
    publishPlayhead();
}

function homeArrangement() {
    returnTick = 0;
    hasReturn = true;
    if (state.song) setPlayhead(state.song, 0);
    publishPlayhead();
}

function arrangementInsertTick() {
    if (!(state.songPlaying && state.isPlaying) || !hasReturn) return null;
    return Math.max(0, returnTick || 0);
}

export function armArrangementContinue() {
    pendingContinue = true;
}

export function cancelArrangementContinue() {
    pendingContinue = false;
}

export { placeArrangementInsert, homeArrangement, arrangementInsertTick };

function prepareStepTime(audioTime) {
    if (!anchors.length) return { time: audioTime, rewind: false };
    syncTempo(audioTime);
    const end = loopEndTick();
    if (end == null) return { time: audioTime, rewind: false };
    if (isLoopAnchorTime(audioTime)) {
        rearmSynth = true;
        return { time: audioTime, rewind: false };
    }
    const tick = tickAt(audioTime);
    if (tick < end - 0.25) return { time: audioTime, rewind: false };
    const atEnd = audioTimeForTick(end);
    pushLoopAnchor(atEnd);
    rearmSynth = true;
    return { time: atEnd, rewind: audioTime > atEnd + 1e-4 };
}

function onSynthStep(audioTime) {
    if (!anchors.length) return { action: 'same' };
    syncTempo(audioTime);
    const force = rearmSynth;
    rearmSynth = false;
    const tick = tickAt(audioTime);
    const cue = cueAtTick('synth', tick);
    const cueClip = cue?.clip || null;
    if (cueClip?.kind === 'notes') {
        const entered = activeSynthId != null && activeSynthId !== 'silence';
        if (entered) applySongAutomation(null);
        activeSynthId = 'silence';
        state.songSynthSilent = true;
        const when = audioTime;
        const notesClip = cueClip;
        const gen = state.playGeneration;
        // After playStep releases a pattern hold, so that release cannot erase the note.
        queueMicrotask(() => {
            if (gen !== state.playGeneration) return;
            if (!state.songPlaying || !state.isPlaying) return;
            scheduleNotesWindow(notesClip, when);
        });
        return { action: 'silence', advanceSec: sixteenthSec(), entered };
    }
    const clip = cueClip?.kind === 'n' ? cueClip : null;
    const end = clip ? (clip.startTick | 0) + (clip.lengthTick | 0) : 0;
    if (!clip || tick >= end - 0.25) {
        const entered = activeSynthId != null && activeSynthId !== 'silence';
        if (entered) applySongAutomation(null);
        activeSynthId = 'silence';
        state.songSynthSilent = true;
        return { action: 'silence', advanceSec: sixteenthSec(), entered };
    }
    preparePitch(audioTime);
    if (!force && clip.id === activeSynthId) {
        state.songSynthSilent = false;
        return { action: 'same' };
    }
    loadSongSlot('n', clip.data);
    selectSlot(SONG_SLOT, { flush: false, followDrums: false, startTime: audioTime });
    applySongAutomation(clip.automation);
    notifyAutomationLoopAnchor(audioTime);
    activeSynthId = clip.id;
    state.songSynthSilent = false;
    return { action: 'arm', ...normalPosition(clip, tick) };
}

function nextNormalAdvanceCap(audioTime) {
    if (!anchors.length) return Infinity;
    const cueCap = nextCueCap('synth', audioTime);
    const stepCap = nextStepCap(audioTime);
    return Math.min(cueCap, stepCap);
}

function nextSynthCapFrom(audioTime) {
    return nextCueCap('synth', audioTime);
}

function armBerlin(audioTime) {
    if (!anchors.length) return { silent: true, armed: false };
    return applyBerlinClip(berlinClipAt(audioTime), audioTime, true);
}

function onBerlinBoundary(audioTime) {
    if (!anchors.length) return { silent: true, armed: false };
    syncTempo(audioTime);
    let time = audioTime;
    let force = false;
    const end = loopEndTick();
    const tick = tickAt(audioTime);
    if (end != null && tick >= end - 0.5) {
        const atEnd = audioTimeForTick(end);
        pushLoopAnchor(atEnd);
        time = atEnd;
        force = true;
    } else if (isLoopAnchorTime(audioTime)) {
        force = true;
    }
    return applyBerlinClip(berlinClipAt(time), time, force);
}

function nextDrumCapFrom(audioTime) {
    return nextCueCap('drums', audioTime);
}

function arriveDrum(audioTime) {
    if (!anchors.length) return false;
    if (lastDrumArrived != null && Math.abs(audioTime - lastDrumArrived) < 1e-4) return false;
    syncTempo(audioTime);
    let time = audioTime;
    let force = false;
    const end = loopEndTick();
    const tick = tickAt(audioTime);
    if (end != null && tick >= end - 0.5) {
        const atEnd = audioTimeForTick(end);
        pushLoopAnchor(atEnd);
        time = atEnd;
        force = true;
    } else if (isLoopAnchorTime(audioTime)) {
        force = true;
    }
    const cue = cueAtTick('drums', tickAt(time));
    const clip = cue?.clip?.kind === 'd' ? cue.clip : null;
    applyDrumCue(clip, time, force);
    lastDrumArrived = time;
    return true;
}

export function initSongConductor() {
    setSongConductor({
        rememberPerform,
        restorePerformSlots,
        finishSong,
        begin,
        prepareStepTime,
        onSynthStep,
        nextNormalAdvanceCap,
        nextSynthCapFrom,
        armBerlin,
        onBerlinBoundary,
        berlinSilent: () => berlinSilent,
        nextDrumCapFrom,
        arriveDrum,
        preparePitch,
        clearContinue: cancelArrangementContinue,
    });
}
