// Step piano roll for one arrangement clip. Writes clip.data only.
// markEdited runs once per gesture, before the mutation.

import { state } from './state.js?v=120';
import { markEdited } from './song-model.js?v=4';
import {
    POLY_CHORD_MAX,
    chordFromCellNotes,
    clampChord,
    stepCellNotes,
} from './pattern-bank.js?v=50';
import { nextRatch } from './step-ratch.js?v=1';
import { semitonesToNoteName } from './tuning.js?v=108';
import { refreshArrange, setArrangeRollOpener } from './arrange-view.js?v=25';

const TUNE_LO = -39;
const TUNE_HI = 48;
const WINDOW_ROWS = 24;
const ROW_MIN = 12;
const ROW_MAX = 22;

const LANE_NAMES = ['O1', 'O2', 'O3', 'O4', 'M1', 'M2', 'M3', 'M4'];

let roll;
let scroller;
let sheet;
let headsEl;
let keysEl;
let gridEl;
let titleEl;
let lanesEl;
let toolsEl;
let hintEl;
let openId = null;
let laneIndex = 0;
let selectedCol = 0;
let rowPx = 16;
let rendering = false;
let session = null;
let dragY = 0;
let dragRAF = 0;

export function arrangeRollIsOpen() {
    return openId != null;
}

