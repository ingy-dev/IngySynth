// Arrange page: transport, shared timeline, pattern bank, clip editing.
// Record arms a take. Play starts at the insert marker. Stop returns there,
// and Stop again returns to bar 1. Shift+Play continues from the last stop.
// The scrub strip launches playback and follows the pointer.
// Drag-back and notes quantize store the overwritten bank slot on a side
// stack because redo() always returns extra: null.

import { state } from './state.js?v=120';
import { getNumber, subscribe } from './params.js?v=44';
import { initAudio } from './audio-engine.js?v=247';
import { togglePlay, stopArp, relocateArrangement } from './sequencer.js?v=455';
import { arrangeStop, cancelArrangeCountIn } from './song-record.js?v=21';
import {
    armArrangementContinue,
    arrangementInsertTick,
    cancelArrangementContinue,
    homeArrangement,
    placeArrangementInsert,
} from './song-conductor.js?v=23';
import {
    SONG_SLOT,
    patternHash,
    snapshotDrumSlot,
    snapshotSynthSlot,
    writeDrumSlot,
    writeSynthSlot,
} from './pattern-bank.js?v=50';
import { snapshotBankAutomation } from './automation.js?v=101';
import {
    BAR_TICKS,
    PPQ,
    canRedo,
    canUndo,
    clipCycleTicks,
    clipShowsUpdate,
    clipStepTicks,
    createSong,
    deleteClip,
    duplicateClip,
    keepClip,
    moveClip,
    checkpointUndo,
    placeClip,
    redo,
    resizeClip,
    retargetClip,
    setLaneMask,
    setLoop,
    undo,
    updateFromSource,
} from './song-model.js?v=4';
import { quantizeToPattern } from './song-quantize.js?v=18';
import { arrangeRollIsOpen, closeArrangeRoll } from './arrange-roll.js?v=24';

const MIN_PX = 24;
const MAX_PX = 320;
const HALF_BAR = 1920;
const BEAT = 960;
const SIXTEENTH = PPQ / 4;
const SLOP = 8;
const LONG_PRESS = 450;
const DBL_TAP_MS = 350;
const NOTICE_MS = 2000;
const TUNE_MIN = -24;
const TUNE_MAX = 24;

let viewOn = false;
let pxPerBar = 80;
let bankTab = 'synth';
let armed = null;
let selectedId = null;
let recordArmed = false;
let rollOpener = null;
/** @type {null | { id: string, at: number }} */
let lastClipTap = null;
let menuEl = null;
let gestureDepth = 0;
let suspend = 0;
let dirty = false;
/** @type {{ kind: string, slot: number, data: any, automation: any }[]} */
let bankRedo = [];
/** @type {null | { id: string, startTick: number, endTick: number }} */
let noteRange = null;
let noticeTimer = 0;

const pinchPts = new Map();
let pinch = null;
let didPinch = false;

let root;
let scroller;
let sheet;
let ruler;
let synthLane;
let drumLane;

export function setArrangeRollOpener(fn) {
    rollOpener = typeof fn === 'function' ? fn : null;
}

export function setArrangeView(on) {
    const next = !!on;
    if (next === viewOn) return;
    viewOn = next;
    document.body.classList.toggle('is-arrange', next);
    const view = document.getElementById('arrangeView');
    if (view) view.hidden = !next;
    const perform = document.getElementById('siteViewPerform');
    const arrange = document.getElementById('siteViewArrange');
    if (perform) perform.setAttribute('aria-pressed', next ? 'false' : 'true');
    if (arrange) arrange.setAttribute('aria-pressed', next ? 'true' : 'false');
    syncHash(next);
    const play = document.getElementById('arrangePlay');
    if (play) {
        play.classList.remove('is-on');
        play.setAttribute('aria-pressed', 'false');
    }
    if (!next) {
        closeMenu();
        armed = null;
        if (arrangeRollIsOpen()) closeArrangeRoll();
    } else {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest('.keyboard-toolbar, .keyboard-filter-knobs, #keyboardXyFieldset')) {
            active.blur();
        }
    }
    cancelArrangeCountIn();
    cancelArrangementContinue();
    if (state.isPlaying) togglePlay();
    stopArp();
    state.songPlaying = false;
    if (next) renderAll();
}

export function initArrangeView() {
    if (!state.song) state.song = createSong();
    root = document.getElementById('arrangeView');
    if (!root || root.dataset.ready === '1') {
        if (location.hash === '#arrange') setArrangeView(true);
        return;
    }
    root.dataset.ready = '1';
    root.innerHTML = markup();
    scroller = document.getElementById('arrangeScroll');
    sheet = document.getElementById('arrangeSheet');
    ruler = document.getElementById('arrangeRuler');
    synthLane = document.getElementById('arrangeSynthLane');
    drumLane = document.getElementById('arrangeDrumLane');
    bind();
    window.addEventListener('hashchange', () => {
        setArrangeView(location.hash === '#arrange');
    });
    if (location.hash === '#arrange') setArrangeView(true);
}

function markup() {
    return `
        <div class="arrange-transport">
            <div class="arrange-transport-main" role="group" aria-label="Transport">
                <button type="button" id="arrangeRecord" class="arrange-btn arrange-btn-icon" aria-pressed="false" aria-label="Record"><span class="arrange-icon-rec" aria-hidden="true"></span></button>
                <button type="button" id="arrangePlay" class="arrange-btn arrange-btn-icon" aria-pressed="false" aria-label="Play"><span class="arrange-icon-play" aria-hidden="true"></span></button>
                <button type="button" id="arrangeStop" class="arrange-btn arrange-btn-icon" aria-label="Stop"><span class="arrange-icon-stop" aria-hidden="true"></span></button>
            </div>
            <button type="button" id="arrangeLoop" class="arrange-btn" aria-pressed="false">Loop</button>
            <button type="button" id="arrangeUndo" class="arrange-btn" disabled>Undo</button>
            <button type="button" id="arrangeRedo" class="arrange-btn" disabled>Redo</button>
        </div>
        <div class="arrange-time">
            <span class="arrange-time-kicker">TIME</span>
            <span id="arrangeClock">0:00</span>
            <span id="arrangePosition">1.1</span>
        </div>
        <p id="arrangeNotice" class="arrange-notice" role="status" hidden></p>
        <div class="arrange-timelines">
            <div class="arrange-grid">
                <div class="arrange-gutter" aria-hidden="true">
                    <div class="arrange-gutter-scrub">Scrub</div>
                    <div class="arrange-gutter-ruler"></div>
                    <div class="arrange-gutter-lane" data-track="synth">Synth</div>
                    <div class="arrange-gutter-lane" data-track="drums">Drums</div>
                </div>
                <div class="arrange-scroll" id="arrangeScroll">
                    <div class="arrange-sheet" id="arrangeSheet">
                        <div id="arrangeScrub" class="arrange-scrub" aria-label="Scrub arrangement"></div>
                        <div id="arrangeRuler" class="arrange-ruler" aria-label="Timeline ruler"></div>
                        <div id="arrangeSynthLane" class="arrange-lane" data-track="synth" aria-label="Synth timeline"></div>
                        <div id="arrangeDrumLane" class="arrange-lane" data-track="drums" aria-label="Drums timeline"></div>
                        <div id="arrangeLoopShade" class="arrange-loop-shade" hidden></div>
                        <div id="arrangeInsert" class="arrange-insert" hidden></div>
                        <div id="arrangePlayhead" class="arrange-playhead"></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="arrange-bank">
            <div class="arrange-tab-strip" role="tablist" aria-label="Pattern bank">
                <button type="button" class="arrange-tab is-active" role="tab" data-tab="synth" aria-selected="true">Synth</button>
                <button type="button" class="arrange-tab" role="tab" data-tab="drums" aria-selected="false">Drums</button>
                <button type="button" class="arrange-tab" role="tab" data-tab="effects" aria-selected="false">Effects</button>
                <button type="button" class="arrange-tab" role="tab" data-tab="mixer" aria-selected="false">Mixer</button>
            </div>
            <div id="arrangeBankBody"></div>
        </div>
    `;
}

