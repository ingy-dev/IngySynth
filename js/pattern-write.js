// TB-303-style step write mode: keyboard programs .step-tune / On / Acc / Sld.
import { state } from './state.js?v=120';
import { refreshIdleVfd, beginWriteVfdPrompt, endWriteVfdPrompt, markWriteStepProgrammed, stopArp } from './sequencer.js?v=452';
import { setCollapsibleExpanded } from './collapsible.js?v=75';
import { isTabbedView, selectKeyboardTab } from './view-mode.js?v=13';
import { bindKnob } from './knobs.js?v=183';
import { cancelChordMemoryLearn, syncChordMemUI } from './chord-memory.js?v=49';
import { forceNoteOff } from './voice.js?v=188';
import { forcePolyAllOff, polyNoteOn, polyNoteOff } from './poly-voice.js?v=188';
import { getNumber, set, subscribe } from './params.js?v=40';
import { getGlobalTune } from './tuning.js?v=104';
import { updateChordVisualizer, clearNoteVisualizer } from './visualizers.js?v=147';
import {
    getLiveStep,
    chordFromCellNotes,
    clampChord,
    paintStepChordMarker,
} from './pattern-bank.js?v=46';

const WRITE_TUNE_MIN = -39; // A0 — match full keyboard / computer-keys range
const WRITE_TUNE_MAX = 48;  // C8

const polyWriteHeld = new Set();
const polyWriteSession = new Set();
let polyWriteTargetStep = null;
let polyWriteIgnoreUntilEmpty = false;

export function isPolyWriteMode() {
    return !!(state.keyboardWrite && (state.keyboardPoly || state.keyboardMultitudes));
}

export function getPolyWriteHeldNotes() {
    return [...polyWriteSession];
}

function clampWriteSemi(cellSemitone) {
    return Math.max(WRITE_TUNE_MIN, Math.min(WRITE_TUNE_MAX, Math.round(cellSemitone)));
}

function previewPolyWrite(semi, on) {
    if (state.isPlaying || !Number.isFinite(semi)) return;
    const sounding = semi + getGlobalTune();
    if (on) polyNoteOn(semi, sounding);
    else polyNoteOff(semi);
}

function applyChordToLiveStep(step, notes) {
    const { tune, chord } = chordFromCellNotes(notes);
    setStepTune(step, tune);
    setStepOn(step, true);
    const live = getLiveStep(step);
    live.chord = clampChord(chord);
    paintStepChordMarker(step, live);
}

function clearLiveChord(step) {
    const live = getLiveStep(step);
    live.chord = [];
    paintStepChordMarker(step, live);
}

function commitPolyWrite({ advance = false } = {}) {
    if (polyWriteSession.size === 0) return false;
    const step = polyWriteTargetStep != null
        ? clampWriteStep(polyWriteTargetStep)
        : clampWriteStep(state.writeStep);
    const notes = [...polyWriteSession];
    if (!state.isPlaying) {
        for (const n of polyWriteHeld) polyNoteOff(n);
    }
    applyChordToLiveStep(step, notes);
    polyWriteSession.clear();
    polyWriteTargetStep = null;
    requestKeyboardStepsSync();
    markWriteStepProgrammed();
    if (advance) advanceAfterWrite();
    else {
        syncWriteToolbarFromStep();
        syncWriteCursorHighlight();
    }
    return true;
}

export function commitPolyWriteIfHolding({ advance = false } = {}) {
    if (polyWriteSession.size === 0) return false;
    const ok = commitPolyWrite({ advance });
    polyWriteIgnoreUntilEmpty = polyWriteHeld.size > 0;
    return ok;
}

function resetPolyWriteCapture() {
    if (!state.isPlaying) {
        for (const n of polyWriteHeld) polyNoteOff(n);
    }
    polyWriteHeld.clear();
    polyWriteSession.clear();
    polyWriteTargetStep = null;
    polyWriteIgnoreUntilEmpty = false;
    paintPolyWriteChordVfd();
}

function paintPolyWriteChordVfd() {
    if (state.isPlaying || window.noteVisualizerPreviewActive) return;
    const notes = [...polyWriteSession];
    if (!notes.length) {
        clearNoteVisualizer();
        return;
    }
    const global = getGlobalTune();
    updateChordVisualizer(notes.map((n) => n + global));
}

