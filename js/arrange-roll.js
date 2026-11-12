// Step piano roll for one arrangement clip. Writes clip.data only.
// markEdited runs once per gesture, before the mutation.

import { state } from './state.js?v=120';
import { markEdited, reverseClip, invertClip, transposeClip, clipTransposeRoom, checkpointUndo, clipCycleTicks, clipPlaySpan, clipStartOffset, clipStepTicks, findClipById, BAR_TICKS } from './song-model.js?v=14';
import {
    POLY_CHORD_MAX,
    chordFromCellNotes,
    clampChord,
    cloneStep,
    stepCellNotes,
} from './pattern-bank.js?v=51';
import { nextRatch } from './step-ratch.js?v=1';
import { semitonesToNoteName, getActiveScale, getStepTotalTuneFromRaw } from './tuning.js?v=108';
import { previewChordVisualizer } from './visualizers.js?v=150';
import { subscribe } from './params.js?v=44';
import { placeArrangementInsert } from './song-conductor.js?v=34';
import { refreshArrange, setArrangeLoop, setArrangeRollOpener, toggleClipReverse } from './arrange-view.js?v=61';
import { createIngyWindow } from './ingy-window.js?v=3';
import { pressKey, releaseKey, heldNoteDown, heldNoteUp } from './keyboard.js?v=277';
import { needsHeldNoteSet } from './held-notes.js?v=13';
import { auditionDrumHit } from './sequencer.js?v=459';

const TUNE_LO = -39;
const TUNE_HI = 48;
const WINDOW_ROWS = 24;
const ROW_MIN = 12;
const ROW_MIN_TOUCH = 18;
const ROW_MAX = 22;

const LANE_NAMES = ['O1', 'O2', 'O3', 'O4', 'M1', 'M2', 'M3', 'M4'];
const PROP_ROWS = [
    { key: 'accent', name: 'Accent', short: 'Acc' },
    { key: 'slide', name: 'Slide', short: 'Sld' },
    { key: 'ratch', name: 'Ratchet', short: 'Rat' },
    { key: 'on', name: 'On/Off', short: 'On' },
];

let roll;
let propsEl;
let plabelsEl;
let playBtn;
let stopBtn;
let loopBtn;
let playLine = null;
let playKey = '';
let lastTick = NaN;
let propPaint = null;
// Loop clip: the song loop as it was before, and the range the roll set.
let loopClipId = null;
let loopSaved = null;
let loopApplied = null;
let foldBtn;
let monoBtn;
let transposeEl;
// Up / Down transpose only while the roll was the last thing pressed.
let rollActive = false;
// Note entry: Mono writes one note per step, Poly stacks a chord. It arms to the
// loaded synth (Ingy 6 / Multitudes are poly) and the user can flip it; either way
// existing chords (recorded MIDI dropped on a P square) stay as they are.
let polyEdit = false;
let polyArmedFor = null;
let rowTunes = [];
// Fold: only rows that hold notes (Ableton's Fold). Scale: only the project
// scale's rows; it turns on with the project scale and follows it.
let foldNotes = false;
// Key-click selection (Ableton): a key press selects that pitch's notes; a 6px+ drag makes a range.
let keySel = null;
let stepsOn = false;
let onRevPattern = null;  // Steps view: Rev goes through the step strip      // Steps view: the step strip in place of the grid
let scaleView = false;
let win;
let scroller;
let sheet;
let headsEl;
let keysEl;
let gridEl;
let lanesEl;
let hintEl;
let openId = null;
let laneIndex = 0;
let selectedCol = 0;
let rowPx = 16;
let rendering = false;
let session = null;
let dragY = 0;
let dragRAF = 0;
let audition = null;
// Preview (Ableton's headphones): notes sound as they are written, pressed or dragged.
// The piano keys always sound. Remembered per browser.
const PREVIEW_KEY = 'ingysynth.rollPreview';
let previewOn = readPreview();
let previewBtn;
// Notes-clip editing (paintNotes): selected note objects, view geometry, the length a
// new note gets (the last one resized), and the last note pressed (double-click delete).
const NOTE_GRID = 240;
const NOTE_BAR_PX = 160;
const NOTES_HINT = 'Click to add a note · drag empty space to select · drag a note to move · drag its end to resize · double-click or Delete removes · Alt: no snap';
const DRAW_HINT = 'Draw: click or drag to paint notes · start on a note to erase · Alt: no snap';
// Draw tool (pencil): a press writes and a drag keeps writing, one undo step per stroke;
// a stroke that starts on a note erases instead. Remembered per browser.
const DRAW_KEY = 'ingysynth.rollDraw';
let drawOn = readFlag(DRAW_KEY, false);
let drawBtn;
let paint = null;
let noteSel = new Set();
let notesGeom = null;
let lastNoteLen = NOTE_GRID;
let lastNoteClick = null;
// Box selection in the step grid: cellKey() of each selected note of the open clip
// (and Berlin lane). A key whose note is gone drops out when the grid repaints.
let stepSel = new Set();
let marquee = null;

export function arrangeRollIsOpen() {
    return openId != null;
}

export function closeArrangeRoll() {
    if (openId == null) return;
    cancelSession();
    cancelMarquee();
    cancelPropPaint();
    endPaint();
    stopAudition();
    releaseLoopClip();
    openId = null;
    playKey = '';
    win?.close();
    document.dispatchEvent(new CustomEvent('ingysynth:arrange-roll-closed'));
}

export function initArrangeRoll() {
    const view = document.getElementById('arrangeView');
    if (!view || document.getElementById('arrangeRoll')) {
        setArrangeRollOpener(openArrangeRoll);
        return;
    }
    roll = document.createElement('div');
    roll.id = 'arrangeRoll';
    roll.className = 'arrange-roll';
    roll.setAttribute('role', 'region');
    roll.setAttribute('aria-label', 'Step piano roll');
    roll.innerHTML = `
        <div class="arrange-roll-bar">
            <div class="arrange-roll-transport" role="group" aria-label="Transport">
                <button type="button" id="arrangeRollPreview" class="arrange-btn arrange-btn-icon" aria-pressed="true" aria-label="Preview" title="Preview: hear notes as you write or drag them"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M0.6 4.6h3L8.6 0v16L3.6 11.4H0.6z"/><path class="arrange-icon-waves" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M11 3.6a4.2 4.2 0 0 1 0 8.8"/><path class="arrange-icon-mute" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M1.4 1.4l13.2 13.2"/></svg></button>
                <button type="button" id="arrangeRollPlay" class="arrange-btn arrange-btn-icon" aria-pressed="false" aria-label="Play"><span class="arrange-icon-play" aria-hidden="true"></span></button>
                <button type="button" id="arrangeRollStop" class="arrange-btn arrange-btn-icon" aria-label="Stop"><span class="arrange-icon-stop" aria-hidden="true"></span></button>
                <button type="button" id="arrangeRollLoop" class="arrange-btn arrange-btn-icon" aria-pressed="false" aria-label="Loop clip" title="Loop the song around this clip"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V6.5A2.5 2.5 0 0 1 5.5 4H12"/><path d="M10 2l2 2-2 2"/><path d="M13 9v.5A2.5 2.5 0 0 1 10.5 12H4"/><path d="M6 14l-2-2 2-2"/></svg></button>
                <button type="button" id="arrangeRollDraw" class="arrange-btn arrange-btn-icon" aria-pressed="false" aria-label="Draw" title="Draw: click or drag to paint notes. Start on a note to erase"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M1.6 14.4l0.9-3.6 8.6-8.6 2.7 2.7-8.6 8.6z"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M9.4 3.9l2.7 2.7M2.5 10.8l2.7 2.7"/></svg></button>
                <button type="button" id="arrangeRollReverse" class="arrange-btn" title="Play this clip's notes backwards" aria-label="Reverse">Rev</button>
                <button type="button" id="arrangeRollInvert" class="arrange-btn" title="Turn the melody upside down: high notes become low" aria-label="Invert">Inv</button>
                <div id="arrangeRollTranspose" class="arrange-roll-transpose" role="group" aria-label="Transpose">
                    <button type="button" class="arrange-btn" data-transpose="-12" aria-label="Transpose down an octave" title="Down an octave (Shift + Down arrow)">-12</button>
                    <button type="button" class="arrange-btn" data-transpose="-1" aria-label="Transpose down a semitone" title="Down a semitone (Down arrow)">-1</button>
                    <button type="button" class="arrange-btn" data-transpose="1" aria-label="Transpose up a semitone" title="Up a semitone (Up arrow)">+1</button>
                    <button type="button" class="arrange-btn" data-transpose="12" aria-label="Transpose up an octave" title="Up an octave (Shift + Up arrow)">+12</button>
                </div>
                <button type="button" id="arrangeRollMono" class="arrange-btn" title="Mono: one note at a time. Click for Poly" hidden>Mono</button>
            </div>
            <div id="arrangeRollLanes" class="arrange-roll-lanes" role="tablist" aria-label="Berlin lanes" hidden></div>
        </div>
        <p id="arrangeRollHint" class="arrange-roll-hint" hidden>Drag onto a P square to edit as a pattern</p>
        <div class="arrange-roll-scroller" id="arrangeRollScroll">
            <div class="arrange-roll-sheet" id="arrangeRollSheet">
                <div class="arrange-roll-corner"><button type="button" id="arrangeRollFold" class="arrange-roll-rowmode" aria-label="Rows: every key" title="Rows: every key. Click for the scale's notes or only the notes in use">Keys</button></div>
                <div class="arrange-roll-heads" id="arrangeRollHeads"></div>
                <div class="arrange-roll-keys" id="arrangeRollKeys"></div>
                <div class="arrange-roll-grid" id="arrangeRollGrid"></div>
                <div class="arrange-roll-pcorner" id="arrangeRollPLabels" aria-hidden="true">
                    ${PROP_ROWS.map((row) => `<div class="arrange-roll-plabel"><span class="is-full">${row.name}</span><span class="is-short">${row.short}</span></div>`).join('')}
                </div>
                <div class="arrange-roll-props" id="arrangeRollProps" role="group" aria-label="Accent, slide and ratchet per step"></div>
            </div>
        </div>
    `;
    win = createIngyWindow({
        id: 'arrangeRoll',
        title: 'Piano Roll',
        label: 'Step piano roll',
        width: 820,
        height: 480,
        onClose: () => closeArrangeRoll(),
    });
    win.el.classList.add('arrange-roll-window');
    win.body.appendChild(roll);

    scroller = roll.querySelector('#arrangeRollScroll');
    sheet = roll.querySelector('#arrangeRollSheet');
    headsEl = roll.querySelector('#arrangeRollHeads');
    keysEl = roll.querySelector('#arrangeRollKeys');
    gridEl = roll.querySelector('#arrangeRollGrid');
    lanesEl = roll.querySelector('#arrangeRollLanes');
    hintEl = roll.querySelector('#arrangeRollHint');
    propsEl = roll.querySelector('#arrangeRollProps');
    plabelsEl = roll.querySelector('#arrangeRollPLabels');
    playBtn = roll.querySelector('#arrangeRollPlay');
    stopBtn = roll.querySelector('#arrangeRollStop');
    loopBtn = roll.querySelector('#arrangeRollLoop');
    foldBtn = roll.querySelector('#arrangeRollFold');
    previewBtn = roll.querySelector('#arrangeRollPreview');
    syncPreviewBtn();
    previewBtn.addEventListener('click', () => {
        previewOn = !previewOn;
        writePreview(previewOn);
        syncPreviewBtn();
        if (!previewOn) stopAudition();
    });
    drawBtn = roll.querySelector('#arrangeRollDraw');
    syncDrawBtn();
    drawBtn.addEventListener('click', () => {
        drawOn = !drawOn;
        writeFlag(DRAW_KEY, drawOn);
        syncDrawBtn();
    });
    monoBtn = roll.querySelector('#arrangeRollMono');
    transposeEl = roll.querySelector('#arrangeRollTranspose');

    // Same buttons as the arrange transport. Play first moves the insert marker to
    // the open clip's start (opening the clip by double-tap leaves it where you
    // tapped), so the roll always plays its clip from the top and Stop returns there.
    playBtn.addEventListener('click', () => {
        const clip = findClip(openId);
        if (clip && !state.songCountIn) placeArrangementInsert(Math.max(0, clip.startTick | 0));
        document.getElementById('arrangePlay')?.click();
    });
    stopBtn.addEventListener('click', () => document.getElementById('arrangeStop')?.click());
    loopBtn.addEventListener('click', toggleLoopClip);
    // The corner cell cycles which rows show: every key → the project scale's notes (when a scale is on)
    // → only the notes in use (REAPER-style fold) → every key.
    foldBtn.addEventListener('click', () => {
        const mode = rowMode(findClip(openId));
        if (mode === 'keys') {
            if (scaleDegrees()) scaleView = true;
            else foldNotes = true;
        } else if (mode === 'scale') {
            foldNotes = true;
        } else {
            foldNotes = false;
            scaleView = false;
        }
        if (openId != null) render({ jump: true });
    });
    // Same as Reverse on the clip's timeline menu. A pattern clip has the hardware Reverse switch (its
    // steps play back to front, and it goes back to the pad with Reverse on); a notes clip is mirrored.
    // Either way a second press undoes it, so the button stays lit while it's on.
    roll.querySelector('#arrangeRollReverse').addEventListener('click', () => {
        if (openId == null) return;
        const clip = findClip(openId);
        if (clip && (clip.kind === 'n' || clip.kind === 'b')) {
            if (onRevPattern) onRevPattern();
            else if (!toggleClipReverse(openId)) return;
        } else if (!reverseClip(state.song, openId)) return;
        selectedCol = 0;
        stepSel.clear();
        refreshArrange();
    });
    // Same as Invert on the clip's timeline menu.
    roll.querySelector('#arrangeRollInvert').addEventListener('click', () => {
        if (openId == null || !invertClip(state.song, openId)) return;
        stepSel.clear();
        refreshArrange();
    });
    transposeEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-transpose]');
        if (button) transposeOpenClip(Number(button.dataset.transpose));
    });
    document.addEventListener('pointerdown', (event) => {
        rollActive = event.target instanceof Node && win.el.contains(event.target);
    }, true);
    monoBtn.addEventListener('click', () => setPolyEdit(!polyEdit));
    // Loading or leaving a poly synth re-arms the switch. Bare Metal announces it;
    // the web doesn't, so the roll also checks before every press and render.
    document.addEventListener('ingysynth:native-flags', () => {
        queueMicrotask(() => {
            if (openId != null) syncVoiceBtns(findClip(openId));
        });
    });
    roll.addEventListener('pointerdown', () => syncVoiceBtns(findClip(openId)), true);
    const onScale = () => {
        scaleView = !!scaleDegrees();
        if (openId != null) render({ jump: true });
    };
    subscribe('scaleToggle', onScale);
    subscribe('scaleSelect', onScale);
    propsEl.addEventListener('pointerdown', onPropDown);
    lanesEl.addEventListener('click', onLaneClick);
    document.addEventListener('ingysynth:sequencer-start', syncTransport);
    document.addEventListener('ingysynth:sequencer-stop', syncTransport);
    document.addEventListener('ingysynth:arrange-transport', syncTransport);
    document.addEventListener('ingysynth:song-tick', (event) => {
        if (state.songOneShot) return;
        lastTick = Number(event.detail?.tick);
        if (openId != null) paintPlayhead();
    });
    keysEl.addEventListener('pointerdown', onKeyDown);
    scroller.addEventListener('pointerdown', onPointerDown);
    roll.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', onRollKey, true);
    document.addEventListener('ingysynth:arrange-render', () => {
        if (openId == null) return;
        if (!findClip(openId)) {
            closeArrangeRoll();
            return;
        }
        reconcileLoopClip();
        render({ jump: false });
    });
    const observer = new ResizeObserver(() => {
        if (openId == null || rendering) return;
        const clip = findClip(openId);
        if (!clip || clip.kind === 'd') return;
        const next = measureRow(clip);
        if (next && next !== rowPx) render({ jump: false });
    });
    observer.observe(roll);
    setArrangeRollOpener(openArrangeRoll);
}

