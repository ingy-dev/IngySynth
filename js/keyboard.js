import { state } from './state.js?v=107';
import { getActiveScale, getGlobalTune, semitonesToNoteName, SCALE_BANKS } from './tuning.js?v=74';
import { noteOn, noteOff, forceNoteOff, retuneNote } from './voice.js?v=101';
import { initAudio } from './audio-engine.js?v=129';
import { updateNoteVisualizer } from './visualizers.js?v=90';
import {
    refreshStepTuneReadouts,
    startArp,
    stopArp,
    retuneArpTranspose,
    refreshIdleVfd,
    beginScaleVfdPrompt,
    endScaleVfdPrompt,
    invalidateChordArpOrder,
} from './sequencer.js?v=190';
import { syncKeyboardStepsVisibilityWithKeyboard } from './keyboard-steps.js?v=92';
import { refreshXYPad } from './xy-pad.js?v=75';
import {
    initPatternWrite,
    writeNote,
    setWriteMode,
} from './pattern-write.js?v=86';
import {
    addHeldNote,
    removeHeldNote,
    getHeldNotes,
    getHeldPressOrder,
    heldNoteCount,
    clearHeldNotes,
    needsHeldNoteSet,
    clearFrozenArpNotes,
    clearArpChordSession,
    recordArpChordSessionNote,
    freezeArpChordSession,
} from './held-notes.js?v=5';
import {
    toggleChordMemoryLearn,
    cancelChordMemoryLearn,
    commitChordMemoryFromNotes,
    syncChordMemUI,
    recordLearnNote,
    getLearnSessionNotes,
} from './chord-memory.js?v=9';
import {
    togglePolyMode,
    togglePolyUnison,
    setPolyMode,
    syncPolyModeUI,
    polyNoteOn,
    polyNoteOff,
    forcePolyAllOff,
    retunePolyVoices,
    hasPolyVoices,
    initPolyVoice,
} from './poly-voice.js?v=28';

const ARP_ORDER_CYCLE = ['up', 'down', 'upDown', 'random'];
const POLY_ARP_ORDER_CYCLE = ['up', 'down', 'upDown'];
const ARP_ORDER_LABELS = {
    up: 'Up',
    down: 'Down',
    upDown: 'Up/Down',
    random: 'Rand',
};

// Full 88-key piano: A0 (−39) through C8 (+48), relative to C4 = 0.
const SEMI_MIN = -39;
const SEMI_MAX = 48;
// Step-tune / Write window: full 88-key span (A0…C8), same as live keyboard.
const WRITE_SEMI_MIN = -39;
const WRITE_SEMI_MAX = 48;
const WHITE_KEY_PX_NORMAL = 36;
const WHITE_KEY_PX_FULLSCREEN = 52;

function whiteKeyPx() {
    return state.keyboardFullscreen ? WHITE_KEY_PX_FULLSCREEN : WHITE_KEY_PX_NORMAL;
}

function blackOverhangPx() {
    return whiteKeyPx() * 0.32;
}

// Pitch classes that are black keys (relative to C).
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

let activePointerId = null;
let pressedSemitone = null;
let hasCenteredOnce = false;
/** Multi-touch map while Poly On: pointerId → cell semitone */
const polyPointers = new Map();

function pitchClass(semitones) {
    let pc = semitones % 12;
    if (pc < 0) pc += 12;
    return pc;
}

function isBlackKey(semitones) {
    return BLACK_PCS.has(pitchClass(semitones));
}

export function isInActiveScale(semitonesFromC) {
    const scale = getActiveScale();
    if (!scale || scale.id === 'chromatic') return true;
    const sounding = semitonesFromC + getGlobalTune();
    const rootPc = pitchClass(getGlobalTune());
    const degree = (pitchClass(sounding) - rootPc + 12) % 12;
    return scale.degrees.includes(degree);
}

export function soundingSemitones(cellSemitone) {
    return cellSemitone + getGlobalTune();
}

export function pressKey(cellSemitone) {
    handlePress(cellSemitone);
}

export function releaseKey() {
    handleRelease();
}

export { SEMI_MIN as KEYBOARD_SEMI_MIN, SEMI_MAX as KEYBOARD_SEMI_MAX };

function notifyKeyboardPitchUi() {
    document.dispatchEvent(new CustomEvent('ingysynth:keyboard-pitch-ui'));
}

