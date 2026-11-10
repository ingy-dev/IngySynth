// Arrange page: transport, shared timeline, pattern bank, clip editing.
// Record arms a take. Play starts at the insert marker. Stop returns there,
// and Stop again returns to bar 1. Shift+Play continues from the last stop.
// The scrub strip launches playback and follows the pointer.
// Drag-back and notes quantize store the overwritten bank slot on a side
// stack because redo() always returns extra: null.

import { state } from './state.js?v=120';
import { getNumber, subscribe } from './params.js?v=44';
import { initAudio } from './audio-engine.js?v=247';
import { togglePlay, stopArp, relocateArrangement } from './sequencer.js?v=456';
import { arrangeStop, cancelArrangeCountIn, liveTakeRegions } from './song-record.js?v=26';
import { arrangeTempoMarkup, initArrangeTempo } from './arrange-tempo.js?v=2';
import {
    armArrangementContinue,
    arrangementInsertTick,
    cancelArrangementContinue,
    homeArrangement,
    placeArrangementInsert,
} from './song-conductor.js?v=29';
import {
    SONG_SLOT,
    patternHash,
    snapshotDrumSlot,
    snapshotSynthSlot,
    writeDrumSlot,
    writeSynthSlot,
} from './pattern-bank.js?v=50';
import { snapshotBankAutomation } from './automation.js?v=102';
import {
    BAR_TICKS,
    PPQ,
    canRedo,
    canUndo,
    clipCycleTicks,
    clipIsTrimmed,
    trimmedClipData,
    playOrderData,
    reverseClip,
    invertClip,
    clipPatternTicks,
    clipPlaySpan,
    clipShowsUpdate,
    clipStartOffset,
    clipStepTicks,
    createSong,
    deleteClip,
    duplicateClip,
    keepClip,
    moveClip,
    overwritePreview,
    checkpointUndo,
    placeClip,
    redo,
    repeatClip,
    repeatRoom,
    resizeClip,
    retargetClip,
    setLaneMask,
    setLoop,
    trimClipStart,
    undo,
    updateFromSource,
} from './song-model.js?v=9';
import { quantizeToPattern } from './song-quantize.js?v=19';
import { arrangeRollIsOpen, closeArrangeRoll } from './arrange-roll.js?v=46';

const MIN_PX = 24;
const MAX_PX = 1280;
const BEAT = 960;
// Ableton-style adaptive grid: the finest of these whose lines stay at least
// GRID_MIN_PX apart is both the drawn grid and the clip start snap.
const GRID_MIN_PX = 10;
const GRID_UNITS = [
    BAR_TICKS / 64, BAR_TICKS / 32, BAR_TICKS / 16, BAR_TICKS / 8, BAR_TICKS / 4, BAR_TICKS / 2, BAR_TICKS,
];
// Ruler position labels (Bitwig/Ableton style "2.3" and "2.3.2") need this much room.
const LABEL_MIN_PX = 38;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
// Held during a drag, the Ableton modifier (Cmd on Mac, Alt elsewhere) places freely.
let snapBypass = false;
const SIXTEENTH = PPQ / 4;
const SLOP = 8;
/** While a grip is dragged: the clip as it will be, for drawing and the label. */
let drawOverride = null;
/** Copy knob on the lane past the selected (or mouse-hovered) clip's right edge. */
let knobEl = null;
let hoverClipId = null;
let copyDrag = false;
const KNOB_GAP = 10;
// Copy icon: two clips, one stacked over the other, and an arrow to the right (copies
// drop that way). Black on the cyan hexagon.
const COPY_ICON = '<svg viewBox="0 0 24 14" aria-hidden="true">'
    + '<rect x="1.5" y="5" width="9" height="7.5" rx="1.5" fill="none" stroke="#000" stroke-width="1.6"/>'
    + '<rect x="5.5" y="1.5" width="9" height="7.5" rx="1.5" fill="#00e5ff" stroke="#000" stroke-width="1.6"/>'
    + '<path d="M17 7h5.5M19.5 4l3 3-3 3" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
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

// Live touch pointers on the timeline, so a pinch can cancel a one-finger gesture.
const touchPointers = new Set();
/** @type {null | { dist: number, bar: number, px: number }} */
let pinch = null;
let didPinch = false;

let root;
let scroller;
let gridCanvas;
let gridFrame = 0;
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
    gridCanvas = document.getElementById('arrangeGridCanvas');
    bind();
    initArrangeTempo();
    window.addEventListener('hashchange', () => {
        setArrangeView(location.hash === '#arrange');
    });
    if (location.hash === '#arrange') setArrangeView(true);
}

function markup() {
    return `
        <div class="arrange-transport">${arrangeTempoMarkup()}
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
                        <canvas id="arrangeGridCanvas" class="arrange-grid-canvas" aria-hidden="true"></canvas>
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
            <fieldset class="arrange-bank-field" id="arrangeBankBody"></fieldset>
            <div id="arrangeToast" class="arrange-toast" role="status" aria-hidden="true">
                <span class="arrange-toast-text"></span>
                <button type="button" class="arrange-toast-undo" tabindex="-1">Undo?</button>
            </div>
        </div>
    `;
}

// A loaded project brought its own arrangement (save-capture.js applyDoc).
function onSongLoaded() {
    if (arrangeRollIsOpen()) closeArrangeRoll();
    selectedId = null;
    armed = null;
    if (shown()) renderAll();
    else dirty = true;
}

function bind() {
    document.addEventListener('ingysynth:song-loaded', onSongLoaded);
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
    document.querySelector('#arrangeToast .arrange-toast-undo').addEventListener('click', onToastUndo);
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
    sheet.addEventListener('pointerover', onSheetHover);
    sheet.addEventListener('pointerleave', () => {
        if (copyDrag || hoverClipId == null) return;
        hoverClipId = null;
        clearCopyGhosts();
        paintKnob();
    });
    // Clip gestures hide the knob; bring it back once the pointer lifts.
    window.addEventListener('pointerup', () => requestAnimationFrame(paintKnob));
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
    scroller.addEventListener('scroll', scheduleGrid, { passive: true });
    timelines.addEventListener('wheel', onWheel, { passive: false });
    // Pinch runs on touch events: the browser cancels pointer events once it
    // starts scrolling, which used to drop the second finger mid-pinch.
    timelines.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'touch') touchPointers.add(event.pointerId);
    }, true);
    const dropTouchPointer = (event) => touchPointers.delete(event.pointerId);
    window.addEventListener('pointerup', dropTouchPointer, true);
    window.addEventListener('pointercancel', dropTouchPointer, true);
    timelines.addEventListener('touchstart', onPinchStart, { passive: false });
    timelines.addEventListener('touchmove', onPinchMove, { passive: false });
    timelines.addEventListener('touchend', onPinchEnd);
    timelines.addEventListener('touchcancel', onPinchEnd);
    // iOS Safari zooms the page on pinch even with user-scalable=no.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        timelines.addEventListener(type, (event) => event.preventDefault(), { passive: false });
    }

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
    // The take commits just after the stop event: clear the live take once it has.
    document.addEventListener('ingysynth:sequencer-stop', () => requestAnimationFrame(paintTake));
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
    // Song playback swaps the automation bank at every synth clip boundary;
    // rebuilding the view for that blanks every preview for a frame.
    if (event?.type === 'ingysynth:automation-changed' && state.songPlaying) {
        dirty = true;
        return;
    }
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
    hideReplaceToast();
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
    // Draw before this frame paints so rebuilt canvases never show blank;
    // the next frame catches any canvas that had no layout yet.
    drawCanvases();
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
    paintKnob();
    syncPlayhead();
    syncLoop();
    drawGrid();
}