export function polyWriteNoteDown(cellSemitone) {
    if (!isPolyWriteMode() || !Number.isFinite(cellSemitone)) return false;
    const semi = clampWriteSemi(cellSemitone);
    polyWriteHeld.add(semi);
    if (polyWriteIgnoreUntilEmpty) return true;
    if (polyWriteSession.size === 0) {
        polyWriteTargetStep = clampWriteStep(state.writeStep);
    }
    polyWriteSession.add(semi);
    previewPolyWrite(semi, true);
    paintPolyWriteChordVfd();
    document.dispatchEvent(new CustomEvent('ingysynth:poly-write-keys'));
    return true;
}

export function polyWriteNoteUp(cellSemitone) {
    if (!Number.isFinite(cellSemitone)) return false;
    const semi = clampWriteSemi(cellSemitone);
    polyWriteHeld.delete(semi);
    previewPolyWrite(semi, false);
    if (polyWriteIgnoreUntilEmpty) {
        if (polyWriteHeld.size === 0) polyWriteIgnoreUntilEmpty = false;
        return true;
    }
    if (!isPolyWriteMode()) {
        polyWriteSession.clear();
        polyWriteTargetStep = null;
        paintPolyWriteChordVfd();
        return false;
    }
    if (polyWriteHeld.size === 0 && polyWriteSession.size > 0) {
        commitPolyWrite({ advance: true });
        paintPolyWriteChordVfd();
    }
    document.dispatchEvent(new CustomEvent('ingysynth:poly-write-keys'));
    return true;
}

let writeFineBound = false;
let syncingWriteFineFromStep = false;

function stepCount() {
    const n = Math.round(getNumber('stepCount', 8));
    return Math.max(1, Math.min(32, Number.isFinite(n) ? n : 8));
}

function clampWriteStep(step) {
    const n = stepCount();
    if (!Number.isFinite(step)) return 0;
    return ((Math.round(step) % n) + n) % n;
}

function formatCents(cents) {
    const n = Math.round(Number(cents) || 0);
    return `${n > 0 ? '+' : ''}${n}¢`;
}

export function requestKeyboardStepsSync() {
    document.dispatchEvent(new CustomEvent('ingysynth-kb-steps-sync'));
}

function syncWriteFineEnabled() {
    const knob = document.querySelector('.keyboard-write-fine-knob');
    const dial = document.getElementById('kbWriteFineKnob');
    if (knob) knob.classList.toggle('is-disabled', !state.keyboardWrite);
    if (dial) {
        if (state.keyboardWrite) dial.removeAttribute('tabindex');
        else dial.setAttribute('tabindex', '-1');
        dial.setAttribute('aria-disabled', state.keyboardWrite ? 'false' : 'true');
    }
}

/** Pull current write-step fine cents into the Write µTUNE knob. */
export function syncWriteFineKnob() {
    const proxy = document.getElementById('kbWriteFineProxy');
    const valueEl = document.getElementById('kbWriteFineValue');
    if (!proxy) return;
    const cents = Math.round(Number(getLiveStep(state.writeStep).fine) || 0);
    syncingWriteFineFromStep = true;
    proxy.value = String(cents);
    proxy.dispatchEvent(new Event('input', { bubbles: true }));
    syncingWriteFineFromStep = false;
    if (valueEl) valueEl.textContent = formatCents(cents);
}

function applyWriteFineFromProxy() {
    if (syncingWriteFineFromStep || !state.keyboardWrite) return;
    const proxy = document.getElementById('kbWriteFineProxy');
    const valueEl = document.getElementById('kbWriteFineValue');
    if (!proxy) return;
    const cents = Math.round(Number(proxy.value) || 0);
    set(`step-fine-${state.writeStep}`, cents);
    if (valueEl) valueEl.textContent = formatCents(cents);
}