function updateTransposeReadout() {
    const t = state.keyboardTranspose || 0;
    const name = semitonesToNoteName(t).replace(/\d+$/, '');
    const num = t > 0 ? `+${t}` : `${t}`;
    const label = `T: ${num} (${name})`;
    ['keyboardTransposeReadout', 'kbXyTransposeReadout'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
}

function setKeyActive(semitone, on) {
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return;
    board.querySelectorAll('.piano-key').forEach(key => {
        const s = parseInt(key.dataset.semitone, 10);
        key.classList.toggle('active', on && s === semitone);
        key.classList.toggle('latched', on && state.keyboardLatch && s === semitone);
    });
}

function clearKeyHighlights() {
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return;
    board.querySelectorAll('.piano-key').forEach(key => {
        key.classList.remove('active', 'latched');
    });
}

function highlightNotes(semis) {
    clearKeyHighlights();
    const set = new Set(semis || []);
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return;
    board.querySelectorAll('.piano-key').forEach((key) => {
        const s = parseInt(key.dataset.semitone, 10);
        key.classList.toggle('active', set.has(s));
    });
}

function highlightHeldOrFrozen() {
    const live = getHeldNotes();
    if (live.length) {
        highlightNotes(live);
        return;
    }
    if (state.arpFrozenNotes?.length) {
        highlightNotes(state.arpFrozenNotes);
        return;
    }
    clearKeyHighlights();
}

function highlightFromState() {
    if (!state.isPlaying && (needsHeldNoteSet() || state.arpFrozenNotes?.length)) {
        highlightHeldOrFrozen();
        updateTransposeReadout();
        return;
    }
    clearKeyHighlights();
    if (state.isPlaying) {
        if (state.keyboardHeldSemitone !== null) {
            setKeyActive(state.keyboardHeldSemitone, true);
        } else if (state.keyboardTranspose !== 0) {
            setKeyActive(state.keyboardTranspose, true);
        }
    } else if (state.keyboardHeldSemitone !== null) {
        setKeyActive(state.keyboardHeldSemitone, true);
    }
    updateTransposeReadout();
}

function ensureAudioReady() {
    if (!state.audioContext) initAudio();
    if (state.audioContext && state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }
}

/** Multi-hold note on (Arp Chord / Chord Mem Learn / Poly). Used by piano, QWERTY, MIDI. */
export function heldNoteDown(cellSemitone) {
    if (state.isPlaying || !Number.isFinite(cellSemitone)) return;
    if (!isInActiveScale(cellSemitone)) return;
    ensureAudioReady();

    if (state.chordMemoryLearning) {
        addHeldNote(cellSemitone);
        recordLearnNote(cellSemitone);
        highlightHeldOrFrozen();
        updateNoteVisualizer(soundingSemitones(cellSemitone));
        return;
    }

    // Poly Arp (Juno): held keys feed the pool only — clock plays one note at a time
    if (state.keyboardPoly && state.keyboardArp) {
        ensurePolyChordArp();
        if (heldNoteCount() === 0) {
            clearFrozenArpNotes();
            clearArpChordSession();
        }
        addHeldNote(cellSemitone);
        recordArpChordSessionNote(cellSemitone);
        state.keyboardHeldSemitone = cellSemitone;
        invalidateChordArpOrder();
        highlightHeldOrFrozen();
        updateNoteVisualizer(soundingSemitones(cellSemitone));
        if (!state.isArping) startArp();
        return;
    }

    if (state.keyboardPoly) {
        if (!addHeldNote(cellSemitone)) return;
        state.keyboardHeldSemitone = cellSemitone;
        polyNoteOn(cellSemitone, soundingSemitones(cellSemitone));
        highlightHeldOrFrozen();
        return;
    }

    if (state.keyboardArp && state.keyboardArpChord) {
        // New physical note data replaces a latched chord
        if (heldNoteCount() === 0) {
            clearFrozenArpNotes();
            clearArpChordSession();
        }
        addHeldNote(cellSemitone);
        recordArpChordSessionNote(cellSemitone);
        state.keyboardHeldSemitone = cellSemitone;
        invalidateChordArpOrder();
        highlightHeldOrFrozen();
        updateNoteVisualizer(soundingSemitones(cellSemitone));
        if (!state.isArping) startArp();
    }
}

/** Multi-hold note off. */
export function heldNoteUp(cellSemitone) {
    if (!Number.isFinite(cellSemitone)) return;

    if (state.chordMemoryLearning) {
        removeHeldNote(cellSemitone);
        if (heldNoteCount() === 0) {
            // Commit the full peak chord from this Learn gesture, not the last key left
            commitChordMemoryFromNotes(getLearnSessionNotes());
            clearKeyHighlights();
        } else {
            highlightHeldOrFrozen();
        }
        return;
    }

    // Poly Arp: same latch/freeze semantics as mono chord arp (no direct polyNoteOff)
    if (state.keyboardPoly && state.keyboardArp) {
        removeHeldNote(cellSemitone);
        if (heldNoteCount() === 0) {
            if (state.keyboardLatch && freezeArpChordSession()) {
                invalidateChordArpOrder();
                highlightHeldOrFrozen();
            } else {
                stopArp();
                clearFrozenArpNotes();
                clearArpChordSession();
                state.keyboardHeldSemitone = null;
                clearKeyHighlights();
            }
        } else {
            state.keyboardHeldSemitone = getHeldNotes().at(-1) ?? null;
            invalidateChordArpOrder();
            highlightHeldOrFrozen();
        }
        return;
    }

    if (state.keyboardPoly) {
        removeHeldNote(cellSemitone);
        if (state.keyboardPolyUnison) {
            if (heldNoteCount() === 0) {
                polyNoteOff(cellSemitone);
                state.keyboardHeldSemitone = null;
                clearKeyHighlights();
            } else {
                const last = getHeldPressOrder().at(-1);
                state.keyboardHeldSemitone = last ?? null;
                if (last != null) polyNoteOn(last, soundingSemitones(last));
                highlightHeldOrFrozen();
            }
        } else {
            polyNoteOff(cellSemitone);
            state.keyboardHeldSemitone = getHeldPressOrder().at(-1) ?? null;
            if (heldNoteCount() === 0) clearKeyHighlights();
            else highlightHeldOrFrozen();
        }
        return;
    }

    if (state.keyboardArp && state.keyboardArpChord) {
        removeHeldNote(cellSemitone);
        if (heldNoteCount() === 0) {
            if (state.keyboardLatch && freezeArpChordSession()) {
                // Keep arping the latched peak chord until new notes are played
                invalidateChordArpOrder();
                highlightHeldOrFrozen();
            } else {
                stopArp();
                clearFrozenArpNotes();
                clearArpChordSession();
                state.keyboardHeldSemitone = null;
                clearKeyHighlights();
            }
        } else {
            state.keyboardHeldSemitone = getHeldNotes().at(-1) ?? null;
            invalidateChordArpOrder();
            highlightHeldOrFrozen();
        }
    }
}

function handlePress(cellSemitone) {
    if (pressedSemitone === cellSemitone && state.keyboardHeldSemitone === cellSemitone
        && !needsHeldNoteSet()) {
        return;
    }

    ensureAudioReady();

    const sounding = soundingSemitones(cellSemitone);
    pressedSemitone = cellSemitone;

    if (state.keyboardWrite) {
        writeNote(cellSemitone);
        state.keyboardHeldSemitone = cellSemitone;
        if (!state.isPlaying) {
            if (state.keyboardVoiceActive) {
                retuneNote(sounding);
            } else {
                noteOn(sounding);
            }
        } else {
            updateNoteVisualizer(sounding);
        }
        highlightFromState();
        return;
    }

    if (state.isPlaying) {
        state.keyboardTranspose = cellSemitone;
        state.keyboardHeldSemitone = cellSemitone;
        highlightFromState();
        updateNoteVisualizer(sounding);
        return;
    }

    if (needsHeldNoteSet()) {
        heldNoteDown(cellSemitone);
        return;
    }

    state.keyboardHeldSemitone = cellSemitone;

    if (state.keyboardArp) {
        // Pattern arp: temporary root only — does not sticky-change sequencer transpose.
        if (state.isArping) {
            const delta = cellSemitone - (state.arpTranspose || 0);
            state.arpTranspose = cellSemitone;
            retuneArpTranspose(delta);
        } else {
            state.arpTranspose = cellSemitone;
            startArp();
        }
        highlightFromState();
        updateNoteVisualizer(sounding);
        return;
    }

    if (state.keyboardVoiceActive) {
        retuneNote(sounding);
    } else {
        noteOn(sounding);
    }
    highlightFromState();
}

function keyFromPoint(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const key = el.closest?.('.piano-key');
    if (!key || key.classList.contains('key-out-of-scale')) return null;
    const semi = parseInt(key.dataset.semitone, 10);
    return Number.isFinite(semi) ? semi : null;
}

function handlePointerMove(e) {
    if (state.keyboardWrite) return;
    // Multi-hold / poly: no drag-retune (would break chord / learn / poly)
    if (needsHeldNoteSet()) return;
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const semi = keyFromPoint(e.clientX, e.clientY);
    if (semi === null || semi === pressedSemitone) return;
    handlePress(semi);
}

function polyPointerDown(pointerId, cellSemitone) {
    if (polyPointers.has(pointerId)) return;
    polyPointers.set(pointerId, cellSemitone);
    heldNoteDown(cellSemitone);
}

function polyPointerUp(pointerId) {
    const semi = polyPointers.get(pointerId);
    if (semi === undefined) return;
    polyPointers.delete(pointerId);
    // Only release if no other pointer still holds this semi
    for (const s of polyPointers.values()) {
        if (s === semi) return;
    }
    heldNoteUp(semi);
}

/** Drop multi-touch tracking without note-off/on side effects (teardown-safe). */
function clearPolyPointers() {
    polyPointers.clear();
}

function handleRelease() {
    const released = pressedSemitone;
    pressedSemitone = null;

    if (state.keyboardWrite) {
        state.keyboardHeldSemitone = null;
        if (!state.isPlaying) noteOff();
        clearKeyHighlights();
        return;
    }

    if (state.isPlaying) {
        if (!state.keyboardLatch) {
            highlightFromState();
        }
        return;
    }

    if (needsHeldNoteSet() || state.chordMemoryLearning
        || (state.keyboardArp && state.keyboardArpChord)) {
        if (released != null) heldNoteUp(released);
        return;
    }

    if (state.keyboardLatch) {
        highlightFromState();
        return;
    }

    if (state.isArping) {
        stopArp();
        state.keyboardHeldSemitone = null;
        clearKeyHighlights();
        return;
    }

    state.keyboardHeldSemitone = null;
    noteOff();
    clearKeyHighlights();
}

function keyboardSemiRange() {
    if (state.keyboardWrite) {
        return { min: WRITE_SEMI_MIN, max: WRITE_SEMI_MAX };
    }
    return { min: SEMI_MIN, max: SEMI_MAX };
}

function whiteKeyIndex(semitone, visibleSet) {
    const { min } = keyboardSemiRange();
    let count = 0;
    for (let s = min; s < semitone; s++) {
        if (isBlackKey(s)) continue;
        if (visibleSet && !visibleSet.has(s)) continue;
        count++;
    }
    return count;
}

function countWhiteKeys(visibleSet) {
    const { min, max } = keyboardSemiRange();
    let count = 0;
    for (let s = min; s <= max; s++) {
        if (isBlackKey(s)) continue;
        if (visibleSet && !visibleSet.has(s)) continue;
        count++;
    }
    return count;
}

export function refreshKeyboard() {
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return;

    const { min, max } = keyboardSemiRange();
    const visibleSet = new Set();
    for (let semi = min; semi <= max; semi++) {
        if (!isInActiveScale(semi)) continue;
        visibleSet.add(semi);
    }

    const keyPx = whiteKeyPx();
    const overhang = blackOverhangPx();
    const whites = Math.max(1, countWhiteKeys(visibleSet));
    const boardWidth = whites * keyPx + overhang * 2;
    board.style.setProperty('--white-count', String(whites));
    board.style.setProperty('--white-key-width', `${keyPx}px`);
    board.style.width = `${boardWidth}px`;
    board.style.paddingLeft = `${overhang}px`;
    board.style.paddingRight = `${overhang}px`;
    board.style.boxSizing = 'border-box';
    board.innerHTML = '';

    const whiteLayer = document.createElement('div');
    whiteLayer.className = 'piano-white-layer';
    const blackLayer = document.createElement('div');
    blackLayer.className = 'piano-black-layer';

    let rootKey = null;

    for (let semi = min; semi <= max; semi++) {
        if (!visibleSet.has(semi)) continue;

        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'piano-key';
        key.dataset.semitone = String(semi);
        key.setAttribute('aria-label', semitonesToNoteName(soundingSemitones(semi)));

        const black = isBlackKey(semi);
        key.classList.add(black ? 'piano-key-black' : 'piano-key-white');
        if (semi === 0) {
            key.classList.add('key-root');
            rootKey = key;
        }

        const label = document.createElement('span');
        label.className = 'piano-key-label';
        label.textContent = semitonesToNoteName(soundingSemitones(semi));
        key.appendChild(label);

        if (black) {
            const wi = whiteKeyIndex(semi, visibleSet);
            // Absolute layer is relative to the padding box; whites sit after
            // left padding, so center the black key on that white boundary.
            key.style.left = `${wi * keyPx}px`;
            key.style.width = `${keyPx * 0.64}px`;
            blackLayer.appendChild(key);
        } else {
            key.style.width = `${keyPx}px`;
            key.style.flex = `0 0 ${keyPx}px`;
            whiteLayer.appendChild(key);
        }

        key.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const boardEl = document.getElementById('chromaticKeyboard');
            if (boardEl) {
                try { boardEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            }
            if (state.keyboardPoly && !state.isPlaying && !state.keyboardWrite
                && !state.chordMemoryLearning
                && !(state.keyboardArp && state.keyboardArpChord)) {
                polyPointerDown(e.pointerId, semi);
                return;
            }
            activePointerId = e.pointerId;
            handlePress(semi);
        });
    }

    board.appendChild(whiteLayer);
    board.appendChild(blackLayer);
    highlightFromState();

    // Center the board on middle C (root) once layout has settled
    const panel = document.getElementById('chromaticKeyboardPanel');
    if (panel && rootKey) {
        const centerOnRoot = () => {
            const keyRect = rootKey.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            if (panelRect.width < 1 || keyRect.width < 1) return false;
            const keyCenterInContent =
                panel.scrollLeft + (keyRect.left - panelRect.left) + keyRect.width / 2;
            panel.scrollLeft = Math.max(0, keyCenterInContent - panel.clientWidth / 2);
            return true;
        };

        // Re-center when entering/leaving Write (range changes) or first load
        requestAnimationFrame(() => {
            if (centerOnRoot()) return;
            requestAnimationFrame(centerOnRoot);
        });
        hasCenteredOnce = true;
    }
}

