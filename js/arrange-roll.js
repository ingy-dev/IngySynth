// Step piano roll for one arrangement clip. Writes clip.data only.
// markEdited runs once per gesture, before the mutation.

import { state } from './state.js?v=120';
import { markEdited, reverseClip, invertClip, clipCycleTicks, clipPlaySpan, clipStartOffset, clipStepTicks } from './song-model.js?v=10';
import {
    POLY_CHORD_MAX,
    chordFromCellNotes,
    clampChord,
    cloneStep,
    stepCellNotes,
} from './pattern-bank.js?v=50';
import { nextRatch } from './step-ratch.js?v=1';
import { semitonesToNoteName, getActiveScale, getStepTotalTuneFromRaw } from './tuning.js?v=108';
import { previewChordVisualizer } from './visualizers.js?v=150';
import { subscribe } from './params.js?v=44';
import { placeArrangementInsert } from './song-conductor.js?v=30';
import { refreshArrange, setArrangeLoop, setArrangeRollOpener } from './arrange-view.js?v=50';
import { createIngyWindow } from './ingy-window.js?v=3';
import { pressKey, releaseKey, heldNoteDown, heldNoteUp } from './keyboard.js?v=276';
import { needsHeldNoteSet } from './held-notes.js?v=13';

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
let scaleBtn;
let monoBtn;
let polyBtn;
// Note entry: Mono writes one note per step, Poly stacks a chord. It arms to the
// loaded synth (Ingy 6 / Multitudes are poly) and the user can flip it; either way
// existing chords (recorded MIDI dropped on a P square) stay as they are.
let polyEdit = false;
let polyArmedFor = null;
let rowTunes = [];
// Fold: only rows that hold notes (Ableton's Fold). Scale: only the project
// scale's rows; it turns on with the project scale and follows it.
let foldNotes = false;
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

export function arrangeRollIsOpen() {
    return openId != null;
}