function initWriteFineKnob() {
    if (writeFineBound) return;
    const dial = document.getElementById('kbWriteFineKnob');
    const proxy = document.getElementById('kbWriteFineProxy');
    const valueEl = document.getElementById('kbWriteFineValue');
    if (!dial || !proxy) return;
    writeFineBound = true;

    bindKnob(dial, proxy, null, {
        onInteract: () => {
            if (valueEl) valueEl.textContent = formatCents(proxy.value);
            endWriteVfdPrompt();
        },
    });

    proxy.addEventListener('input', () => {
        applyWriteFineFromProxy();
        if (valueEl) valueEl.textContent = formatCents(proxy.value);
    });

    for (let i = 0; i < 32; i++) {
        subscribe(`step-fine-${i}`, () => {
            if (!state.keyboardWrite) return;
            if (state.writeStep !== i) return;
            syncWriteFineKnob();
        });
    }

    syncWriteFineKnob();
    syncWriteFineEnabled();
}

function syncWriteButton() {
    const btn = document.getElementById('kbWrite');
    if (!btn) return;
    btn.classList.toggle('off', !state.keyboardWrite);
    btn.classList.toggle('on', state.keyboardWrite);
    btn.setAttribute('aria-pressed', state.keyboardWrite ? 'true' : 'false');
}

function syncWriteNavEnabled() {
    const disabled = !state.keyboardWrite;
    ['kbWritePrev', 'kbWriteNext', 'kbRest', 'kbWriteAcc', 'kbWriteSld'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = disabled;
    });
}

function isStepOn(step) {
    return getLiveStep(step).on !== false;
}

function isStepFlagOn(kind, step) {
    const data = getLiveStep(step);
    if (kind === 'accent') return !!data.accent;
    if (kind === 'slide') return !!data.slide;
    return false;
}

/** Write-toolbar Acc/Sld/Rst mirror the write-cursor step (not sticky arms). */
export function syncWriteToolbarFromStep() {
    const step = state.writeStep;
    const acc = document.getElementById('kbWriteAcc');
    const sld = document.getElementById('kbWriteSld');
    const rest = document.getElementById('kbRest');
    const accOn = isStepFlagOn('accent', step);
    const sldOn = isStepFlagOn('slide', step);
    const restOn = !isStepOn(step);
    // Keep state mirrors in sync for any leftover readers
    state.writeArmAccent = accOn;
    state.writeArmSlide = sldOn;

    if (acc) {
        acc.classList.toggle('off', !accOn);
        acc.classList.toggle('on', accOn);
        acc.setAttribute('aria-pressed', accOn ? 'true' : 'false');
    }
    if (sld) {
        sld.classList.toggle('off', !sldOn);
        sld.classList.toggle('on', sldOn);
        sld.setAttribute('aria-pressed', sldOn ? 'true' : 'false');
    }
    if (rest) {
        rest.classList.toggle('off', !restOn);
        rest.classList.toggle('on', restOn);
        rest.setAttribute('aria-pressed', restOn ? 'true' : 'false');
    }
}

export function syncWriteCursorHighlight() {
    document.querySelectorAll('.keyboard-step.write-cursor, .sequencer-step.write-cursor')
        .forEach((el) => el.classList.remove('write-cursor'));
    if (!state.keyboardWrite) return;
    const step = state.writeStep;
    document.querySelector(`.keyboard-step[data-step="${step}"]`)?.classList.add('write-cursor');
    document.querySelector(`.sequencer-step[data-step="${step}"]`)?.classList.add('write-cursor');
}

function setStepOn(step, on) {
    set(`step-toggle-${step}`, !!on);
}

function setStepFlag(kind, step, on) {
    if (kind !== 'accent' && kind !== 'slide') return;
    set(`step-${kind}-${step}`, !!on);
}

function setStepTune(step, semitones) {
    const clamped = Math.max(WRITE_TUNE_MIN, Math.min(WRITE_TUNE_MAX, Math.round(semitones)));
    set(`step-slider-${step}`, clamped);
}