function syncKeyboardXyVisibility() {
    const fieldset = document.getElementById('keyboardXyFieldset');
    if (!fieldset) return;
    const show = !!state.keyboardVisible && !!state.keyboardFullscreen;
    fieldset.hidden = !show;
    if (show) requestAnimationFrame(() => refreshXYPad());
}

function syncChromaticSpaceBarVisibility() {
    const row = document.getElementById('chromaticSpaceBarRow');
    if (!row) return;
    // Default fullscreen play surface: chromatic piano + space (hide when computer keys mode)
    const show = !!state.keyboardVisible
        && !!state.keyboardFullscreen
        && !state.computerKeyboardEnabled;
    row.hidden = !show;
}

function syncMidiFieldsetSlot(fullscreenOn) {
    const midi = document.getElementById('midiFieldset');
    const home = document.getElementById('midiFieldsetHome');
    const stage = document.getElementById('midiFieldsetStage');
    if (!midi || !home || !stage) return;
    const target = fullscreenOn ? stage : home;
    if (midi.parentElement !== target) target.appendChild(midi);
}

function syncFullscreenUI() {
    const section = document.querySelector('.keyboard-section');
    const btn = document.getElementById('keyboardFullscreenToggle');
    const on = !!state.keyboardFullscreen;
    document.body.classList.toggle('keyboard-stage-mode', on);
    if (section) section.classList.toggle('is-fullscreen', on);
    syncMidiFieldsetSlot(on);
    if (btn) {
        const label = on ? 'Exit Fullscreen' : 'Fullscreen';
        const front = btn.querySelector('.front');
        if (front) front.textContent = label;
        else btn.textContent = label;
        btn.classList.toggle('off', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    syncKeyboardXyVisibility();
    syncChromaticSpaceBarVisibility();
}

function setKeyboardFullscreen(on) {
    const was = !!state.keyboardFullscreen;
    state.keyboardFullscreen = !!on;
    syncFullscreenUI();
    if (was !== state.keyboardFullscreen) refreshKeyboard();
}

export function syncVisibilityUI() {
    const section = document.querySelector('.keyboard-section');
    const panel = document.getElementById('chromaticKeyboardPanel');
    const ckbPanel = document.getElementById('computerKeyboardPanel');
    const controls = document.querySelector('.keyboard-filter-knobs');
    const bend = document.getElementById('keyboardPitchBend');
    const toolbarControls = document.getElementById('keyboardControlsFieldset');
    const btn = document.getElementById('keyboardVisibilityToggle');
    const visible = !!state.keyboardVisible;
    if (section) section.classList.toggle('keyboard-off', !visible);
    if (controls) controls.style.display = visible ? '' : 'none';
    if (bend) bend.style.display = visible ? '' : 'none';
    if (toolbarControls) toolbarControls.style.display = visible ? '' : 'none';
    // Chromatic piano vs computer-keys board (view only — QWERTY input works for both)
    if (visible) {
        const ckbOn = !!state.computerKeyboardEnabled;
        if (panel) panel.style.display = ckbOn ? 'none' : '';
        if (ckbPanel) ckbPanel.hidden = !ckbOn;
        section?.classList.toggle('computer-keyboard-mode', ckbOn);
    } else {
        if (panel) panel.style.display = 'none';
        if (ckbPanel) ckbPanel.hidden = true;
        section?.classList.remove('computer-keyboard-mode');
    }
    syncKeyboardStepsVisibilityWithKeyboard();
    syncKeyboardXyVisibility();
    syncChromaticSpaceBarVisibility();
    if (btn) {
        const front = btn.querySelector('.front');
        if (front) front.textContent = visible ? 'Keyboard: On' : 'Keyboard: Off';
        btn.classList.toggle('off', !visible);
    }
    if (!visible && state.keyboardFullscreen) {
        setKeyboardFullscreen(false);
    }
}

function syncLatchUI() {
    const btn = document.getElementById('keyboardLatchToggle');
    if (!btn) return;
    const label = state.keyboardLatch ? 'Latch: On' : 'Latch: Off';
    const front = btn.querySelector('.front');
    if (front) front.textContent = label;
    else btn.textContent = label;
    btn.classList.toggle('off', !state.keyboardLatch);
    btn.setAttribute('aria-pressed', state.keyboardLatch ? 'true' : 'false');
}

function setToolbarButtonLocked(btn, locked) {
    if (!btn) return;
    btn.disabled = !!locked;
    btn.classList.toggle('is-locked', !!locked);
    btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
}

/** Force Juno chord-style arp when Poly + Arp are both on. */
function ensurePolyChordArp() {
    if (!(state.keyboardPoly && state.keyboardArp)) return;
    state.keyboardArpChord = true;
    if (state.arpOrder === 'random') state.arpOrder = 'up';
}

function syncArpUI() {
    const btn = document.getElementById('keyboardArpToggle');
    if (!btn) return;
    const label = state.keyboardArp ? 'Arp: On' : 'Arp: Off';
    const front = btn.querySelector('.front');
    if (front) front.textContent = label;
    else btn.textContent = label;
    btn.classList.toggle('off', !state.keyboardArp);
    btn.setAttribute('aria-pressed', state.keyboardArp ? 'true' : 'false');
    setToolbarButtonLocked(btn, state.isPlaying);
    refreshIdleVfd();
}

function syncArpChordUI() {
    const btn = document.getElementById('keyboardArpChordToggle');
    if (!btn) return;
    ensurePolyChordArp();
    const on = !!(state.keyboardArp && state.keyboardArpChord);
    const label = on ? 'Arp Chord: On' : 'Arp Chord: Off';
    const front = btn.querySelector('.front');
    if (front) front.textContent = label;
    else btn.textContent = label;
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    // Locked off when Arp off / playing; locked on (forced) in Poly Arp
    const polyForced = !!(state.keyboardPoly && state.keyboardArp);
    setToolbarButtonLocked(btn, state.isPlaying || !state.keyboardArp || polyForced);
}

function syncArpOrderUI() {
    const btn = document.getElementById('keyboardArpOrderToggle');
    if (!btn) return;
    ensurePolyChordArp();
    const order = state.arpOrder || 'up';
    const label = `Order: ${ARP_ORDER_LABELS[order] || 'Up'}`;
    const front = btn.querySelector('.front');
    if (front) front.textContent = label;
    else btn.textContent = label;
    const active = !!(state.keyboardArp && state.keyboardArpChord);
    btn.classList.toggle('off', !active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    setToolbarButtonLocked(btn, state.isPlaying || !active);
}

function syncArpRangeUI() {
    const btn = document.getElementById('keyboardArpRangeToggle');
    if (!btn) return;
    const range = Math.max(1, Math.min(3, Math.floor(Number(state.arpRange)) || 1));
    state.arpRange = range;
    const label = `Range: ${range}`;
    const front = btn.querySelector('.front');
    if (front) front.textContent = label;
    else btn.textContent = label;
    const active = !!(state.keyboardArp && state.keyboardArpChord);
    btn.classList.toggle('off', !active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    setToolbarButtonLocked(btn, state.isPlaying || !active);
}

/** Refresh Arp / Arp Chord / Order / Range / Chord Mem / Poly enable + labels. */
export function syncLiveModeControlsUI() {
    if (!state.keyboardArp) {
        state.keyboardArpChord = false;
    } else {
        ensurePolyChordArp();
    }
    syncArpUI();
    syncArpChordUI();
    syncArpOrderUI();
    syncArpRangeUI();
    syncChordMemUI();
    syncPolyModeUI();
}

/** Keep sequencer + keyboard scale controls in sync, then refresh dependents. */
export function applyScaleState(enabled, scaleId) {
    const mainToggle = document.getElementById('scaleToggle');
    const mainSelect = document.getElementById('scaleSelect');
    const mainSelectControl = document.getElementById('scaleSelectControl');
    const kbToggle = document.getElementById('keyboardScaleToggle');
    const kbSelect = document.getElementById('keyboardScaleSelect');
    const patternToggle = document.getElementById('kbPatternScaleToggle');
    const patternSelect = document.getElementById('kbPatternScaleSelect');
    const xyToggle = document.getElementById('kbXyScaleToggle');
    const xySelect = document.getElementById('kbXyScaleSelect');
    const wasEnabled = mainToggle ? !mainToggle.classList.contains('off') : false;

    if (mainToggle) {
        mainToggle.classList.toggle('off', !enabled);
        const front = mainToggle.querySelector('.front');
        if (front) front.textContent = enabled ? 'Scale: On' : 'Scale: Off';
    }
    const syncToggle = (btn) => {
        if (!btn) return;
        btn.classList.toggle('off', !enabled);
        const label = enabled ? 'Scale: On' : 'Scale: Off';
        const front = btn.querySelector('.front');
        if (front) front.textContent = label;
        else btn.textContent = label;
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    };
    syncToggle(kbToggle);
    syncToggle(patternToggle);
    syncToggle(xyToggle);

    if (scaleId !== undefined && scaleId !== null) {
        if (mainSelect) mainSelect.value = scaleId;
        if (kbSelect) kbSelect.value = scaleId;
        if (patternSelect) patternSelect.value = scaleId;
        if (xySelect) xySelect.value = scaleId;
    } else if (mainSelect) {
        if (kbSelect) kbSelect.value = mainSelect.value;
        if (patternSelect) patternSelect.value = mainSelect.value;
        if (xySelect) xySelect.value = mainSelect.value;
    }

    if (mainSelectControl) mainSelectControl.style.display = enabled ? '' : 'none';
    const kbScaleRow = document.getElementById('keyboardScaleSelectRow');
    if (kbScaleRow) kbScaleRow.style.display = enabled ? '' : 'none';
    const tuningScaleRow = document.getElementById('kbTuningScaleSelectRow');
    if (tuningScaleRow) tuningScaleRow.style.display = enabled ? '' : 'none';
    const xyScaleRow = document.getElementById('kbXyScaleSelectRow');
    if (xyScaleRow) xyScaleRow.style.display = enabled ? '' : 'none';
    else if (patternSelect && !tuningScaleRow) patternSelect.style.display = enabled ? '' : 'none';

    if (enabled && !wasEnabled) {
        beginScaleVfdPrompt();
    } else if (!enabled && wasEnabled) {
        endScaleVfdPrompt();
        refreshIdleVfd();
    }

    refreshStepTuneReadouts();
    refreshKeyboard();
    notifyKeyboardPitchUi();
}

function populateScaleSelect(selectEl) {
    if (!selectEl) return;
    selectEl.innerHTML = '';
    SCALE_BANKS.forEach(bank => {
        const group = document.createElement('optgroup');
        group.label = bank.name;
        bank.scales.forEach(scale => {
            const option = document.createElement('option');
            option.value = scale.id;
            option.textContent = scale.name;
            group.appendChild(option);
        });
        selectEl.appendChild(group);
    });
}

function populateKeyboardScaleSelect() {
    const mainSelect = document.getElementById('scaleSelect');
    const selects = [
        document.getElementById('keyboardScaleSelect'),
        document.getElementById('kbPatternScaleSelect'),
        document.getElementById('kbXyScaleSelect'),
    ];
    selects.forEach((el) => {
        populateScaleSelect(el);
        if (el && mainSelect?.value) el.value = mainSelect.value;
    });
}

function formatMasterTuneValue(value) {
    const n = parseInt(value, 10) || 0;
    return n > 0 ? `+${n}` : String(n);
}

function formatOctaveSwitchValue(value) {
    const n = Math.max(-2, Math.min(2, parseInt(value, 10) || 0));
    return n > 0 ? `+${n}` : String(n);
}

function syncOctaveSwitchUi() {
    const main = document.getElementById('octaveSwitch');
    const n = Math.max(-2, Math.min(2, parseInt(main?.value, 10) || 0));
    const label = formatOctaveSwitchValue(n);
    [
        'kbPatternOctaveValue',
        'kbXyOctaveValue',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
    [
        'kbPatternOctaveDown',
        'kbXyOctaveDown',
    ].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = n <= -2;
    });
    [
        'kbPatternOctaveUp',
        'kbXyOctaveUp',
    ].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = n >= 2;
    });
}

function setOctaveSwitch(value) {
    const main = document.getElementById('octaveSwitch');
    if (!main) return;
    const next = String(Math.max(-2, Math.min(2, parseInt(value, 10) || 0)));
    const changed = main.value !== next;
    if (changed) main.value = next;
    const mainReadout = document.getElementById('octaveSwitchValue');
    if (mainReadout) mainReadout.textContent = next;
    syncOctaveSwitchUi();
    if (changed) main.dispatchEvent(new Event('input', { bubbles: true }));
}

function shiftOctaveSwitch(delta) {
    const main = document.getElementById('octaveSwitch');
    const cur = parseInt(main?.value, 10) || 0;
    setOctaveSwitch(cur + delta);
}

const SEMI_SWITCH_IDS = ['kbPatternSemiSwitch', 'kbXySemiSwitch'];
const SEMI_SWITCH_VALUE_IDS = ['kbPatternSemiSwitchValue', 'kbXySemiSwitchValue'];
const SEMI_AMOUNT_IDS = ['kbPatternSemiAmount', 'kbXySemiAmount'];

function clampSemiSwitch(n) {
    return Math.max(-2, Math.min(2, Math.round(Number(n) || 0)));
}

function syncSemitoneSwitchUi() {
    const main = document.getElementById('semitoneSwitch');
    const amount = document.getElementById('semitoneAmount');
    const pos = clampSemiSwitch(main?.value);
    const label = String(pos);
    SEMI_SWITCH_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value !== label) el.value = label;
    });
    SEMI_SWITCH_VALUE_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
    if (amount) {
        SEMI_AMOUNT_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.value !== amount.value) el.value = amount.value;
        });
    }
}

