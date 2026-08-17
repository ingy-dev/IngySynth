import { state, OSC_COUNT } from './state.js?v=114';
import { getOscVol, set } from './params.js?v=8';
import {
    clearHeldNotes,
    intervalsFromHeldNotes,
    polyChordIntervalsFromNotes,
} from './held-notes.js?v=8';
import { refreshFilterInputDrive } from './filter-drive.js?v=24';

/** Notes heard during the current Learn gesture (survives staggered key-ups). */
let learnSessionNotes = [];

/** Ingy-6 / Multitudes: one-finger stack through the 6-voice pool. */
let polyChordOn = false;
let polyChordIntervals = [];

const POLY_CHORD_MAX = 6;

function setOscTuneUI(oscIndex, value) {
    const clamped = Math.max(-12, Math.min(12, Math.round(Number(value) || 0)));
    if (state.oscTunes) state.oscTunes[oscIndex] = clamped;
    set(`osc-tune-${oscIndex}`, clamped);

    const kbVal = document.getElementById(`kbOsc${oscIndex + 1}TuneValue`);
    if (kbVal) kbVal.textContent = String(clamped);
}

/** Turn an oscillator On (used when Chord Mem learns a 4th voice). */
function enableOscillator(oscIndex) {
    if (state.oscStates[oscIndex]) return;

    state.oscStates[oscIndex] = true;
    set(`osc-toggle-${oscIndex}`, true);

    const mainToggle = document.querySelector(`.osc-toggle[data-osc="${oscIndex}"]`);
    if (mainToggle) {
        mainToggle.classList.remove('off');
        const front = mainToggle.querySelector('.front');
        if (front) front.textContent = 'On';
    }

    const kbToggle = document.querySelector(`.kb-osc-toggle[data-osc="${oscIndex}"]`);
    if (kbToggle) {
        kbToggle.classList.remove('off');
        kbToggle.textContent = 'On';
        kbToggle.setAttribute('aria-pressed', 'true');
    }

    if (state.audioContext && state.oscGains[oscIndex]) {
        const vol = getOscVol(oscIndex);
        state.oscGains[oscIndex].gain.setValueAtTime(
            Number.isFinite(vol) ? vol : 0.33,
            state.audioContext.currentTime,
        );
    }
    refreshFilterInputDrive();
}

/** Apply up to OSC_COUNT intervals into oscillator tunes and sync knobs. */
export function applyChordMemoryIntervals(intervals) {
    for (let i = 0; i < OSC_COUNT; i++) {
        setOscTuneUI(i, intervals[i] ?? 0);
    }
}

export function isPolyChordMemoryOn() {
    return !!polyChordOn && polyChordIntervals.length > 0;
}

export function getPolyChordIntervals() {
    return polyChordOn ? [...polyChordIntervals] : [];
}

export function clearPolyChordMemory() {
    polyChordOn = false;
    polyChordIntervals = [];
    syncChordMemUI();
}

export function syncChordMemUI() {
    const btn = document.getElementById('keyboardChordMemToggle');
    if (!btn) return;
    const learning = !!state.chordMemoryLearning;
    const armed = isPolyChordMemoryOn() && !learning;
    const locked = !!(state.isPlaying || state.keyboardWrite);
    // Idle = grey SVG; learning = flashing green rec dot; armed = solid green SVG
    btn.classList.toggle('off', !learning && !armed);
    btn.classList.toggle('active', learning);
    btn.classList.toggle('chord-mem-on', armed);
    btn.classList.toggle('is-locked', locked);
    btn.disabled = locked;
    btn.setAttribute('aria-pressed', (learning || armed) ? 'true' : 'false');
    btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
    btn.setAttribute(
        'aria-label',
        learning ? 'Chord memory learning' : armed ? 'Chord memory on' : 'Chord memory learn',
    );
}

export function clearLearnSession() {
    learnSessionNotes = [];
}

/** Record a note into the Learn session (call on key down while learning). */
export function recordLearnNote(semi) {
    if (!Number.isFinite(semi)) return;
    if (!learnSessionNotes.includes(semi)) {
        learnSessionNotes.push(semi);
    }
}

export function getLearnSessionNotes() {
    return [...learnSessionNotes];
}

export function cancelChordMemoryLearn() {
    if (!state.chordMemoryLearning) {
        syncChordMemUI();
        return;
    }
    state.chordMemoryLearning = false;
    clearLearnSession();
    clearHeldNotes();
    syncChordMemUI();
}

export function beginChordMemoryLearn() {
    if (state.isPlaying || state.keyboardWrite) return;
    polyChordOn = false;
    polyChordIntervals = [];
    state.chordMemoryLearning = true;
    clearLearnSession();
    clearHeldNotes();
    syncChordMemUI();
}

export function toggleChordMemoryLearn() {
    if (state.isPlaying || state.keyboardWrite) return;
    if (state.chordMemoryLearning) {
        cancelChordMemoryLearn();
        return;
    }
    if (isPolyChordMemoryOn()) {
        clearPolyChordMemory();
        return;
    }
    beginChordMemoryLearn();
}

function isPolyStyleMode() {
    return !!(state.keyboardPoly || state.keyboardMultitudes);
}

/**
 * Commit Learn from the session peak chord (not the last remaining key).
 * Master: writes oscTunes and auto-offs Chord Mem. 4-note chord enables OSC 4.
 * Ingy-6 / Multitudes: stay in mode, arm one-finger stack, solid green SVG.
 */
export function commitChordMemoryFromNotes(notes) {
    if (!state.chordMemoryLearning || state.isPlaying) return false;
    const source = (notes?.length ? notes : learnSessionNotes);
    if (!source.length) return false;

    if (isPolyStyleMode()) {
        const intervals = polyChordIntervalsFromNotes(source, POLY_CHORD_MAX);
        if (!intervals.length) return false;
        polyChordIntervals = intervals;
        polyChordOn = true;
        state.chordMemoryLearning = false;
        clearLearnSession();
        clearHeldNotes();
        syncChordMemUI();
        return true;
    }

    const uniqueCount = new Set(source.filter(Number.isFinite)).size;
    const intervals = intervalsFromHeldNotes(source);
    applyChordMemoryIntervals(intervals);
    if (uniqueCount >= 4) {
        enableOscillator(3);
    }
    state.chordMemoryLearning = false;
    clearLearnSession();
    clearHeldNotes();
    syncChordMemUI();
    return true;
}