function scheduleGrid() {
    if (gridFrame) return;
    gridFrame = requestAnimationFrame(() => {
        gridFrame = 0;
        drawGrid();
    });
}

function gridLevel(tick) {
    if (tick % BAR_TICKS === 0) return 0;
    if (tick % BEAT === 0) return 1;
    if (tick % (BEAT / 2) === 0) return 2;
    return 3;
}

// Bars, beats, 8ths, finer. Lit lines only where the grid has room for them.
const GRID_LINE_ALPHA = [0.42, 0.24, 0.15, 0.1];
const RULER_TICK_H = [0, 7, 5, 3];

// One viewport-wide canvas behind the lanes: lines snap to device pixels so
// none drop out or blur at fractional zoom, and cost stays flat however long
// the song is.
function drawGrid() {
    if (!gridCanvas || !scroller || !shown()) return;
    const viewW = scroller.clientWidth;
    const height = sheet.clientHeight;
    if (!(viewW > 0) || !(height > 0)) return;
    const left = scroller.scrollLeft;
    gridCanvas.style.left = `${left}px`;
    gridCanvas.style.width = `${viewW}px`;
    gridCanvas.style.height = `${height}px`;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(viewW * dpr));
    const bh = Math.max(1, Math.round(height * dpr));
    if (gridCanvas.width !== bw || gridCanvas.height !== bh) {
        gridCanvas.width = bw;
        gridCanvas.height = bh;
    }
    const ctx = gridCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, height);
    const laneTop = synthLane.offsetTop;
    const rulerBottom = ruler.offsetTop + ruler.offsetHeight;
    const grid = gridTicks();
    const tickPx = pxPerBar / BAR_TICKS;
    const step = grid * tickPx;
    const beatPx = BEAT * tickPx;
    const sixteenthPx = SIXTEENTH * tickPx;
    const first = Math.max(0, Math.floor(left / step));
    const last = Math.ceil((left + viewW) / step);
    const snap = (x) => Math.round(x * dpr) / dpr;
    ctx.font = '7px Michroma, sans-serif';
    ctx.textBaseline = 'top';
    for (let i = first; i <= last; i += 1) {
        const tick = i * grid;
        const x = snap(tick * tickPx - left);
        const level = gridLevel(tick);
        ctx.fillStyle = `rgba(0, 200, 0, ${GRID_LINE_ALPHA[level]})`;
        ctx.fillRect(x, laneTop, 1, height - laneTop);
        if (level === 0) continue;
        ctx.fillStyle = `rgba(0, 170, 0, ${level === 1 ? 0.7 : 0.45})`;
        ctx.fillRect(x, rulerBottom - RULER_TICK_H[level], 1, RULER_TICK_H[level]);
        const bar = Math.floor(tick / BAR_TICKS) + 1;
        const beat = Math.floor((tick % BAR_TICKS) / BEAT) + 1;
        let label = '';
        if (level === 1 && beatPx >= LABEL_MIN_PX) label = `${bar}.${beat}`;
        else if (tick % SIXTEENTH === 0 && sixteenthPx >= LABEL_MIN_PX) {
            label = `${bar}.${beat}.${Math.floor((tick % BEAT) / SIXTEENTH) + 1}`;
        }
        if (label) {
            ctx.fillStyle = 'rgba(0, 170, 0, 0.6)';
            ctx.fillText(label, x + 3, ruler.offsetTop + 3);
        }
    }
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
    // Trim grips, Final Cut style: left trims the start, right trims or extends the end.
    const left = document.createElement('div');
    left.className = 'arrange-clip-handle is-left';
    left.dataset.edge = 'l';
    const handle = document.createElement('div');
    handle.className = 'arrange-clip-handle is-right';
    handle.dataset.edge = 'r';
    el.append(canvas, label, left, handle);
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
        if (patternReversed(kind, slot)) {
            // The pad keeps step order, like the sequencer: REV says it plays backwards.
            const rev = document.createElement('span');
            rev.className = 'arrange-square-rev';
            rev.textContent = 'REV';
            button.appendChild(rev);
        }
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
    paintTake();
}

/**
 * The take being recorded, drawn as it grows: a red clip from where recording
 * began to the playhead, notes appearing as they are played. Stop commits it
 * as a real notes clip and the song re-render replaces this.
 */