function syncArpButtonOff() {
    const btn = document.getElementById('keyboardArpToggle');
    if (!btn) return;
    const front = btn.querySelector('.front');
    if (front) front.textContent = 'Arp: Off';
    else btn.textContent = 'Arp: Off';
    btn.classList.add('off');
    btn.setAttribute('aria-pressed', 'false');

    state.keyboardArpChord = false;
    state.arpRange = 1;
    const chord = document.getElementById('keyboardArpChordToggle');
    if (chord) {
        const cFront = chord.querySelector('.front');
        if (cFront) cFront.textContent = 'Arp Chord: Off';
        else chord.textContent = 'Arp Chord: Off';
        chord.classList.add('off', 'is-locked');
        chord.disabled = true;
        chord.setAttribute('aria-pressed', 'false');
        chord.setAttribute('aria-disabled', 'true');
    }
    const order = document.getElementById('keyboardArpOrderToggle');
    if (order) {
        const oFront = order.querySelector('.front');
        if (oFront) oFront.textContent = 'Order: Up';
        else order.textContent = 'Order: Up';
        order.classList.add('off', 'is-locked');
        order.disabled = true;
        order.setAttribute('aria-pressed', 'false');
        order.setAttribute('aria-disabled', 'true');
    }
    const range = document.getElementById('keyboardArpRangeToggle');
    if (range) {
        const rFront = range.querySelector('.front');
        if (rFront) rFront.textContent = 'Range: 1';
        else range.textContent = 'Range: 1';
        range.classList.add('off', 'is-locked');
        range.disabled = true;
        range.setAttribute('aria-pressed', 'false');
        range.setAttribute('aria-disabled', 'true');
    }
}

const WRITE_VIEW_PANEL_IDS = [
    'keyboardStepsFieldset',
    'keyboardSynthFieldset',
    'keyboardMixerFieldset',
    'keyboardXyFieldset',
    'keyboardAutomationFieldset',
];

/** Pre-Write expand/collapse layout — restored when Write exits. */
let writeViewSnapshot = null;

function isPanelExpanded(fieldset) {
    return !!(fieldset && !fieldset.classList.contains('collapsed'));
}

/** Snapshot current panels, then open Steps and collapse synth/XY/automation. */
function applyWriteTemporaryView() {
    if (isTabbedView()) {
        selectKeyboardTab('keyboardStepsFieldset');
        return;
    }

    writeViewSnapshot = {};
    for (const id of WRITE_VIEW_PANEL_IDS) {
        writeViewSnapshot[id] = isPanelExpanded(document.getElementById(id));
    }

    state.keyboardStepsExpanded = true;
    setCollapsibleExpanded(document.getElementById('keyboardStepsFieldset'), true);
    setCollapsibleExpanded(document.getElementById('keyboardSynthFieldset'), false);
    setCollapsibleExpanded(document.getElementById('keyboardMixerFieldset'), false);
    setCollapsibleExpanded(document.getElementById('keyboardXyFieldset'), false);
    setCollapsibleExpanded(document.getElementById('keyboardAutomationFieldset'), false);
}

function restoreWriteTemporaryView() {
    if (isTabbedView()) {
        writeViewSnapshot = null;
        return;
    }
    if (!writeViewSnapshot) return;
    for (const id of WRITE_VIEW_PANEL_IDS) {
        const expanded = !!writeViewSnapshot[id];
        setCollapsibleExpanded(document.getElementById(id), expanded);
        if (id === 'keyboardStepsFieldset') {
            state.keyboardStepsExpanded = expanded;
        }
    }
    writeViewSnapshot = null;
}

export function setWriteCursor(step) {
    if (state.keyboardWrite) commitPolyWriteIfHolding({ advance: false });
    state.writeStep = clampWriteStep(step);
    syncWriteCursorHighlight();
    syncWriteFineKnob();
    syncWriteToolbarFromStep();
    requestKeyboardStepsSync();
    if (state.keyboardWrite) endWriteVfdPrompt();
}

export function nudgeWriteCursor(delta) {
    if (!state.keyboardWrite) return;
    setWriteCursor(state.writeStep + delta);
}

