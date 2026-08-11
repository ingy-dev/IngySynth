import { state, OSC_COUNT } from './state.js?v=107';
import {
    clearHeldNotes,
    intervalsFromHeldNotes,
} from './held-notes.js?v=5';
import { refreshFilterInputDrive } from './filter-drive.js?v=8';
import { setPolyMode } from './poly-voice.js?v=34';

/** Notes heard during the current Learn gesture (survives staggered key-ups). */
let learnSessionNotes = [];

function setOscTuneUI(oscIndex, value) {
    const clamped = Math.max(-12, Math.min(12, Math.round(Number(value) || 0)));
    state.oscTunes[oscIndex] = clamped;

    const main = document.querySelector(`.osc-tune[data-osc="${oscIndex}"]`);
    if (main) {
        main.value = String(clamped);
        const display = main.nextElementSibling;
        if (display?.classList?.contains('osc-tune-value')) {
            display.textContent = String(clamped);
        }
        main.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const kbVal = document.getElementById(`kbOsc${oscIndex + 1}TuneValue`);
    if (kbVal) kbVal.textContent = String(clamped);
}

/** Turn an oscillator On (used when Chord Mem learns a 4th voice). */
function enableOscillator(oscIndex) {
    if (state.oscStates[oscIndex]) return;

    state.oscStates[oscIndex] = true;

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
        const volEl = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
        const vol = parseFloat(volEl?.value ?? '0.33');
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

export function syncChordMemUI() {
    const btn = document.getElementById('keyboardChordMemToggle');
    if (!btn) return;
    const learning = !!state.chordMemoryLearning;
    const locked = !!(state.isPlaying || state.keyboardWrite);
    // Idle = red "Chord Mem"; learning = flashing green rec dot
    btn.classList.toggle('off', !learning);
    btn.classList.toggle('active', learning);
    btn.classList.toggle('is-locked', locked);
    btn.disabled = locked;
    btn.setAttribute('aria-pressed', learning ? 'true' : 'false');
    btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
    btn.setAttribute('aria-label', learning ? 'Chord memory learning' : 'Chord memory learn');
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
    beginChordMemoryLearn();
}

/**
 * Commit Learn from the session peak chord (not the last remaining key).
 * Writes oscTunes and auto-offs Chord Mem.
 * A 4-note chord automatically enables OSC 4.
 */
export function commitChordMemoryFromNotes(notes) {
    if (!state.chordMemoryLearning || state.isPlaying) return false;
    const source = (notes?.length ? notes : learnSessionNotes);
    if (!source.length) return false;

    // Leave poly playground first so osc On/Off restore, then Chord Mem writes tunes
    if (state.keyboardPoly) setPolyMode(false);

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