export function closeArrangeRoll() {
    if (openId == null) return;
    cancelSession();
    cancelPropPaint();
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
                <button type="button" id="arrangeRollPlay" class="arrange-btn arrange-btn-icon" aria-pressed="false" aria-label="Play"><span class="arrange-icon-play" aria-hidden="true"></span></button>
                <button type="button" id="arrangeRollStop" class="arrange-btn arrange-btn-icon" aria-label="Stop"><span class="arrange-icon-stop" aria-hidden="true"></span></button>
                <button type="button" id="arrangeRollLoop" class="arrange-btn" aria-pressed="false" title="Loop the song around this clip">Loop clip</button>
                <button type="button" id="arrangeRollFold" class="arrange-btn" aria-pressed="false" title="Show only rows that have notes">Fold</button>
                <button type="button" id="arrangeRollReverse" class="arrange-btn" title="Play this clip's notes backwards">Reverse</button>
                <button type="button" id="arrangeRollInvert" class="arrange-btn" title="Turn the melody upside down: high notes become low">Invert</button>
                <button type="button" id="arrangeRollScale" class="arrange-btn" aria-pressed="false" title="Show only the project scale's notes" hidden>Scale</button>
                <button type="button" id="arrangeRollMono" class="arrange-btn" aria-pressed="false" title="Mono: one note per step. A click writes or deletes one note" hidden>Mono</button>
                <button type="button" id="arrangeRollPoly" class="arrange-btn" aria-pressed="false" title="Poly: stack up to six notes per step" hidden>Poly</button>
            </div>
            <div id="arrangeRollLanes" class="arrange-roll-lanes" role="tablist" aria-label="Berlin lanes" hidden></div>
        </div>
        <p id="arrangeRollHint" class="arrange-roll-hint" hidden>Drag onto a P square to edit as a pattern</p>
        <div class="arrange-roll-scroller" id="arrangeRollScroll">
            <div class="arrange-roll-sheet" id="arrangeRollSheet">
                <div class="arrange-roll-corner"></div>
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
    scaleBtn = roll.querySelector('#arrangeRollScale');
    monoBtn = roll.querySelector('#arrangeRollMono');
    polyBtn = roll.querySelector('#arrangeRollPoly');

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
    foldBtn.addEventListener('click', () => {
        foldNotes = !foldNotes;
        if (openId != null) render({ jump: true });
    });
    // Same as Reverse on the clip's timeline menu: the notes are mirrored inside the clip.
    roll.querySelector('#arrangeRollReverse').addEventListener('click', () => {
        if (openId == null || !reverseClip(state.song, openId)) return;
        selectedCol = 0;
        refreshArrange();
    });
    // Same as Invert on the clip's timeline menu.
    roll.querySelector('#arrangeRollInvert').addEventListener('click', () => {
        if (openId != null && invertClip(state.song, openId)) refreshArrange();
    });
    scaleBtn.addEventListener('click', () => {
        scaleView = !scaleView;
        if (openId != null) render({ jump: true });
    });
    monoBtn.addEventListener('click', () => setPolyEdit(false));
    polyBtn.addEventListener('click', () => setPolyEdit(true));
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
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const el = event.target instanceof Element ? event.target : null;
    if (el?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
}

function openArrangeRoll(id) {
    const clip = findClip(id);
    if (!clip || !roll) return;
    if (openId !== id) {
        laneIndex = 0;
        selectedCol = 0;
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
    return song.synth.clips.find((clip) => clip.id === id)
        || song.drums.clips.find((clip) => clip.id === id)
        || null;
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
    // The Acc / Sld / Rat rows stick over the bottom of the grid, so they come out of the room too.
    // Measured before paintProps runs, so work it out: 16px per row plus the 1px rule (styles.css).
    const props = clip && (clip.kind === 'n' || clip.kind === 'b') ? PROP_ROWS.length * 16 + 1 : 0;
    // Fingers need taller rows than a mouse; a short phone screen scrolls instead of shrinking past that.
    const min = window.matchMedia('(pointer: coarse)').matches ? ROW_MIN_TOUCH : ROW_MIN;
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
        roll.classList.toggle('is-readonly', clip.kind === 'notes');
        win.setTitle(`Piano Roll · ${clipTitle(clip)}`);
        hintEl.hidden = clip.kind !== 'notes';
        if (clip.kind === 'notes') hintEl.textContent = 'Drag onto a P square to edit as a pattern';
        paintLanes(clip);
        const measured = measureRow(clip);
        if (measured) rowPx = measured;
        sheet.style.setProperty('--row', `${rowPx}px`);
        if (clip.kind === 'd') paintDrums(clip);
        else if (clip.kind === 'notes') paintNotes(clip);
        else paintPitch(clip);
        paintProps(clip);
        syncFoldBtn(clip);
        syncVoiceBtns(clip);
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
    if (jump && clip.kind !== 'd') scrollToPitches(clipPitches(clip));
    else if (!jump) {
        scroller.scrollTop = keepTop;
        scroller.scrollLeft = keepLeft;
    }
}

function clipTitle(clip) {
    if (clip.kind === 'notes') return 'Rec';
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
    LANE_NAMES.forEach((name, index) => {
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

function syncFoldBtn(clip) {
    const pitched = clip?.kind === 'n' || clip?.kind === 'b';
    const scaleOn = pitched && !!scaleDegrees();
    foldBtn.hidden = !pitched;
    roll.querySelector('#arrangeRollInvert').hidden = clip?.kind === 'd';
    foldBtn.classList.toggle('is-on', foldNotes);
    foldBtn.setAttribute('aria-pressed', foldNotes ? 'true' : 'false');
    scaleBtn.hidden = !scaleOn;
    scaleBtn.classList.toggle('is-on', scaleOn && scaleView);
    scaleBtn.setAttribute('aria-pressed', scaleOn && scaleView ? 'true' : 'false');
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
    const pitched = clip?.kind === 'n' || clip?.kind === 'b';
    monoBtn.hidden = !pitched;
    polyBtn.hidden = !pitched;
    monoBtn.classList.toggle('is-on', !polyEdit);
    monoBtn.setAttribute('aria-pressed', polyEdit ? 'false' : 'true');
    polyBtn.classList.toggle('is-on', polyEdit);
    polyBtn.setAttribute('aria-pressed', polyEdit ? 'true' : 'false');
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

function paintNotes(clip) {
    sheet.style.setProperty('--cols', '1');
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    gridEl.replaceChildren();
    paintKeyboard();
    const layer = document.createElement('div');
    layer.className = 'arrange-roll-notes';
    const length = Math.max(1, Number(clip.lengthTick) || 1);
    for (const note of clip.notes || []) {
        const semi = Math.round(Number(note.semi));
        if (!Number.isFinite(semi)) continue;
        const tune = Math.max(TUNE_LO, Math.min(TUNE_HI, semi));
        const start = Math.max(0, Number(note.startTick) || 0);
        const dur = Math.max(1, Number(note.durTick) || 1);
        const bar = document.createElement('div');
        bar.className = 'arrange-roll-note';
        bar.style.top = `${(TUNE_HI - tune) * rowPx + 1}px`;
        bar.style.height = `${Math.max(4, rowPx - 2)}px`;
        bar.style.left = `${(start / length) * 100}%`;
        bar.style.width = `${Math.max(0.8, (dur / length) * 100)}%`;
        bar.title = semitonesToNoteName(tune);
        layer.appendChild(bar);
    }
    gridEl.appendChild(layer);
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
    const ratch = Math.round(Number(step?.ratch) || 1);
    if (step && ratch >= 2) {
        const mark = document.createElement('span');
        mark.className = 'arrange-roll-ratch arrange-roll-ratch-head';
        mark.textContent = String(ratch);
        el.appendChild(mark);
    }
    if (col === selectedCol) el.classList.add('is-col');
    if (col % 4 === 0) el.classList.add('is-bar');
    return el;
}

// Vertical piano, Ableton style: every key edge sits on a lane or half-lane line, so a white key
// covers its own lane plus half of each neighbouring black lane, and black keys cover exactly one lane.
function paintKeyboard() {
    const rows = TUNE_HI - TUNE_LO + 1;
    keysEl.classList.remove('is-fold');
    keysEl.classList.add('is-piano');
    keysEl.style.height = `calc(var(--row, 16px) * ${rows})`;
    const blacks = [];
    for (let tune = TUNE_HI; tune >= TUNE_LO; tune -= 1) {
        const row = TUNE_HI - tune;
        const el = document.createElement('div');
        el.dataset.tune = String(tune);
        el.title = semitonesToNoteName(tune);
        if (isBlack(tune)) {
            el.className = 'arrange-roll-bkey';
            el.style.top = `calc(var(--row, 16px) * ${row})`;
            blacks.push(el);
            continue;
        }
        const up = tune < TUNE_HI && isBlack(tune + 1) ? 0.5 : 0;
        const down = tune > TUNE_LO && isBlack(tune - 1) ? 0.5 : 0;
        el.className = 'arrange-roll-wkey';
        el.style.top = `calc(var(--row, 16px) * ${row - up})`;
        el.style.height = `calc(var(--row, 16px) * ${1 + up + down})`;
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
}

function onKeyMove(event) {
    if (!audition || event.pointerId !== audition.pointer) return;
    const tune = keyTuneAt(event.clientX, event.clientY);
    if (tune != null) soundKey(tune);
}

function onKeyUp(event) {
    if (!audition || event.pointerId !== audition.pointer) return;
    stopAudition();
}

function stopAudition() {
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
            const mark = document.createElement('span');
            mark.className = 'arrange-roll-ratch';
            mark.textContent = String(ratch);
            el.appendChild(mark);
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
    return !!state.songPlaying && !!state.isPlaying;
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
    if (clip.kind === 'notes') return { pct: ((tick - start) / Math.max(1, len)) * 100 };
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
    if (event.button !== 0 || session) return;
    const head = event.target.closest('.arrange-roll-head');
    if (head && roll.contains(head)) {
        selectedCol = head.dataset.col | 0;
        syncTools();
        previewStep(selectedStep(findClip(openId)));
        return;
    }
    const cell = event.target.closest('.arrange-roll-cell');
    if (!cell || !roll.contains(cell) || cell.classList.contains('is-dim')) return;
    const clip = findClip(openId);
    if (!clip || clip.kind === 'notes') return;
    const col = cell.dataset.col | 0;
    selectedCol = col;
    syncTools();
    const tune = cell.dataset.tune != null ? Number(cell.dataset.tune) : null;
    session = {
        id: event.pointerId,
        kind: clip.kind,
        col,
        row: cell.dataset.row != null ? (cell.dataset.row | 0) : 0,
        tune,
        from: cell.classList.contains('is-on') && tune != null ? tune : null,
        to: tune,
        x: event.clientX,
        y: event.clientY,
        drag: false,
    };
    if (session.from != null) {
        event.preventDefault();
        cell.classList.add('is-drag');
        previewStep(patternOf(clip)?.steps?.[col]);
    }
    try { cell.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
}

function onPointerMove(event) {
    if (!session || event.pointerId !== session.id) return;
    if (session.kind === 'd' || session.from == null) return;
    dragY = event.clientY;
    if (!session.drag && Math.abs(event.clientY - session.y) < 5) return;
    session.drag = true;
    const next = tuneFromClientY(event.clientY);
    if (next != null && next !== session.to) {
        session.to = next;
        paintDrag(session.col, session.from, session.to);
        previewDrag();
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
    if (s.kind === 'd') {
        if (Math.hypot(event.clientX - s.x, event.clientY - s.y) > 6) return;
        toggleDrum(s.row, s.col);
        return;
    }
    if (s.drag) {
        if (s.from != null && s.to != null && s.to !== s.from) commitDrag(s.col, s.from, s.to);
        else render({ jump: false });
        return;
    }
    if (s.from == null && Math.hypot(event.clientX - s.x, event.clientY - s.y) > 6) return;
    if (s.tune == null) return;
    togglePitch(s.col, s.tune);
}

function cancelSession() {
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

function paintDrag(col, from, to) {
    gridEl.querySelectorAll(`.arrange-roll-cell[data-col="${col}"]`).forEach((cell) => {
        const tune = Number(cell.dataset.tune);
        const base = cell.dataset.on === '1';
        const on = tune === from ? false : tune === to ? true : base;
        cell.classList.toggle('is-on', on);
        cell.classList.toggle('is-drag', on && tune === to);
        cell.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
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
    const next = tuneFromClientY(dragY);
    if (next != null && next !== session.to) {
        session.to = next;
        paintDrag(session.col, session.from, session.to);
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

function commitDrag(col, from, to) {
    const clip = findClip(openId);
    if (!clip || (clip.kind !== 'n' && clip.kind !== 'b')) return;
    const step = patternOf(clip)?.steps?.[col];
    if (!step) return;
    const next = stepPitches(step).filter((p) => p !== from);
    if (to >= TUNE_LO && to <= TUNE_HI) next.push(to);
    const keepOff = step.on === false;
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const target = patternOf(live)?.steps?.[col];
    if (!target) return;
    applyPitches(target, next, keepOff);
    selectedCol = col;
    refreshArrange();
    previewStep(target);
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
    const pitches = columnPitches(step).filter((p) => p !== session.from);
    if (!pitches.includes(session.to)) pitches.push(session.to);
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