function paintTake() {
    if (!synthLane) return;
    const regions = shown() ? liveTakeRegions() : [];
    const els = [...synthLane.querySelectorAll('.arrange-take')];
    for (let i = regions.length; i < els.length; i += 1) els[i].remove();
    regions.forEach((region, i) => {
        let el = els[i];
        if (!el) {
            el = document.createElement('div');
            el.className = 'arrange-clip arrange-take';
            el.setAttribute('aria-hidden', 'true');
            const canvas = document.createElement('canvas');
            const label = document.createElement('span');
            label.className = 'arrange-clip-label';
            label.textContent = 'Rec';
            el.append(canvas, label);
            synthLane.appendChild(el);
        }
        const length = Math.max(1, region.endTick - region.startTick);
        el.style.left = `${(region.startTick / BAR_TICKS) * pxPerBar}px`;
        el.style.width = `${(length / BAR_TICKS) * pxPerBar}px`;
        const box = canvasBox(el.querySelector('canvas'));
        if (!box) return;
        const geom = { tickPx: pxPerBar / BAR_TICKS, lead: 0, cycle: length };
        drawNotes(box.ctx, box.w, box.h, { notes: region.notes, lengthTick: length }, geom, '#ff3333');
    });
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

/**
 * The piano roll's Loop clip toggle. A temporary view setting, so no undo step.
 * With `jump`, a running song outside the new loop moves to its start.
 */
export function setArrangeLoop(loop, { jump = false } = {}) {
    if (!state.song) return;
    const next = {
        on: !!loop?.on,
        startTick: Math.max(0, loop?.startTick | 0),
        endTick: Math.max(0, loop?.endTick | 0),
    };
    state.song.loop = next;
    syncLoop();
    document.dispatchEvent(new CustomEvent('ingysynth:song-loop'));
    if (!jump || !next.on || !(state.isPlaying && state.songPlaying)) return;
    const tick = Number(state.song.playheadTick) || 0;
    if (tick < next.startTick || tick >= next.endTick) relocateArrangement(next.startTick);
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
    // One mark for "differs from its pattern": edited or trimmed here, or the pattern changed since.
    const star = clip.kind !== 'notes' && (clip.edited || clipIsTrimmed(clip) || patternChanged(clip)) ? '*' : '';
    if (clip.kind === 'notes') return 'Rec';
    if (clip.kind === 'n' && state.berlinMode) return `Normal${star}`;
    if (clip.kind === 'b' && !state.berlinMode) return `Berlin${star}`;
    return `P${(clip.source | 0) + 1}${star}`;
}

function patternChanged(clip) {
    if (!clip || clip.kind === 'notes' || clip.edited) return false;
    if (clip.source == null || clip.source < 0 || clip.source > 7) return false;
    return clipShowsUpdate(clip, patternHash(clip.kind, clip.source));
}

// Reverse is on for the pattern: every lane in use, for drums and Berlin.
function patternReversed(kind, slot) {
    if (kind === 'n') return !!snapshotSynthSlot('n', slot)?.reverse;
    let lanes = [];
    if (kind === 'd') lanes = snapshotDrumSlot(slot);
    else if (kind === 'b') {
        const data = snapshotSynthSlot('b', slot);
        const osc = data?.oscCount || 3;
        const mod = data?.modCount || 1;
        lanes = (data?.lanes || []).filter((_, row) => (row < 4 ? row < osc : row - 4 < mod));
    }
    const used = lanes.filter((lane) => lane && lane.enabled !== false);
    return used.length > 0 && used.every((lane) => lane.reverse);
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

function gridTicks() {
    for (const unit of GRID_UNITS) {
        if ((unit / BAR_TICKS) * pxPerBar >= GRID_MIN_PX) return unit;
    }
    return BAR_TICKS;
}

function bypassesSnap(ev) {
    return IS_MAC ? !!ev?.metaKey : !!ev?.altKey;
}

function startGrid() {
    return snapBypass ? 1 : gridTicks();
}

// Mirrors song-model snapStartTick so the preview lands where the drop will.
function previewSnapStart(track, excludeId, pointerStart) {
    const start = Math.max(0, Number(pointerStart) || 0);
    const unit = startGrid();
    const barCandidate = Math.round(start / unit) * unit;
    const reach = unit / 2;
    const clips = track === 'drums' ? state.song.drums.clips : state.song.synth.clips;
    let bestEnd = null;
    let bestDist = reach + 1;
    for (const clip of clips) {
        if (clip.id === excludeId) continue;
        const end = clip.startTick + clip.lengthTick;
        const dist = Math.abs(start - end);
        if (dist <= reach && dist < bestDist) {
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

function pinchMetrics(touches) {
    const a = touches[0];
    const b = touches[1];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    return { dist, mid: (a.clientX + b.clientX) / 2 };
}

function onPinchStart(event) {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    // A second finger turns whatever the first one started into a pinch.
    for (const pointerId of [...touchPointers]) {
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId, pointerType: 'touch' }));
    }
    touchPointers.clear();
    const info = pinchMetrics(event.touches);
    if (info.dist <= 0) return;
    const left = scroller.getBoundingClientRect().left;
    pinch = { dist: info.dist, bar: (scroller.scrollLeft + info.mid - left) / pxPerBar, px: pxPerBar };
    didPinch = true;
}

function onPinchMove(event) {
    if (!pinch || event.touches.length < 2) return;
    if (event.cancelable) event.preventDefault();
    const info = pinchMetrics(event.touches);
    const next = Math.min(MAX_PX, Math.max(MIN_PX, pinch.px * (info.dist / pinch.dist)));
    // The bar first under the fingers stays under their midpoint, so two
    // fingers zoom and pan together.
    const anchor = info.mid - scroller.getBoundingClientRect().left;
    const scrollLeft = pinch.bar * next - anchor;
    if (Math.abs(next - pxPerBar) < 0.05) {
        scroller.scrollLeft = scrollLeft;
        return;
    }
    pxPerBar = next;
    renderAll({ scrollLeft, bank: false });
}

function onPinchEnd(event) {
    if (event.touches.length >= 2) {
        // Three fingers down to two: restart from the pair that is left.
        pinch = null;
        onPinchStart(event);
        return;
    }
    pinch = null;
    if (event.touches.length === 0 && didPinch) {
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
        if (didPinch || pinch) return;
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
    const handleEl = event.target.closest('.arrange-clip-handle');
    const handle = !!handleEl;
    const leftEdge = handleEl?.dataset.edge === 'l';
    if (handleEl) handleEl.classList.add('is-active');
    const inSelection = clip.kind === 'notes' && pointInNoteRange(clip, tickFromClientX(startX));
    const heldRange = noteRange
        ? { id: noteRange.id, startTick: noteRange.startTick, endTick: noteRange.endTick }
        : null;
    let mode = 'pending';
    // Touch has no Delete key or right-click, so a moved clip can be dropped on a bin.
    const trashable = event.pointerType === 'touch' || event.pointerType === 'pen';
    let trash = null;
    let overTrash = false;
    // Off its lane the clip stays put and a dark pad-shaped copy is carried instead.
    let carry = null;
    const carryTo = (x, y) => {
        const lane = laneAt(x, y);
        const off = !lane || lane.dataset.track !== clip.track;
        clipEl.classList.toggle('is-carried', off);
        if (!off) {
            if (carry) carry.hidden = true;
            return;
        }
        clipEl.style.left = `${(originStart / BAR_TICKS) * pxPerBar}px`;
        clipEl.classList.remove('is-blocked');
        if (!carry) carry = showCarryGhost(clip, clipEl, x, y);
        else if (carry.hidden) {
            carry.hidden = false;
            drawCanvas(carry.querySelector('canvas'));
        }
        const target = root.querySelector('.arrange-square.is-replace');
        const hint = carry.querySelector('.arrange-ghost-hint');
        hint.hidden = !target;
        if (target) hint.textContent = `Replace P${(target.dataset.slot | 0) + 1}`;
        ghostToPad(carry, x, y);
    };
    const settleCarry = (ev) => {
        if (!carry) return;
        const square = carry.hidden || ev.type === 'pointercancel' ? null : squareAt(ev.clientX, ev.clientY);
        const slot = square && canDropOnSquare(clip, square.dataset.slot | 0) ? square.dataset.slot | 0 : -1;
        return () => landGhost(carry, slot);
    };
    const timer = window.setTimeout(() => {
        // Hold arms note-range selection only; the clip menu is right-click only.
        if (mode === 'pending' && clip.kind === 'notes') mode = 'range-arm';
    }, LONG_PRESS);
    const move = (ev) => {
        if (ev.pointerId !== pointerId) return;
        snapBypass = bypassesSnap(ev);
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
        if (mode === 'resize') {
            document.documentElement.classList.add('arrange-trimming');
            if (leftEdge) previewTrimStart(clipEl, clip, originStart, ev.clientX - startX);
            else previewResize(clipEl, clip, originLen, ev.clientX - startX);
        }
        if (mode === 'range') {
            setNoteRange(clip, tickFromClientX(startX), tickFromClientX(ev.clientX));
            paintClipRange(clipEl, clip);
            previewSquare(clip, ev.clientX, ev.clientY);
        }
        if (mode === 'range-drag') previewSquare(clip, ev.clientX, ev.clientY);
        if (mode === 'move' || mode === 'range-drag') carryTo(ev.clientX, ev.clientY);
        if (mode === 'move' && trashable) {
            if (!trash) trash = showTrash();
            overTrash = trashHit(trash, ev.clientX, ev.clientY);
            trash.classList.toggle('is-hot', overTrash);
            // On short screens the bin can sit over a pad: the bin wins.
            if (overTrash) clearTargets();
            if (carry) {
                carry.classList.toggle('is-trash', overTrash);
                if (overTrash) {
                    carry.querySelector('.arrange-ghost-hint').hidden = true;
                    ghostToTrash(carry, trash);
                }
            }
        }
    };
    const up = (ev) => {
        if (ev.pointerId !== pointerId) return;
        snapBypass = bypassesSnap(ev);
        queueMicrotask(() => { snapBypass = false; });
        window.clearTimeout(timer);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        gestureDepth = Math.max(0, gestureDepth - 1);
        document.documentElement.classList.remove('arrange-trimming');
        handleEl?.classList.remove('is-active');
        drawOverride = null;
        clearTargets();
        const trashing = overTrash && mode === 'move' && ev.type !== 'pointercancel';
        if (trash) hideTrash(trash, trashing);
        if (trashing) {
            lastClipTap = null;
            trashClip(clip, carry);
            return;
        }
        const land = settleCarry(ev);
        const replacing = ev.type !== 'pointercancel' && ['move', 'range', 'range-drag'].includes(mode)
            ? replacedSlot(clip, ev.clientX, ev.clientY)
            : -1;
        if (ev.type === 'pointercancel') {
            lastClipTap = null;
            noteRange = heldRange;
            renderAll();
            land?.();
            return;
        }
        if (mode === 'move') {
            lastClipTap = null;
            commitMove(clip, originStart, startX, ev.clientX, ev.clientY);
            land?.();
            if (replacing >= 0) showReplaceToast(replacing, !!carry, clip.id);
            return;
        }
        if (mode === 'resize') {
            lastClipTap = null;
            if (leftEdge) commitTrimStart(clip, originStart, startX, ev.clientX);
            else commitResize(clip, originLen, startX, ev.clientX);
            return;
        }
        if (mode === 'range-arm') {
            lastClipTap = null;
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
            land?.();
            if (replacing >= 0) showReplaceToast(replacing, !!carry, clip.id);
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

// Generous on purpose: a fingertip covers the bin, so near enough counts.
const TRASH_REACH = 50;
const TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
let trashEl = null;

// The bin sits at the bottom centre of the screen, Instagram-style; CSS places it.
function showTrash() {
    if (!trashEl) {
        trashEl = document.createElement('div');
        trashEl.className = 'arrange-trash';
        trashEl.setAttribute('aria-hidden', 'true');
        trashEl.innerHTML = TRASH_ICON;
        document.body.appendChild(trashEl);
    }
    trashEl.classList.remove('is-hot', 'is-gulp');
    trashEl.classList.add('is-on');
    return trashEl;
}

function hideTrash(el, gulp) {
    el.classList.remove('is-hot');
    if (gulp && !reducedMotion() && typeof el.animate === 'function') {
        el.classList.add('is-gulp');
        el.animate([
            { transform: 'scale(1.15)' },
            { transform: 'scale(0.9)', offset: 0.4 },
            { transform: 'scale(1)' },
        ], { duration: 260, easing: 'ease-out' }).finished.then(() => {
            el.classList.remove('is-on', 'is-gulp');
        }, () => el.classList.remove('is-on', 'is-gulp'));
        return;
    }
    el.classList.remove('is-on');
}

function trashCentre(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function trashHit(el, x, y) {
    const c = trashCentre(el);
    return Math.hypot(x - c.x, y - c.y) <= TRASH_REACH;
}

function ghostToTrash(ghost, el) {
    const size = Number(ghost.dataset.size) || 40;
    const c = trashCentre(el);
    ghost.style.left = `${c.x - size / 2}px`;
    ghost.style.top = `${c.y - size / 2}px`;
}

function trashClip(clip, ghost) {
    deleteSelected(clip.id);
    renderAll();
    if (ghost) {
        if (reducedMotion() || typeof ghost.animate !== 'function') ghost.remove();
        else {
            ghost.animate([
                { transform: 'scale(0.55)', opacity: 0.8 },
                { transform: 'scale(0)', opacity: 0 },
            ], { duration: 160, easing: 'ease-in', fill: 'forwards' })
                .finished.then(() => ghost.remove(), () => ghost.remove());
            window.setTimeout(() => ghost.remove(), 600);
        }
    }
    showToast('Deleted clip', -1, 0, null);
}

function previewMove(el, clip, origin, dx, clientX, clientY) {
    clearTargets();
    const square = squareAt(clientX, clientY);
    if (square && canDropOnSquare(clip, square.dataset.slot | 0)) {
        markDrop(square);
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
    // Repaint at the new width so the preview crops instead of stretching the old bitmap.
    previewDraw(el, clip, { lengthTick: snapped });
    markOverwrite(clip, clip.startTick + clip.lengthTick, clip.startTick + snapped);
    const need = clip.startTick + snapped;
    const bars = Math.max(sheetBars(), Math.ceil(need / BAR_TICKS) + 1);
    sheet.style.width = `${bars * pxPerBar}px`;
}

// Draw (and label) a clip as it would be after the edit in progress.
function previewDraw(el, clip, patch) {
    drawOverride = { id: clip.id, ...patch };
    drawCanvas(el.querySelector('canvas[data-role="clip"]'));
    const label = el.querySelector('.arrange-clip-label');
    if (label) label.textContent = clipLabel({ ...clip, ...patch });
}

// Same snapping as song-model trimClipStart: whole steps, right edge fixed, at least one step.
function trimStartTick(clip, raw) {
    const grid = clipStepTicks(clip);
    const start0 = clip.startTick;
    const end = start0 + clip.lengthTick;
    let steps = Math.round((raw - start0) / grid);
    steps = Math.min(steps, Math.floor((end - start0) / grid) - 1);
    steps = Math.max(steps, -Math.floor(start0 / grid));
    return start0 + steps * grid;
}

function previewTrimStart(el, clip, originStart, dx) {
    const next = trimStartTick(clip, originStart + (dx / pxPerBar) * BAR_TICKS);
    const end = clip.startTick + clip.lengthTick;
    el.style.left = `${(next / BAR_TICKS) * pxPerBar}px`;
    el.style.width = `${((end - next) / BAR_TICKS) * pxPerBar}px`;
    previewDraw(el, clip, {
        startTick: next,
        lengthTick: end - next,
        startOffset: clipStartOffset(clip) + (next - clip.startTick),
    });
    markOverwrite(clip, next, clip.startTick);
}

// While an edge is dragged over neighbours: clips it will remove fade out; clips it
// will cut sit under the dragged clip, which draws on top.
function markOverwrite(clip, start, end) {
    const { removed } = end > start
        ? overwritePreview(state.song, clip.track, clip.id, start, end)
        : { removed: [] };
    root.querySelectorAll('.arrange-clip').forEach((el) => {
        el.classList.toggle('is-overwritten', removed.includes(el.dataset.id));
    });
}

function commitTrimStart(clip, originStart, startX, clientX) {
    const raw = originStart + ((clientX - startX) / pxPerBar) * BAR_TICKS;
    const ok = trimClipStart(state.song, clip.id, raw);
    const now = findClip(clip.id);
    if (ok && now && now.startTick !== originStart) noteEdit();
    renderAll();
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
    const ok = moveClip(state.song, clip.id, raw, startGrid());
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
        snapBypass = bypassesSnap(ev);
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > SLOP) {
            dragging = true;
            dragLen = cycleTicks(kind, slot);
            ghost = showGhost(kind, slot, square, startX, startY);
        }
        if (!dragging) return;
        clearTargets();
        const lane = laneAt(ev.clientX, ev.clientY);
        if (lane && lane.dataset.track === track) {
            lane.classList.add('is-target');
            const snapped = previewSnapStart(track, null, tickFromClientX(ev.clientX));
            ghost.classList.toggle('is-blocked', overlaps(track, null, snapped, dragLen));
            ghostToLane(ghost, lane, snapped, dragLen);
        } else {
            ghost.classList.remove('is-blocked');
            ghostToPad(ghost, ev.clientX, ev.clientY);
        }
    };
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        snapBypass = bypassesSnap(ev);
        queueMicrotask(() => { snapBypass = false; });
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
    // On the timeline a clip holds the notes as they sound: a reversed pattern is flipped.
    const data = playOrderData(kind, kind === 'd'
        ? { lanes: snapshotDrumSlot(slot) }
        : snapshotSynthSlot(kind, slot));
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
    }, startGrid());
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
    if (square && canDropOnSquare(clip, square.dataset.slot | 0)) markDrop(square);
}

// A filled pad under a drop is about to be overwritten: say so before release.
function markDrop(square) {
    square.classList.add('is-drop');
    square.classList.toggle('is-replace', !square.classList.contains('is-empty'));
}

function absoluteNotes(clip) {
    const origin = clipPlaySpan(clip).origin;
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
    // A trimmed clip lands as what it plays: only the steps inside its edges.
    const cut = clipIsTrimmed(clip) ? trimmedClipData(clip) : null;
    const data = cut ? cut.data : clip.data;
    // The clip takes the cut pattern as its own, unless that is not all of it: cut short
    // at 32 steps, or only the uncovered part of the clip was dragged.
    const stored = findClip(clip.id);
    const whole = !!stored && stored.startTick === clip.startTick && stored.lengthTick === clip.lengthTick;
    const baked = cut && !cut.truncated && whole ? data : null;
    let updated = null;
    suspend += 1;
    try {
        if (kind === 'd') writeDrumSlot(slot, data?.lanes || []);
        else writeSynthSlot(kind, slot, data, clip.automation);
        updated = retargetClip(state.song, clip.id, slot, patternHash(kind, slot), prev, baked);
        if (!updated) writePayload(prev);
    } finally {
        suspend -= 1;
    }
    if (updated) noteEdit();
    showArrangeNotice(cut?.truncated ? 'Truncated to 32 steps' : '');
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
    // While the replace notice shows, the top undo entry is that replace.
    const replaced = toastReplace;
    hideReplaceToast();
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
    if (replaced) liftGhost(replaced.slot, replaced.clipId);
}

function onRedo() {
    hideReplaceToast();
    if (!canRedo(state.song)) return;
    const result = redo(state.song);
    if (!result.ok) return;
    const payload = bankRedo.pop();
    if (payload) writePayload(payload);
    closeMenu();
    renderAll();
}

// The dragged pad keeps its pad look (shrunk) until it is over its lane, then
// becomes the clip it will drop as, sitting at the snapped start tick.
const GHOST_PAD_SCALE = 0.7;

function showGhost(kind, slot, square, x, y) {
    const rect = square.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'arrange-ghost is-pad';
    if (square.classList.contains('is-empty')) ghost.classList.add('is-empty');
    const size = Math.max(24, rect.width * GHOST_PAD_SCALE);
    ghost.dataset.size = String(size);
    // Keep the grabbed point under the pointer, scaled with the pad.
    ghost.dataset.grabX = String(((x - rect.left) / Math.max(1, rect.width)) * size);
    ghost.dataset.grabY = String(((y - rect.top) / Math.max(1, rect.height)) * size);
    const canvas = document.createElement('canvas');
    canvas.dataset.role = 'bank';
    canvas.dataset.kind = kind;
    canvas.dataset.slot = String(slot);
    const label = document.createElement('span');
    label.className = 'arrange-clip-label';
    label.textContent = `P${slot + 1}`;
    ghost.append(canvas, label);
    ghost.addEventListener('transitionend', (ev) => {
        if (ev.target === ghost && (ev.propertyName === 'width' || ev.propertyName === 'height')) drawCanvas(canvas);
    });
    document.body.appendChild(ghost);
    ghostToPad(ghost, x, y);
    requestAnimationFrame(() => drawCanvas(canvas));
    return ghost;
}

function ghostToPad(ghost, x, y) {
    if (!ghost) return;
    const size = Number(ghost.dataset.size) || 40;
    setGhostMode(ghost, 'pad');
    ghost.style.width = `${size}px`;
    ghost.style.height = `${size}px`;
    ghost.style.left = `${x - Number(ghost.dataset.grabX || 0)}px`;
    ghost.style.top = `${y - Number(ghost.dataset.grabY || 0)}px`;
}

function ghostToLane(ghost, lane, startTick, lengthTick) {
    if (!ghost) return;
    const sheetRect = sheet.getBoundingClientRect();
    const laneRect = lane.getBoundingClientRect();
    const inner = laneRect.top + lane.clientTop;
    setGhostMode(ghost, 'clip');
    ghost.style.width = `${Math.max(16, (lengthTick / BAR_TICKS) * pxPerBar)}px`;
    ghost.style.height = `${Math.max(12, laneRect.bottom - inner - 6)}px`;
    ghost.style.left = `${sheetRect.left + (startTick / BAR_TICKS) * pxPerBar}px`;
    ghost.style.top = `${inner + 3}px`;
}

function setGhostMode(ghost, mode) {
    const pad = mode === 'pad';
    if (ghost.classList.contains('is-pad') === pad) return;
    ghost.classList.toggle('is-pad', pad);
    const canvas = ghost.querySelector('canvas');
    if (!canvas) return;
    // Pads are lit green with a black preview; clips are dark with a green one.
    canvas.dataset.role = pad ? 'bank' : 'ghost';
    drawCanvas(canvas);
}

// A timeline clip carried back to the bank: an unlit (black) pad with the
// clip's green preview, which floods green as it lands in its new slot.
function showCarryGhost(clip, clipEl, x, y) {
    const sample = root.querySelector('.arrange-square');
    const padW = sample ? sample.getBoundingClientRect().width : 80;
    const size = Math.max(24, padW * GHOST_PAD_SCALE);
    const ghost = document.createElement('div');
    ghost.className = 'arrange-ghost is-pad is-carry';
    ghost.dataset.size = String(size);
    ghost.dataset.grabX = String(size / 2);
    ghost.dataset.grabY = String(size / 2);
    const canvas = document.createElement('canvas');
    canvas.dataset.role = 'clip';
    canvas.dataset.id = clip.id;
    const label = document.createElement('span');
    label.className = 'arrange-clip-label';
    label.textContent = clipEl.querySelector('.arrange-clip-label')?.textContent || '';
    const hint = document.createElement('span');
    hint.className = 'arrange-ghost-hint';
    hint.hidden = true;
    ghost.append(canvas, label, hint);
    document.body.appendChild(ghost);
    ghostToPad(ghost, x, y);
    requestAnimationFrame(() => drawCanvas(canvas));
    return ghost;
}

function reducedMotion() {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// Only transform and opacity animate, so the whole landing stays on the compositor.
function landGhost(ghost, slot) {
    const square = slot >= 0 ? root.querySelector(`.arrange-square[data-slot="${slot}"]`) : null;
    if (!square || ghost.hidden || typeof ghost.animate !== 'function' || reducedMotion()) {
        ghost.remove();
        return;
    }
    const from = ghost.getBoundingClientRect();
    const to = square.getBoundingClientRect();
    const hint = ghost.querySelector('.arrange-ghost-hint');
    if (hint) hint.hidden = true;
    ghost.classList.add('is-landing');
    ghost.style.left = `${to.left}px`;
    ghost.style.top = `${to.top}px`;
    ghost.style.width = `${to.width}px`;
    ghost.style.height = `${to.height}px`;
    drawCanvas(ghost.querySelector('canvas'));
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const sx = from.width / Math.max(1, to.width);
    const sy = from.height / Math.max(1, to.height);
    ghost.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: 'translate(0, 0) scale(0.92)', offset: 0.75 },
        { transform: 'none' },
    ], { duration: 180, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    const flood = document.createElement('div');
    flood.className = 'arrange-ghost-flood';
    ghost.appendChild(flood);
    flood.animate([
        { transform: 'scale(0)' },
        { transform: 'scale(1)' },
    ], { duration: 200, delay: 130, easing: 'cubic-bezier(0.3, 0, 0.2, 1)', fill: 'both' });
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 120, delay: 330, fill: 'forwards',
    });
    window.setTimeout(() => {
        root.querySelector(`.arrange-square[data-slot="${slot}"]`)?.animate([
            { transform: 'scale(1)' },
            { transform: 'scale(1.06)', offset: 0.35 },
            { transform: 'scale(1)' },
        ], { duration: 240, easing: 'ease-out' });
    }, 320);
    fade.finished.then(() => ghost.remove(), () => ghost.remove());
    // Backstop in case a throttled page never finishes the fade.
    window.setTimeout(() => ghost.remove(), 1000);
}

// The landing played backwards: the green drains to the centre, then the black
// pad lifts out and flies back into its clip. Transform and opacity only.
function liftGhost(slot, clipId) {
    const square = root.querySelector(`.arrange-square[data-slot="${slot}"]`);
    if (!square || typeof square.animate !== 'function' || reducedMotion()) return;
    const clipEl = [...root.querySelectorAll('.arrange-clip')].find((el) => el.dataset.id === clipId);
    const from = square.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = 'arrange-ghost is-pad is-carry is-landing';
    ghost.style.left = `${from.left}px`;
    ghost.style.top = `${from.top}px`;
    ghost.style.width = `${from.width}px`;
    ghost.style.height = `${from.height}px`;
    const canvas = document.createElement('canvas');
    canvas.dataset.role = 'clip';
    canvas.dataset.id = clipId;
    const label = document.createElement('span');
    label.className = 'arrange-clip-label';
    label.textContent = clipEl?.querySelector('.arrange-clip-label')?.textContent || '';
    const flood = document.createElement('div');
    flood.className = 'arrange-ghost-flood';
    flood.style.transform = 'scale(1)';
    ghost.append(canvas, label, flood);
    document.body.appendChild(ghost);
    drawCanvas(canvas);
    flood.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(0)' },
    ], { duration: 180, easing: 'cubic-bezier(0.5, 0, 0.75, 0.4)', fill: 'both' });
    square.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(0.95)', offset: 0.4 },
        { transform: 'scale(1)' },
    ], { duration: 260, delay: 150, easing: 'ease-out' });
    let flight;
    if (clipEl) {
        const to = clipEl.getBoundingClientRect();
        const dx = to.left + to.width / 2 - (from.left + from.width / 2);
        const dy = to.top + to.height / 2 - (from.top + from.height / 2);
        const sx = to.width / Math.max(1, from.width);
        const sy = to.height / Math.max(1, from.height);
        flight = ghost.animate([
            { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
            { transform: 'translate(0px, 0px) scale(0.9)', opacity: 1, offset: 0.25 },
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.15 },
        ], { duration: 280, delay: 170, easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'both' });
        clipEl.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 140, delay: 420, fill: 'backwards' });
    } else {
        flight = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: 170, fill: 'both' });
    }
    flight.finished.then(() => ghost.remove(), () => ghost.remove());
    window.setTimeout(() => ghost.remove(), 1200);
}