function bind() {
    document.getElementById('arrangeRecord').addEventListener('click', () => {
        state.songRecordArmed = !state.songRecordArmed;
        recordArmed = !!state.songRecordArmed;
        const btn = document.getElementById('arrangeRecord');
        btn.classList.toggle('is-armed', recordArmed);
        btn.setAttribute('aria-pressed', recordArmed ? 'true' : 'false');
    });
    document.getElementById('arrangePlay').addEventListener('click', (event) => {
        if (state.songCountIn || !(state.isPlaying && state.songPlaying)) {
            if (event.shiftKey && !state.isPlaying && !state.songCountIn) armArrangementContinue();
            else cancelArrangementContinue();
            togglePlay();
        } else {
            cancelArrangementContinue();
            const insert = arrangementInsertTick();
            relocateArrangement(insert == null ? 0 : insert);
        }
        syncArrangeTransport();
    });
    document.getElementById('arrangeStop').addEventListener('click', () => {
        cancelArrangementContinue();
        arrangeStop();
        syncArrangeTransport();
    });
    document.getElementById('arrangeLoop').addEventListener('click', () => {
        const loop = state.song.loop || { on: false, startTick: 0, endTick: 0 };
        setLoop(state.song, {
            on: !loop.on,
            startTick: loop.startTick | 0,
            endTick: loop.endTick | 0,
        });
        noteEdit();
        syncLoop();
        syncHistory();
    });
    document.getElementById('arrangeUndo').addEventListener('click', onUndo);
    document.getElementById('arrangeRedo').addEventListener('click', onRedo);

    root.querySelector('.arrange-tab-strip').addEventListener('click', (event) => {
        const tab = event.target.closest('.arrange-tab');
        if (!tab) return;
        bankTab = tab.dataset.tab;
        armed = null;
        layoutBank();
        requestAnimationFrame(drawCanvases);
    });
    root.querySelector('.arrange-bank').addEventListener('pointerdown', onSquarePointerDown);
    sheet.addEventListener('pointerdown', onSheetPointerDown);
    ruler.addEventListener('pointerdown', onRulerPointerDown);
    document.getElementById('arrangeScrub').addEventListener('pointerdown', onScrubPointerDown);
    root.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        if (gestureDepth > 0) return;
        const clipEl = event.target.closest('.arrange-clip');
        if (!clipEl) return;
        selectedId = clipEl.dataset.id;
        paintSelection();
        openMenu(selectedId, event.clientX, event.clientY);
    });

    const timelines = root.querySelector('.arrange-timelines');
    timelines.addEventListener('wheel', onWheel, { passive: false });
    timelines.addEventListener('pointerdown', onPinchDown);
    timelines.addEventListener('pointermove', onPinchMove);
    timelines.addEventListener('pointerup', onPinchEnd);
    timelines.addEventListener('pointercancel', onPinchEnd);

    document.addEventListener('pointerdown', (event) => {
        if (!menuEl || menuEl.contains(event.target)) return;
        closeMenu();
    }, true);
    document.addEventListener('keydown', onKey);
    subscribe('tempo', () => {
        if (shown()) syncPlayhead();
    });
    document.addEventListener('ingysynth:sequencer-start', syncArrangeTransport);
    document.addEventListener('ingysynth:sequencer-stop', syncArrangeTransport);
    document.addEventListener('ingysynth:arrange-transport', syncArrangeTransport);
    document.addEventListener('ingysynth:song-changed', () => {
        refreshArrange();
    });
    document.addEventListener('ingysynth:song-tick', onSongTick);
    document.addEventListener('ingysynth:pattern-slot', onPatternEvent);
    document.addEventListener('ingysynth:berlin-slot', onPatternEvent);
    document.addEventListener('ingysynth:drum-slot', onPatternEvent);
    document.addEventListener('ingysynth:automation-changed', onPatternEvent);
    document.addEventListener('ingysynth:berlin-mode', onPatternEvent);
    document.addEventListener('ingysynth:arrange-roll-closed', () => {
        if (shown()) renderAll();
    });
    const observer = new ResizeObserver(() => {
        if (shown()) drawCanvases();
    });
    observer.observe(root);
}

function shown() {
    return document.body.classList.contains('is-arrange');
}

function syncHash(on) {
    const base = location.pathname + location.search;
    if (on) {
        if (location.hash !== '#arrange') history.replaceState(null, '', `${base}#arrange`);
    } else if (location.hash === '#arrange') {
        history.replaceState(null, '', base);
    }
}

function onPatternEvent(event) {
    const slot = event?.detail?.slot;
    if (slot === SONG_SLOT) return;
    requestRender();
}

function requestRender() {
    if (!shown() || suspend > 0 || gestureDepth > 0) {
        dirty = true;
        return;
    }
    renderAll();
}

function noteEdit() {
    bankRedo = [];
}

export function refreshArrange() {
    noteEdit();
    syncHistory();
    if (shown()) renderAll();
}

function renderAll({ scrollLeft, bank = true } = {}) {
    if (!state.song || !sheet) return;
    dirty = false;
    const keep = scrollLeft != null ? scrollLeft : scroller.scrollLeft;
    layoutTimeline();
    if (bank) layoutBank();
    syncChrome();
    scroller.scrollLeft = keep;
    requestAnimationFrame(drawCanvases);
    document.dispatchEvent(new CustomEvent('ingysynth:arrange-render'));
}

function layoutTimeline() {
    const bars = sheetBars();
    sheet.style.width = `${bars * pxPerBar}px`;
    sheet.style.setProperty('--arrange-px', `${pxPerBar}px`);
    paintRuler(bars);
    paintLane(synthLane, state.song.synth.clips);
    paintLane(drumLane, state.song.drums.clips);
    syncPlayhead();
    syncLoop();
}

function sheetBars() {
    let end = 0;
    for (const clip of state.song.synth.clips) end = Math.max(end, clip.startTick + clip.lengthTick);
    for (const clip of state.song.drums.clips) end = Math.max(end, clip.startTick + clip.lengthTick);
    return Math.max(16, Math.ceil(end / BAR_TICKS) + 4);
}

function paintRuler(bars) {
    ruler.replaceChildren();
    for (let bar = 0; bar < bars; bar += 1) {
        const mark = document.createElement('div');
        mark.className = 'arrange-bar-mark';
        mark.style.left = `${bar * pxPerBar}px`;
        mark.textContent = String(bar + 1);
        ruler.appendChild(mark);
        if (pxPerBar < 48) continue;
        for (let beat = 1; beat < 4; beat += 1) {
            const tick = document.createElement('div');
            tick.className = 'arrange-beat-mark';
            tick.style.left = `${bar * pxPerBar + (beat * pxPerBar) / 4}px`;
            ruler.appendChild(tick);
        }
    }
}

