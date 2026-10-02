import { state } from './state.js?v=116';
import { getActiveScale, getGlobalTune, semitonesToNoteName, SCALE_BANKS } from './tuning.js?v=80';
import { noteOn, noteOff, forceNoteOff, retuneNote } from './voice.js?v=155';
import { initAudio } from './audio-engine.js?v=208';
import { updateNoteVisualizer, updateChordVisualizer, clearNoteVisualizer } from './visualizers.js?v=121';
import {
    refreshStepTuneReadouts,
    startArp,
    stopArp,
    retuneArpTranspose,
    refreshIdleVfd,
    beginScaleVfdPrompt,
    endScaleVfdPrompt,
    invalidateChordArpOrder,
} from './sequencer.js?v=416';
import { refreshXYPad } from './xy-pad.js?v=79';
import {
    initPatternWrite,
    writeNote,
    setWriteMode,
    isPolyWriteMode,
    polyWriteNoteDown,
    polyWriteNoteUp,
    getPolyWriteHeldNotes,
} from './pattern-write.js?v=123';
import {
    addHeldNote,
    removeHeldNote,
    moveHeldNote,
    getHeldNotes,
    getHeldPressOrder,
    heldNoteCount,
    clearHeldNotes,
    needsHeldNoteSet,
    clearFrozenArpNotes,
    clearArpChordSession,
    recordArpChordSessionNote,
    freezeArpChordSession,
    getChordArpSourceNotes,
} from './held-notes.js?v=9';
import { getLiveStep, stepCellNotes } from './pattern-bank.js?v=16';
import { get, getNumber, getString, set as setParam, subscribe } from './params.js?v=15';
import {
    toggleChordMemoryLearn,
    cancelChordMemoryLearn,
    commitChordMemoryFromNotes,
    syncChordMemUI,
    recordLearnNote,
    getLearnSessionNotes,
    isPolyChordMemoryOn,
    getPolyChordIntervals,
} from './chord-memory.js?v=23';
import {
    initMultitudesPanel,
    setMultitudesMode,
} from './keyboard-multitudes-panel.js?v=50';
import {
    togglePolyMode,
    togglePolyUnison,
    syncPolyModeUI,
    polyNoteOn,
    polyNoteOff,
    glidePolyFinger,
    forcePolyAllOff,
    retunePolyVoices,
    hasPolyVoices,
    initPolyVoice,
    forceDrumFiltOffForPoly,
} from './poly-voice.js?v=129';

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
const WHITE_KEY_PX = 52;