const TOAST_MS = 5000;
const TOAST_DONE_MS = 900;
// Lands after the drop-in animation so the flood stays the moment of the drop.
const TOAST_DELAY_MS = 420;
let toastTimer = 0;
let toastShowTimer = 0;
let toastReplace = null;

function replacedSlot(clip, x, y) {
    const square = squareAt(x, y);
    if (!square || square.classList.contains('is-empty')) return -1;
    const slot = square.dataset.slot | 0;
    return canDropOnSquare(clip, slot) ? slot : -1;
}

function showReplaceToast(slot, animated, clipId) {
    const delay = animated && !reducedMotion() ? TOAST_DELAY_MS : 0;
    showToast(`Replaced P${slot + 1}`, slot, delay, { slot, clipId });
}

// An undoable edit's notice: under pad `slot`, or centred on the bank's bottom stroke when -1.
function showToast(text, slot, delay, replace) {
    const el = document.getElementById('arrangeToast');
    if (!el) return;
    window.clearTimeout(toastShowTimer);
    window.clearTimeout(toastTimer);
    const reveal = () => {
        toastReplace = replace;
        const button = el.querySelector('.arrange-toast-undo');
        button.textContent = 'Undo?';
        button.disabled = false;
        el.classList.remove('is-done');
        el.querySelector('.arrange-toast-text').textContent = text;
        placeToast(el, slot);
        el.classList.add('is-on');
        el.setAttribute('aria-hidden', 'false');
        el.querySelector('.arrange-toast-undo').tabIndex = 0;
        toastTimer = window.setTimeout(hideReplaceToast, TOAST_MS);
    };
    if (delay > 0) toastShowTimer = window.setTimeout(reveal, delay);
    else reveal();
}