function setSemitoneSwitch(value) {
    const main = document.getElementById('semitoneSwitch');
    if (!main) return;
    const next = String(clampSemiSwitch(value));
    const changed = main.value !== next;
    if (changed) main.value = next;
    const mainReadout = document.getElementById('semitoneSwitchValue');
    if (mainReadout) mainReadout.textContent = next;
    syncSemitoneSwitchUi();
    if (changed) main.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSemitoneAmount(value) {
    const main = document.getElementById('semitoneAmount');
    if (!main) return;
    const next = String(Math.max(0, Math.min(12, parseInt(value, 10) || 0)));
    const changed = main.value !== next;
    if (changed) main.value = next;
    syncSemitoneSwitchUi();
    if (changed) main.dispatchEvent(new Event('change', { bubbles: true }));
}

function initSemitoneMirrors() {
    syncSemitoneSwitchUi();
    SEMI_SWITCH_IDS.forEach((id) => {
        document.getElementById(id)?.addEventListener('input', function () {
            setSemitoneSwitch(this.value);
        });
    });
    SEMI_AMOUNT_IDS.forEach((id) => {
        document.getElementById(id)?.addEventListener('change', function () {
            setSemitoneAmount(this.value);
        });
    });
    document.getElementById('semitoneSwitch')?.addEventListener('input', syncSemitoneSwitchUi);
    document.getElementById('semitoneAmount')?.addEventListener('change', syncSemitoneSwitchUi);
}

function syncKeyboardMasterTune() {
    const main = document.getElementById('masterTune');
    if (!main) return;
    const label = formatMasterTuneValue(main.value);
    ['keyboardMasterTune', 'kbTuningMasterTune', 'kbXyTuningMasterTune'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value !== main.value) el.value = main.value;
    });
    ['keyboardMasterTuneValue', 'kbTuningMasterTuneValue', 'kbXyTuningMasterTuneValue'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
}