function paintLane(lane, clips) {
    lane.replaceChildren();
    const ordered = clips.slice().sort((a, b) => a.startTick - b.startTick);
    for (const clip of ordered) lane.appendChild(clipElement(clip));
}

function clipElement(clip) {
    const el = document.createElement('div');
    el.className = 'arrange-clip';
    el.dataset.id = clip.id;
    if (clip.id === selectedId) el.classList.add('is-selected');
    if (isForeign(clip)) el.classList.add('is-foreign');
    el.style.left = `${(clip.startTick / BAR_TICKS) * pxPerBar}px`;
    el.style.width = `${(clip.lengthTick / BAR_TICKS) * pxPerBar}px`;
    const canvas = document.createElement('canvas');
    canvas.dataset.role = 'clip';
    canvas.dataset.id = clip.id;
    const label = document.createElement('span');
    label.className = 'arrange-clip-label';
    label.textContent = clipLabel(clip);
    const dot = document.createElement('span');
    dot.className = 'arrange-clip-dot';
    dot.hidden = !showDot(clip);
    const handle = document.createElement('div');
    handle.className = 'arrange-clip-handle';
    el.append(canvas, label, dot, handle);
    paintClipRange(el, clip);
    return el;
}

function layoutBank() {
    const body = document.getElementById('arrangeBankBody');
    root.querySelectorAll('.arrange-tab').forEach((tab) => {
        const on = tab.dataset.tab === bankTab;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    body.replaceChildren();
    if (bankTab === 'effects' || bankTab === 'mixer') {
        const note = document.createElement('p');
        note.className = 'arrange-coming';
        note.textContent = 'Coming soon';
        body.appendChild(note);
        return;
    }
    const kind = bankTab === 'drums' ? 'd' : currentKind();
    const track = bankTab === 'drums' ? 'drums' : 'synth';
    const grid = document.createElement('div');
    grid.className = 'arrange-bank-grid';
    for (let slot = 0; slot < 8; slot += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arrange-square';
        button.dataset.slot = String(slot);
        button.dataset.kind = kind;
        button.setAttribute('aria-label', `P${slot + 1}`);
        if (patternEmpty(kind, slot)) button.classList.add('is-empty');
        if (armed && armed.slot === slot && armed.track === track) button.classList.add('is-armed');
        const name = document.createElement('span');
        name.className = 'arrange-square-name';
        name.textContent = `P${slot + 1}`;
        const canvas = document.createElement('canvas');
        canvas.dataset.role = 'bank';
        canvas.dataset.slot = String(slot);
        canvas.dataset.kind = kind;
        button.append(name, canvas);
        grid.appendChild(button);
    }
    body.appendChild(grid);
}

function syncChrome() {
    syncPlayhead();
    syncLoop();
    syncHistory();
}

function syncHistory() {
    const undoBtn = document.getElementById('arrangeUndo');
    const redoBtn = document.getElementById('arrangeRedo');
    if (undoBtn) undoBtn.disabled = !canUndo(state.song);
    if (redoBtn) redoBtn.disabled = !canRedo(state.song);
}

function syncArrangeTransport() {
    const play = document.getElementById('arrangePlay');
    if (!play) return;
    const on = (!!state.songPlaying && !!state.isPlaying) || !!state.songCountIn;
    play.classList.toggle('is-on', on);
    play.setAttribute('aria-pressed', on ? 'true' : 'false');
    const stop = document.getElementById('arrangeStop');
    if (stop) {
        stop.setAttribute('aria-label', on ? 'Stop' : 'Return to start');
    }
}

function onSongTick(event) {
    if (!shown()) return;
    const tick = Number(event.detail?.tick);
    if (!Number.isFinite(tick)) return;
    syncPlayhead();
    followPlayhead(tick);
}

function followPlayhead(tick) {
    if (!scroller) return;
    const x = (tick / BAR_TICKS) * pxPerBar;
    const left = scroller.scrollLeft;
    const width = scroller.clientWidth || 0;
    if (!(width > 0)) return;
    const pad = Math.max(24, width * 0.2);
    if (x < left + pad) scroller.scrollLeft = Math.max(0, x - pad);
    else if (x > left + width - pad) scroller.scrollLeft = Math.max(0, x - width + pad);
}

function syncPlayhead() {
    const tick = Math.max(0, Number(state.song?.playheadTick) || 0);
    const line = document.getElementById('arrangePlayhead');
    if (line) line.style.left = `${(tick / BAR_TICKS) * pxPerBar}px`;
    const insert = document.getElementById('arrangeInsert');
    const insertTick = arrangementInsertTick();
    if (insert) {
        const show = insertTick != null && Math.abs(insertTick - tick) > 1;
        insert.hidden = !show;
        if (show) insert.style.left = `${(insertTick / BAR_TICKS) * pxPerBar}px`;
    }
    const clock = document.getElementById('arrangeClock');
    const position = document.getElementById('arrangePosition');
    if (clock) clock.textContent = formatClock(tick);
    if (position) position.textContent = formatPosition(tick);
}

function syncLoop(preview) {
    const loop = preview || state.song.loop || { on: false, startTick: 0, endTick: 0 };
    const shade = document.getElementById('arrangeLoopShade');
    if (!preview) {
        const button = document.getElementById('arrangeLoop');
        const on = !!state.song.loop?.on;
        if (button) {
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
            button.classList.toggle('is-on', on);
        }
    }
    if (!shade) return;
    if (!loop.on || loop.endTick <= loop.startTick) {
        shade.hidden = true;
        return;
    }
    shade.hidden = false;
    shade.style.left = `${(loop.startTick / BAR_TICKS) * pxPerBar}px`;
    shade.style.width = `${((loop.endTick - loop.startTick) / BAR_TICKS) * pxPerBar}px`;
}

function formatClock(tick) {
    const tempoN = getNumber('tempo', 120);
    const tempo = Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
    const seconds = Math.max(0, Number(tick) || 0) / PPQ / (tempo / 60);
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatPosition(tick) {
    const t = Math.max(0, Number(tick) || 0);
    const bar = Math.floor(t / BAR_TICKS) + 1;
    const beat = Math.floor((t % BAR_TICKS) / BEAT) + 1;
    return `${bar}.${beat}`;
}

function currentKind() {
    return state.berlinMode ? 'b' : 'n';
}

function findClip(id) {
    if (!state.song || !id) return null;
    return state.song.synth.clips.find((clip) => clip.id === id)
        || state.song.drums.clips.find((clip) => clip.id === id)
        || null;
}

function isForeign(clip) {
    if (!clip || clip.kind === 'd' || clip.kind === 'notes') return false;
    if (clip.kind === 'n') return !!state.berlinMode;
    if (clip.kind === 'b') return !state.berlinMode;
    return false;
}

function clipLabel(clip) {
    const star = clip.edited && clip.kind !== 'notes' ? '*' : '';
    if (clip.kind === 'notes') return 'Rec';
    if (clip.kind === 'n' && state.berlinMode) return `Normal${star}`;
    if (clip.kind === 'b' && !state.berlinMode) return `Berlin${star}`;
    return `P${(clip.source | 0) + 1}${star}`;
}

function showDot(clip) {
    if (!clip || clip.kind === 'notes' || clip.edited) return false;
    if (clip.source == null || clip.source < 0 || clip.source > 7) return false;
    return clipShowsUpdate(clip, patternHash(clip.kind, clip.source));
}

function patternEmpty(kind, slot) {
    if (kind === 'd') {
        return snapshotDrumSlot(slot).every((lane) => stepsOff(lane?.steps, lane?.stepCount || 8));
    }
    const data = snapshotSynthSlot(kind, slot);
    if (!data) return true;
    if (kind === 'n') return stepsOff(data.steps, data.stepCount || 8);
    const osc = data.oscCount || 3;
    const mod = data.modCount || 1;
    for (let row = 0; row < osc; row += 1) {
        const lane = data.lanes?.[row];
        if (lane && lane.enabled !== false && !stepsOff(lane.steps, lane.stepCount || 8)) return false;
    }
    for (let row = 0; row < mod; row += 1) {
        const lane = data.lanes?.[4 + row];
        if (lane && lane.enabled !== false && !stepsOff(lane.steps, lane.stepCount || 8)) return false;
    }
    return true;
}

function stepsOff(steps, count) {
    const n = Math.max(0, count | 0);
    for (let i = 0; i < n; i += 1) {
        if (steps?.[i]?.on) return false;
    }
    return true;
}

function tickFromClientX(clientX) {
    const rect = sheet.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, (x / pxPerBar) * BAR_TICKS);
}

function snapBeat(tick) {
    return Math.max(0, Math.round(tick / BEAT) * BEAT);
}

function snapSixteenth(tick) {
    return Math.max(0, Math.round(tick / SIXTEENTH) * SIXTEENTH);
}

function snapBar(tick) {
    return Math.max(0, Math.round(tick / BAR_TICKS) * BAR_TICKS);
}

function previewSnapStart(track, excludeId, pointerStart) {
    const start = Math.max(0, Number(pointerStart) || 0);
    const barCandidate = Math.round(start / BAR_TICKS) * BAR_TICKS;
    const clips = track === 'drums' ? state.song.drums.clips : state.song.synth.clips;
    let bestEnd = null;
    let bestDist = HALF_BAR + 1;
    for (const clip of clips) {
        if (clip.id === excludeId) continue;
        const end = clip.startTick + clip.lengthTick;
        const dist = Math.abs(start - end);
        if (dist <= HALF_BAR && dist < bestDist) {
            bestDist = dist;
            bestEnd = end;
        }
    }
    return bestEnd != null ? bestEnd : barCandidate;
}

function overlaps(track, excludeId, start, length) {
    const clips = track === 'drums' ? state.song.drums.clips : state.song.synth.clips;
    const end = start + length;
    for (const clip of clips) {
        if (clip.id === excludeId) continue;
        if (start < clip.startTick + clip.lengthTick && clip.startTick < end) return true;
    }
    return false;
}

function previewLength(clip, lengthTick) {
    const grid = clipStepTicks(clip);
    const raw = Math.max(grid, Number(lengthTick) || grid);
    return Math.max(1, Math.floor(raw / grid)) * grid;
}

function onWheel(event) {
    if (gestureDepth > 0) return;
    const unit = event.deltaMode === 1 ? 16 : 1;
    if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * unit * 0.0016);
        setZoom(event.clientX, pxPerBar * factor);
        return;
    }
    event.preventDefault();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    scroller.scrollLeft += delta * unit;
}