// Hangs the notice just under the pad it names, kept inside the bank's edges;
// falls back to the CSS default (centred on the bank's bottom stroke).
function placeToast(el, slot) {
    const bank = el.closest('.arrange-bank');
    const square = bank?.querySelector(`.arrange-square[data-slot="${slot}"]`);
    el.classList.remove('is-placed');
    el.style.left = '';
    el.style.top = '';
    if (!bank || !square) return;
    const bankRect = bank.getBoundingClientRect();
    const padRect = square.getBoundingClientRect();
    const half = el.offsetWidth / 2;
    const centre = padRect.left + padRect.width / 2 - bankRect.left;
    const x = Math.min(Math.max(centre, half + 2), bankRect.width - half - 2);
    el.style.left = `${x}px`;
    el.style.top = `${padRect.bottom - bankRect.top + 3}px`;
    el.classList.add('is-placed');
}

function hideReplaceToast() {
    window.clearTimeout(toastShowTimer);
    window.clearTimeout(toastTimer);
    toastReplace = null;
    const el = document.getElementById('arrangeToast');
    if (!el || !el.classList.contains('is-on')) return;
    el.classList.remove('is-on');
    el.setAttribute('aria-hidden', 'true');
    el.querySelector('.arrange-toast-undo').tabIndex = -1;
}