function setMasterTuneFromKeyboard(value) {
    const main = document.getElementById('masterTune');
    if (!main) return;
    const next = String(value);
    const label = formatMasterTuneValue(next);
    ['keyboardMasterTuneValue', 'kbTuningMasterTuneValue', 'kbXyTuningMasterTuneValue'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
    if (main.value === next) {
        // Still mirror sibling sliders when value is unchanged
        ['keyboardMasterTune', 'kbTuningMasterTune', 'kbXyTuningMasterTune'].forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.value !== next) el.value = next;
        });
        return;
    }
    main.value = next;
    const readout = document.getElementById('masterTuneValue');
    if (readout) readout.textContent = next;
    main.dispatchEvent(new Event('input', { bubbles: true }));
}

function syncTransposeDimUI() {
    const dimmed = !state.isPlaying;
    document.querySelectorAll('.keyboard-transpose-screen').forEach((el) => {
        el.classList.toggle('is-dimmed', dimmed);
    });
}

export function onSequencerStart() {
    stopArp();
    // Clear holds first so teardown can't retrigger last-note / poly unison
    clearPolyPointers();
    clearHeldNotes();
    forceNoteOff();
    forcePolyAllOff({ silent: true });
    // Play forces Poly off; Acid stays (acid seq is valid)
    if (state.keyboardPoly) setPolyMode(false);
    cancelChordMemoryLearn();
    clearFrozenArpNotes();
    clearArpChordSession();
    if (!state.keyboardLatch) {
        if (state.keyboardHeldSemitone === null && state.keyboardTranspose !== 0) {
            state.keyboardHeldSemitone = state.keyboardTranspose;
        }
    }
    highlightFromState();
    syncTransposeDimUI();
    syncLiveModeControlsUI();
    syncPolyModeUI();
}