export function setWriteMode(on, { refreshKeyboard } = {}) {
    const next = !!on;
    if (next === state.keyboardWrite) {
        syncWriteButton();
        syncWriteNavEnabled();
        return;
    }

    state.keyboardWrite = next;
    document.body.classList.toggle('write-mode-on', next);

    if (next) {
        if (state.keyboardArp) {
            state.keyboardArp = false;
            state.keyboardArpChord = false;
            stopArp();
            syncArpButtonOff();
        }
        if (state.keyboardPoly || state.keyboardMultitudes) {
            forceNoteOff();
            forcePolyAllOff();
            resetPolyWriteCapture();
        }
        cancelChordMemoryLearn();
        syncChordMemUI();
        state.writeStep = clampWriteStep(state.writeStep);
        applyWriteTemporaryView();
        syncWriteButton();
        syncWriteNavEnabled();
        syncWriteFineEnabled();
        syncWriteCursorHighlight();
        syncWriteFineKnob();
        syncWriteToolbarFromStep();
        requestKeyboardStepsSync();
        beginWriteVfdPrompt();
    } else {
        commitPolyWriteIfHolding({ advance: false });
        resetPolyWriteCapture();
        restoreWriteTemporaryView();
        syncWriteButton();
        syncWriteNavEnabled();
        syncWriteFineEnabled();
        syncWriteCursorHighlight();
        requestKeyboardStepsSync();
        refreshIdleVfd();
        syncChordMemUI();
    }

    if (typeof refreshKeyboard === 'function') refreshKeyboard();
}

export function toggleWriteMode(refreshKeyboard) {
    setWriteMode(!state.keyboardWrite, { refreshKeyboard });
}

function toggleWriteStepFlag(kind) {
    if (!state.keyboardWrite) return;
    if (kind !== 'accent' && kind !== 'slide') return;
    const step = clampWriteStep(state.writeStep);
    state.writeStep = step;
    setStepFlag(kind, step, !isStepFlagOn(kind, step));
    requestKeyboardStepsSync();
    syncWriteToolbarFromStep();
    markWriteStepProgrammed();
    endWriteVfdPrompt();
}

export function toggleWriteAccentArm() {
    toggleWriteStepFlag('accent');
}

export function toggleWriteSlideArm() {
    toggleWriteStepFlag('slide');
}

function advanceAfterWrite() {
    setWriteCursor(state.writeStep + 1);
}

export function writeNote(cellSemitone) {
    if (!state.keyboardWrite) return false;
    if (!Number.isFinite(cellSemitone)) return false;
    if (isPolyWriteMode()) return polyWriteNoteDown(cellSemitone);

    // Keep within step-tune range (same span as chromatic / computer keyboard)
    const semi = Math.max(WRITE_TUNE_MIN, Math.min(WRITE_TUNE_MAX, Math.round(cellSemitone)));

    const step = clampWriteStep(state.writeStep);
    state.writeStep = step;

    setStepTune(step, semi);
    setStepOn(step, true);
    clearLiveChord(step);
    // Acc/Sld are per-step edits via the toolbar — don't overwrite when entering pitch
    requestKeyboardStepsSync();
    markWriteStepProgrammed();

    advanceAfterWrite();
    syncWriteToolbarFromStep();
    return true;
}

export function toggleWriteRest() {
    if (!state.keyboardWrite) return false;
    commitPolyWriteIfHolding({ advance: false });
    const step = clampWriteStep(state.writeStep);
    state.writeStep = step;

    if (isStepOn(step)) {
        setStepOn(step, false);
        setStepFlag('accent', step, false);
        setStepFlag('slide', step, false);
        clearLiveChord(step);
    } else {
        setStepOn(step, true);
        clearLiveChord(step);
    }

    requestKeyboardStepsSync();
    syncWriteToolbarFromStep();
    markWriteStepProgrammed();
    return true;
}

export function writeRest() {
    return toggleWriteRest();
}

export function initPatternWrite(refreshKeyboard) {
    syncWriteButton();
    syncWriteNavEnabled();
    syncWriteToolbarFromStep();
    initWriteFineKnob();

    document.getElementById('kbWrite')?.addEventListener('click', () => {
        toggleWriteMode(refreshKeyboard);
    });
    document.getElementById('kbWritePrev')?.addEventListener('click', () => {
        nudgeWriteCursor(-1);
    });
    document.getElementById('kbWriteNext')?.addEventListener('click', () => {
        nudgeWriteCursor(1);
    });
    document.getElementById('kbRest')?.addEventListener('click', () => {
        toggleWriteRest();
    });
    document.getElementById('kbWriteAcc')?.addEventListener('click', () => {
        toggleWriteAccentArm();
    });
    document.getElementById('kbWriteSld')?.addEventListener('click', () => {
        toggleWriteSlideArm();
    });

    subscribe('stepCount', () => {
        if (!state.keyboardWrite) return;
        setWriteCursor(state.writeStep);
    });
}