function onToastUndo() {
    const el = document.getElementById('arrangeToast');
    // Only while showing: any later edit or undo hides it, so this undoes the replace.
    if (!el?.classList.contains('is-on') || el.classList.contains('is-done')) return;
    onUndo();
    // onUndo hid the notice; bring it straight back to confirm, then let it go.
    window.clearTimeout(toastTimer);
    const button = el.querySelector('.arrange-toast-undo');
    el.querySelector('.arrange-toast-text').textContent = 'Reverted';
    button.textContent = 'Done';
    button.disabled = true;
    el.classList.add('is-on', 'is-done');
    el.setAttribute('aria-hidden', 'false');
    toastTimer = window.setTimeout(hideReplaceToast, TOAST_DONE_MS);
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
        el.classList.remove('is-target', 'is-drop', 'is-replace');
    });
}

function paintSelection() {
    root.querySelectorAll('.arrange-clip').forEach((el) => {
        const on = el.dataset.id === selectedId;
        if (el.classList.contains('is-selected') === on) return;
        el.classList.toggle('is-selected', on);
        drawCanvas(el.querySelector('canvas[data-role="clip"]'));
    });
    paintKnob();
}

// The copy knob sits just past a clip's right edge, half way down. It shows for the
// selected clip (and, with a mouse, the hovered one) only when a whole copy fits there.
function paintKnob() {
    if (copyDrag) return;
    knobEl?.remove();
    knobEl = null;
    if (!shown() || gestureDepth > 0 || !state.song) return;
    const clip = findClip(hoverClipId || selectedId);
    if (!clip || repeatRoom(state.song, clip.id, 1) < 1) return;
    const lane = clip.track === 'drums' ? drumLane : synthLane;
    const el = document.createElement('div');
    el.className = 'arrange-knob';
    el.dataset.id = clip.id;
    el.setAttribute('aria-label', 'Drag to drop copies');
    el.innerHTML = `<span class="arrange-knob-hex">${COPY_ICON}</span>`;
    el.style.left = `${((clip.startTick + clip.lengthTick) / BAR_TICKS) * pxPerBar + KNOB_GAP}px`;
    el.addEventListener('pointerdown', onKnobDown);
    el.addEventListener('pointerenter', (event) => {
        if (event.pointerType === 'mouse' && !event.buttons) showCopyGhosts(clip, 1);
    });
    el.addEventListener('pointerleave', (event) => {
        if (event.pointerType === 'mouse' && !copyDrag) clearCopyGhosts();
    });
    lane.appendChild(el);
    knobEl = el;
}