export function closeArrangeRoll() {
    if (openId == null) return;
    cancelSession();
    openId = null;
    if (roll) roll.hidden = true;
    document.body.classList.remove('is-arrange-roll');
    const timelines = document.querySelector('#arrangeView .arrange-timelines');
    if (timelines) timelines.hidden = false;
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
    roll.hidden = true;
    roll.setAttribute('role', 'region');
    roll.setAttribute('aria-label', 'Step piano roll');
    roll.innerHTML = `
        <div class="arrange-roll-bar">
            <span id="arrangeRollTitle" class="arrange-roll-title"></span>
            <div id="arrangeRollLanes" class="arrange-roll-lanes" role="tablist" aria-label="Berlin lanes" hidden></div>
            <div id="arrangeRollTools" class="arrange-roll-tools">
                <button type="button" class="arrange-btn" data-tool="slide" id="arrangeRollSlide">Slide</button>
                <button type="button" class="arrange-btn" data-tool="accent" id="arrangeRollAccent">Accent</button>
                <button type="button" class="arrange-btn" data-tool="ratch" id="arrangeRollRatch">Ratch</button>
            </div>
            <button type="button" class="arrange-btn" id="arrangeRollClose">Close</button>
        </div>
        <p id="arrangeRollHint" class="arrange-roll-hint" hidden>Drag onto a P square to edit as a pattern</p>
        <div class="arrange-roll-scroller" id="arrangeRollScroll">
            <div class="arrange-roll-sheet" id="arrangeRollSheet">
                <div class="arrange-roll-corner"></div>
                <div class="arrange-roll-heads" id="arrangeRollHeads"></div>
                <div class="arrange-roll-keys" id="arrangeRollKeys"></div>
                <div class="arrange-roll-grid" id="arrangeRollGrid"></div>
            </div>
        </div>
    `;
    const bank = view.querySelector('.arrange-bank');
    if (bank) view.insertBefore(roll, bank);
    else view.appendChild(roll);

    scroller = roll.querySelector('#arrangeRollScroll');
    sheet = roll.querySelector('#arrangeRollSheet');
    headsEl = roll.querySelector('#arrangeRollHeads');
    keysEl = roll.querySelector('#arrangeRollKeys');
    gridEl = roll.querySelector('#arrangeRollGrid');
    titleEl = roll.querySelector('#arrangeRollTitle');
    lanesEl = roll.querySelector('#arrangeRollLanes');
    toolsEl = roll.querySelector('#arrangeRollTools');
    hintEl = roll.querySelector('#arrangeRollHint');

    roll.querySelector('#arrangeRollClose').addEventListener('click', () => closeArrangeRoll());
    toolsEl.addEventListener('click', onToolClick);
    lanesEl.addEventListener('click', onLaneClick);
    scroller.addEventListener('pointerdown', onPointerDown);
    roll.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', onRollKey, true);
    document.addEventListener('ingysynth:arrange-render', () => {
        if (openId == null) return;
        if (!findClip(openId)) {
            closeArrangeRoll();
            return;
        }
        render({ jump: false });
    });
    const observer = new ResizeObserver(() => {
        if (openId == null || rendering) return;
        const clip = findClip(openId);
        if (!clip || clip.kind === 'd') return;
        const next = measureRow();
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
    openId = id;
    const timelines = document.querySelector('#arrangeView .arrange-timelines');
    if (timelines) timelines.hidden = true;
    document.body.classList.add('is-arrange-roll');
    roll.hidden = false;
    render({ jump: true });
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

function measureRow() {
    const height = scroller?.clientHeight || 0;
    if (height < 48) return 0;
    const header = headsEl?.offsetHeight || 18;
    return Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor((height - header) / WINDOW_ROWS)));
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
        titleEl.textContent = clipTitle(clip);
        hintEl.hidden = clip.kind !== 'notes';
        if (clip.kind === 'notes') hintEl.textContent = 'Drag onto a P square to edit as a pattern';
        toolsEl.hidden = clip.kind === 'd' || clip.kind === 'notes';
        paintLanes(clip);
        const measured = measureRow();
        if (measured) rowPx = measured;
        sheet.style.setProperty('--row', `${rowPx}px`);
        if (clip.kind === 'd') paintDrums(clip);
        else if (clip.kind === 'notes') paintNotes(clip);
        else paintPitch(clip);
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

function patternOf(clip) {
    if (!clip) return null;
    if (clip.kind === 'n') {
        return {
            steps: clip.data?.steps || [],
            count: clampCount(clip.data?.stepCount),
        };
    }
    if (clip.kind === 'b') {
        const lane = clip.data?.lanes?.[laneIndex];
        if (!lane) return { steps: [], count: 8 };
        return {
            steps: lane.steps || [],
            count: clampCount(lane.stepCount),
        };
    }
    return null;
}

function columnPitches(step) {
    if (!step || step.on === false) return [];
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
    for (let i = 0; i < pattern.count; i += 1) out.push(...columnPitches(pattern.steps[i]));
    return out;
}

function isBlack(tune) {
    const pc = ((tune % 12) + 12) % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function paintPitch(clip) {
    const pattern = patternOf(clip);
    const count = pattern?.count || 8;
    if (selectedCol >= count) selectedCol = 0;
    const steps = pattern?.steps || [];
    sheet.style.setProperty('--cols', String(count));
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    gridEl.replaceChildren();
    for (let col = 0; col < count; col += 1) {
        headsEl.appendChild(headCell(col, steps[col]));
    }
    for (let tune = TUNE_HI; tune >= TUNE_LO; tune -= 1) {
        keysEl.appendChild(keyCell(tune));
        for (let col = 0; col < count; col += 1) {
            const step = steps[col];
            const pitches = columnPitches(step);
            const on = pitches.includes(tune);
            gridEl.appendChild(pitchCell(col, tune, on, step));
        }
    }
}

function paintDrums(clip) {
    const lanes = clip.data?.lanes || [];
    let count = 1;
    for (let i = 0; i < 4; i += 1) count = Math.max(count, clampCount(lanes[i]?.stepCount));
    if (selectedCol >= count) selectedCol = 0;
    sheet.style.setProperty('--cols', String(count));
    sheet.style.setProperty('--row', 'minmax(28px, 1fr)');
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    gridEl.replaceChildren();
    for (let col = 0; col < count; col += 1) headsEl.appendChild(headCell(col, null));
    for (let row = 0; row < 4; row += 1) {
        const lane = lanes[row];
        const own = clampCount(lane?.stepCount);
        keysEl.appendChild(drumKey(row));
        for (let col = 0; col < count; col += 1) {
            const step = lane?.steps?.[col];
            const dim = col >= own || !step;
            const on = !dim && step.on !== false;
            gridEl.appendChild(drumCell(row, col, on, dim));
        }
    }
}

function paintNotes(clip) {
    sheet.style.setProperty('--cols', '1');
    headsEl.replaceChildren();
    keysEl.replaceChildren();
    gridEl.replaceChildren();
    for (let tune = TUNE_HI; tune >= TUNE_LO; tune -= 1) keysEl.appendChild(keyCell(tune));
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

function keyCell(tune) {
    const el = document.createElement('div');
    el.className = 'arrange-roll-key';
    el.dataset.tune = String(tune);
    el.textContent = semitonesToNoteName(tune);
    if (isBlack(tune)) el.classList.add('is-black');
    if (((tune % 12) + 12) % 12 === 0) el.classList.add('is-c');
    return el;
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
    const midTop = header + (TUNE_HI - mid) * rowPx + rowPx / 2;
    scroller.scrollTop = Math.max(0, midTop - scroller.clientHeight / 2);
}

function selectedStep(clip) {
    if (!clip || clip.kind === 'notes' || clip.kind === 'd') return null;
    const pattern = patternOf(clip);
    if (!pattern) return null;
    return pattern.steps[selectedCol] || null;
}

function syncTools() {
    const clip = findClip(openId);
    const step = selectedStep(clip);
    const slide = !!step?.slide;
    const accent = !!step?.accent;
    const ratch = Math.round(Number(step?.ratch) || 1);
    const slideBtn = roll.querySelector('#arrangeRollSlide');
    const accentBtn = roll.querySelector('#arrangeRollAccent');
    const ratchBtn = roll.querySelector('#arrangeRollRatch');
    slideBtn.classList.toggle('is-on', slide);
    slideBtn.setAttribute('aria-pressed', slide ? 'true' : 'false');
    accentBtn.classList.toggle('is-on', accent);
    accentBtn.setAttribute('aria-pressed', accent ? 'true' : 'false');
    ratchBtn.classList.toggle('is-on', ratch >= 2);
    ratchBtn.setAttribute('aria-pressed', ratch >= 2 ? 'true' : 'false');
    ratchBtn.dataset.ratch = String(Math.max(1, Math.min(4, ratch)));
    paintSelection();
}

function paintSelection() {
    roll.querySelectorAll('.is-col').forEach((el) => el.classList.remove('is-col'));
    roll.querySelectorAll(`[data-col="${selectedCol}"]`).forEach((el) => {
        if (el.classList.contains('arrange-roll-head') || el.classList.contains('arrange-roll-cell')) {
            el.classList.add('is-col');
        }
    });
}

function onToolClick(event) {
    const button = event.target.closest('[data-tool]');
    if (!button) return;
    applyTool(button.dataset.tool);
}

function applyTool(which) {
    const clip = findClip(openId);
    if (!clip || clip.kind === 'notes' || clip.kind === 'd') return;
    const before = selectedStep(clip);
    if (!before) return;
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const step = selectedStep(live);
    if (!step) return;
    if (which === 'slide') step.slide = !step.slide;
    else if (which === 'accent') step.accent = !step.accent;
    else step.ratch = nextRatch(step.ratch);
    refreshArrange();
}

function onPointerDown(event) {
    if (event.button !== 0 || session) return;
    const head = event.target.closest('.arrange-roll-head');
    if (head && roll.contains(head)) {
        selectedCol = head.dataset.col | 0;
        syncTools();
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
    if (session.from != null) event.preventDefault();
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
        cell.classList.toggle('is-drag', on && tune === to && from !== to);
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
    }
    dragRAF = requestAnimationFrame(edgeFrame);
}

function togglePitch(col, tune) {
    const clip = findClip(openId);
    if (!clip || (clip.kind !== 'n' && clip.kind !== 'b')) return;
    const pattern = patternOf(clip);
    const step = pattern?.steps?.[col];
    if (!step || tune < TUNE_LO || tune > TUNE_HI) return;
    const pitches = columnPitches(step);
    const has = pitches.includes(tune);
    if (!has && pitches.length >= POLY_CHORD_MAX) return;
    const next = has ? pitches.filter((p) => p !== tune) : pitches.concat(tune);
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const target = patternOf(live)?.steps?.[col];
    if (!target) return;
    applyPitches(target, next);
    selectedCol = col;
    refreshArrange();
}

function commitDrag(col, from, to) {
    const clip = findClip(openId);
    if (!clip || (clip.kind !== 'n' && clip.kind !== 'b')) return;
    const step = patternOf(clip)?.steps?.[col];
    if (!step) return;
    const next = columnPitches(step).filter((p) => p !== from);
    if (to >= TUNE_LO && to <= TUNE_HI) next.push(to);
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const target = patternOf(live)?.steps?.[col];
    if (!target) return;
    applyPitches(target, next);
    selectedCol = col;
    refreshArrange();
}

function applyPitches(step, pitches) {
    const uniq = [];
    const seen = new Set();
    for (const n of pitches) {
        const v = Math.round(Number(n));
        if (!Number.isFinite(v) || v < TUNE_LO || v > TUNE_HI || seen.has(v)) continue;
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
    step.on = true;
    step.tune = formed.tune;
    step.chord = clampChord(formed.chord);
}

function toggleDrum(row, col) {
    const clip = findClip(openId);
    if (!clip || clip.kind !== 'd') return;
    const lane = clip.data?.lanes?.[row];
    if (!lane) return;
    if (col < 0 || col >= clampCount(lane.stepCount)) return;
    const step = lane.steps?.[col];
    if (!step) return;
    const live = markEdited(state.song, clip.id);
    if (!live) return;
    const liveStep = live.data?.lanes?.[row]?.steps?.[col];
    if (!liveStep) return;
    liveStep.on = liveStep.on === false;
    selectedCol = col;
    refreshArrange();
}