function whiteKeyPx() {
    return WHITE_KEY_PX;
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
/** Touch gesture on the piano: null until it is clearly sideways or up/down. */
const touchGesture = new Map();

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

/** Note VFD: chord from live hold / write / chord-mem / arp pool. */
function paintLiveChordVfd() {
    if (window.noteVisualizerPreviewActive) return;
    if (state.isPlaying) return;

    if (isPolyWriteMode()) {
        const notes = getPolyWriteHeldNotes();
        if (notes.length) updateChordVisualizer(notes.map(soundingSemitones));
        else clearNoteVisualizer();
        return;
    }

    if (state.chordMemoryLearning) {
        const notes = getLearnSessionNotes();
        if (notes.length) updateChordVisualizer(notes.map(soundingSemitones));
        else clearNoteVisualizer();
        return;
    }

    const pool = getHeldNotes().length ? getHeldNotes() : getChordArpSourceNotes();
    if (!pool.length) {
        clearNoteVisualizer();
        return;
    }

    if (isPolyChordMemoryOn()) {
        const root = Math.min(...pool);
        const ivs = getPolyChordIntervals();
        if (ivs.length > 1) {
            const soundingRoot = soundingSemitones(root);
            updateChordVisualizer(ivs.map((iv) => soundingRoot + iv));
            return;
        }
    }

    updateChordVisualizer(pool.map(soundingSemitones));
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
    if (state.keyboardWrite && !state.isPlaying) {
        const held = getPolyWriteHeldNotes();
        if (held.length) {
            highlightNotes(held);
            updateTransposeReadout();
            return;
        }
        if (state.keyboardPoly || state.keyboardMultitudes) {
            const data = getLiveStep(state.writeStep);
            if (data.on !== false) highlightNotes(stepCellNotes(data));
            else clearKeyHighlights();
            updateTransposeReadout();
            return;
        }
    }
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
        paintLiveChordVfd();
        return;
    }

    // Poly / Multitudes Arp: held keys feed the pool only — clock plays one note at a time
    if (isPolyArpMode()) {
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
        paintLiveChordVfd();
        if (!state.isArping) startArp();
        return;
    }

    if (state.keyboardPoly) {
        if (!addHeldNote(cellSemitone)) return;
        state.keyboardHeldSemitone = cellSemitone;
        polyNoteOn(cellSemitone, soundingSemitones(cellSemitone));
        highlightHeldOrFrozen();
        paintLiveChordVfd();
        return;
    }

    if (state.keyboardMultitudes) {
        if (!addHeldNote(cellSemitone)) return;
        state.keyboardHeldSemitone = cellSemitone;
        polyNoteOn(cellSemitone, soundingSemitones(cellSemitone));
        highlightHeldOrFrozen();
        paintLiveChordVfd();
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
        paintLiveChordVfd();
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
        paintLiveChordVfd();
        return;
    }

    // Poly / Multitudes Arp: same latch/freeze semantics as mono chord arp (no direct polyNoteOff)
    if (isPolyArpMode()) {
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
        paintLiveChordVfd();
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
        paintLiveChordVfd();
        return;
    }

    if (state.keyboardMultitudes) {
        removeHeldNote(cellSemitone);
        polyNoteOff(cellSemitone);
        state.keyboardHeldSemitone = getHeldPressOrder().at(-1) ?? null;
        if (heldNoteCount() === 0) clearKeyHighlights();
        else highlightHeldOrFrozen();
        paintLiveChordVfd();
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
        paintLiveChordVfd();
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
        if (isPolyWriteMode()) {
            polyWriteNoteDown(cellSemitone);
            state.keyboardHeldSemitone = cellSemitone;
            highlightFromState();
            if (!state.isPlaying) paintLiveChordVfd();
            return;
        }
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

/** Live key rects, read once per pointer event. */
function collectKeyRects() {
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return [];
    const out = [];
    for (const key of board.querySelectorAll('.piano-key')) {
        if (key.classList.contains('key-out-of-scale')) continue;
        const semi = parseInt(key.dataset.semitone, 10);
        if (!Number.isFinite(semi)) continue;
        const r = key.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        out.push({ semi, r, black: key.classList.contains('piano-key-black') });
    }
    return out;
}

/**
 * Key under a point. Rects, not elementFromPoint: during a touch the browser
 * often keeps reporting the key that received pointerdown, so a slide never
 * leaves the first note. Black keys win where they overlap whites.
 * slopY catches a fingertip that sits just above or below the key strip.
 */
function keyFromRects(rects, clientX, clientY, slopY = 0) {
    let black = null;
    let white = null;
    let blackSlop = null;
    let whiteSlop = null;
    let whiteSlopDist = Infinity;
    for (const { semi, r, black: isBlack } of rects) {
        if (clientX < r.left || clientX >= r.right) continue;
        if (clientY >= r.top && clientY < r.bottom) {
            if (isBlack) black = semi;
            else white = semi;
            continue;
        }
        if (slopY <= 0) continue;
        const dy = clientY < r.top ? r.top - clientY : clientY - r.bottom;
        if (dy <= 0 || dy > slopY) continue;
        if (isBlack) blackSlop = semi;
        else if (dy < whiteSlopDist) {
            whiteSlopDist = dy;
            whiteSlop = semi;
        }
    }
    if (black != null) return black;
    if (white != null) return white;
    if (blackSlop != null) return blackSlop;
    return whiteSlop;
}

function keyFromPoint(clientX, clientY, slopY = 0) {
    return keyFromRects(collectKeyRects(), clientX, clientY, slopY);
}

/** Last key the pointer actually crossed, including positions the browser coalesced. */
function slideSemiFromEvent(e) {
    const slop = (e.pointerType === 'touch' || e.pointerType === 'pen') ? 36 : 10;
    const rects = collectKeyRects();
    if (!rects.length) return null;
    let semi = null;
    const consider = (x, y) => {
        const next = keyFromRects(rects, x, y, slop);
        if (next != null) semi = next;
    };
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    if (coalesced) {
        for (const ev of coalesced) consider(ev.clientX, ev.clientY);
    }
    consider(e.clientX, e.clientY);
    return semi;
}

/** Poly Uni owns the stack only when chord memory is not playing a real chord. */
function polyUnisonOwnsVoices() {
    return !!(
        state.keyboardPolyUnison
        && state.keyboardPoly
        && getPolyChordIntervals().length <= 1
    );
}

/**
 * Slide one poly pointer onto a new key.
 * The map is updated before any note-off: polyPointerUp releases only the
 * semitone stored for that pointer, and skips the release while another
 * pointer still lists it.
 */
function movePolyPointer(pointerId, toSemi) {
    const fromSemi = polyPointers.get(pointerId);
    if (fromSemi == null || fromSemi === toSemi) return;

    let sharingOld = false;
    let destTaken = getHeldNotes().includes(toSemi);
    for (const [id, semi] of polyPointers) {
        if (id === pointerId) continue;
        if (semi === fromSemi) sharingOld = true;
        if (semi === toSemi) destTaken = true;
    }
    polyPointers.set(pointerId, toSemi);

    if (polyUnisonOwnsVoices()) {
        const sounding = getHeldPressOrder().at(-1);
        const isSounding = fromSemi === sounding;
        if (!sharingOld && isSounding) {
            glidePolyFinger(fromSemi, toSemi, soundingSemitones(toSemi));
            moveHeldNote(fromSemi, toSemi);
        } else if (!sharingOld) {
            moveHeldNote(fromSemi, toSemi);
        } else if (!destTaken) {
            heldNoteDown(toSemi);
        }
    } else if (!sharingOld && !destTaken) {
        glidePolyFinger(fromSemi, toSemi, soundingSemitones(toSemi));
        moveHeldNote(fromSemi, toSemi);
    } else if (!sharingOld) {
        // Occupied destination (other finger, MIDI, or computer keys).
        // polyNoteOff, not heldNoteUp: heldNoteUp's Poly Uni branch would
        // retrigger the last key instead of releasing this finger's stack.
        removeHeldNote(fromSemi);
        polyNoteOff(fromSemi);
    } else if (!destTaken) {
        heldNoteDown(toSemi);
    }

    state.keyboardHeldSemitone = getHeldPressOrder().at(-1) ?? null;
    highlightHeldOrFrozen();
    paintLiveChordVfd();
}

function handlePointerMove(e) {
    if (state.keyboardWrite) return;
    // Learn commits every key touched. A swipe would store the smear.
    if (state.chordMemoryLearning) return;
    if (polyPointers.has(e.pointerId)) {
        const semi = slideSemiFromEvent(e);
        if (semi == null) return;
        movePolyPointer(e.pointerId, semi);
        return;
    }
    // Poly arp and mono chord arp stay on the press path. Playback transpose
    // still falls through when this pointer is not in polyPointers.
    if (needsHeldNoteSet()) return;
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const semi = slideSemiFromEvent(e);
    if (semi === null || semi === pressedSemitone) return;
    handlePress(semi);
}

function polyPointerDown(pointerId, cellSemitone) {
    if (polyPointers.has(pointerId)) return;
    polyPointers.set(pointerId, cellSemitone);
    if (isPolyWriteMode()) polyWriteNoteDown(cellSemitone);
    else heldNoteDown(cellSemitone);
}

function polyPointerUp(pointerId) {
    const semi = polyPointers.get(pointerId);
    if (semi === undefined) return;
    polyPointers.delete(pointerId);
    // Only release if no other pointer still holds this semi
    for (const s of polyPointers.values()) {
        if (s === semi) return;
    }
    if (isPolyWriteMode()) polyWriteNoteUp(semi);
    else heldNoteUp(semi);
}

/** Drop multi-touch tracking without note-off/on side effects (teardown-safe). */
function clearPolyPointers() {
    polyPointers.clear();
}

function handleRelease() {
    const released = pressedSemitone;
    pressedSemitone = null;

    if (state.keyboardWrite) {
        if (isPolyWriteMode()) {
            if (released != null) polyWriteNoteUp(released);
            highlightFromState();
            if (!state.isPlaying) paintLiveChordVfd();
            return;
        }
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
            // A touch can still become a page scroll. Don't cancel it until
            // the finger moves sideways; a mouse press can be captured now.
            const touchMayScroll = e.pointerType === 'touch' && useTouchKeyboardScroller();
            if (!touchMayScroll) {
                e.preventDefault();
            }
            e.stopPropagation();
            const boardEl = document.getElementById('chromaticKeyboard');
            if (boardEl && !touchMayScroll) {
                try { boardEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            }
            const polyStyle = state.keyboardPoly || state.keyboardMultitudes;
            const polyWrite = polyStyle && state.keyboardWrite;
            const polyLiveHold = polyStyle && !state.isPlaying && !state.keyboardWrite
                && !state.chordMemoryLearning
                && !(state.keyboardArp && state.keyboardArpChord);
            // Learn banks when the last finger lifts. One activePointerId drops
            // the other key-ups, so a phone chord never empties the held set.
            const chordLearnHold = !!state.chordMemoryLearning && !state.isPlaying;
            if (polyWrite || polyLiveHold || chordLearnHold) {
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
            if (centerOnRoot()) {
                syncChromaticKeyboardScroller();
                return;
            }
            requestAnimationFrame(() => {
                centerOnRoot();
                syncChromaticKeyboardScroller();
            });
        });
        hasCenteredOnce = true;
    }
    syncChromaticKeyboardScroller();
}

function useTouchKeyboardScroller() {
    return window.matchMedia('(max-width: 768px)').matches
        || window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

function chromaticKeyboardIsShown(panel) {
    if (!panel || panel.hidden || panel.style.display === 'none') return false;
    const section = panel.closest('.keyboard-section');
    if (!section) return true;
    if (section.classList.contains('keyboard-off')) return false;
    if (section.classList.contains('computer-keyboard-mode')) return false;
    return true;
}

function syncChromaticKeyboardScroller() {
    const panel = document.getElementById('chromaticKeyboardPanel');
    const scroller = document.getElementById('chromaticKeyboardScroller');
    const track = scroller?.querySelector('.chromatic-keyboard-scroller-track');
    const thumb = scroller?.querySelector('.chromatic-keyboard-scroller-thumb');
    if (!panel || !scroller || !track || !thumb) return;

    const mobile = useTouchKeyboardScroller();
    const maxScroll = Math.max(0, panel.scrollWidth - panel.clientWidth);
    const show = mobile && chromaticKeyboardIsShown(panel) && maxScroll > 2;
    scroller.hidden = !show;
    scroller.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (!show) return;

    const trackW = track.clientWidth;
    const viewRatio = panel.scrollWidth > 0 ? panel.clientWidth / panel.scrollWidth : 1;
    const thumbW = Math.min(
        Math.max(56, trackW - 8),
        Math.max(56, Math.round(trackW * viewRatio)),
    );
    const travel = Math.max(0, trackW - thumbW);
    const x = maxScroll > 0 ? (panel.scrollLeft / maxScroll) * travel : 0;
    thumb.style.width = `${thumbW}px`;
    thumb.style.transform = `translate(${x}px, -50%)`;
    const now = maxScroll > 0 ? Math.round((panel.scrollLeft / maxScroll) * 100) : 0;
    track.setAttribute('aria-valuenow', String(now));
    track.setAttribute('aria-valuemax', '100');
}

function initChromaticKeyboardScroller() {
    const panel = document.getElementById('chromaticKeyboardPanel');
    const scroller = document.getElementById('chromaticKeyboardScroller');
    const track = scroller?.querySelector('.chromatic-keyboard-scroller-track');
    const thumb = scroller?.querySelector('.chromatic-keyboard-scroller-thumb');
    if (!panel || !scroller || !track || !thumb) return;

    // Sideways touch must not pan the keys. Up and down is left to the page.
    // Touch identifiers are not pointer ids, so match on the gesture state:
    // while any finger is running the keys, hold every touchmove here. If
    // iOS starts a page scroll mid-run it cancels the pointer and drops the note.
    const touchStarts = new Map();
    panel.addEventListener('touchstart', (e) => {
        for (const t of e.changedTouches) {
            touchStarts.set(t.identifier, { x: t.clientX, y: t.clientY });
        }
    }, { passive: true });
    const forgetTouches = (e) => {
        for (const t of e.changedTouches) touchStarts.delete(t.identifier);
    };
    panel.addEventListener('touchend', forgetTouches, { passive: true });
    panel.addEventListener('touchcancel', forgetTouches, { passive: true });
    panel.addEventListener('touchmove', (e) => {
        if (!useTouchKeyboardScroller()) return;
        let keyTouch = false;
        for (const gesture of touchGesture.values()) {
            if (gesture.bar) continue;
            if (gesture.lock === 'x') {
                e.preventDefault();
                return;
            }
            if (gesture.lock !== 'y') keyTouch = true;
        }
        if (!keyTouch) return;
        // touchmove can land before the pointermove that sets the lock.
        // Judge this touch on its own so the first sideways move is held too.
        for (const t of e.changedTouches) {
            const start = touchStarts.get(t.identifier);
            if (!start) continue;
            const dx = Math.abs(t.clientX - start.x);
            const dy = Math.abs(t.clientY - start.y);
            if (dx >= 6 && dx >= dy) {
                e.preventDefault();
                return;
            }
        }
    }, { passive: false });
    panel.addEventListener('scroll', syncChromaticKeyboardScroller, { passive: true });
    window.addEventListener('resize', syncChromaticKeyboardScroller);
    window.matchMedia('(max-width: 768px)').addEventListener('change', syncChromaticKeyboardScroller);
    window.matchMedia('(hover: none) and (pointer: coarse)').addEventListener('change', syncChromaticKeyboardScroller);
    const ro = new ResizeObserver(() => syncChromaticKeyboardScroller());
    ro.observe(panel);
    const board = document.getElementById('chromaticKeyboard');
    if (board) ro.observe(board);

    let drag = null;

    const scrollFromPointer = (clientX, originX, originScroll) => {
        const maxScroll = Math.max(0, panel.scrollWidth - panel.clientWidth);
        const trackW = track.clientWidth;
        const thumbW = thumb.offsetWidth;
        const travel = Math.max(1, trackW - thumbW);
        const dx = clientX - originX;
        panel.scrollLeft = originScroll + (dx / travel) * maxScroll;
    };

    track.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (scroller.hidden) return;
        const touchMayScroll = e.pointerType === 'touch' && useTouchKeyboardScroller();
        if (touchMayScroll) {
            touchGesture.set(e.pointerId, {
                x: e.clientX,
                y: e.clientY,
                lock: null,
                bar: true,
                originScroll: panel.scrollLeft,
            });
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        startBarDrag(e, e.clientX, panel.scrollLeft);
    });

    const startBarDrag = (e, originX, originScroll) => {
        const maxScroll = Math.max(0, panel.scrollWidth - panel.clientWidth);
        const trackRect = track.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        const onThumb = originX >= thumbRect.left && originX <= thumbRect.right;
        if (!onThumb && maxScroll > 0) {
            const travel = Math.max(1, track.clientWidth - thumb.offsetWidth);
            const local = originX - trackRect.left - thumb.offsetWidth / 2;
            panel.scrollLeft = (Math.min(travel, Math.max(0, local)) / travel) * maxScroll;
            originScroll = panel.scrollLeft;
        }
        drag = {
            pointerId: e.pointerId,
            originX,
            originScroll,
        };
        scroller.classList.add('is-dragging');
        try { track.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };

    track.addEventListener('pointermove', (e) => {
        const gesture = touchGesture.get(e.pointerId);
        if (gesture?.bar && !gesture.lock) {
            const dx = e.clientX - gesture.x;
            const dy = e.clientY - gesture.y;
            if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
            if (Math.abs(dy) > Math.abs(dx)) {
                gesture.lock = 'y';
                touchGesture.delete(e.pointerId);
                return;
            }
            gesture.lock = 'x';
            e.preventDefault();
            startBarDrag(e, gesture.x, gesture.originScroll);
        }
        if (!drag || e.pointerId !== drag.pointerId) return;
        e.preventDefault();
        scrollFromPointer(e.clientX, drag.originX, drag.originScroll);
    });

    const endDrag = (e) => {
        if (e?.pointerId != null) {
            const gesture = touchGesture.get(e.pointerId);
            if (gesture?.bar) touchGesture.delete(e.pointerId);
        }
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        drag = null;
        scroller.classList.remove('is-dragging');
        if (e) {
            try { track.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        }
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);

    track.addEventListener('keydown', (e) => {
        const maxScroll = Math.max(0, panel.scrollWidth - panel.clientWidth);
        const step = Math.max(WHITE_KEY_PX, panel.clientWidth * 0.2);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            panel.scrollLeft = Math.min(maxScroll, panel.scrollLeft + step);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            panel.scrollLeft = Math.max(0, panel.scrollLeft - step);
        } else if (e.key === 'Home') {
            panel.scrollLeft = 0;
        } else if (e.key === 'End') {
            panel.scrollLeft = maxScroll;
        } else {
            return;
        }
        e.preventDefault();
    });

    syncChromaticKeyboardScroller();
}

function syncKeyboardXyVisibility() {
    const fieldset = document.getElementById('keyboardXyFieldset');
    if (!fieldset) return;
    fieldset.hidden = false;
    requestAnimationFrame(() => refreshXYPad());
}

function syncChromaticSpaceBarVisibility() {
    const row = document.getElementById('chromaticSpaceBarRow');
    if (!row) return;
    // Off hides piano + spacebar; computer-keys mode hides chromatic space.
    const show = !!state.keyboardVisible && !state.computerKeyboardEnabled;
    row.hidden = !show;
}

export function syncVisibilityUI() {
    const section = document.querySelector('.keyboard-section');
    const panel = document.getElementById('chromaticKeyboardPanel');
    const ckbPanel = document.getElementById('computerKeyboardPanel');
    const btn = document.getElementById('keyboardVisibilityToggle');
    const visible = !!state.keyboardVisible;
    if (section) section.classList.toggle('keyboard-off', !visible);
    // Off hides piano + computer-keys board only. Transport, knobs, steps, MIDI, XY, pitch bend stay.
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
    syncKeyboardXyVisibility();
    syncChromaticSpaceBarVisibility();
    syncChromaticKeyboardScroller();
    if (btn) {
        const front = btn.querySelector('.front');
        if (front) front.textContent = 'Keys';
        else btn.textContent = 'Keys';
        btn.classList.toggle('off', !visible);
        btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
        btn.setAttribute('aria-label', visible ? 'Hide piano keyboard' : 'Show piano keyboard');
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

/** True when Ingy-6 Poly or Multitudes owns the 6-voice playground. */
function isPolyStyleMode() {
    return !!(state.keyboardPoly || state.keyboardMultitudes);
}

/** Juno-style arp: held keys feed the pool; clock gates one poly voice at a time. */
function isPolyArpMode() {
    return isPolyStyleMode() && !!state.keyboardArp;
}

/** Force chord-style arp when Poly/Multitudes + Arp are both on. */
function ensurePolyChordArp() {
    if (!isPolyArpMode()) return;
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
    setToolbarButtonLocked(btn, !!state.isPlaying);
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
    // Locked off when Arp off / playing; locked on (forced) in Poly/Multitudes Arp
    const polyForced = isPolyArpMode();
    setToolbarButtonLocked(btn, !!state.isPlaying || !state.keyboardArp || polyForced);
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
    setToolbarButtonLocked(btn, !!state.isPlaying || !active);
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
    setToolbarButtonLocked(btn, !!state.isPlaying || !active);
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
    const wasEnabled = !!get('scaleToggle');
    if (enabled !== undefined && enabled !== null) {
        setParam('scaleToggle', !!enabled);
    }
    if (scaleId) {
        setParam('scaleSelect', scaleId);
    }
    const scaleOn = !!get('scaleToggle');
    const selectedId = getString('scaleSelect');

    const mainToggle = document.getElementById('scaleToggle');
    const mainSelect = document.getElementById('scaleSelect');
    const mainSelectControl = document.getElementById('scaleSelectControl');
    const kbToggle = document.getElementById('keyboardScaleToggle');
    const kbSelect = document.getElementById('keyboardScaleSelect');
    const patternToggle = document.getElementById('kbPatternScaleToggle');
    const patternSelect = document.getElementById('kbPatternScaleSelect');
    const xyToggle = document.getElementById('kbXyScaleToggle');
    const xySelect = document.getElementById('kbXyScaleSelect');

    if (mainToggle) {
        mainToggle.classList.toggle('off', !scaleOn);
        const front = mainToggle.querySelector('.front');
        if (front) front.textContent = scaleOn ? 'Scale: On' : 'Scale: Off';
    }
    const syncToggle = (btn, { on = 'On', off = 'Off' } = {}) => {
        if (!btn) return;
        btn.classList.toggle('off', !scaleOn);
        const label = scaleOn ? on : off;
        const front = btn.querySelector('.front');
        if (front) front.textContent = label;
        else btn.textContent = label;
        btn.setAttribute('aria-pressed', scaleOn ? 'true' : 'false');
    };
    syncToggle(kbToggle, { on: 'Scale: On', off: 'Scale: Off' });
    syncToggle(patternToggle, { on: 'On', off: 'Scale Off' });
    syncToggle(xyToggle, { on: 'On', off: 'Scale Off' });

    if (selectedId) {
        if (mainSelect) mainSelect.value = selectedId;
        if (kbSelect) kbSelect.value = selectedId;
        if (patternSelect) patternSelect.value = selectedId;
        if (xySelect) xySelect.value = selectedId;
    }

    if (mainSelectControl) mainSelectControl.style.display = scaleOn ? '' : 'none';
    const kbScaleRow = document.getElementById('keyboardScaleSelectRow');
    if (kbScaleRow) kbScaleRow.style.display = scaleOn ? '' : 'none';
    const tuningScaleRow = document.getElementById('kbTuningScaleSelectRow');
    if (tuningScaleRow) tuningScaleRow.style.display = '';
    const xyScaleRow = document.getElementById('kbXyScaleSelectRow');
    if (xyScaleRow) xyScaleRow.style.display = '';
    if (patternSelect) patternSelect.style.display = scaleOn ? '' : 'none';
    if (xySelect) xySelect.style.display = scaleOn ? '' : 'none';

    if (scaleOn && !wasEnabled) {
        beginScaleVfdPrompt();
    } else if (!scaleOn && wasEnabled) {
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
    const selectedId = getString('scaleSelect') || mainSelect?.value;
    selects.forEach((el) => {
        populateScaleSelect(el);
        if (el && selectedId) el.value = selectedId;
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
    const n = Math.max(-2, Math.min(2, Math.round(getNumber('octaveSwitch', 0)) || 0));
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
    const next = Math.max(-2, Math.min(2, parseInt(value, 10) || 0));
    setParam('octaveSwitch', next);
    syncOctaveSwitchUi();
}

function shiftOctaveSwitch(delta) {
    const cur = parseInt(String(get('octaveSwitch') ?? 0), 10) || 0;
    setOctaveSwitch(cur + delta);
}

const SEMI_SWITCH_IDS = ['kbPatternSemiSwitch', 'kbXySemiSwitch'];
const SEMI_SWITCH_VALUE_IDS = ['kbPatternSemiSwitchValue', 'kbXySemiSwitchValue'];
const SEMI_AMOUNT_IDS = ['kbPatternSemiAmount', 'kbXySemiAmount'];

function clampSemiSwitch(n) {
    return Math.max(-2, Math.min(2, Math.round(Number(n) || 0)));
}

function syncSemitoneSwitchUi() {
    const pos = clampSemiSwitch(getNumber('semitoneSwitch', 0));
    const label = String(pos);
    SEMI_SWITCH_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value !== label) el.value = label;
    });
    SEMI_SWITCH_VALUE_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
    const amountVal = getString('semitoneAmount', '7');
    SEMI_AMOUNT_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value !== amountVal) el.value = amountVal;
    });
}

function setSemitoneSwitch(value) {
    setParam('semitoneSwitch', clampSemiSwitch(value));
    syncSemitoneSwitchUi();
}

function setSemitoneAmount(value) {
    const next = String(Math.max(0, Math.min(12, parseInt(value, 10) || 0)));
    setParam('semitoneAmount', next);
    syncSemitoneSwitchUi();
}

function retuneKeyboardFromGlobalPitch() {
    refreshKeyboard();
    notifyKeyboardPitchUi();
    if (!state.isPlaying && hasPolyVoices()) {
        retunePolyVoices((semi) => soundingSemitones(semi));
    } else if (!state.isPlaying && state.keyboardVoiceActive && state.keyboardHeldSemitone !== null) {
        noteOn(soundingSemitones(state.keyboardHeldSemitone));
    }
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
    const value = String(get('masterTune') ?? 0);
    const label = formatMasterTuneValue(value);
    ['keyboardMasterTune', 'kbTuningMasterTune', 'kbXyTuningMasterTune'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value !== value) el.value = value;
    });
    ['keyboardMasterTuneValue', 'kbTuningMasterTuneValue', 'kbXyTuningMasterTuneValue'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
}

function setMasterTuneFromKeyboard(value) {
    const changed = setParam('masterTune', value);
    const next = String(get('masterTune') ?? 0);
    const label = formatMasterTuneValue(next);
    ['keyboardMasterTuneValue', 'kbTuningMasterTuneValue', 'kbXyTuningMasterTuneValue'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
    ['keyboardMasterTune', 'kbTuningMasterTune', 'kbXyTuningMasterTune'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.value !== next) el.value = next;
    });
    const readout = document.getElementById('masterTuneValue');
    if (readout) readout.textContent = next;
    if (!changed) return;
    refreshKeyboard();
    notifyKeyboardPitchUi();
    if (!state.isPlaying && hasPolyVoices()) {
        retunePolyVoices((semi) => soundingSemitones(semi));
    } else if (!state.isPlaying && state.keyboardVoiceActive && state.keyboardHeldSemitone !== null) {
        noteOn(soundingSemitones(state.keyboardHeldSemitone));
    }
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
    if (state.keyboardPoly || state.keyboardMultitudes) forceDrumFiltOffForPoly();
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
    // Do not exit Poly / Multitudes — that restores polySnapshot and wipes Ingy-6.
    clearPolyPointers();
    clearHeldNotes();
    forceNoteOff();
    forcePolyAllOff({ silent: true });
    state.keyboardHeldSemitone = state.keyboardTranspose !== 0 ? state.keyboardTranspose : null;
    highlightFromState();
    syncTransposeDimUI();
    syncLiveModeControlsUI();
    syncPolyModeUI();
}