// Dotted, see-through boxes where copies will land. Numbers count the original as 1,
// so the last box reads how many times the pattern plays in a row.
function showCopyGhosts(clip, count) {
    clearCopyGhosts();
    const lane = clip.track === 'drums' ? drumLane : synthLane;
    const origin = document.createElement('div');
    origin.className = 'arrange-copy-ghost is-origin';
    origin.style.left = `${(clip.startTick / BAR_TICKS) * pxPerBar}px`;
    origin.style.width = `${(clip.lengthTick / BAR_TICKS) * pxPerBar}px`;
    origin.textContent = '1';
    lane.appendChild(origin);
    for (let k = 1; k <= count; k += 1) {
        const start = clip.startTick + k * clip.lengthTick;
        const ghost = document.createElement('div');
        ghost.className = 'arrange-copy-ghost';
        ghost.style.left = `${(start / BAR_TICKS) * pxPerBar}px`;
        ghost.style.width = `${(clip.lengthTick / BAR_TICKS) * pxPerBar}px`;
        ghost.textContent = String(k + 1);
        // The knob sits over the first box's left end, so centre its number in the rest.
        if (k === 1) ghost.style.paddingLeft = `${KNOB_GAP + 32}px`;
        lane.appendChild(ghost);
    }
}

function clearCopyGhosts() {
    root.querySelectorAll('.arrange-copy-ghost').forEach((el) => el.remove());
}