function setZoom(clientX, nextPx) {
    const clamped = Math.min(MAX_PX, Math.max(MIN_PX, nextPx));
    if (Math.abs(clamped - pxPerBar) < 0.05) return;
    const rect = scroller.getBoundingClientRect();
    const anchor = clientX - rect.left;
    const content = scroller.scrollLeft + anchor;
    const ratio = clamped / pxPerBar;
    pxPerBar = clamped;
    renderAll({ scrollLeft: content * ratio - anchor, bank: false });
}

function pinchMetrics() {
    const pts = [...pinchPts.values()];
    if (pts.length < 2) return null;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    return { dist, mid: (pts[0].x + pts[1].x) / 2 };
}

function onPinchDown(event) {
    pinchPts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchPts.size === 2 && gestureDepth === 0) {
        const info = pinchMetrics();
        if (info && info.dist > 0) pinch = { dist: info.dist, mid: info.mid, px: pxPerBar };
    }
}

function onPinchMove(event) {
    if (!pinchPts.has(event.pointerId)) return;
    pinchPts.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!pinch || gestureDepth > 0) return;
    const info = pinchMetrics();
    if (!info || pinch.dist <= 0) return;
    didPinch = true;
    setZoom(info.mid, pinch.px * (info.dist / pinch.dist));
}

function onPinchEnd(event) {
    pinchPts.delete(event.pointerId);
    if (pinchPts.size < 2) pinch = null;
    if (pinchPts.size === 0 && didPinch) {
        window.setTimeout(() => {
            didPinch = false;
        }, 0);
    }
}

function onRulerPointerDown(event) {
    if (event.button !== 0 || gestureDepth > 0) return;
    gestureDepth += 1;
    const originX = event.clientX;
    const originY = event.clientY;
    const originTick = tickFromClientX(originX);
    let moved = false;
    const move = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        if (Math.hypot(ev.clientX - originX, ev.clientY - originY) > 6) moved = true;
        if (!moved) return;
        let start = snapBar(originTick);
        let end = snapBar(tickFromClientX(ev.clientX));
        if (end < start) [start, end] = [end, start];
        if (end === start) end = start + BAR_TICKS;
        syncLoop({ on: true, startTick: start, endTick: end });
    };
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        gestureDepth = Math.max(0, gestureDepth - 1);
        if (ev.type === 'pointercancel') {
            syncLoop();
            return;
        }
        if (!moved) {
            placeArrangementInsert(snapBeat(tickFromClientX(ev.clientX)));
            syncLoop();
            return;
        }
        let start = snapBar(originTick);
        let end = snapBar(tickFromClientX(ev.clientX));
        if (end < start) [start, end] = [end, start];
        if (end === start) end = start + BAR_TICKS;
        setLoop(state.song, { on: true, startTick: start, endTick: end });
        noteEdit();
        syncLoop();
        syncHistory();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function onSheetPointerDown(event) {
    if (event.button !== 0 || event.ctrlKey) return;
    if (event.target.closest('#arrangeRuler, #arrangeScrub')) return;
    const clipEl = event.target.closest('.arrange-clip');
    if (clipEl) {
        beginClipGesture(event, clipEl);
        return;
    }
    const lane = event.target.closest('.arrange-lane');
    if (lane) beginLaneTap(event, lane);
}

function beginLaneTap(event, lane) {
    if (gestureDepth > 0) return;
    const x = event.clientX;
    const y = event.clientY;
    const track = lane.dataset.track;
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        window.removeEventListener('pointerup', up);
        if (didPinch || pinchPts.size > 0) return;
        if (Math.hypot(ev.clientX - x, ev.clientY - y) > SLOP) return;
        if (armed && armed.track === track) {
            commitPlace(track, track === 'drums' ? 'd' : currentKind(), armed.slot, tickFromClientX(ev.clientX));
            return;
        }
        selectedId = null;
        paintSelection();
        placeArrangementInsert(snapBeat(tickFromClientX(ev.clientX)));
    };
    window.addEventListener('pointerup', up);
}