export function arpOrderLabel() {
    return ARP_ORDER_LABELS[state.arpOrder || 'up'] || 'Up';
}

/** Toggle keyboard arp. Safe with no 2D toolbar. */
export function toggleKeyboardArp() {
    if (state.isPlaying) return;
    if (!state.keyboardArp && state.keyboardWrite) {
        setWriteMode(false, { refreshKeyboard });
    }
    state.keyboardArp = !state.keyboardArp;
    if (state.keyboardArp && isPolyStyleMode()) {
        ensurePolyChordArp();
        if (!state.isPlaying) {
            clearPolyPointers();
            forcePolyAllOff({ silent: true });
            for (const semi of getHeldNotes()) {
                recordArpChordSessionNote(semi);
            }
            if (heldNoteCount() > 0 && !state.isArping) startArp();
        }
    }
    if (!state.keyboardArp) {
        state.keyboardArpChord = false;
        const wasArping = state.isArping;
        if (wasArping) stopArp();
        clearFrozenArpNotes();
        clearArpChordSession();
        if (isPolyStyleMode() && !state.isPlaying) {
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
}

export function toggleKeyboardArpChord() {
    if (state.isPlaying || !state.keyboardArp) return;
    if (isPolyStyleMode()) return;
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
}

export function cycleArpOrder() {
    if (state.isPlaying || !state.keyboardArp || !state.keyboardArpChord) return;
    const cycle = isPolyArpMode()
        ? POLY_ARP_ORDER_CYCLE
        : ARP_ORDER_CYCLE;
    let idx = cycle.indexOf(state.arpOrder || 'up');
    if (idx < 0) idx = 0;
    state.arpOrder = cycle[(idx + 1) % cycle.length];
    invalidateChordArpOrder();
    syncArpOrderUI();
}

export function initKeyboard() {
    const board = document.getElementById('chromaticKeyboard');
    if (!board) return;
    initChromaticKeyboardScroller();

    const releaseTouchPlay = (pointerId) => {
        if (polyPointers.has(pointerId)) {
            try { board.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
            polyPointerUp(pointerId);
            return;
        }
        if (activePointerId !== pointerId) return;
        try { board.releasePointerCapture(pointerId); } catch (_) { /* ignore */ }
        activePointerId = null;
        if (pressedSemitone !== null) {
            pressedSemitone = null;
            handleRelease();
        }
    };

    // Upward swipe scrolls the page. Sideways swipe stays on the keys and plays a run.
    board.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch' || !useTouchKeyboardScroller()) return;
        if (!e.target.closest?.('.piano-key')) return;
        // A primary touch means no other finger is down. Drop any gesture whose
        // pointerup was lost so a stale sideways lock cannot pin page scrolling.
        if (e.isPrimary) {
            for (const [id, g] of touchGesture) {
                if (!g.bar) touchGesture.delete(id);
            }
        }
        touchGesture.set(e.pointerId, { x: e.clientX, y: e.clientY, lock: null });
    }, true);

    board.addEventListener('pointermove', (e) => {
        const gesture = touchGesture.get(e.pointerId);
        if (!gesture || gesture.lock || gesture.bar) return;
        const dx = Math.abs(e.clientX - gesture.x);
        const dy = Math.abs(e.clientY - gesture.y);
        // Decide sideways early. iOS starts a page scroll and cancels the
        // pointer after about 10px, so the slide must own the touch before
        // that. A finger press dips before it runs, so up/down needs to be
        // clearly steeper and longer before it hands the touch to the page.
        if (dx >= 6 && dx >= dy) {
            gesture.lock = 'x';
            try { board.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            return;
        }
        if (dy >= 14 && dy > dx * 1.5) {
            gesture.lock = 'y';
            releaseTouchPlay(e.pointerId);
        }
    }, true);

    const endPointer = (e) => {
        touchGesture.delete(e.pointerId);
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

    document.getElementById('keyboardArpToggle')?.addEventListener('click', () => {
        toggleKeyboardArp();
    });

    document.getElementById('keyboardArpChordToggle')?.addEventListener('click', () => {
        toggleKeyboardArpChord();
    });

    document.getElementById('keyboardArpOrderToggle')?.addEventListener('click', () => {
        cycleArpOrder();
    });

    document.getElementById('keyboardArpRangeToggle')?.addEventListener('click', () => {
        if (state.isPlaying || !state.keyboardArp || !state.keyboardArpChord) return;
        const cur = Math.max(1, Math.min(3, Math.floor(Number(state.arpRange)) || 1));
        state.arpRange = cur >= 3 ? 1 : cur + 1;
        invalidateChordArpOrder();
        syncArpRangeUI();
    });

    document.getElementById('keyboardChordMemToggle')?.addEventListener('click', () => {
        if (state.keyboardWrite) return;
        const wasArmed = isPolyChordMemoryOn();
        toggleChordMemoryLearn();
        if (state.isPlaying) return;
        if (wasArmed && !isPolyChordMemoryOn()) {
            forcePolyAllOff();
            clearPolyPointers();
            clearHeldNotes();
            state.keyboardHeldSemitone = null;
            clearKeyHighlights();
        }
        if (state.chordMemoryLearning) {
            // Learn uses held set; don't leave a pattern arp running on the same keys
            if (state.isArping && state.keyboardArpChord) {
                stopArp();
            }
            clearFrozenArpNotes();
            // Pause poly audio while learning (notes are silent capture)
            if (isPolyStyleMode()) {
                forcePolyAllOff();
                clearPolyPointers();
            }
        }
        highlightFromState();
    });

    document.getElementById('keyboardPolyToggle')?.addEventListener('click', () => {
        if (!state.keyboardPoly && state.chordMemoryLearning) {
            cancelChordMemoryLearn();
        }
        const enabling = !state.keyboardPoly;
        if (enabling && state.keyboardMultitudes) {
            setMultitudesMode(false);
        }
        // Always clear holds before mode flip so unison last-note logic can't respawn
        clearPolyPointers();
        if (enabling && state.keyboardArp) {
            ensurePolyChordArp();
            forceNoteOff();
            forcePolyAllOff({ silent: true });
            if (state.isArping) stopArp();
            togglePolyMode();
            if (!state.isPlaying
                && (heldNoteCount() > 0 || (state.arpFrozenNotes && state.arpFrozenNotes.length))) {
                startArp();
            }
        } else if (!enabling && state.keyboardArp) {
            if (state.isArping) stopArp();
            forcePolyAllOff({ silent: true });
            togglePolyMode();
            if (!state.isPlaying
                && (heldNoteCount() > 0 || (state.arpFrozenNotes && state.arpFrozenNotes.length))) {
                startArp();
            }
        } else {
            if (!state.isPlaying) clearHeldNotes();
            forceNoteOff();
            forcePolyAllOff();
            togglePolyMode();
        }
        highlightFromState();
        syncLiveModeControlsUI();
    });

    document.getElementById('keyboardMultitudesToggle')?.addEventListener('click', () => {
        if (state.chordMemoryLearning) cancelChordMemoryLearn();
        const enabling = !state.keyboardMultitudes;
        if (enabling && state.keyboardPoly) {
            clearPolyPointers();
            if (!state.keyboardArp && !state.isPlaying) clearHeldNotes();
            forceNoteOff();
            forcePolyAllOff({ silent: true });
            togglePolyMode();
        }
        if (enabling) {
            void initAudio();
            clearPolyPointers();
            if (state.keyboardArp) {
                forceNoteOff();
                forcePolyAllOff({ silent: true });
                if (state.isArping) stopArp();
                setMultitudesMode(true);
                ensurePolyChordArp();
                if (!state.isPlaying
                    && (heldNoteCount() > 0 || (state.arpFrozenNotes && state.arpFrozenNotes.length))) {
                    startArp();
                }
            } else {
                if (!state.isPlaying) clearHeldNotes();
                forcePolyAllOff({ silent: true });
                setMultitudesMode(true);
            }
        } else if (state.keyboardArp) {
            clearPolyPointers();
            if (state.isArping) stopArp();
            forcePolyAllOff({ silent: true });
            setMultitudesMode(false);
            if (!state.isPlaying
                && (heldNoteCount() > 0 || (state.arpFrozenNotes && state.arpFrozenNotes.length))) {
                startArp();
            }
        } else {
            clearPolyPointers();
            if (!state.isPlaying) clearHeldNotes();
            forcePolyAllOff({ silent: true });
            setMultitudesMode(false);
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
        applyScaleState(!get('scaleToggle'), getString('scaleSelect'));
    });

    document.getElementById('keyboardScaleSelect')?.addEventListener('change', function () {
        applyScaleState(!!get('scaleToggle'), this.value);
    });

    document.getElementById('kbPatternScaleToggle')?.addEventListener('click', () => {
        applyScaleState(!get('scaleToggle'), getString('scaleSelect'));
    });

    document.getElementById('kbPatternScaleSelect')?.addEventListener('change', function () {
        applyScaleState(!!get('scaleToggle'), this.value);
    });

    document.getElementById('kbXyScaleToggle')?.addEventListener('click', () => {
        applyScaleState(!get('scaleToggle'), getString('scaleSelect'));
    });

    document.getElementById('kbXyScaleSelect')?.addEventListener('change', function () {
        applyScaleState(!!get('scaleToggle'), this.value);
    });

    syncOctaveSwitchUi();
    document.getElementById('kbPatternOctaveDown')?.addEventListener('click', () => shiftOctaveSwitch(-1));
    document.getElementById('kbPatternOctaveUp')?.addEventListener('click', () => shiftOctaveSwitch(1));
    document.getElementById('kbXyOctaveDown')?.addEventListener('click', () => shiftOctaveSwitch(-1));
    document.getElementById('kbXyOctaveUp')?.addEventListener('click', () => shiftOctaveSwitch(1));
    initSemitoneMirrors();

    subscribe('octaveSwitch', () => {
        syncOctaveSwitchUi();
        retuneKeyboardFromGlobalPitch();
    });
    subscribe('semitoneSwitch', () => {
        syncSemitoneSwitchUi();
        retuneKeyboardFromGlobalPitch();
    });
    subscribe('semitoneAmount', () => {
        syncSemitoneSwitchUi();
        retuneKeyboardFromGlobalPitch();
    });

    ['masterTune', 'octaveSwitch', 'semitoneSwitch'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => {
            if (id === 'masterTune') syncKeyboardMasterTune();
            if (id === 'octaveSwitch') syncOctaveSwitchUi();
            retuneKeyboardFromGlobalPitch();
        });
    });
    document.getElementById('semitoneAmount')?.addEventListener('change', () => {
        retuneKeyboardFromGlobalPitch();
    });

    document.addEventListener('ingysynth:sequencer-start', () => onSequencerStart());
    document.addEventListener('ingysynth:sequencer-stop', () => onSequencerStop());
    document.addEventListener('ingysynth:seq-step-ui', (e) => {
        if (!state.isPlaying) return;
        const notes = e.detail?.cellNotes;
        if (Array.isArray(notes) && notes.length) highlightNotes(notes);
        else highlightFromState();
    });
    document.addEventListener('ingysynth-kb-steps-sync', () => {
        if (state.keyboardWrite && !state.isPlaying) highlightFromState();
    });
    document.addEventListener('ingysynth:poly-write-keys', () => highlightFromState());

    // Match keyboard scale UI to the param Map (catalog default is off)
    applyScaleState(
        !!get('scaleToggle'),
        getString('scaleSelect'),
    );

    initPatternWrite(refreshKeyboard);
    initPolyVoice();
    initMultitudesPanel();

    syncVisibilityUI();
    syncLiveModeControlsUI();
    syncLatchUI();
    syncTransposeDimUI();
}