function onRollKey(event) {
    if (openId == null) return;
    const el = event.target instanceof Element ? event.target : null;
    if (el?.closest('input, textarea, [contenteditable="true"]')) return;
    const clip = findClip(openId);
    if (clip && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
        if (clip.kind === 'notes') {
            noteSel = new Set(clip.notes || []);
            render({ jump: false });
        } else {
            selectAllSteps();
        }
        return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        // Write mode and focused knobs, sliders and tabs keep their arrows.
        if (!rollActive || state.keyboardWrite || clip?.kind === 'd') return;
        if (el?.closest('select, [role="slider"], [role="spinbutton"], [role="tab"], [role="radio"], [role="listbox"], [role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        transposeOpenClip((event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 12 : 1));
        return;
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    event.stopPropagation();
    if (clip?.kind === 'notes') deleteSelectedNotes();
    else deleteSelectedSteps();
}

function openArrangeRoll(id) {
    const clip = findClip(id);
    if (!clip || !roll) return;
    if (openId !== id) {
        // An oscillator row clip opens on the lane it plays.
        laneIndex = clip.kind === 'b' && Number.isInteger(clip.row) ? clip.row : 0;
        selectedCol = 0;
        noteSel = new Set();
        stepSel.clear();
    }
    const wasOpen = openId != null;
    openId = id;
    if (!wasOpen) {
        scaleView = !!scaleDegrees();
        polyArmedFor = null;
    }
    // Loop clip starts on each time the roll opens; switching clips while open keeps the user's choice.
    if (!wasOpen && !loopClipId) engageLoopClip(clip);
    else if (loopClipId && loopClipId !== id) applyLoopClip(clip);
    win.open();
    rollActive = true;
    syncTransport();
    render({ jump: true });
    // A freshly shown window can settle its height a frame later; centre on the notes again then.
    requestAnimationFrame(() => {
        if (openId === id) render({ jump: true });
    });
}

function findClip(id) {
    const song = state.song;
    if (!song || !id) return null;
    return findClipById(song, id);
}

function clampCount(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 8;
    return Math.max(1, Math.min(32, v));
}

function measureRow(clip) {
    const height = scroller?.clientHeight || 0;
    if (height < 48) return 0;
    const header = headsEl?.offsetHeight || 18;
    // The step roll keeps the piano roll's row height: its Acc / Sld / Rat rows stay stuck to the
    // bottom and the grid scrolls under them, instead of every row shrinking to make room.
    const props = 0;
    // Fingers need taller rows than a mouse; a short phone screen scrolls instead of shrinking past that.
    const min = window.matchMedia('(pointer: coarse)').matches ? ROW_MIN_TOUCH : ROW_MIN;
    // Folded to the pitches in use (REAPER style), a short list gets taller rows (up to ROW_MAX)
    // instead of sitting in a band of empty space. The Acc / Sld rows come out of the room here.
    if (foldNotes && clip && (clip.kind === 'n' || clip.kind === 'b')) {
        const n = new Set(clipPitches(clip)).size;
        if (n > 0) return Math.max(min, Math.min(ROW_MAX, Math.floor((height - header - (PROP_ROWS.length * 16 + 1)) / n)));
    }
    return Math.max(min, Math.min(ROW_MAX, Math.floor((height - header - props) / WINDOW_ROWS)));
}

function render({ jump }) {
    const clip = findClip(openId);
    if (!clip || !roll) {
        if (openId != null) closeArrangeRoll();
        return;
    }
    if (rendering) return;
    rendering = true;
    const keepTop = scroller.scrollTop;
    const keepLeft = scroller.scrollLeft;
    try {
        roll.dataset.kind = clip.kind;
        roll.classList.toggle('is-drums', clip.kind === 'd');
        roll.classList.toggle('is-notes', clip.kind === 'notes');
        // A roll locked to steps (pattern and drum clips) is the Step Roll; free notes are the Piano Roll.
        win.setTitle(clip.kind === 'notes' ? `Piano Roll · ${clipTitle(clip)}` : `Step Roll - ${clipTitle(clip)}`);
        hintEl.hidden = true;   // no hint line: the tools' tooltips say how they work
        if (clip.kind !== 'notes') {
            sheet.style.width = '';
            notesGeom = null;
        }
        paintLanes(clip);
        const measured = measureRow(clip);
        if (measured) rowPx = measured;
        sheet.style.setProperty('--row', `${rowPx}px`);
        if (clip.kind === 'd') paintDrums(clip);
        else if (clip.kind === 'notes') paintNotes(clip);
        else paintPitch(clip);
        paintRowShade();
        paintStepSel();
        paintProps(clip);
        syncFoldBtn(clip);
        syncVoiceBtns(clip);
        syncRevInv(clip);
        playLine = document.createElement('div');
        playLine.className = 'arrange-roll-playcol';
        playLine.hidden = true;
        gridEl.appendChild(playLine);
        playKey = '';
        paintPlayhead();
        syncLoopBtn();
        syncTools();
    } finally {
        rendering = false;
    }
    requestAnimationFrame(fitWindowToRows);
    if (jump && clip.kind !== 'd') scrollToPitches(clipPitches(clip));
    else if (!jump) {
        scroller.scrollTop = keepTop;
        scroller.scrollLeft = keepLeft;
    }
}

function clipTitle(clip) {
    if (clip.kind === 'notes') return clip.name || 'Rec';
    const star = clip.edited ? '*' : '';
    const name = `P${(clip.source | 0) + 1}${star}`;
    if (clip.kind === 'b') return `${name} ${LANE_NAMES[laneIndex] || 'O1'}`;
    return name;
}

function paintLanes(clip) {
    const show = clip.kind === 'b';
    lanesEl.hidden = !show;
    lanesEl.replaceChildren();
    if (!show) return;
    // A row clip plays one oscillator: its other oscillators are not offered, its mod lanes are.
    const own = Number.isInteger(clip.row) ? clip.row : null;
    LANE_NAMES.forEach((name, index) => {
        if (own != null && index < 4 && index !== own) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arrange-roll-tab';
        button.dataset.lane = String(index);
        button.setAttribute('role', 'tab');
        button.textContent = name;
        button.setAttribute('aria-selected', index === laneIndex ? 'true' : 'false');
        if (index === laneIndex) button.classList.add('is-on');
        lanesEl.appendChild(button);
    });
}

function onLaneClick(event) {
    const button = event.target.closest('[data-lane]');
    if (!button) return;
    const next = button.dataset.lane | 0;
    if (next === laneIndex) return;
    laneIndex = next;
    selectedCol = 0;
    stepSel.clear();
    render({ jump: true });
}

// `count` is the pattern's own steps; `cols` adds the columns of any space the clip was
// lengthened by, which a write grows the pattern into (see growPattern).
function patternOf(clip) {
    if (!clip) return null;
    if (clip.kind === 'n') {
        const count = clampCount(clip.data?.stepCount);
        return {
            steps: clip.data?.steps || [],
            count,
            cols: viewCols(clip, count, clipStepTicks(clip), clip.data?.repeat),
        };
    }
    if (clip.kind === 'b') {
        const lane = clip.data?.lanes?.[laneIndex];
        if (!lane) return { steps: [], count: 8, cols: 8 };
        const count = clampCount(lane.stepCount);
        return {
            steps: lane.steps || [],
            count,
            cols: viewCols(clip, count, laneTicks(lane), clip.data?.repeat),
        };
    }
    return null;
}

// Columns the clip covers in a lane's steps: the pattern, plus the empty space a longer
// clip adds after it (up to 32 steps). Repeating patterns show their own steps only.
function viewCols(clip, count, stepTicks, repeat) {
    if ((Math.round(Number(repeat)) || 1) > 1 || !(stepTicks > 0)) return count;
    const reach = clipStartOffset(clip) + (Number(clip.lengthTick) || 0);
    return Math.max(count, Math.min(32, Math.ceil(reach / stepTicks - 1e-6)));
}

// Writing into the added space: the pattern grows to reach `col`, with rests between.
function growPattern(target, col) {
    if (!target || col < clampCount(target.stepCount)) return;
    if (!Array.isArray(target.steps)) target.steps = [];
    for (let i = clampCount(target.stepCount); i <= col; i += 1) {
        target.steps[i] = { ...cloneStep(null), on: false };
    }
    target.stepCount = col + 1;
}

function patternTarget(clip) {
    if (clip?.kind === 'n') return clip.data;
    if (clip?.kind === 'b') return clip.data?.lanes?.[laneIndex];
    return null;
}

// A step turned off with On/Off keeps its notes (playback rests it); the roll shows
// them greyed. An off step still at the default rest (tune 0, no chord, no accent,
// slide or ratchet) is an empty step. Deleting the last note writes exactly that.
function isBlankRest(step) {
    if (!step) return true;
    if (step.on !== false) return false;
    return Math.round(Number(step.tune) || 0) === 0
        && clampChord(step.chord).length === 0
        && !step.accent && !step.slide
        && Math.round(Number(step.ratch) || 1) <= 1;
}

function columnPitches(step) {
    if (!step || step.on === false) return [];
    return viewPitches(step);
}

// Notes the grid draws for a step: sounding ones, or the greyed notes of an off step.
function viewPitches(step) {
    if (isBlankRest(step)) return [];
    const out = [];
    const seen = new Set();
    for (const n of stepCellNotes(step)) {
        const v = Math.round(Number(n));
        if (!Number.isFinite(v) || v < TUNE_LO || v > TUNE_HI || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

// Every note the step holds, including any outside the roll's rows, so an edit
// never drops notes it can't show.
function stepPitches(step) {
    if (isBlankRest(step)) return [];
    return [...new Set(stepCellNotes(step).map((n) => Math.round(Number(n))).filter(Number.isFinite))];
}

function clipPitches(clip) {
    if (clip.kind === 'notes') {
        const out = [];
        for (const note of clip.notes || []) {
            const semi = Math.round(Number(note.semi));
            if (!Number.isFinite(semi)) continue;
            out.push(Math.max(TUNE_LO, Math.min(TUNE_HI, semi)));
        }
        return out;
    }
    const pattern = patternOf(clip);
    if (!pattern) return [];
    const out = [];
    for (let i = 0; i < pattern.count; i += 1) out.push(...viewPitches(pattern.steps[i]));
    return out;
}

function isBlack(tune) {
    const pc = ((tune % 12) + 12) % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function paintPitch(clip) {
    const pattern = patternOf(clip);
    const count = pattern?.count || 8;
    const cols = pattern?.cols || count;
    if (selectedCol >= cols) selectedCol = 0;
    const steps = pattern?.steps || [];
    sheet.style.setProperty('--cols', String(cols));
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    gridEl.replaceChildren();
    for (let col = 0; col < cols; col += 1) {
        headsEl.appendChild(markExt(headCell(col, col < count ? steps[col] : null), col, count));
    }
    const degrees = scaleDegrees();
    const used = new Set(clipPitches(clip));
    const byNotes = foldNotes && used.size > 0;
    const byScale = !byNotes && scaleView && !!degrees;
    rowTunes = [];
    for (let tune = TUNE_HI; tune >= TUNE_LO; tune -= 1) {
        if (byNotes ? used.has(tune) : (!byScale || inScale(tune, degrees) || used.has(tune))) rowTunes.push(tune);
    }
    if (byNotes || byScale) paintFoldKeys(degrees);
    else paintKeyboard();
    for (const tune of rowTunes) {
        const out = !!degrees && !inScale(tune, degrees);
        for (let col = 0; col < cols; col += 1) {
            const step = col < count ? steps[col] : null;
            const pitches = viewPitches(step);
            const on = pitches.includes(tune);
            const cell = markExt(pitchCell(col, tune, on, step), col, count);
            if (out) cell.classList.add('is-out');
            gridEl.appendChild(cell);
        }
    }
}

// Scale degrees count from step tune 0 (the root), the same way quantizeStepTune snaps.
function scaleDegrees() {
    const scale = getActiveScale();
    if (!scale || scale.id === 'chromatic' || !Array.isArray(scale.degrees)) return null;
    return scale.degrees;
}

function inScale(tune, degrees) {
    return degrees.includes(((tune % 12) + 12) % 12);
}

// Which rows the step roll shows: 'fold' (notes in use), 'scale' (the project scale) or 'keys' (all).
function rowMode(clip) {
    const pitched = clip?.kind === 'n' || clip?.kind === 'b';
    if (!pitched) return 'keys';
    if (foldNotes) return 'fold';
    return scaleView && scaleDegrees() ? 'scale' : 'keys';
}

const ROW_MODES = {
    keys: ['Keys', 'Rows: every key. Click for the scale\'s notes or only the notes in use'],
    scale: ['Scale', 'Rows: the project scale. Click for only the notes in use'],
    fold: ['Fold', 'Rows: only the notes in use. Click for every key'],
};

// Rev and Inv light while the clip is reversed / inverted (each undoes itself on a second press).
function syncRevInv(clip) {
    const rev = roll.querySelector('#arrangeRollReverse');
    const inv = roll.querySelector('#arrangeRollInvert');
    rev.classList.toggle('is-on', !!clip?.reversed);
    rev.setAttribute('aria-pressed', clip?.reversed ? 'true' : 'false');
    inv.classList.toggle('is-on', !!clip?.inverted);
    inv.setAttribute('aria-pressed', clip?.inverted ? 'true' : 'false');
}

function syncFoldBtn(clip) {
    const pitched = clip?.kind === 'n' || clip?.kind === 'b';
    const mode = rowMode(clip);
    foldBtn.hidden = !pitched;
    roll.querySelector('#arrangeRollInvert').hidden = clip?.kind === 'd';
    syncTransposeBtns(clip);
    const [label, title] = ROW_MODES[mode];
    foldBtn.textContent = label;
    foldBtn.title = title;
    foldBtn.setAttribute('aria-label', title.split('.')[0]);
    foldBtn.classList.toggle('is-on', mode !== 'keys');
}

// Folded (Fold or Scale), the window fits its height to the rows (never taller than its own size; more
// rows than fit scroll). Back on every key, it goes back to its own height.
function fitWindowToRows() {
    if (!win?.fitHeight || stepsOn) return;
    if (!keysEl.classList.contains('is-fold')) {
        win.fitHeight(null);
        return;
    }
    const h = (n) => n?.getBoundingClientRect().height || 0;
    win.fitHeight(h(roll.querySelector('.arrange-roll-bar')) + h(headsEl) + h(keysEl) + h(propsEl) + 2, { shrink: true });
}

// What the transpose buttons move: the selected notes of a recorded clip (all of them
// when none is selected), the lane shown for Berlin, the whole pattern otherwise.
function transposeOptions(clip) {
    if (clip?.kind === 'notes') return noteSel.size ? { notes: noteSel } : {};
    return clip?.kind === 'b' ? { lane: laneIndex } : {};
}

// A button is off when its move would push a note off the keyboard.
function syncTransposeBtns(clip) {
    if (!transposeEl) return;
    transposeEl.hidden = !clip || clip.kind === 'd';
    if (transposeEl.hidden) return;
    const room = clipTransposeRoom(state.song, clip.id, transposeOptions(clip));
    for (const button of transposeEl.querySelectorAll('[data-transpose]')) {
        const by = Number(button.dataset.transpose);
        button.disabled = by > 0 ? by > room.up : -by > room.down;
    }
}

function transposeOpenClip(semis) {
    const clip = findClip(openId);
    if (!clip || session || propPaint) return false;
    if (!transposeClip(state.song, openId, semis, transposeOptions(clip))) return false;
    // The whole pattern moved: a box selection goes with its notes.
    if (clip.kind !== 'notes') shiftStepSel(semis);
    refreshArrange();
    const now = findClip(openId);
    if (now) revealPitches(clipPitches(now));
    return true;
}

// Scrolls only when the notes have left the view, so a small move reads as the notes moving.
function revealPitches(pitches) {
    if (!pitches.length || !scroller) return;
    const fold = keysEl.classList.contains('is-fold');
    const rowOf = (tune) => (fold ? Math.max(0, rowTunes.indexOf(tune)) : TUNE_HI - tune);
    const top = rowOf(Math.max(...pitches)) * rowPx;
    const bottom = (rowOf(Math.min(...pitches)) + 1) * rowPx;
    const room = scroller.clientHeight - (headsEl.offsetHeight || 0) - (propsEl.hidden ? 0 : propsEl.offsetHeight);
    if (top < scroller.scrollTop || bottom > scroller.scrollTop + room) scrollToPitches(pitches);
}

function synthIsPoly() {
    return !!(state.keyboardPoly || state.keyboardMultitudes);
}

function setPolyEdit(on) {
    polyEdit = !!on;
    syncVoiceBtns(findClip(openId));
}

function syncVoiceBtns(clip) {
    if (!monoBtn) return;
    if (polyArmedFor !== synthIsPoly()) {
        polyArmedFor = synthIsPoly();
        polyEdit = polyArmedFor;
    }
    // One switch showing the mode (it has no "off", so it never lights); the piano roll has it too.
    const pitched = clip?.kind === 'n' || clip?.kind === 'b' || clip?.kind === 'notes';
    monoBtn.hidden = !pitched;
    monoBtn.textContent = polyEdit ? 'Poly' : 'Mono';
    monoBtn.title = polyEdit
        ? 'Poly: notes stack (up to six per step). Click for Mono'
        : 'Mono: one note at a time; a new note ends the one under it. Click for Poly';
    monoBtn.setAttribute('aria-label', `Voice: ${polyEdit ? 'Poly' : 'Mono'}`);
}

// Mono in the piano roll plays like a mono synth: a new note ends the note sounding when it starts,
// and notes that start inside it go. Poly leaves notes stacked.
function monoMakeRoom(clip, start, dur) {
    if (polyEdit || !clip?.notes) return;
    const end = start + dur;
    clip.notes = clip.notes.filter((n) => !(n.startTick >= start && n.startTick < end));
    for (const n of clip.notes) {
        if (n.startTick < start && n.startTick + n.durTick > start) n.durTick = start - n.startTick;
    }
}

// Folded rows (Fold or Scale): one piano key per row (a black key sits over a white strip,
// as on the full keyboard), labelled with its note; root labels in cyan.
function paintFoldKeys(degrees) {
    keysEl.classList.remove('is-piano');
    keysEl.classList.add('is-fold');
    keysEl.style.height = '';
    for (const tune of rowTunes) {
        const name = semitonesToNoteName(tune);
        const el = document.createElement('div');
        el.className = 'arrange-roll-fkey';
        el.dataset.tune = String(tune);
        el.title = name;
        if (isBlack(tune)) {
            el.classList.add('is-black');
            const cap = document.createElement('span');
            cap.className = 'arrange-roll-fkey-cap';
            el.appendChild(cap);
        }
        if (((tune % 12) + 12) % 12 === 0) el.classList.add('is-root');
        if (degrees && !inScale(tune, degrees)) el.classList.add('is-out');
        const label = document.createElement('span');
        label.className = 'arrange-roll-klabel';
        label.textContent = name;
        el.appendChild(label);
        keysEl.appendChild(el);
    }
    paintKeyLights();
}

function paintDrums(clip) {
    const lanes = clip.data?.lanes || [];
    let count = 1;
    for (let i = 0; i < 4; i += 1) count = Math.max(count, clampCount(lanes[i]?.stepCount));
    // Each lane can grow into space the clip was lengthened by, past every lane's end.
    const reach = (lane) => (lane ? viewCols(clip, clampCount(lane.stepCount), laneTicks(lane), 1) : 0);
    let cols = count;
    for (let i = 0; i < 4; i += 1) cols = Math.max(cols, reach(lanes[i]));
    if (selectedCol >= cols) selectedCol = 0;
    sheet.style.setProperty('--cols', String(cols));
    sheet.style.setProperty('--row', 'minmax(28px, 1fr)');
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    keysEl.classList.remove('is-piano', 'is-fold');
    keysEl.style.height = '';
    gridEl.replaceChildren();
    for (let col = 0; col < cols; col += 1) headsEl.appendChild(markExt(headCell(col, null), col, count));
    for (let row = 0; row < 4; row += 1) {
        const lane = lanes[row];
        const own = clampCount(lane?.stepCount);
        const laneReach = reach(lane);
        keysEl.appendChild(drumKey(row));
        for (let col = 0; col < cols; col += 1) {
            const ext = col >= count && col >= own && col < laneReach;
            const step = col < own ? lane?.steps?.[col] : null;
            const dim = !ext && (col >= own || !step);
            const on = !dim && !ext && step.on !== false;
            gridEl.appendChild(markExt(drumCell(row, col, on, dim), col, count));
        }
    }
}

// Notes clips (recorded takes, imported MIDI) are edited as free notes, not steps:
// click empty space to add a note, drag empty space to box-select, drag a note to move
// it, drag its right end to resize, double-click or Delete to remove. Shift adds to the
// selection, Alt/Option turns the 1/16 snap off. Positions are relative to the clip's
// origin (its start minus any start trim), like playback.
function notesSpan(clip) {
    let end = (Number(clip.lengthTick) || 0) + clipStartOffset(clip);
    for (const n of clip.notes || []) end = Math.max(end, (Number(n.startTick) || 0) + (Number(n.durTick) || 0));
    return Math.max(BAR_TICKS, Math.ceil(end / BAR_TICKS) * BAR_TICKS);
}

function paintNotes(clip) {
    sheet.style.setProperty('--cols', '1');
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    gridEl.replaceChildren();
    paintKeyboard();
    const len = notesSpan(clip);
    const keysW = keysEl.offsetWidth || 64;
    const avail = Math.max(120, (scroller.clientWidth || 600) - keysW);
    const ppt = Math.max(avail / len, NOTE_BAR_PX / BAR_TICKS);
    notesGeom = { len, ppt };
    sheet.style.width = `calc(var(--keys-w) + ${Math.ceil(len * ppt)}px)`;
    const beats = document.createElement('div');
    beats.className = 'arrange-roll-beats';
    beats.setAttribute('aria-hidden', 'true');
    beats.style.setProperty('--bar-px', `${BAR_TICKS * ppt}px`);
    beats.style.setProperty('--beat-px', `${960 * ppt}px`);
    beats.style.setProperty('--grid-px', `${NOTE_GRID * ppt}px`);
    beats.classList.toggle('is-fine', NOTE_GRID * ppt >= 8);
    // Bar numbers ride in the sticky header row, so they stay in view while scrolling pitches.
    const step = Math.max(1, Math.ceil(28 / (BAR_TICKS * ppt)));
    for (let bar = 0; bar * BAR_TICKS < len; bar += step) {
        const label = document.createElement('span');
        label.className = 'arrange-roll-barnum';
        label.style.left = `${bar * BAR_TICKS * ppt}px`;
        label.textContent = String(bar + 1);
        headsEl.appendChild(label);
    }
    gridEl.appendChild(beats);
    const layer = document.createElement('div');
    layer.className = 'arrange-roll-notes';
    const notes = clip.notes || [];
    for (const sel of [...noteSel]) if (!notes.includes(sel)) noteSel.delete(sel);
    notes.forEach((note, index) => {
        const semi = Math.round(Number(note.semi));
        if (!Number.isFinite(semi)) return;
        const bar = document.createElement('div');
        bar.className = 'arrange-roll-note';
        bar.dataset.i = String(index);
        if (noteSel.has(note)) bar.classList.add('is-sel');
        placeNoteEl(bar, note.startTick, note.durTick, semi, note.velocity);
        bar.title = semitonesToNoteName(semi);
        const end = document.createElement('div');
        end.className = 'arrange-roll-note-end';
        bar.appendChild(end);
        layer.appendChild(bar);
    });
    gridEl.appendChild(layer);
}

function placeNoteEl(el, startTick, durTick, semi, velocity) {
    const g = notesGeom;
    if (!g) return;
    const tune = Math.max(TUNE_LO, Math.min(TUNE_HI, Math.round(semi)));
    el.style.top = `${(TUNE_HI - tune) * rowPx + 1}px`;
    el.style.height = `${Math.max(4, rowPx - 2)}px`;
    el.style.left = `${Math.max(0, Number(startTick) || 0) * g.ppt}px`;
    el.style.width = `${Math.max(3, Math.max(1, Number(durTick) || 1) * g.ppt)}px`;
    const vel = Number(velocity);
    el.style.opacity = String(0.45 + 0.55 * (Number.isFinite(vel) ? Math.max(0, Math.min(1, vel)) : 0.8));
}

function noteTickAt(clientX) {
    const rect = gridEl.getBoundingClientRect();
    return (clientX - rect.left) / (notesGeom?.ppt || 1);
}

function noteTuneAt(clientY) {
    const rect = gridEl.getBoundingClientRect();
    return Math.max(TUNE_LO, Math.min(TUNE_HI, TUNE_HI - Math.floor((clientY - rect.top) / rowPx)));
}

function snapNoteTick(tick, free, mode = Math.round) {
    return free ? Math.round(tick) : mode(tick / NOTE_GRID) * NOTE_GRID;
}

function readPreview() {
    return readFlag(PREVIEW_KEY, true);
}

function writePreview(on) {
    writeFlag(PREVIEW_KEY, on);
}

function readFlag(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v !== '0';
    } catch {
        return fallback;
    }
}

function writeFlag(key, on) {
    try {
        localStorage.setItem(key, on ? '1' : '0');
    } catch { /* storage blocked: the choice lasts this session */ }
}

function syncDrawBtn() {
    if (!drawBtn) return;
    drawBtn.setAttribute('aria-pressed', drawOn ? 'true' : 'false');
    drawBtn.classList.toggle('is-on', drawOn);
    roll.classList.toggle('is-draw', drawOn);
    if (roll.classList.contains('is-notes')) hintEl.textContent = drawOn ? DRAW_HINT : NOTES_HINT;
}

function syncPreviewBtn() {
    if (!previewBtn) return;
    previewBtn.setAttribute('aria-pressed', previewOn ? 'true' : 'false');
    previewBtn.classList.toggle('is-on', previewOn);
}

function auditionNote(pointerId, tune) {
    if (!previewOn || !canAudition()) return;
    if (!audition) audition = { pointer: pointerId, tune: null, held: needsHeldNoteSet() };
    soundKey(tune);
}

// Clip grows to hold notes moved or stretched past its end.
function fitClipToNotes(clip) {
    let end = 0;
    for (const n of clip.notes) end = Math.max(end, n.startTick + n.durTick);
    const reach = end - clipStartOffset(clip);
    if (reach > (Number(clip.lengthTick) || 0)) clip.lengthTick = Math.ceil(reach / NOTE_GRID) * NOTE_GRID;
}

function commitNotes(clip) {
    clip.notes.sort((a, b) => a.startTick - b.startTick || a.semi - b.semi);
    fitClipToNotes(clip);
    refreshArrange();
}

function deleteSelectedNotes() {
    const clip = findClip(openId);
    if (!clip || clip.kind !== 'notes' || !noteSel.size) return false;
    checkpointUndo(state.song);
    clip.notes = clip.notes.filter((n) => !noteSel.has(n));
    noteSel.clear();
    commitNotes(clip);
    return true;
}

function onNotesPointerDown(event, clip) {
    if (!notesGeom || !Array.isArray(clip.notes)) return;
    if (drawOn) {
        if (event.target.closest('.arrange-roll-grid')) startNotesPaint(event, clip);
        return;
    }
    const noteEl = event.target.closest('.arrange-roll-note');
    if (!noteEl) {
        if (event.target.closest('.arrange-roll-grid')) onNotesEmptyDown(event, clip);
        return;
    }
    const x0 = event.clientX;
    const y0 = event.clientY;
    const note = clip.notes[noteEl.dataset.i | 0];
    if (!note) return;
    const now = performance.now();
    if (lastNoteClick && lastNoteClick.note === note && now - lastNoteClick.at < 350 && !event.shiftKey) {
        lastNoteClick = null;
        noteSel = new Set([note]);
        deleteSelectedNotes();
        return;
    }
    lastNoteClick = { note, at: now };
    if (event.shiftKey) {
        if (noteSel.has(note)) noteSel.delete(note);
        else noteSel.add(note);
    } else if (!noteSel.has(note)) {
        noteSel = new Set([note]);
    }
    const mode = event.target.closest('.arrange-roll-note-end') ? 'resize' : 'move';
    event.preventDefault();
    gridEl.querySelectorAll('.arrange-roll-note').forEach((el) => {
        el.classList.toggle('is-sel', noteSel.has(clip.notes[el.dataset.i | 0]));
    });
    const picked = [...noteSel].map((n) => ({
        n,
        el: gridEl.querySelector(`.arrange-roll-note[data-i="${clip.notes.indexOf(n)}"]`),
        start: n.startTick,
        dur: n.durTick,
        semi: Math.round(Number(n.semi)) || 0,
    }));
    const t0 = noteTickAt(x0);
    const tune0 = noteTuneAt(y0);
    let dTick = 0;
    let dSemi = 0;
    let dragged = false;
    auditionNote(event.pointerId, Math.round(Number(note.semi)) || 0);
    const move = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        if (!dragged && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        dragged = true;
        const freeNow = ev.altKey;
        if (mode === 'move') {
            const minStart = Math.min(...picked.map((p) => p.start));
            dTick = Math.max(-minStart, snapNoteTick(noteTickAt(ev.clientX) - t0, freeNow));
            const lo = Math.min(...picked.map((p) => p.semi));
            const hi = Math.max(...picked.map((p) => p.semi));
            dSemi = Math.max(TUNE_LO - lo, Math.min(TUNE_HI - hi, noteTuneAt(ev.clientY) - tune0));
        } else {
            dTick = snapNoteTick(noteTickAt(ev.clientX) - t0, freeNow);
        }
        for (const p of picked) {
            if (!p.el) continue;
            if (mode === 'move') placeNoteEl(p.el, p.start + dTick, p.dur, p.semi + dSemi, p.n.velocity);
            else placeNoteEl(p.el, p.start, resized(p.dur, dTick, freeNow), p.semi, p.n.velocity);
        }
        if (mode === 'move') auditionNote(ev.pointerId, (Math.round(Number(note.semi)) || 0) + dSemi);
    };
    const resized = (dur, d, freeNow) => Math.max(freeNow ? 30 : NOTE_GRID, dur + d);
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        stopAudition();
        const cancelled = ev.type === 'pointercancel';
        const changed = dragged && !cancelled && (dTick !== 0 || dSemi !== 0);
        if (changed) {
            checkpointUndo(state.song);
            for (const p of picked) {
                if (mode === 'move') {
                    p.n.startTick = p.start + dTick;
                    p.n.semi = p.semi + dSemi + ((Number(p.n.semi) || 0) - Math.round(Number(p.n.semi) || 0));
                } else {
                    p.n.durTick = resized(p.dur, dTick, ev.altKey);
                    if (picked.length === 1) lastNoteLen = p.n.durTick;
                }
            }
        }
        if (changed) commitNotes(clip);
        else render({ jump: false });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

// Empty space: a drag draws a selection box (Shift adds to the selection). A click drops
// the selection if there is one, otherwise adds a note the length of the last one resized;
// it stays unselected, so the next click adds another.
function onNotesEmptyDown(event, clip) {
    const x0 = event.clientX;
    const y0 = event.clientY;
    const shift = event.shiftKey;
    const adds = shift || !noteSel.size;
    const tick = snapNoteTick(noteTickAt(x0), event.altKey, Math.floor);
    const semi = noteTuneAt(y0);
    event.preventDefault();
    if (adds) auditionNote(event.pointerId, semi);
    const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        stopAudition();
    };
    const move = (ev) => {
        if (ev.pointerId !== event.pointerId || ev.pointerType === 'touch') return;
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
        stop();
        const base = shift ? new Set(noteSel) : new Set();
        startMarquee(event.pointerId, x0, y0, {
            selector: '.arrange-roll-note',
            keep: (el) => base.has(clip.notes[el.dataset.i | 0]),
            done: (hits) => {
                if (hits) {
                    noteSel = base;
                    for (const el of hits) {
                        const hit = clip.notes[el.dataset.i | 0];
                        if (hit) noteSel.add(hit);
                    }
                }
                render({ jump: false });
            },
        });
        onMarqueeMove(ev);
    };
    const up = (ev) => {
        if (ev.pointerId !== event.pointerId) return;
        stop();
        if (ev.type === 'pointercancel') return;
        if (!adds) {
            noteSel.clear();
            gridEl.querySelectorAll('.arrange-roll-note.is-sel').forEach((el) => el.classList.remove('is-sel'));
            syncTransposeBtns(clip);
            return;
        }
        if (tick < 0 || tick >= notesGeom.len) return;
        checkpointUndo(state.song);
        monoMakeRoom(clip, tick, lastNoteLen);
        clip.notes.push({
            startTick: tick,
            durTick: lastNoteLen,
            semi,
            fine: 0,
            velocity: 0.8,
            legato: false,
        });
        commitNotes(clip);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
}

// Rubber-band selection, shared by the step grid and the notes view (mouse and pen; a
// touch drag scrolls the grid instead). The box is anchored in grid coordinates, so it
// keeps its corner while a drag near an edge scrolls the view. `keep` says which elements
// stay selected whatever the box covers; `done` gets the covered elements, or null if
// the drag was cancelled.
function startMarquee(pointerId, x0, y0, { selector, keep, done }) {
    cancelMarquee();
    const rect = gridEl.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'arrange-roll-marquee';
    box.setAttribute('aria-hidden', 'true');
    marquee = {
        id: pointerId,
        ax: x0 - rect.left,
        ay: y0 - rect.top,
        x: x0,
        y: y0,
        box,
        selector,
        keep,
        done,
        hits: [],
        raf: 0,
    };
    window.addEventListener('pointermove', onMarqueeMove);
    window.addEventListener('pointerup', onMarqueeUp);
    window.addEventListener('pointercancel', onMarqueeUp);
}

function paintMarquee() {
    const m = marquee;
    if (!m) return;
    const rect = gridEl.getBoundingClientRect();
    const px = Math.max(0, Math.min(rect.width, m.x - rect.left));
    const py = Math.max(0, Math.min(rect.height, m.y - rect.top));
    const left = Math.min(m.ax, px);
    const top = Math.min(m.ay, py);
    const right = Math.max(m.ax, px);
    const bottom = Math.max(m.ay, py);
    m.box.style.left = `${left}px`;
    m.box.style.top = `${top}px`;
    m.box.style.width = `${right - left}px`;
    m.box.style.height = `${bottom - top}px`;
    // A repaint under the drag (the song edited elsewhere) empties the grid: put the box back.
    if (!m.box.isConnected) gridEl.appendChild(m.box);
    m.hits = [];
    gridEl.querySelectorAll(m.selector).forEach((el) => {
        const r = el.getBoundingClientRect();
        const hit = r.right > rect.left + left && r.left < rect.left + right
            && r.bottom > rect.top + top && r.top < rect.top + bottom;
        if (hit) m.hits.push(el);
        el.classList.toggle('is-sel', hit || m.keep(el));
    });
}

function onMarqueeMove(event) {
    if (!marquee || event.pointerId !== marquee.id) return;
    marquee.x = event.clientX;
    marquee.y = event.clientY;
    paintMarquee();
    if (!marquee.raf) marquee.raf = requestAnimationFrame(marqueeFrame);
}

// Holding the drag near an edge scrolls the view; the sticky header, keys and
// Accent / Slide rows cover part of the scroller, so the edges sit inside them.
function marqueeFrame() {
    const m = marquee;
    if (!m) return;
    m.raf = 0;
    const rect = scroller.getBoundingClientRect();
    const top = rect.top + (headsEl.offsetHeight || 0);
    const left = rect.left + (keysEl.offsetWidth || 0);
    const bottom = rect.bottom - (propsEl.hidden ? 0 : propsEl.offsetHeight || 0);
    const speed = Math.max(8, Math.round(rowPx * 0.85));
    let dx = 0;
    let dy = 0;
    if (m.y < top + 24) dy = -speed;
    else if (m.y > bottom - 24) dy = speed;
    if (m.x < left + 24) dx = -speed;
    else if (m.x > rect.right - 24) dx = speed;
    if (!dx && !dy) return;
    const fromTop = scroller.scrollTop;
    const fromLeft = scroller.scrollLeft;
    scroller.scrollTop = fromTop + dy;
    scroller.scrollLeft = fromLeft + dx;
    if (scroller.scrollTop === fromTop && scroller.scrollLeft === fromLeft) return;
    paintMarquee();
    m.raf = requestAnimationFrame(marqueeFrame);
}

function onMarqueeUp(event) {
    const m = marquee;
    if (!m || event.pointerId !== m.id) return;
    cancelMarquee();
    m.done(event.type === 'pointercancel' ? null : m.hits);
}

function cancelMarquee() {
    const m = marquee;
    if (!m) return;
    window.removeEventListener('pointermove', onMarqueeMove);
    window.removeEventListener('pointerup', onMarqueeUp);
    window.removeEventListener('pointercancel', onMarqueeUp);
    if (m.raf) cancelAnimationFrame(m.raf);
    m.box.remove();
    marquee = null;
}

// Step grid selection. Pitched notes key by column and tune, drum hits by row and column.
function cellKey(cell) {
    return cell.dataset.tune != null
        ? `${cell.dataset.col}:${cell.dataset.tune}`
        : `d${cell.dataset.row}:${cell.dataset.col}`;
}

function paintStepSel() {
    const live = new Set();
    gridEl.querySelectorAll('.arrange-roll-cell').forEach((cell) => {
        const key = cellKey(cell);
        const on = cell.classList.contains('is-on') && stepSel.has(key);
        cell.classList.toggle('is-sel', on);
        if (on) live.add(key);
    });
    stepSel = live;
}

function shiftStepSel(semis) {
    stepSel = new Set([...stepSel].map((key) => {
        const [col, tune] = key.split(':').map(Number);
        return `${col}:${tune + semis}`;
    }));
}

function selectAllSteps() {
    stepSel = new Set();
    gridEl.querySelectorAll('.arrange-roll-cell.is-on').forEach((cell) => stepSel.add(cellKey(cell)));
    paintStepSel();
}

function stepMarquee(s, event) {
    const base = s.shift ? new Set(stepSel) : new Set();
    startMarquee(s.id, s.x, s.y, {
        selector: '.arrange-roll-cell.is-on',
        keep: (el) => base.has(cellKey(el)),
        done: (hits) => {
            if (hits) {
                stepSel = base;
                for (const el of hits) stepSel.add(cellKey(el));
            }
            paintStepSel();
        },
    });
    onMarqueeMove(event);
}

// Delete on a selection: the picked notes leave their steps (one undo step); a step
// left with no notes becomes a rest, as when its last note is clicked away.
function deleteSelectedSteps() {
    const clip = findClip(openId);
    if (!clip || clip.kind === 'notes' || !stepSel.size) return;
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    if (live.kind === 'd') {
        for (const key of stepSel) {
            const at = /^d(\d+):(\d+)$/.exec(key);
            const step = at ? live.data?.lanes?.[at[1] | 0]?.steps?.[at[2] | 0] : null;
            if (step) step.on = false;
        }
    } else {
        const steps = patternOf(live)?.steps || [];
        const gone = new Map();
        for (const key of stepSel) {
            const [col, tune] = key.split(':').map(Number);
            if (!gone.has(col)) gone.set(col, new Set());
            gone.get(col).add(tune);
        }
        for (const [col, tunes] of gone) {
            const step = steps[col];
            if (!step) continue;
            applyPitches(step, stepPitches(step).filter((p) => !tunes.has(p)), step.on === false);
        }
    }
    stepSel.clear();
    refreshArrange();
}

// Columns past the pattern (space the clip was lengthened by) look empty until written.
function markExt(el, col, count) {
    if (col >= count) el.classList.add('is-ext');
    if (col === count) el.classList.add('is-ext-start');
    return el;
}

function headCell(col, step) {
    const el = document.createElement('div');
    el.className = 'arrange-roll-head';
    el.dataset.col = String(col);
    el.textContent = String(col + 1);
    if (col === selectedCol) el.classList.add('is-col');
    if (col % 4 === 0) el.classList.add('is-bar');
    return el;
}

// Vertical piano in the touch-plate keyboard's shape: the naturals split each octave the way a real
// keyboard does (C-E share five rows, F-B seven), each sharp is a plate on its own row, and every edge
// is snapped to a whole pixel so the key lines stay crisp at any row height.
const NAT_SPAN = { 0: [0, 5 / 3], 2: [5 / 3, 10 / 3], 4: [10 / 3, 5], 5: [5, 6.75], 7: [6.75, 8.5], 9: [8.5, 10.25], 11: [10.25, 12] };
function paintRowShade() {
    if (!keysEl.classList.contains('is-piano') || roll.classList.contains('is-drums')) return;
    const rows = TUNE_HI - TUNE_LO + 1;
    const px = (n) => Math.round(n * (rowPx || 16));
    const shade = document.createElement('div');
    shade.className = 'arrange-roll-shade';
    shade.setAttribute('aria-hidden', 'true');
    shade.style.height = `${px(rows)}px`;
    let html = '';
    for (let row = 0; row < rows; row += 1) {
        if (!isBlack(TUNE_HI - row)) html += `<i style="top:${px(row)}px;height:${px(row + 1) - px(row)}px"></i>`;
    }
    shade.innerHTML = html;
    gridEl.prepend(shade);
}

function paintKeyboard() {
    const rows = TUNE_HI - TUNE_LO + 1;
    const px = (n) => Math.round(n * (rowPx || 16));
    keysEl.classList.remove('is-fold');
    keysEl.classList.add('is-piano');
    keysEl.style.height = `${px(rows)}px`;
    const blacks = [];
    for (let tune = TUNE_HI; tune >= TUNE_LO; tune -= 1) {
        const row = TUNE_HI - tune;
        const el = document.createElement('div');
        el.dataset.tune = String(tune);
        el.title = semitonesToNoteName(tune);
        if (isBlack(tune)) {
            el.className = 'arrange-roll-bkey';
            el.style.top = `${px(row) + 1}px`;
            el.style.height = `${px(row + 1) - px(row) - 2}px`;
            blacks.push(el);
            continue;
        }
        const pc = ((tune % 12) + 12) % 12;
        const cBottom = TUNE_HI - (tune - pc) + 1;
        const [lo, hi] = NAT_SPAN[pc];
        const top = Math.max(0, cBottom - hi);
        const bottom = Math.min(rows, cBottom - lo);
        el.className = 'arrange-roll-wkey';
        el.style.top = `${px(top)}px`;
        el.style.height = `${px(bottom) - px(top)}px`;
        if (((tune % 12) + 12) % 12 === 0) {
            el.classList.add('is-c');
            const label = document.createElement('span');
            label.className = 'arrange-roll-klabel';
            label.textContent = semitonesToNoteName(tune);
            el.appendChild(label);
        }
        keysEl.appendChild(el);
    }
    blacks.forEach((el) => keysEl.appendChild(el));
    paintKeyLights();
}

// Click a key to hear it, drag along the keys to play each one (Ableton preview).
// Uses the on-screen keyboard's own path, but never in modes where a key press
// writes steps, transposes the running pattern, retargets the arp or latches.
function canAudition() {
    if (state.keyboardWrite || state.keyboardArp || state.keyboardLatch) return false;
    if (state.isPlaying && !state.songLiveKeys) return false;
    return true;
}

function keyTuneAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest?.('[data-tune]');
    if (!el || !keysEl.contains(el)) return null;
    return Number(el.dataset.tune);
}

function soundKey(tune) {
    if (!audition || audition.tune === tune) return;
    const held = audition.held;
    if (audition.tune != null) {
        if (held) heldNoteUp(audition.tune);
        else if (tune == null) releaseKey();
    }
    keysEl.querySelector('.is-down')?.classList.remove('is-down');
    audition.tune = tune;
    if (tune == null) {
        paintKeyRow(null);
        return;
    }
    // Mono: pressKey on a new key retunes the held voice, like legato playing.
    if (held) heldNoteDown(tune);
    else pressKey(tune);
    keysEl.querySelector(`[data-tune="${tune}"]`)?.classList.add('is-down');
    paintKeyRow(tune);
}

// While a key is held, light its row across the grid (Ableton style). Folded rows
// index into rowTunes; the full keyboard (steps or notes) has one row per tune.
function paintKeyRow(tune) {
    let band = gridEl.querySelector('.arrange-roll-keyrow');
    const row = tune == null ? -1 : keysEl.classList.contains('is-fold') ? rowTunes.indexOf(tune) : TUNE_HI - tune;
    if (row < 0) {
        band?.remove();
        return;
    }
    if (!band) {
        band = document.createElement('div');
        band.className = 'arrange-roll-keyrow';
        band.setAttribute('aria-hidden', 'true');
    }
    band.style.top = `calc(var(--row, 16px) * ${row})`;
    gridEl.appendChild(band);
}

function onKeyDown(event) {
    if (event.button !== 0) return;
    if (!keysEl.classList.contains('is-piano') && !keysEl.classList.contains('is-fold')) return;
    const tune = keyTuneAt(event.clientX, event.clientY);
    if (tune == null || !canAudition()) return;
    event.preventDefault();
    event.stopPropagation();
    stopAudition();
    audition = { pointer: event.pointerId, tune: null, held: needsHeldNoteSet() };
    try {
        keysEl.setPointerCapture(event.pointerId);
    } catch {
        // No capture (synthetic or already-ended pointer): moves still arrive while over the keys.
    }
    keysEl.addEventListener('pointermove', onKeyMove);
    keysEl.addEventListener('pointerup', onKeyUp);
    keysEl.addEventListener('pointercancel', onKeyUp);
    soundKey(tune);
    const clip = openId != null ? findClip(openId) : null;
    if (clip?.kind === 'notes') {
        keySel = { base: event.shiftKey ? new Set(noteSel) : new Set(), anchor: tune, y0: event.clientY, dragging: false, toggle: event.shiftKey };
        selectPitchRange(clip, tune, tune);
    }
}

// Select every note whose pitch is between a and b (inclusive), on top of keySel.base. A Shift-click on
// one key toggles that pitch's notes in and out of the selection.
function selectPitchRange(clip, a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const hits = (clip.notes || []).filter((n) => {
        const semi = Math.round(Number(n.semi)) || 0;
        return semi >= lo && semi <= hi;
    });
    const next = new Set(keySel.base);
    if (keySel.toggle && lo === hi && hits.length && hits.every((n) => keySel.base.has(n))) hits.forEach((n) => next.delete(n));
    else hits.forEach((n) => next.add(n));
    noteSel = next;
    gridEl.querySelectorAll('.arrange-roll-note').forEach((el) => {
        el.classList.toggle('is-sel', noteSel.has(clip.notes[el.dataset.i | 0]));
    });
}

function onKeyMove(event) {
    if (!audition || event.pointerId !== audition.pointer) return;
    // A click selects one pitch; only a real drag (6px+) becomes a range, so a wobble can't spill over.
    if (keySel && !keySel.dragging) {
        if (Math.abs(event.clientY - keySel.y0) < 6) return;
        keySel.dragging = true;
        keySel.toggle = false;
    }
    const tune = keyTuneAt(event.clientX, event.clientY);
    if (tune == null) return;
    soundKey(tune);
    const clip = keySel && openId != null ? findClip(openId) : null;
    if (clip) selectPitchRange(clip, keySel.anchor, tune);
}

function onKeyUp(event) {
    if (!audition || event.pointerId !== audition.pointer) return;
    stopAudition();
}

function stopAudition() {
    keySel = null;
    if (!audition) return;
    soundKey(null);
    audition = null;
    keysEl.removeEventListener('pointermove', onKeyMove);
    keysEl.removeEventListener('pointerup', onKeyUp);
    keysEl.removeEventListener('pointercancel', onKeyUp);
}

function paintKeyLights() {
    if (!keysEl?.classList.contains('is-piano') && !keysEl?.classList.contains('is-fold')) return;
    const clip = findClip(openId);
    const pattern = clip && clip.kind !== 'notes' ? patternOf(clip) : null;
    const lit = new Set(pattern ? columnPitches(pattern.steps[selectedCol]) : []);
    keysEl.querySelectorAll('[data-tune]').forEach((el) => {
        el.classList.toggle('is-lit', lit.has(Number(el.dataset.tune)));
    });
}

function drumKey(row) {
    const el = document.createElement('div');
    el.className = 'arrange-roll-key arrange-roll-key-drum';
    el.textContent = `D${row + 1}`;
    return el;
}

function pitchCell(col, tune, on, step) {
    const el = document.createElement('div');
    el.className = 'arrange-roll-cell';
    el.dataset.col = String(col);
    el.dataset.tune = String(tune);
    el.dataset.on = on ? '1' : '0';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    el.setAttribute('aria-label', `${semitonesToNoteName(tune)} step ${col + 1}`);
    if (isBlack(tune)) el.classList.add('is-black');
    if (((tune % 12) + 12) % 12 === 0) el.classList.add('is-c');
    if (col % 4 === 0) el.classList.add('is-bar');
    if (col === selectedCol) el.classList.add('is-col');
    if (on) {
        el.classList.add('is-on');
        if (step?.on === false) el.classList.add('is-ghost');
        if (step?.accent) el.classList.add('is-accent');
        if (step?.slide) el.classList.add('is-slide');
        const ratch = Math.round(Number(step?.ratch) || 1);
        if (ratch >= 2) {
            el.classList.add('is-ratch');
            el.style.setProperty('--rn', String(ratch));
            el.setAttribute('aria-label', `${el.getAttribute('aria-label')}, ratchet ${ratch}`);
        }
        if (step?.slide) {
            const tie = document.createElement('span');
            tie.className = 'arrange-roll-tie';
            el.appendChild(tie);
        }
    }
    return el;
}

function drumCell(row, col, on, dim) {
    const el = document.createElement('div');
    el.className = 'arrange-roll-cell arrange-roll-hit';
    el.dataset.row = String(row);
    el.dataset.col = String(col);
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `D${row + 1} step ${col + 1}`);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (col % 4 === 0) el.classList.add('is-bar');
    if (col === selectedCol) el.classList.add('is-col');
    if (dim) {
        el.classList.add('is-dim');
        el.setAttribute('aria-disabled', 'true');
    } else if (on) {
        el.classList.add('is-on');
    }
    return el;
}

function scrollToPitches(pitches) {
    const header = headsEl.offsetHeight || 0;
    let mid = 0;
    if (pitches.length) mid = (Math.min(...pitches) + Math.max(...pitches)) / 2;
    let row = TUNE_HI - mid;
    if (keysEl.classList.contains('is-fold')) {
        const at = rowTunes.findIndex((tune) => tune <= mid);
        row = at < 0 ? rowTunes.length - 1 : at;
    }
    const midTop = header + row * rowPx + rowPx / 2;
    scroller.scrollTop = Math.max(0, midTop - scroller.clientHeight / 2);
}

function selectedStep(clip) {
    if (!clip || clip.kind === 'notes' || clip.kind === 'd') return null;
    const pattern = patternOf(clip);
    if (!pattern || selectedCol >= pattern.count) return null;
    return pattern.steps[selectedCol] || null;
}

function syncTools() {
    paintSelection();
}

function paintSelection() {
    paintKeyLights();
    roll.querySelectorAll('.is-col').forEach((el) => el.classList.remove('is-col'));
    roll.querySelectorAll(`[data-col="${selectedCol}"]`).forEach((el) => {
        if (el.classList.contains('arrange-roll-head')
            || el.classList.contains('arrange-roll-cell')
            || el.classList.contains('arrange-roll-prop')) {
            el.classList.add('is-col');
        }
    });
}

// Accent / Slide / Ratchet rows under the grid, one cell per step (TB-303 style).
function paintProps(clip) {
    propsEl.replaceChildren();
    const show = clip.kind === 'n' || clip.kind === 'b';
    propsEl.hidden = !show;
    plabelsEl.hidden = !show;
    if (!show) return;
    const pattern = patternOf(clip);
    const count = pattern?.count || 8;
    const cols = pattern?.cols || count;
    for (const row of PROP_ROWS) {
        for (let col = 0; col < cols; col += 1) {
            if (col >= count) {
                const pad = document.createElement('div');
                pad.className = 'arrange-roll-prop is-ext';
                if (col === count) pad.classList.add('is-ext-start');
                propsEl.appendChild(pad);
                continue;
            }
            const el = document.createElement('div');
            el.className = 'arrange-roll-prop';
            el.dataset.prop = row.key;
            el.dataset.col = String(col);
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', `${row.name} step ${col + 1}`);
            if (col % 4 === 0) el.classList.add('is-bar');
            if (col === selectedCol) el.classList.add('is-col');
            paintPropCell(el, pattern?.steps?.[col]);
            propsEl.appendChild(el);
        }
    }
}

function paintPropCell(el, step) {
    const key = el.dataset.prop;
    let on;
    if (key === 'ratch') {
        const r = Math.max(1, Math.min(4, Math.round(Number(step?.ratch) || 1)));
        on = r >= 2;
        el.textContent = on ? String(r) : '';
    } else if (key === 'on') {
        on = !!step && step.on !== false;
        el.classList.toggle('is-held', !on && !isBlankRest(step));
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
        return;
    } else {
        on = !!step?.[key];
    }
    el.classList.toggle('is-on', on);
    el.classList.toggle('is-rest', !step || step.on === false);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// Accent, Slide and On/Off paint across steps in one drag (one undo step). Ratchet cycles per click.
function onPropDown(event) {
    if (event.button !== 0 || propPaint || session) return;
    const cell = event.target.closest('.arrange-roll-prop');
    if (!cell || !propsEl.contains(cell)) return;
    const clip = findClip(openId);
    if (!clip || (clip.kind !== 'n' && clip.kind !== 'b')) return;
    const col = cell.dataset.col | 0;
    const key = cell.dataset.prop;
    if (!key || col >= (patternOf(clip)?.count || 0) || !patternOf(clip)?.steps?.[col]) return;
    event.preventDefault();
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const step = patternOf(live)?.steps?.[col];
    if (!step) return;
    selectedCol = col;
    if (key === 'ratch') {
        step.ratch = nextRatch(step.ratch);
        refreshArrange();
        return;
    }
    const value = key === 'on' ? step.on === false : !step[key];
    step[key] = value;
    // The grid's greyed notes catch up on release (onPropUp refreshes).
    paintPropCell(cell, step);
    propPaint = { id: event.pointerId, key, value, done: new Set([col]) };
    try { propsEl.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    propsEl.addEventListener('pointermove', onPropMove);
    propsEl.addEventListener('pointerup', onPropUp);
    propsEl.addEventListener('pointercancel', onPropUp);
}

function onPropMove(event) {
    if (!propPaint || event.pointerId !== propPaint.id) return;
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.arrange-roll-prop');
    if (!el || !propsEl.contains(el) || el.dataset.prop !== propPaint.key) return;
    const col = el.dataset.col | 0;
    if (propPaint.done.has(col) || col >= (patternOf(findClip(openId))?.count || 0)) return;
    const step = patternOf(findClip(openId))?.steps?.[col];
    if (!step) return;
    propPaint.done.add(col);
    step[propPaint.key] = propPaint.value;
    paintPropCell(el, step);
}

function onPropUp(event) {
    if (!propPaint || event.pointerId !== propPaint.id) return;
    cancelPropPaint();
    refreshArrange();
}

function cancelPropPaint() {
    if (!propsEl) return;
    propsEl.removeEventListener('pointermove', onPropMove);
    propsEl.removeEventListener('pointerup', onPropUp);
    propsEl.removeEventListener('pointercancel', onPropUp);
    propPaint = null;
}

function songRunning() {
    return !!state.songPlaying && !!state.isPlaying && !state.songOneShot;
}

function syncTransport() {
    if (!playBtn) return;
    const on = songRunning() || !!state.songCountIn;
    playBtn.classList.toggle('is-on', on);
    playBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    stopBtn.setAttribute('aria-label', on ? 'Stop' : 'Return to start');
    if (openId != null) paintPlayhead();
}

function laneTicks(lane) {
    return clipStepTicks({ kind: 'n', data: { division: lane?.division } });
}

function laneColumn(local, count, stepTicks, reverse) {
    if (!(stepTicks > 0)) return -1;
    const i = Math.floor(local / stepTicks) % count;
    return reverse ? count - 1 - i : i;
}

// Which step the song is on inside the open clip: { col }, { rows } for drums, { pct } for recorded notes.
function playState(clip, tick) {
    if (!clip || !songRunning() || !Number.isFinite(tick)) return null;
    const start = Number(clip.startTick) || 0;
    const len = Number(clip.lengthTick) || 0;
    if (tick < start || tick >= start + len) return null;
    if (clip.kind === 'notes') {
        const rel = tick - (start - clipStartOffset(clip));
        return { pct: (rel / Math.max(1, notesGeom?.len || len)) * 100 };
    }
    // Clips play their pattern once from its origin; trimmed edges and empty space show no step.
    const span = clipPlaySpan(clip);
    if (tick < span.from || tick >= span.to) return null;
    const cycle = clipCycleTicks(clip);
    const rel = tick - span.origin;
    const local = cycle > 0 ? rel % cycle : rel;
    if (clip.kind === 'n') {
        const data = clip.data || {};
        return { col: laneColumn(local, clampCount(data.stepCount), clipStepTicks(clip), !!data.reverse) };
    }
    if (clip.kind === 'b') {
        const lane = clip.data?.lanes?.[laneIndex];
        if (!lane) return null;
        return { col: laneColumn(local, clampCount(lane.stepCount), laneTicks(lane), !!lane.reverse) };
    }
    if (clip.kind === 'd') {
        const lanes = clip.data?.lanes || [];
        return {
            rows: [0, 1, 2, 3].map((row) => {
                const lane = lanes[row];
                return lane ? laneColumn(local, clampCount(lane.stepCount), laneTicks(lane), !!lane.reverse) : -1;
            }),
        };
    }
    return null;
}

function paintPlayhead() {
    if (!roll || !playLine) return;
    const clip = findClip(openId);
    const ps = playState(clip, lastTick);
    const key = ps ? JSON.stringify(ps) : '';
    if (key === playKey) return;
    playKey = key;
    roll.querySelectorAll('.is-play').forEach((el) => el.classList.remove('is-play'));
    playLine.classList.remove('is-line');
    if (!ps) {
        playLine.hidden = true;
        return;
    }
    if (ps.pct != null) {
        playLine.hidden = false;
        playLine.classList.add('is-line');
        playLine.style.left = `${ps.pct}%`;
        playLine.style.width = '';
        return;
    }
    if (ps.rows) {
        playLine.hidden = true;
        ps.rows.forEach((col, row) => {
            if (col < 0) return;
            gridEl.querySelector(`.arrange-roll-cell[data-row="${row}"][data-col="${col}"]`)?.classList.add('is-play');
        });
        return;
    }
    const count = Number(sheet.style.getPropertyValue('--cols')) || 1;
    if (ps.col < 0 || ps.col >= count) {
        playLine.hidden = true;
        return;
    }
    playLine.hidden = false;
    playLine.style.left = `${(ps.col / count) * 100}%`;
    playLine.style.width = `${100 / count}%`;
    roll.querySelectorAll(`[data-col="${ps.col}"]`).forEach((el) => {
        if (el.classList.contains('arrange-roll-head') || el.classList.contains('arrange-roll-prop')) {
            el.classList.add('is-play');
        }
    });
}

function clipSpan(clip) {
    const start = Math.max(0, clip.startTick | 0);
    return { startTick: start, endTick: start + Math.max(0, clip.lengthTick | 0) };
}

function syncLoopBtn() {
    if (!loopBtn) return;
    const on = !!loopClipId;
    loopBtn.classList.toggle('is-on', on);
    loopBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function toggleLoopClip() {
    const clip = findClip(openId);
    if (!clip || !state.song) return;
    if (loopClipId) {
        releaseLoopClip();
        return;
    }
    engageLoopClip(clip);
}

// Remembers the song loop so closing the roll (or Loop clip off) puts it back.
function engageLoopClip(clip) {
    if (!state.song) return;
    const prev = state.song.loop || { on: false, startTick: 0, endTick: 0 };
    loopSaved = { on: !!prev.on, startTick: prev.startTick | 0, endTick: prev.endTick | 0 };
    applyLoopClip(clip);
}

function applyLoopClip(clip) {
    loopClipId = clip.id;
    loopApplied = clipSpan(clip);
    setArrangeLoop({ on: true, ...loopApplied }, { jump: true });
    syncLoopBtn();
}

// Puts back the loop the song had before Loop clip went on.
function releaseLoopClip() {
    if (!loopClipId) return;
    const saved = loopSaved;
    loopClipId = null;
    loopSaved = null;
    loopApplied = null;
    if (saved) setArrangeLoop(saved);
    syncLoopBtn();
}

// The loop follows the clip when it moves or resizes. If the loop was changed
// elsewhere (the main Loop button, undo), the roll lets go of it.
function reconcileLoopClip() {
    if (!loopClipId) return;
    const loop = state.song?.loop;
    const ours = !!loop?.on && !!loopApplied
        && (loop.startTick | 0) === loopApplied.startTick
        && (loop.endTick | 0) === loopApplied.endTick;
    if (!ours) {
        loopClipId = null;
        loopSaved = null;
        loopApplied = null;
        syncLoopBtn();
        return;
    }
    const clip = findClip(loopClipId);
    if (!clip) {
        releaseLoopClip();
        return;
    }
    const span = clipSpan(clip);
    if (span.startTick !== loopApplied.startTick || span.endTick !== loopApplied.endTick) applyLoopClip(clip);
}

function onPointerDown(event) {
    if (event.button !== 0 || session || paint) return;
    const head = event.target.closest('.arrange-roll-head');
    if (head && roll.contains(head)) {
        selectedCol = head.dataset.col | 0;
        syncTools();
        previewStep(selectedStep(findClip(openId)));
        return;
    }
    const notesClip = findClip(openId);
    if (notesClip?.kind === 'notes') {
        if (gridEl.contains(event.target)) onNotesPointerDown(event, notesClip);
        return;
    }
    const cell = event.target.closest('.arrange-roll-cell');
    if (!cell || !roll.contains(cell)) return;
    const clip = findClip(openId);
    if (!clip || clip.kind === 'notes') return;
    if (drawOn) {
        startStepPaint(event, cell, clip);
        return;
    }
    const col = cell.dataset.col | 0;
    const dim = cell.classList.contains('is-dim');
    if (!dim) {
        selectedCol = col;
        syncTools();
    }
    const tune = cell.dataset.tune != null ? Number(cell.dataset.tune) : null;
    const on = cell.classList.contains('is-on');
    const key = cellKey(cell);
    // Shift-click a note to add it to the selection or take it out. Pressing a note
    // outside the selection drops the selection; pressing one inside it drags them all.
    let pick = false;
    if (on && event.shiftKey) {
        pick = true;
        if (!stepSel.delete(key)) stepSel.add(key);
        cell.classList.toggle('is-sel', stepSel.has(key));
    } else if (on && !stepSel.has(key)) {
        clearStepSel();
    }
    const from = on && tune != null ? tune : null;
    const group = from != null && stepSel.has(key);
    session = {
        id: event.pointerId,
        kind: clip.kind,
        col,
        row: cell.dataset.row != null ? (cell.dataset.row | 0) : 0,
        tune,
        from,
        to: tune,
        x: event.clientX,
        y: event.clientY,
        drag: false,
        dim,
        on,
        pick,
        group,
        shift: event.shiftKey,
        touch: event.pointerType === 'touch',
        moves: from == null ? [] : group ? selectedMoves() : [{ col, from, to: from }],
        dRow: 0,
    };
    if (session.from != null) {
        event.preventDefault();
        cell.classList.add('is-drag');
        previewStep(patternOf(clip)?.steps?.[col]);
    }
    // Preview: a write or a Shift-pick sounds at once. A plain press on a note may be a
    // delete, so it sounds only once it drags. Mod lanes hold CV, not notes.
    if (!dim && clip.kind === 'd') {
        const step = clip.data?.lanes?.[session.row]?.steps?.[col];
        if (!on && previewOn && canAudition()) auditionDrumHit(session.row, step);
    } else if (!dim && tune != null && pitchLane(clip) && (pick || (!on && (!stepSel.size || event.shiftKey)))) {
        auditionNote(event.pointerId, tune);
    }
    try { cell.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(event) {
    if (!session || event.pointerId !== session.id) return;
    if (session.kind === 'd' || session.from == null) {
        // A drag that starts off a note draws a selection box. Touch drags scroll instead.
        if (session.touch || Math.hypot(event.clientX - session.x, event.clientY - session.y) < 5) return;
        const s = session;
        cancelSession();
        stepMarquee(s, event);
        return;
    }
    dragY = event.clientY;
    if (!session.drag && Math.abs(event.clientY - session.y) < 5) return;
    if (!session.drag && pitchLane(findClip(openId))) auditionNote(session.id, session.from);
    session.drag = true;
    if (shiftMoves(tuneFromClientY(event.clientY))) {
        paintDrag(session.moves);
        previewDrag();
        if (pitchLane(findClip(openId))) auditionNote(session.id, session.to);
    }
    kickEdgeScroll();
}

function onPointerUp(event) {
    if (!session || event.pointerId !== session.id) return;
    const s = session;
    const cancelled = event.type === 'pointercancel';
    cancelSession();
    if (cancelled) {
        render({ jump: false });
        return;
    }
    if (s.drag) {
        if (s.dRow) commitDrag(s);
        else render({ jump: false });
        return;
    }
    if ((s.kind === 'd' || s.from == null) && Math.hypot(event.clientX - s.x, event.clientY - s.y) > 6) return;
    // A Shift-click only changed the selection. A click off the notes drops a
    // selection first; the next one writes.
    if (s.pick) {
        render({ jump: false });
        return;
    }
    if (!s.on && stepSel.size) {
        if (!s.shift) clearStepSel();
        return;
    }
    if (s.dim) return;
    if (s.kind === 'd') {
        toggleDrum(s.row, s.col);
        return;
    }
    if (s.tune == null) return;
    togglePitch(s.col, s.tune);
}

// Step clips and Berlin oscillator lanes play notes; Berlin mod lanes (M1-M4) do not.
function pitchLane(clip) {
    if (!clip) return false;
    if (clip.kind === 'n') return true;
    return clip.kind === 'b' && laneIndex < 4;
}

function cancelSession() {
    if (session) stopAudition();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    if (dragRAF) cancelAnimationFrame(dragRAF);
    dragRAF = 0;
    session = null;
}

function tuneFromClientY(clientY) {
    const cells = gridEl.querySelectorAll('.arrange-roll-cell[data-col="0"]');
    let best = null;
    let bestDist = Infinity;
    for (const cell of cells) {
        const rect = cell.getBoundingClientRect();
        if (rect.height < 1) continue;
        if (clientY >= rect.top && clientY < rect.bottom) return Number(cell.dataset.tune);
        const dist = Math.abs(clientY - (rect.top + rect.bottom) / 2);
        if (dist < bestDist) {
            bestDist = dist;
            best = cell;
        }
    }
    return best ? Number(best.dataset.tune) : null;
}

function clearStepSel() {
    if (!stepSel.size) return;
    stepSel.clear();
    gridEl.querySelectorAll('.arrange-roll-cell.is-sel').forEach((el) => el.classList.remove('is-sel'));
}

// The selected notes as drag moves. Only pitched notes on a visible row can be selected.
function selectedMoves() {
    const moves = [];
    for (const key of stepSel) {
        const [col, from] = key.split(':').map(Number);
        if (Number.isFinite(col) && rowTunes.includes(from)) moves.push({ col, from, to: from });
    }
    return moves;
}

// Dragged notes move by rows, all by the same count, stopping when one reaches the top
// or bottom row. With Fold or Scale on a row is not a semitone, so a group keeps to the
// rows shown (a scale-wise transpose in Scale view). True when the move changed.
function shiftMoves(next) {
    if (!session || next == null) return false;
    const at = (tune) => rowTunes.indexOf(tune);
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of session.moves) {
        lo = Math.min(lo, at(m.from));
        hi = Math.max(hi, at(m.from));
    }
    if (at(next) < 0 || lo < 0) return false;
    const d = Math.max(-lo, Math.min(rowTunes.length - 1 - hi, at(next) - at(session.from)));
    if (d === session.dRow) return false;
    session.dRow = d;
    for (const m of session.moves) m.to = rowTunes[at(m.from) + d];
    session.to = rowTunes[at(session.from) + d];
    return true;
}

function paintDrag(moves) {
    const cols = new Map();
    for (const m of moves) {
        if (!cols.has(m.col)) cols.set(m.col, { from: new Set(), to: new Set() });
        cols.get(m.col).from.add(m.from);
        cols.get(m.col).to.add(m.to);
    }
    for (const [col, moved] of cols) {
        gridEl.querySelectorAll(`.arrange-roll-cell[data-col="${col}"]`).forEach((cell) => {
            const tune = Number(cell.dataset.tune);
            const lands = moved.to.has(tune);
            const on = lands || (cell.dataset.on === '1' && !moved.from.has(tune));
            cell.classList.toggle('is-on', on);
            cell.classList.toggle('is-drag', lands);
            cell.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }
}

function kickEdgeScroll() {
    if (dragRAF || !session?.drag) return;
    dragRAF = requestAnimationFrame(edgeFrame);
}

function edgeFrame() {
    dragRAF = 0;
    if (!session?.drag) return;
    const rect = scroller.getBoundingClientRect();
    let delta = 0;
    if (dragY < rect.top + 24) delta = -Math.max(8, Math.round(rowPx * 0.85));
    else if (dragY > rect.bottom - 24) delta = Math.max(8, Math.round(rowPx * 0.85));
    if (!delta) return;
    scroller.scrollTop += delta;
    if (shiftMoves(tuneFromClientY(dragY))) {
        paintDrag(session.moves);
        previewDrag();
    }
    dragRAF = requestAnimationFrame(edgeFrame);
}

function togglePitch(col, tune) {
    const clip = findClip(openId);
    if (!clip || (clip.kind !== 'n' && clip.kind !== 'b')) return;
    const pattern = patternOf(clip);
    if (!pattern || col >= pattern.cols || tune < TUNE_LO || tune > TUNE_HI) return;
    const ext = col >= pattern.count;
    const step = ext ? null : pattern.steps[col];
    if (!ext && !step) return;
    const pitches = stepPitches(step);
    const has = pitches.includes(tune);
    let next;
    // A click on a note deletes just that note, in either mode, and an off step stays
    // off. A write in Mono makes the step that one note; Poly adds it to the chord.
    // Writing a note turns an off step back on.
    const keepOff = has && step?.on === false;
    if (has) next = pitches.filter((p) => p !== tune);
    else if (!polyEdit) next = [tune];
    else if (pitches.length >= POLY_CHORD_MAX) return;
    else next = pitches.concat(tune);
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    if (ext) growPattern(patternTarget(live), col);
    const target = patternOf(live)?.steps?.[col];
    if (!target) return;
    applyPitches(target, next, keepOff);
    selectedCol = col;
    refreshArrange();
    previewStep(target);
}

// One note, or every selected note, lands on its new row (one undo step). Notes that
// land on a pitch their step already holds merge with it.
function commitDrag(s) {
    const clip = findClip(openId);
    if (!clip || (clip.kind !== 'n' && clip.kind !== 'b')) return;
    if (!patternOf(clip)?.steps?.[s.col]) return;
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const steps = patternOf(live)?.steps || [];
    const cols = new Map();
    for (const m of s.moves) {
        if (!cols.has(m.col)) cols.set(m.col, []);
        cols.get(m.col).push(m);
    }
    for (const [col, moved] of cols) {
        const target = steps[col];
        if (!target) continue;
        const next = stepPitches(target).filter((p) => !moved.some((m) => m.from === p));
        for (const m of moved) if (m.to >= TUNE_LO && m.to <= TUNE_HI) next.push(m.to);
        applyPitches(target, next, target.on === false);
    }
    if (s.group) stepSel = new Set(s.moves.map((m) => `${m.col}:${m.to}`));
    selectedCol = s.col;
    refreshArrange();
    previewStep(steps[s.col]);
}

// The note VFD shows what the edited step will sound like, in its cyan preview
// colour (scale snap and global tune included), like the step knobs do.
function previewPitches(pitches, fine) {
    if (!pitches.length) return;
    const sorted = [...pitches].sort((a, b) => a - b);
    const root = sorted[0];
    const sounding = getStepTotalTuneFromRaw(root);
    try {
        previewChordVisualizer(sorted.map((n) => n - root + sounding), Number(fine) || 0);
    } catch { /* no note VFD in this layout */ }
}

function previewStep(step) {
    if (!step || step.on === false) return;
    previewPitches(columnPitches(step), step.fine);
}

function previewDrag() {
    if (!session || session.from == null || session.to == null) return;
    const step = patternOf(findClip(openId))?.steps?.[session.col];
    if (!step) return;
    if (step.on === false) return;
    const moved = session.moves.filter((m) => m.col === session.col);
    const pitches = columnPitches(step).filter((p) => !moved.some((m) => m.from === p));
    for (const m of moved) if (!pitches.includes(m.to)) pitches.push(m.to);
    previewPitches(pitches, step.fine);
}

function applyPitches(step, pitches, keepOff = false) {
    const uniq = [];
    const seen = new Set();
    for (const n of pitches) {
        const v = Math.round(Number(n));
        if (!Number.isFinite(v) || seen.has(v)) continue;
        seen.add(v);
        uniq.push(v);
    }
    uniq.sort((a, b) => a - b);
    if (uniq.length > POLY_CHORD_MAX) uniq.length = POLY_CHORD_MAX;
    if (!uniq.length) {
        step.on = false;
        step.tune = 0;
        step.chord = [];
        return;
    }
    const formed = chordFromCellNotes(uniq);
    step.on = !keepOff;
    step.tune = formed.tune;
    step.chord = clampChord(formed.chord);
}

function toggleDrum(row, col) {
    const clip = findClip(openId);
    if (!clip || clip.kind !== 'd') return;
    const lane = clip.data?.lanes?.[row];
    if (!lane) return;
    const own = clampCount(lane.stepCount);
    const ext = col >= own && col < viewCols(clip, own, laneTicks(lane), 1);
    if (col < 0 || (col >= own && !ext)) return;
    if (!ext && !lane.steps?.[col]) return;
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    if (ext) growPattern(live.data?.lanes?.[row], col);
    const liveStep = live.data?.lanes?.[row]?.steps?.[col];
    if (!liveStep) return;
    liveStep.on = liveStep.on === false;
    selectedCol = col;
    refreshArrange();
}

// Draw tool strokes. The grid is updated in place while the stroke runs, so rows never
// shift under the pencil (Fold drops an emptied row only once the stroke ends), and the
// pointer path is sampled every few pixels so a fast stroke skips no cell.
function strokeSamples(x0, y0, x1, y1, visit) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
    for (let i = 1; i <= n; i += 1) visit(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
}

function startPaint(event, onPoint, onEnd) {
    event.preventDefault();
    paint = { id: event.pointerId, x: event.clientX, y: event.clientY, onPoint, onEnd };
    onPoint(event.clientX, event.clientY);
    window.addEventListener('pointermove', onPaintMove);
    window.addEventListener('pointerup', onPaintUp);
    window.addEventListener('pointercancel', onPaintUp);
}

function onPaintMove(event) {
    if (!paint || event.pointerId !== paint.id) return;
    const p = paint;
    strokeSamples(p.x, p.y, event.clientX, event.clientY, (x, y) => {
        if (paint === p) p.onPoint(x, y, event.altKey);
    });
    p.x = event.clientX;
    p.y = event.clientY;
}

function onPaintUp(event) {
    if (!paint || event.pointerId !== paint.id) return;
    const p = paint;
    endPaint();
    p.onEnd();
}

function endPaint() {
    window.removeEventListener('pointermove', onPaintMove);
    window.removeEventListener('pointerup', onPaintUp);
    window.removeEventListener('pointercancel', onPaintUp);
    if (paint) stopAudition();
    paint = null;
}

// Step clips and Berlin lanes: the pencil follows the pointer's row. Mono makes each
// column it crosses that one note; Poly adds the note to the column's chord. Drums keep
// to the row the stroke started on.
function startStepPaint(event, cell, clip) {
    if (cell.classList.contains('is-dim')) return;
    const drum = clip.kind === 'd';
    if (!drum && (clip.kind !== 'n' && clip.kind !== 'b' || cell.dataset.tune == null)) return;
    clearStepSel();
    const erase = cell.classList.contains('is-on');
    const row = drum ? (cell.dataset.row | 0) : 0;
    const pointerId = event.pointerId;
    let edited = false;
    const edit = () => {
        if (!edited) edited = !!markEdited(state.song, clip.id);
        return edited;
    };
    const paintDrum = (el, col) => {
        if ((el.dataset.row | 0) !== row || el.classList.contains('is-dim')) return;
        const lane = clip.data?.lanes?.[row];
        if (!lane) return;
        const own = clampCount(lane.stepCount);
        const ext = col >= own;
        if (ext && (erase || col >= viewCols(clip, own, laneTicks(lane), 1))) return;
        if (!ext && (!lane.steps?.[col] || (lane.steps[col].on !== false) !== erase)) return;
        if (!edit()) return;
        if (ext) growPattern(lane, col);
        const step = lane.steps?.[col];
        if (!step) return;
        step.on = !erase;
        el.classList.toggle('is-on', !erase);
        el.setAttribute('aria-pressed', erase ? 'false' : 'true');
        if (!erase && previewOn && canAudition()) auditionDrumHit(row, step);
    };
    const paintPitchCell = (el, col) => {
        const tune = Number(el.dataset.tune);
        const pattern = patternOf(clip);
        if (!pattern || col >= pattern.cols || !Number.isFinite(tune) || tune < TUNE_LO || tune > TUNE_HI) return;
        const ext = col >= pattern.count;
        const step = ext ? null : pattern.steps[col];
        if (!ext && !step) return;
        const pitches = stepPitches(step);
        const has = pitches.includes(tune);
        const off = step?.on === false;
        let next;
        if (erase) {
            if (!has) return;
            next = pitches.filter((t) => t !== tune);
        } else if (!polyEdit) {
            if (has && pitches.length === 1 && !off) return;
            next = [tune];
        } else if (has) {
            if (!off) return;
            next = pitches;
        } else if (pitches.length >= POLY_CHORD_MAX) {
            return;
        } else {
            next = pitches.concat(tune);
        }
        if (!edit()) return;
        if (ext) growPattern(patternTarget(clip), col);
        const target = patternOf(clip)?.steps?.[col];
        if (!target) return;
        applyPitches(target, next, erase && off);
        selectedCol = col;
        repaintColumn(col, target);
        if (!erase) {
            previewStep(target);
            if (pitchLane(clip)) auditionNote(pointerId, tune);
        }
    };
    // A drum stroke reads the row it started on, wherever the pointer drifts.
    const rowY = event.clientY;
    startPaint(event, (x, y) => {
        const el = document.elementFromPoint(x, drum ? rowY : y)?.closest?.('.arrange-roll-cell');
        if (!el || !gridEl.contains(el)) return;
        const col = el.dataset.col | 0;
        if (drum) paintDrum(el, col);
        else paintPitchCell(el, col);
    }, () => {
        if (edited) refreshArrange();
        else render({ jump: false });
    });
}

function repaintColumn(col, step) {
    const shown = new Set(viewPitches(step));
    const ghost = step.on === false;
    gridEl.querySelectorAll(`.arrange-roll-cell[data-col="${col}"]`).forEach((el) => {
        const on = shown.has(Number(el.dataset.tune));
        el.dataset.on = on ? '1' : '0';
        el.classList.toggle('is-on', on);
        el.classList.toggle('is-ghost', on && ghost);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

// Notes clips: the pencil lays a run of notes, one per slot (the length of the last note
// resized, snapped to 1/16; Alt: unsnapped), each at the pointer's pitch. Starting on a
// note erases every note the stroke crosses.
function startNotesPaint(event, clip) {
    const erase = !!event.target.closest('.arrange-roll-note');
    const free = event.altKey;
    const slot = free ? lastNoteLen : Math.max(NOTE_GRID, Math.round(lastNoteLen / NOTE_GRID) * NOTE_GRID);
    const t0 = snapNoteTick(noteTickAt(event.clientX), free, Math.floor);
    const pointerId = event.pointerId;
    const placed = new Set();
    let changed = false;
    noteSel.clear();
    const change = () => {
        if (!changed) checkpointUndo(state.song);
        changed = true;
    };
    startPaint(event, (x, y) => {
        if (!notesGeom) return;
        if (erase) {
            const el = document.elementFromPoint(x, y)?.closest?.('.arrange-roll-note');
            const note = el && gridEl.contains(el) ? clip.notes[el.dataset.i | 0] : null;
            if (!note) return;
            change();
            clip.notes = clip.notes.filter((n) => n !== note);
            render({ jump: false });
            return;
        }
        const k = Math.floor((noteTickAt(x) - t0) / slot);
        const start = t0 + k * slot;
        if (placed.has(k) || start < 0 || start >= notesGeom.len) return;
        placed.add(k);
        const semi = noteTuneAt(y);
        if (clip.notes.some((n) => n.startTick === start && Math.round(Number(n.semi)) === semi)) return;
        change();
        monoMakeRoom(clip, start, slot);
        clip.notes.push({ startTick: start, durTick: slot, semi, fine: 0, velocity: 0.8, legato: false });
        render({ jump: false });
        auditionNote(pointerId, semi);
    }, () => {
        if (changed) commitNotes(clip);
        else render({ jump: false });
    });
}