function beginClipGesture(event, clipEl) {
    if (gestureDepth > 0) return;
    const clip = findClip(clipEl.dataset.id);
    if (!clip) return;
    gestureDepth += 1;
    selectedId = clip.id;
    paintSelection();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const originStart = clip.startTick;
    const originLen = clip.lengthTick;
    const handle = !!event.target.closest('.arrange-clip-handle');
    const inSelection = clip.kind === 'notes' && pointInNoteRange(clip, tickFromClientX(startX));
    const heldRange = noteRange
        ? { id: noteRange.id, startTick: noteRange.startTick, endTick: noteRange.endTick }
        : null;
    let mode = 'pending';
    const timer = window.setTimeout(() => {
        if (mode !== 'pending') return;
        if (clip.kind === 'notes') {
            mode = 'range-arm';
            return;
        }
        mode = 'menu';
        openMenu(clip.id, startX, startY);
    }, LONG_PRESS);
    const move = (ev) => {
        if (ev.pointerId !== pointerId || mode === 'menu') return;
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (mode === 'pending' && dist > SLOP) {
            window.clearTimeout(timer);
            if (handle) mode = 'resize';
            else if (inSelection) mode = 'range-drag';
            else mode = 'move';
        } else if (mode === 'range-arm' && dist > SLOP) {
            mode = handle ? 'resize' : 'range';
        }
        if (mode === 'move') previewMove(clipEl, clip, originStart, ev.clientX - startX, ev.clientX, ev.clientY);
        if (mode === 'resize') previewResize(clipEl, clip, originLen, ev.clientX - startX);
        if (mode === 'range') {
            setNoteRange(clip, tickFromClientX(startX), tickFromClientX(ev.clientX));
            paintClipRange(clipEl, clip);
            previewSquare(clip, ev.clientX, ev.clientY);
        }
        if (mode === 'range-drag') previewSquare(clip, ev.clientX, ev.clientY);
    };
    const up = (ev) => {
        if (ev.pointerId !== pointerId) return;
        window.clearTimeout(timer);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        gestureDepth = Math.max(0, gestureDepth - 1);
        clearTargets();
        if (ev.type === 'pointercancel') {
            lastClipTap = null;
            noteRange = heldRange;
            renderAll();
            return;
        }
        if (mode === 'move') {
            lastClipTap = null;
            commitMove(clip, originStart, startX, ev.clientX, ev.clientY);
            return;
        }
        if (mode === 'resize') {
            lastClipTap = null;
            commitResize(clip, originLen, startX, ev.clientX);
            return;
        }
        if (mode === 'menu') {
            lastClipTap = null;
            if (dirty) renderAll();
            return;
        }
        if (mode === 'range-arm') {
            lastClipTap = null;
            openMenu(clip.id, startX, startY);
            if (dirty) renderAll();
            return;
        }
        if (mode === 'range' || mode === 'range-drag') {
            lastClipTap = null;
            if (mode === 'range') {
                setNoteRange(clip, tickFromClientX(startX), tickFromClientX(ev.clientX));
            }
            const square = squareAt(ev.clientX, ev.clientY);
            if (square && canDropOnSquare(clip, square.dataset.slot | 0)) {
                quantizeNotesClip(clip, square.dataset.slot | 0, noteRange);
            } else {
                renderAll();
            }
            return;
        }
        placeArrangementInsert(snapBeat(tickFromClientX(ev.clientX)));
        const now = performance.now();
        if (lastClipTap && lastClipTap.id === clip.id && now - lastClipTap.at <= DBL_TAP_MS) {
            lastClipTap = null;
            closeMenu();
            if (typeof rollOpener === 'function') rollOpener(clip.id);
        } else {
            lastClipTap = { id: clip.id, at: now };
        }
        if (dirty) renderAll();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function previewMove(el, clip, origin, dx, clientX, clientY) {
    clearTargets();
    const square = squareAt(clientX, clientY);
    if (square && canDropOnSquare(clip, square.dataset.slot | 0)) {
        square.classList.add('is-drop');
        el.style.left = `${(origin / BAR_TICKS) * pxPerBar}px`;
        el.classList.remove('is-blocked');
        return;
    }
    const raw = Math.max(0, origin + (dx / pxPerBar) * BAR_TICKS);
    const snapped = previewSnapStart(clip.track, clip.id, raw);
    el.style.left = `${(snapped / BAR_TICKS) * pxPerBar}px`;
    el.classList.toggle('is-blocked', overlaps(clip.track, clip.id, snapped, clip.lengthTick));
}

function previewResize(el, clip, originLen, dx) {
    const raw = originLen + (dx / pxPerBar) * BAR_TICKS;
    const snapped = previewLength(clip, raw);
    el.style.width = `${(snapped / BAR_TICKS) * pxPerBar}px`;
    el.classList.toggle('is-blocked', overlaps(clip.track, clip.id, clip.startTick, snapped));
    const need = clip.startTick + snapped;
    const bars = Math.max(sheetBars(), Math.ceil(need / BAR_TICKS) + 1);
    sheet.style.width = `${bars * pxPerBar}px`;
}

function commitMove(clip, origin, startX, clientX, clientY) {
    const square = squareAt(clientX, clientY);
    if (square) {
        if (canDropOnSquare(clip, square.dataset.slot | 0)) dropOnSquare(clip, square.dataset.slot | 0);
        else renderAll();
        return;
    }
    const lane = laneAt(clientX, clientY);
    if (!lane || lane.dataset.track !== clip.track) {
        renderAll();
        return;
    }
    const raw = Math.max(0, origin + ((clientX - startX) / pxPerBar) * BAR_TICKS);
    const before = origin;
    const ok = moveClip(state.song, clip.id, raw);
    const now = findClip(clip.id);
    if (ok && now && now.startTick !== before) {
        shiftNoteRange(clip.id, now.startTick - before);
        noteEdit();
    }
    renderAll();
}

function commitResize(clip, originLen, startX, clientX) {
    const raw = originLen + ((clientX - startX) / pxPerBar) * BAR_TICKS;
    const ok = resizeClip(state.song, clip.id, raw);
    const now = findClip(clip.id);
    if (ok && now && now.lengthTick !== originLen) noteEdit();
    renderAll();
}

function onSquarePointerDown(event) {
    const square = event.target.closest('.arrange-square');
    if (!square || event.button !== 0 || gestureDepth > 0) return;
    gestureDepth += 1;
    const slot = square.dataset.slot | 0;
    const track = bankTab === 'drums' ? 'drums' : 'synth';
    const kind = track === 'drums' ? 'd' : currentKind();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let ghost = null;
    let dragLen = 0;
    const move = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > SLOP) {
            dragging = true;
            dragLen = cycleTicks(kind, slot);
            ghost = showGhost(kind, slot, ev.clientX, ev.clientY);
        }
        if (!dragging) return;
        moveGhost(ghost, ev.clientX, ev.clientY);
        clearTargets();
        const lane = laneAt(ev.clientX, ev.clientY);
        if (lane && lane.dataset.track === track) {
            lane.classList.add('is-target');
            const snapped = previewSnapStart(track, null, tickFromClientX(ev.clientX));
            ghost.classList.toggle('is-blocked', overlaps(track, null, snapped, dragLen));
        }
    };
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        gestureDepth = Math.max(0, gestureDepth - 1);
        clearTargets();
        if (ghost) ghost.remove();
        if (ev.type === 'pointercancel') return;
        if (!dragging) {
            if (armed && armed.slot === slot && armed.track === track) armed = null;
            else armed = { slot, track };
            if (dirty) renderAll();
            else paintArm();
            return;
        }
        const lane = laneAt(ev.clientX, ev.clientY);
        if (!lane || lane.dataset.track !== track) {
            if (dirty) renderAll();
            return;
        }
        commitPlace(track, kind, slot, tickFromClientX(ev.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function commitPlace(track, kind, slot, tick) {
    suspend += 1;
    let clip = null;
    try {
        clip = placeFromBank(track, kind, slot, tick);
    } finally {
        suspend -= 1;
    }
    if (clip) {
        noteEdit();
        selectedId = clip.id;
        armed = null;
    }
    renderAll();
}

function placeFromBank(track, kind, slot, startTick) {
    const data = kind === 'd'
        ? { lanes: snapshotDrumSlot(slot) }
        : snapshotSynthSlot(kind, slot);
    if (!data) return false;
    const automation = kind === 'd' ? null : snapshotBankAutomation(`${kind}${slot}`);
    return placeClip(state.song, {
        track,
        kind,
        source: slot,
        startTick,
        data,
        automation,
        copiedHash: patternHash(kind, slot),
    });
}

function cycleTicks(kind, slot) {
    const data = kind === 'd'
        ? { lanes: snapshotDrumSlot(slot) }
        : snapshotSynthSlot(kind, slot);
    return clipCycleTicks({ kind, data, laneMask: null });
}

function pointInNoteRange(clip, tick) {
    if (!noteRange || !clip || noteRange.id !== clip.id) return false;
    const lo = Math.min(noteRange.startTick, noteRange.endTick);
    const hi = Math.max(noteRange.startTick, noteRange.endTick);
    return tick >= lo && tick <= hi;
}

function setNoteRange(clip, tickA, tickB) {
    const clipStart = clip.startTick;
    const clipEnd = clipStart + clip.lengthTick;
    let lo = Math.max(clipStart, Math.min(tickA, tickB));
    let hi = Math.min(clipEnd, Math.max(tickA, tickB));
    if (hi < lo) hi = lo;
    noteRange = { id: clip.id, startTick: lo, endTick: hi };
    root?.querySelectorAll('.arrange-clip-range').forEach((el) => {
        if (!el.parentElement || el.parentElement.dataset.id !== clip.id) el.remove();
    });
    return noteRange;
}

function shiftNoteRange(id, delta) {
    if (!noteRange || noteRange.id !== id || !delta) return;
    noteRange = {
        id,
        startTick: noteRange.startTick + delta,
        endTick: noteRange.endTick + delta,
    };
}

function paintClipRange(clipEl, clip) {
    if (!clipEl || !clip) return;
    let shade = clipEl.querySelector('.arrange-clip-range');
    if (!noteRange || noteRange.id !== clip.id) {
        shade?.remove();
        return;
    }
    const len = clip.lengthTick || 1;
    const clipStart = clip.startTick;
    const lo = Math.max(clipStart, Math.min(noteRange.startTick, noteRange.endTick));
    const hi = Math.min(clipStart + len, Math.max(noteRange.startTick, noteRange.endTick));
    if (hi <= lo) {
        shade?.remove();
        return;
    }
    if (!shade) {
        shade = document.createElement('div');
        shade.className = 'arrange-clip-range';
        clipEl.appendChild(shade);
    }
    shade.style.left = `${((lo - clipStart) / len) * 100}%`;
    shade.style.width = `${((hi - lo) / len) * 100}%`;
}

function previewSquare(clip, clientX, clientY) {
    clearTargets();
    const square = squareAt(clientX, clientY);
    if (square && canDropOnSquare(clip, square.dataset.slot | 0)) {
        square.classList.add('is-drop');
    }
}

function absoluteNotes(clip) {
    const origin = clip.startTick | 0;
    return (clip.notes || []).map((note) => ({
        semi: note.semi,
        fine: note.fine,
        startTick: origin + (Number(note.startTick) || 0),
        durTick: note.durTick,
        vel: note.vel,
        legato: note.legato,
    }));
}

function rangeBounds(clip, range) {
    const clipStart = clip.startTick | 0;
    const clipEnd = clipStart + (clip.lengthTick | 0);
    if (!range || range.id !== clip.id) return { startTick: clipStart, endTick: clipEnd };
    const lo = Math.min(range.startTick, range.endTick);
    const hi = Math.max(range.startTick, range.endTick);
    return {
        startTick: Math.max(clipStart, Math.min(lo, clipEnd)),
        endTick: Math.max(clipStart, Math.min(hi, clipEnd)),
    };
}

function showArrangeNotice(text) {
    const el = document.getElementById('arrangeNotice');
    window.clearTimeout(noticeTimer);
    if (!el) return;
    if (!text) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.textContent = text;
    el.hidden = false;
    noticeTimer = window.setTimeout(() => {
        el.hidden = true;
    }, NOTICE_MS);
}

function quantizeNotesClip(clip, slot, range) {
    if (!clip || clip.kind !== 'notes' || !canDropOnSquare(clip, slot)) {
        renderAll();
        return;
    }
    const prev = captureSlot('n', slot);
    const { data, truncated } = quantizeToPattern(absoluteNotes(clip), rangeBounds(clip, range));
    checkpointUndo(state.song, prev);
    let wrote = false;
    suspend += 1;
    try {
        wrote = writeSynthSlot('n', slot, data) === true;
    } finally {
        suspend -= 1;
    }
    if (wrote) noteEdit();
    showArrangeNotice(truncated ? 'Truncated to 32 steps' : '');
    renderAll();
}

function canDropOnSquare(clip, slot) {
    if (!clip) return false;
    if (slot < 0 || slot > 7) return false;
    if (clip.kind === 'notes') return bankTab === 'synth' && currentKind() === 'n';
    if (bankTab === 'drums') return clip.kind === 'd';
    if (bankTab === 'synth') return clip.kind === currentKind();
    return false;
}

function dropOnSquare(clip, slot) {
    if (!canDropOnSquare(clip, slot)) {
        renderAll();
        return;
    }
    if (clip.kind === 'notes') {
        quantizeNotesClip(clip, slot, null);
        return;
    }
    const kind = clip.kind;
    const prev = captureSlot(kind, slot);
    let updated = null;
    suspend += 1;
    try {
        if (kind === 'd') writeDrumSlot(slot, clip.data?.lanes || []);
        else writeSynthSlot(kind, slot, clip.data, clip.automation);
        updated = retargetClip(state.song, clip.id, slot, patternHash(kind, slot), prev);
        if (!updated) writePayload(prev);
    } finally {
        suspend -= 1;
    }
    if (updated) noteEdit();
    renderAll();
}

function captureSlot(kind, slot) {
    if (kind === 'd') {
        return { kind, slot, data: snapshotDrumSlot(slot), automation: null };
    }
    return {
        kind,
        slot,
        data: snapshotSynthSlot(kind, slot),
        automation: snapshotBankAutomation(`${kind}${slot}`),
    };
}

function writePayload(payload) {
    if (!payload) return;
    suspend += 1;
    try {
        if (payload.kind === 'd') writeDrumSlot(payload.slot, payload.data);
        else writeSynthSlot(payload.kind, payload.slot, payload.data, payload.automation);
    } finally {
        suspend -= 1;
    }
}

function onUndo() {
    if (!canUndo(state.song)) return;
    const result = undo(state.song);
    if (!result.ok) return;
    if (result.extra) {
        bankRedo.push(captureSlot(result.extra.kind, result.extra.slot));
        writePayload(result.extra);
    } else {
        bankRedo.push(null);
    }
    closeMenu();
    renderAll();
}

function onRedo() {
    if (!canRedo(state.song)) return;
    const result = redo(state.song);
    if (!result.ok) return;
    const payload = bankRedo.pop();
    if (payload) writePayload(payload);
    closeMenu();
    renderAll();
}

function showGhost(kind, slot, x, y) {
    const ghost = document.createElement('div');
    ghost.className = 'arrange-ghost';
    const ticks = cycleTicks(kind, slot);
    ghost.style.width = `${Math.max(16, (ticks / BAR_TICKS) * pxPerBar)}px`;
    const canvas = document.createElement('canvas');
    canvas.dataset.role = 'ghost';
    canvas.dataset.kind = kind;
    canvas.dataset.slot = String(slot);
    const label = document.createElement('span');
    label.className = 'arrange-clip-label';
    label.textContent = `P${slot + 1}`;
    ghost.append(canvas, label);
    document.body.appendChild(ghost);
    moveGhost(ghost, x, y);
    requestAnimationFrame(() => drawCanvas(canvas));
    return ghost;
}

function moveGhost(ghost, x, y) {
    if (!ghost) return;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y - 20}px`;
}

function squareAt(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
        const square = el.closest?.('.arrange-square');
        if (square) return square;
    }
    return null;
}

function laneAt(x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
        const lane = el.closest?.('.arrange-lane');
        if (lane) return lane;
    }
    return null;
}

function clearTargets() {
    root.querySelectorAll('.is-target, .arrange-square.is-drop').forEach((el) => {
        el.classList.remove('is-target', 'is-drop');
    });
}

function paintSelection() {
    root.querySelectorAll('.arrange-clip').forEach((el) => {
        el.classList.toggle('is-selected', el.dataset.id === selectedId);
    });
}

function paintArm() {
    const track = bankTab === 'drums' ? 'drums' : 'synth';
    root.querySelectorAll('.arrange-square').forEach((el) => {
        const on = armed && armed.slot === (el.dataset.slot | 0) && armed.track === track;
        el.classList.toggle('is-armed', !!on);
    });
}

function openMenu(id, x, y) {
    const clip = findClip(id);
    if (!clip) return;
    closeMenu();
    selectedId = id;
    paintSelection();
    const menu = document.createElement('div');
    menu.className = 'arrange-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.id = id;
    addMenuItem(menu, 'edit', 'Edit notes');
    if (showDot(clip)) {
        addMenuItem(menu, 'update', 'Update from pattern');
        addMenuItem(menu, 'keep', 'Keep');
    }
    addMenuItem(menu, 'duplicate', 'Duplicate');
    addMenuItem(menu, 'delete', 'Delete');
    if (clip.kind === 'b' || clip.kind === 'd') {
        const block = document.createElement('div');
        block.className = 'arrange-menu-lanes';
        const caption = document.createElement('span');
        caption.className = 'arrange-menu-lanes-label';
        caption.textContent = 'Lanes';
        block.appendChild(caption);
        const count = clip.kind === 'd' ? 4 : 8;
        for (let i = 0; i < count; i += 1) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.lane = String(i);
            button.textContent = clip.kind === 'd'
                ? `D${i + 1}`
                : (i < 4 ? `O${i + 1}` : `M${i - 3}`);
            button.setAttribute('aria-pressed', laneOn(clip, i) ? 'true' : 'false');
            block.appendChild(button);
        }
        menu.appendChild(block);
    }
    menu.addEventListener('click', onMenuClick);
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    document.body.appendChild(menu);
    menuEl = menu;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function addMenuItem(menu, action, text) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.setAttribute('role', 'menuitem');
    button.textContent = text;
    menu.appendChild(button);
}

function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
}

function onMenuClick(event) {
    const laneBtn = event.target.closest('[data-lane]');
    if (laneBtn && menuEl) {
        toggleLane(menuEl.dataset.id, laneBtn.dataset.lane | 0);
        return;
    }
    const item = event.target.closest('[data-action]');
    if (!item || !menuEl) return;
    const id = menuEl.dataset.id;
    const action = item.dataset.action;
    if (action === 'edit') {
        document.dispatchEvent(new CustomEvent('ingysynth:arrange-edit', { detail: { id } }));
        if (typeof rollOpener === 'function') rollOpener(id);
        closeMenu();
        return;
    }
    if (action === 'update') updateClip(id);
    else if (action === 'keep') keepSelected(id);
    else if (action === 'duplicate') duplicateSelected(id);
    else if (action === 'delete') deleteSelected(id);
    closeMenu();
    renderAll();
}

function toggleLane(id, index) {
    const clip = findClip(id);
    if (!clip || (clip.kind !== 'b' && clip.kind !== 'd')) return;
    const count = clip.kind === 'd' ? 4 : 8;
    const mask = clip.laneMask == null
        ? Array.from({ length: count }, () => true)
        : clip.laneMask.map((value) => value !== false);
    while (mask.length < count) mask.push(true);
    mask[index] = !laneOn(clip, index);
    const updated = setLaneMask(state.song, id, mask);
    if (!updated) return;
    noteEdit();
    syncHistory();
    menuEl?.querySelectorAll('[data-lane]').forEach((button) => {
        const lane = button.dataset.lane | 0;
        button.setAttribute('aria-pressed', laneOn(updated, lane) ? 'true' : 'false');
    });
}

function laneOn(clip, index) {
    if (clip.laneMask == null) return true;
    return clip.laneMask[index] !== false;
}

function updateClip(id) {
    const clip = findClip(id);
    if (!clip || clip.kind === 'notes') return;
    const data = clip.kind === 'd'
        ? { lanes: snapshotDrumSlot(clip.source) }
        : snapshotSynthSlot(clip.kind, clip.source);
    const automation = clip.kind === 'd' ? null : snapshotBankAutomation(`${clip.kind}${clip.source}`);
    suspend += 1;
    let updated = null;
    try {
        updated = updateFromSource(state.song, id, data, automation, patternHash(clip.kind, clip.source));
    } finally {
        suspend -= 1;
    }
    if (updated) noteEdit();
}

function keepSelected(id) {
    const clip = findClip(id);
    if (!clip) return;
    if (keepClip(state.song, id, patternHash(clip.kind, clip.source))) noteEdit();
}

function duplicateSelected(id) {
    const dup = duplicateClip(state.song, id);
    if (!dup) return;
    noteEdit();
    selectedId = dup.id;
}

function deleteSelected(id) {
    if (!deleteClip(state.song, id)) return;
    noteEdit();
    if (selectedId === id) selectedId = null;
    if (noteRange && noteRange.id === id) noteRange = null;
}

function typingTarget(target) {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    if (el.isContentEditable) return true;
    return !!el.closest('input, textarea, [contenteditable="true"]');
}

document.addEventListener('keydown', onArrangeSpace, true);
document.addEventListener('keydown', onViewTab, true);

// Tab flips between the perform and arrange pages. Shift+Tab and text fields
// keep normal focus behaviour.
function onViewTab(event) {
    if (event.key !== 'Tab' || event.repeat || event.defaultPrevented) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingTarget(event.target)) return;
    if (!root) return;
    event.preventDefault();
    setArrangeView(!shown());
}

function onArrangeSpace(event) {
    if (!shown() || event.code !== 'Space' || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingTarget(event.target)) return;
    if (event.shiftKey && !state.isPlaying && !state.songCountIn) armArrangementContinue();
    else cancelArrangementContinue();
}

function onScrubPointerDown(event) {
    if (event.button !== 0 || gestureDepth > 0) return;
    event.preventDefault();
    event.stopPropagation();
    gestureDepth += 1;
    initAudio();
    cancelArrangeCountIn();
    cancelArrangementContinue();
    let last = null;
    let queued = null;
    let frame = 0;
    const flush = () => {
        frame = 0;
        if (queued == null || queued === last) return;
        last = queued;
        relocateArrangement(queued);
        syncPlayhead();
        followPlayhead(Number(state.song?.playheadTick) || queued);
        syncArrangeTransport();
    };
    const aim = (clientX, immediate) => {
        queued = snapSixteenth(tickFromClientX(clientX));
        if (immediate) {
            if (frame) cancelAnimationFrame(frame);
            flush();
            return;
        }
        if (frame) return;
        frame = requestAnimationFrame(flush);
    };
    const move = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        aim(ev.clientX, false);
    };
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        gestureDepth = Math.max(0, gestureDepth - 1);
        if (ev.type !== 'pointercancel') aim(ev.clientX, true);
        else if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
    };
    aim(event.clientX, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function onKey(event) {
    if (!shown()) return;
    if (event.key === 'Home' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (typingTarget(event.target)) return;
        event.preventDefault();
        cancelArrangeCountIn();
        cancelArrangementContinue();
        if (state.isPlaying && state.songPlaying) relocateArrangement(0);
        else homeArrangement();
        syncPlayhead();
        syncArrangeTransport();
        return;
    }
    if (event.key === 'Escape') {
        closeMenu();
        if (arrangeRollIsOpen()) closeArrangeRoll();
        if (armed) {
            armed = null;
            paintArm();
        }
        return;
    }
    if (typingTarget(event.target)) return;
    const meta = event.metaKey || event.ctrlKey;
    if (meta && !event.altKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) onRedo();
        else onUndo();
        return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
        event.preventDefault();
        deleteSelected(selectedId);
        closeMenu();
        renderAll();
    }
}

function drawCanvases() {
    if (!shown()) return;
    root.querySelectorAll('canvas').forEach(drawCanvas);
    document.querySelectorAll('.arrange-ghost canvas').forEach(drawCanvas);
}

function drawCanvas(canvas) {
    if (!canvas || canvas.closest('[hidden]')) return;
    const box = canvasBox(canvas);
    if (!box) return;
    const { ctx, w, h } = box;
    if (canvas.dataset.role === 'clip') {
        const clip = findClip(canvas.dataset.id);
        if (!clip) return;
        if (clip.kind === 'notes') drawNotes(ctx, w, h, clip);
        else if (clip.kind === 'b') drawRows(ctx, w, h, clip.data?.lanes, 8);
        else if (clip.kind === 'd') drawRows(ctx, w, h, clip.data?.lanes, 4);
        else drawNormal(ctx, w, h, clip.data);
        return;
    }
    const kind = canvas.dataset.kind;
    const slot = canvas.dataset.slot | 0;
    if (kind === 'd') drawRows(ctx, w, h, snapshotDrumSlot(slot), 4);
    else if (kind === 'b') drawRows(ctx, w, h, snapshotSynthSlot('b', slot)?.lanes, 8);
    else drawNormal(ctx, w, h, snapshotSynthSlot('n', slot));
}

function canvasBox(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const dpr = window.devicePixelRatio || 1;
    const bitmapW = Math.max(1, Math.round(rect.width * dpr));
    const bitmapH = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
        canvas.width = bitmapW;
        canvas.height = bitmapH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return { ctx, w: rect.width, h: rect.height };
}

function drawNormal(ctx, w, h, data) {
    const steps = data?.steps || [];
    const count = Math.max(1, Math.min(32, data?.stepCount || 8));
    const cell = w / count;
    const noteH = Math.max(2, Math.min(5, h / 12));
    ctx.fillStyle = '#00ff00';
    for (let i = 0; i < count; i += 1) {
        const step = steps[i];
        if (!step || step.on === false) continue;
        const root = Number(step.tune) || 0;
        const pitches = [root];
        if (Array.isArray(step.chord)) {
            for (const extra of step.chord) pitches.push(root + (Number(extra) || 0));
        }
        for (const tune of pitches) {
            const clamped = Math.max(TUNE_MIN, Math.min(TUNE_MAX, tune));
            const y = h - ((clamped - TUNE_MIN) / (TUNE_MAX - TUNE_MIN)) * (h - noteH);
            ctx.fillRect(i * cell + 0.5, y - noteH, Math.max(1, cell - 1.5), noteH);
        }
    }
}

function drawRows(ctx, w, h, lanes, rowCount) {
    const rowH = h / rowCount;
    ctx.fillStyle = '#00ff00';
    for (let row = 0; row < rowCount; row += 1) {
        const lane = lanes?.[row];
        if (!lane) continue;
        const count = Math.max(1, Math.min(32, lane.stepCount || 8));
        const steps = lane.steps || [];
        const cell = w / count;
        for (let i = 0; i < count; i += 1) {
            if (!steps[i] || steps[i].on === false) continue;
            ctx.fillRect(i * cell + 0.4, row * rowH + 1, Math.max(1, cell - 1), Math.max(1, rowH - 2));
        }
    }
}

function drawNotes(ctx, w, h, clip) {
    const notes = clip?.notes || [];
    const len = Math.max(1, clip?.lengthTick || 1);
    let minSemi = Infinity;
    let maxSemi = -Infinity;
    for (const note of notes) {
        const semi = Number(note.semi);
        if (!Number.isFinite(semi)) continue;
        minSemi = Math.min(minSemi, semi);
        maxSemi = Math.max(maxSemi, semi);
    }
    if (!Number.isFinite(minSemi)) return;
    if (minSemi === maxSemi) {
        minSemi -= 6;
        maxSemi += 6;
    }
    const span = maxSemi - minSemi || 1;
    const noteH = Math.max(2, Math.min(5, h / 14));
    ctx.fillStyle = '#00ff00';
    for (const note of notes) {
        const semi = Number(note.semi);
        if (!Number.isFinite(semi)) continue;
        const x = (Math.max(0, Number(note.startTick) || 0) / len) * w;
        const width = Math.max(2, ((Number(note.durTick) || 240) / len) * w);
        const y = h - ((semi - minSemi) / span) * (h - noteH) - noteH;
        ctx.fillRect(x, y, width, noteH);
    }
}