export function onSequencerStop() {
    // Do not resume a latched live note after stop — release any keyboard voice.
    clearPolyPointers();
    clearHeldNotes();
    forceNoteOff();
    forcePolyAllOff({ silent: true });
    // Poly stays off after play; ensure lock class / disabled are cleared when idle
    if (state.keyboardPoly) setPolyMode(false);
    else syncPolyModeUI();
    // Keep transpose for the next run, but clear the live/latch hold so nothing
    // keeps sounding until the user presses a key again.
    state.keyboardHeldSemitone = state.keyboardTranspose !== 0 ? state.keyboardTranspose : null;
    highlightFromState();
    syncTransposeDimUI();
    syncLiveModeControlsUI();
    syncPolyModeUI();
}

export function initKeyboard() {
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return;

    // Stage mode is the default landing view
    state.keyboardFullscreen = true;

    const endPointer = (e) => {
        if (polyPointers.has(e.pointerId)) {
            const boardEl = document.getElementById('chromaticKeyboard');
            if (boardEl) {
                try { boardEl.releasePointerCapture(e.pointerId); } catch (_) {}
            }
            polyPointerUp(e.pointerId);
            return;
        }
        if (activePointerId !== null && e.pointerId !== activePointerId) return;
        const boardEl = document.getElementById('chromaticKeyboard');
        if (boardEl && activePointerId !== null) {
            try { boardEl.releasePointerCapture(activePointerId); } catch (_) {}
        }
        activePointerId = null;
        if (pressedSemitone !== null) {
            pressedSemitone = null;
            handleRelease();
        }
    };
    window.addEventListener('pointerup', endPointer);
    window.addEventListener('pointercancel', endPointer);
    board.addEventListener('pointermove', handlePointerMove);

    document.getElementById('keyboardVisibilityToggle')?.addEventListener('click', () => {
        state.keyboardVisible = !state.keyboardVisible;
        syncVisibilityUI();
        if (!state.keyboardVisible) {
            if (!state.isPlaying) {
                stopArp();
                forceNoteOff();
                forcePolyAllOff();
                clearPolyPointers();
                if (!state.keyboardLatch) {
                    state.keyboardHeldSemitone = null;
                    clearHeldNotes();
                    clearKeyHighlights();
                }
            }
        }
    });

    document.getElementById('keyboardFullscreenToggle')?.addEventListener('click', () => {
        if (!state.keyboardVisible && !state.keyboardFullscreen) {
            state.keyboardVisible = true;
            syncVisibilityUI();
        }
        setKeyboardFullscreen(!state.keyboardFullscreen);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !state.keyboardFullscreen) return;
        setKeyboardFullscreen(false);
    });

    document.getElementById('keyboardArpToggle')?.addEventListener('click', () => {
        if (state.isPlaying) return;
        if (!state.keyboardArp && state.keyboardWrite) {
            // Turning Arp on exits Write
            setWriteMode(false, { refreshKeyboard });
        }
        state.keyboardArp = !state.keyboardArp;
        if (state.keyboardArp && state.keyboardPoly) {
            // Enter Poly Arp: silence sustained poly chord; keys become the pool
            ensurePolyChordArp();
            clearPolyPointers();
            forcePolyAllOff({ silent: true });
            for (const semi of getHeldNotes()) {
                recordArpChordSessionNote(semi);
            }
            if (heldNoteCount() > 0 && !state.isArping) startArp();
        }
        if (!state.keyboardArp) {
            state.keyboardArpChord = false;
            const wasArping = state.isArping;
            if (wasArping) stopArp();
            clearFrozenArpNotes();
            clearArpChordSession();
            if (state.keyboardPoly) {
                // Restore normal poly holding for any keys still down
                forcePolyAllOff({ silent: true });
                for (const semi of getHeldNotes()) {
                    polyNoteOn(semi, soundingSemitones(semi));
                }
                highlightHeldOrFrozen();
            } else if (wasArping) {
                clearHeldNotes();
                if (!state.keyboardLatch) {
                    state.keyboardHeldSemitone = state.keyboardTranspose !== 0 ? state.keyboardTranspose : null;
                    highlightFromState();
                }
            }
        }
        syncLiveModeControlsUI();
    });

    document.getElementById('keyboardArpChordToggle')?.addEventListener('click', () => {
        if (state.isPlaying || !state.keyboardArp) return;
        // Poly Arp always uses chord-style — button stays forced on
        if (state.keyboardPoly) return;
        state.keyboardArpChord = !state.keyboardArpChord;
        invalidateChordArpOrder();
        if (state.isArping) {
            stopArp();
            clearHeldNotes();
            clearFrozenArpNotes();
            clearArpChordSession();
        }
        if (!state.keyboardArpChord) {
            clearHeldNotes();
            clearFrozenArpNotes();
            clearArpChordSession();
        }
        syncLiveModeControlsUI();
        highlightFromState();
    });

    document.getElementById('keyboardArpOrderToggle')?.addEventListener('click', () => {
        if (state.isPlaying || !state.keyboardArp || !state.keyboardArpChord) return;
        const cycle = (state.keyboardPoly && state.keyboardArp)
            ? POLY_ARP_ORDER_CYCLE
            : ARP_ORDER_CYCLE;
        let idx = cycle.indexOf(state.arpOrder || 'up');
        if (idx < 0) idx = 0;
        state.arpOrder = cycle[(idx + 1) % cycle.length];
        invalidateChordArpOrder();
        syncArpOrderUI();
    });

    document.getElementById('keyboardArpRangeToggle')?.addEventListener('click', () => {
        if (state.isPlaying || !state.keyboardArp || !state.keyboardArpChord) return;
        const cur = Math.max(1, Math.min(3, Math.floor(Number(state.arpRange)) || 1));
        state.arpRange = cur >= 3 ? 1 : cur + 1;
        invalidateChordArpOrder();
        syncArpRangeUI();
    });

    document.getElementById('keyboardChordMemToggle')?.addEventListener('click', () => {
        if (state.isPlaying || state.keyboardWrite) return;
        toggleChordMemoryLearn();
        if (state.chordMemoryLearning) {
            // Learn uses held set; don't leave a pattern arp running on the same keys
            if (state.isArping && state.keyboardArpChord) {
                stopArp();
            }
            clearFrozenArpNotes();
            // Pause poly audio while learning (notes are silent capture)
            if (state.keyboardPoly) {
                forcePolyAllOff();
                clearPolyPointers();
            }
        }
        highlightFromState();
    });

    document.getElementById('keyboardPolyToggle')?.addEventListener('click', () => {
        if (state.isPlaying || state.keyboardWrite) return;
        if (!state.keyboardPoly && state.chordMemoryLearning) {
            cancelChordMemoryLearn();
        }
        const enabling = !state.keyboardPoly;
        // Always clear holds before mode flip so unison last-note logic can't respawn
        clearPolyPointers();
        if (enabling && state.keyboardArp) {
            // Entering Poly while Arp on → Poly Arp
            ensurePolyChordArp();
            forceNoteOff();
            forcePolyAllOff({ silent: true });
            // Keep held/frozen pool; restart arp on poly voice path
            if (state.isArping) {
                stopArp();
            }
            togglePolyMode();
            if (heldNoteCount() > 0 || (state.arpFrozenNotes && state.arpFrozenNotes.length)) {
                startArp();
            }
        } else if (!enabling && state.keyboardArp) {
            // Leaving Poly while Arp on → fall back to mono chord arp
            if (state.isArping) stopArp();
            forcePolyAllOff({ silent: true });
            togglePolyMode();
            if (heldNoteCount() > 0 || (state.arpFrozenNotes && state.arpFrozenNotes.length)) {
                startArp();
            }
        } else {
            clearHeldNotes();
            forceNoteOff();
            forcePolyAllOff();
            togglePolyMode();
        }
        highlightFromState();
        syncLiveModeControlsUI();
    });

    document.getElementById('kbPolyUnisonToggle')?.addEventListener('click', () => {
        if (!state.keyboardPoly) return;
        clearPolyPointers();
        clearHeldNotes();
        forcePolyAllOff();
        togglePolyUnison();
        highlightFromState();
    });

    document.getElementById('keyboardLatchToggle')?.addEventListener('click', () => {
        state.keyboardLatch = !state.keyboardLatch;
        syncLatchUI();
        if (!state.keyboardLatch) {
            if (!state.isPlaying) {
                stopArp();
                forceNoteOff();
                forcePolyAllOff();
                clearPolyPointers();
                clearFrozenArpNotes();
                clearArpChordSession();
                clearHeldNotes();
                state.keyboardHeldSemitone = state.keyboardTranspose !== 0 ? state.keyboardTranspose : null;
            }
            highlightFromState();
        }
    });

    document.addEventListener('ingysynth:chord-arp-note', (e) => {
        const semi = e.detail?.cellSemitone;
        if (!Number.isFinite(semi)) return;
        // Flash the sounding chord-arp note while keeping held keys lit
        const held = getHeldNotes();
        const pool = held.length ? held : (state.arpFrozenNotes || []);
        highlightNotes(pool.length ? pool : [semi]);
        setKeyActive(semi, true);
    });

    syncKeyboardMasterTune();
    populateKeyboardScaleSelect();

    document.getElementById('keyboardMasterTune')?.addEventListener('input', function () {
        setMasterTuneFromKeyboard(this.value);
    });
    document.getElementById('kbTuningMasterTune')?.addEventListener('input', function () {
        setMasterTuneFromKeyboard(this.value);
    });
    document.getElementById('kbXyTuningMasterTune')?.addEventListener('input', function () {
        setMasterTuneFromKeyboard(this.value);
    });

    document.getElementById('keyboardScaleToggle')?.addEventListener('click', () => {
        const enabled = document.getElementById('keyboardScaleToggle').classList.contains('off');
        // currently off → turning on
        applyScaleState(enabled, document.getElementById('keyboardScaleSelect')?.value);
    });

    document.getElementById('keyboardScaleSelect')?.addEventListener('change', function () {
        const enabled = !document.getElementById('scaleToggle')?.classList.contains('off');
        applyScaleState(enabled, this.value);
    });

    document.getElementById('kbPatternScaleToggle')?.addEventListener('click', () => {
        const enabled = document.getElementById('kbPatternScaleToggle').classList.contains('off');
        applyScaleState(enabled, document.getElementById('kbPatternScaleSelect')?.value);
    });

    document.getElementById('kbPatternScaleSelect')?.addEventListener('change', function () {
        const enabled = !document.getElementById('scaleToggle')?.classList.contains('off');
        applyScaleState(enabled, this.value);
    });

    document.getElementById('kbXyScaleToggle')?.addEventListener('click', () => {
        const enabled = document.getElementById('kbXyScaleToggle').classList.contains('off');
        applyScaleState(enabled, document.getElementById('kbXyScaleSelect')?.value);
    });

    document.getElementById('kbXyScaleSelect')?.addEventListener('change', function () {
        const enabled = !document.getElementById('scaleToggle')?.classList.contains('off');
        applyScaleState(enabled, this.value);
    });

    syncOctaveSwitchUi();
    document.getElementById('kbPatternOctaveDown')?.addEventListener('click', () => shiftOctaveSwitch(-1));
    document.getElementById('kbPatternOctaveUp')?.addEventListener('click', () => shiftOctaveSwitch(1));
    document.getElementById('kbXyOctaveDown')?.addEventListener('click', () => shiftOctaveSwitch(-1));
    document.getElementById('kbXyOctaveUp')?.addEventListener('click', () => shiftOctaveSwitch(1));
    initSemitoneMirrors();

    ['masterTune', 'octaveSwitch', 'semitoneSwitch'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
            if (id === 'masterTune') syncKeyboardMasterTune();
            if (id === 'octaveSwitch') syncOctaveSwitchUi();
            refreshKeyboard();
            notifyKeyboardPitchUi();
            if (!state.isPlaying && hasPolyVoices()) {
                retunePolyVoices((semi) => soundingSemitones(semi));
            } else if (!state.isPlaying && state.keyboardVoiceActive && state.keyboardHeldSemitone !== null) {
                noteOn(soundingSemitones(state.keyboardHeldSemitone));
            }
        });
    });
    document.getElementById('semitoneAmount')?.addEventListener('change', () => {
        refreshKeyboard();
        notifyKeyboardPitchUi();
        if (!state.isPlaying && hasPolyVoices()) {
            retunePolyVoices((semi) => soundingSemitones(semi));
        } else if (!state.isPlaying && state.keyboardVoiceActive && state.keyboardHeldSemitone !== null) {
            noteOn(soundingSemitones(state.keyboardHeldSemitone));
        }
    });

    document.addEventListener('ingysynth:sequencer-start', () => onSequencerStart());
    document.addEventListener('ingysynth:sequencer-stop', () => onSequencerStop());

    // Match keyboard scale UI to current sequencer scale state
    const scaleOn = !document.getElementById('scaleToggle')?.classList.contains('off');
    applyScaleState(scaleOn, document.getElementById('scaleSelect')?.value);

    initPatternWrite(refreshKeyboard);
    initPolyVoice();

    syncVisibilityUI();
    syncLiveModeControlsUI();
    syncLatchUI();
    syncTransposeDimUI();
    syncFullscreenUI();
}