// Press shows the first copy; drag right adds one per clip length; let go drops them.
// A tap without a drag drops one.
function onKnobDown(event) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const clip = findClip(event.currentTarget.dataset.id);
    if (!clip) return;
    const room = repeatRoom(state.song, clip.id);
    if (room < 1) return;
    copyDrag = true;
    selectedId = clip.id;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const unit = Math.max(1, (clip.lengthTick / BAR_TICKS) * pxPerBar);
    let count = 1;
    showCopyGhosts(clip, count);
    say(copyNotice(count));
    const move = (ev) => {
        if (ev.pointerId !== pointerId) return;
        const next = Math.max(1, Math.min(room, 1 + Math.round((ev.clientX - startX) / unit)));
        if (next === count) return;
        count = next;
        showCopyGhosts(clip, count);
        say(copyNotice(count));
    };
    const up = (ev) => {
        if (ev.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        copyDrag = false;
        clearCopyGhosts();
        say('');
        if (ev.type === 'pointercancel') {
            paintKnob();
            return;
        }
        const made = repeatClip(state.song, clip.id, count);
        if (made.length) {
            // The last copy takes the selection, so its knob carries on the row.
            selectedId = made[made.length - 1].id;
            noteEdit();
        }
        renderAll();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

function copyNotice(count) {
    return `${count + 1} in a row · let go to add ${count}`;
}

function say(text) {
    showArrangeNotice(text);
}

function onSheetHover(event) {
    if (event.pointerType !== 'mouse' || copyDrag || gestureDepth > 0) return;
    if (event.target.closest('.arrange-knob')) return;
    const id = event.target.closest('.arrange-clip')?.dataset.id || null;
    if (id === hoverClipId) return;
    hoverClipId = id;
    clearCopyGhosts();
    paintKnob();
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
    if (patternChanged(clip)) {
        addMenuItem(menu, 'update', 'Update from pattern');
        addMenuItem(menu, 'keep', 'Keep');
    }
    addMenuItem(menu, 'reverse', 'Reverse');
    if (clip.kind !== 'd') addMenuItem(menu, 'invert', 'Invert');
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
    else if (action === 'reverse') reverseSelected(id);
    else if (action === 'invert') invertSelected(id);
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
    const data = playOrderData(clip.kind, clip.kind === 'd'
        ? { lanes: snapshotDrumSlot(clip.source) }
        : snapshotSynthSlot(clip.kind, clip.source));
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

function reverseSelected(id) {
    if (reverseClip(state.song, id)) noteEdit();
}

function invertSelected(id) {
    if (invertClip(state.song, id)) noteEdit();
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
    drawGrid();
    root.querySelectorAll('canvas[data-role]').forEach(drawCanvas);
    document.querySelectorAll('.arrange-ghost canvas').forEach(drawCanvas);
}

function drawCanvas(canvas) {
    if (!canvas || canvas.closest('[hidden]')) return;
    const box = canvasBox(canvas);
    if (!box) return;
    const { ctx, w, h } = box;
    if (canvas.dataset.role === 'clip') {
        let clip = findClip(canvas.dataset.id);
        if (!clip) return;
        if (drawOverride?.id === clip.id) clip = { ...clip, ...drawOverride };
        // Clips draw at the timeline's tick scale and play their pattern once: the
        // edges crop it, and space past the pattern (or before it) stays empty.
        const geom = {
            tickPx: pxPerBar / BAR_TICKS,
            lead: clipPlaySpan(clip).origin - clip.startTick,
            cycle: clipPatternTicks(clip),
        };
        // The selected clip's notes light cyan, matching its frame. Only on the timeline:
        // a copy carried to the bank stays green on black.
        const ink = canvas.closest('.arrange-clip.is-selected') ? '#00e5ff' : '#00ff00';
        if (clip.kind === 'notes') drawNotes(ctx, w, h, clip, geom, ink);
        else if (clip.kind === 'b') drawRows(ctx, w, h, clip.data?.lanes, 8, ink, geom);
        else if (clip.kind === 'd') drawRows(ctx, w, h, clip.data?.lanes, 4, ink, geom);
        else drawNormal(ctx, w, h, clip.data, ink, geom);
        return;
    }
    const kind = canvas.dataset.kind;
    const slot = canvas.dataset.slot | 0;
    // Bank pads are lit green, so their note preview is black.
    const color = canvas.dataset.role === 'bank' ? '#000' : '#00ff00';
    if (kind === 'd') drawRows(ctx, w, h, snapshotDrumSlot(slot), 4, color);
    else if (kind === 'b') drawRows(ctx, w, h, snapshotSynthSlot('b', slot)?.lanes, 8, color);
    else drawNormal(ctx, w, h, snapshotSynthSlot('n', slot), color);
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

// Where each step goes. Bank pads (no geom) fit one pass to the box. Clips place
// steps on the timeline from the pattern origin and stop at the end of one cycle.
function stepCells(w, count, division, geom) {
    if (!geom) return { cell: w / count, total: count, x0: 0 };
    const stepTicks = clipStepTicks({ kind: 'n', data: { division } });
    return {
        cell: stepTicks * geom.tickPx,
        total: Math.max(1, Math.floor(geom.cycle / stepTicks + 1e-6)),
        x0: geom.lead * geom.tickPx,
    };
}

function drawNormal(ctx, w, h, data, color = '#00ff00', geom = null) {
    const steps = data?.steps || [];
    const count = Math.max(1, Math.min(32, data?.stepCount || 8));
    const { cell, total, x0 } = stepCells(w, count, data?.division, geom);
    const noteH = Math.max(2, Math.min(5, h / 12));
    ctx.fillStyle = color;
    for (let k = 0; k < total; k += 1) {
        const x = x0 + k * cell;
        if (x + cell <= 0) continue;
        if (x >= w) break;
        // The timeline shows what plays: a clip still carrying Reverse draws back to front.
        const i = geom && data?.reverse ? count - 1 - (k % count) : k % count;
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
            ctx.fillRect(x + 0.5, y - noteH, Math.max(1, cell - 1.5), noteH);
        }
    }
}

function drawRows(ctx, w, h, lanes, rowCount, color = '#00ff00', geom = null) {
    const rowH = h / rowCount;
    ctx.fillStyle = color;
    for (let row = 0; row < rowCount; row += 1) {
        const lane = lanes?.[row];
        if (!lane) continue;
        const count = Math.max(1, Math.min(32, lane.stepCount || 8));
        const steps = lane.steps || [];
        const { cell, total, x0 } = stepCells(w, count, lane.division, geom);
        for (let k = 0; k < total; k += 1) {
            const x = x0 + k * cell;
            if (x + cell <= 0) continue;
            if (x >= w) break;
            const i = geom && lane.reverse ? count - 1 - (k % count) : k % count;
            if (!steps[i] || steps[i].on === false) continue;
            ctx.fillRect(x + 0.4, row * rowH + 1, Math.max(1, cell - 1), Math.max(1, rowH - 2));
        }
    }
}

function drawNotes(ctx, w, h, clip, geom = null, color = '#00ff00') {
    const notes = clip?.notes || [];
    const scale = geom ? geom.tickPx : w / Math.max(1, clip?.lengthTick || 1);
    const lead = geom ? geom.lead : 0;
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
    ctx.fillStyle = color;
    for (const note of notes) {
        const semi = Number(note.semi);
        if (!Number.isFinite(semi)) continue;
        const x = (Math.max(0, Number(note.startTick) || 0) + lead) * scale;
        const width = Math.max(2, (Number(note.durTick) || 240) * scale);
        const y = h - ((semi - minSemi) / span) * (h - noteH) - noteH;
        ctx.fillRect(x, y, width, noteH);
    }
}
