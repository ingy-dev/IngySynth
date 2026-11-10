import { state } from './state.js?v=120';
import { semitonesToNoteName } from './tuning.js?v=108';
import { initAudio } from './audio-engine.js?v=247';
import { togglePlay } from './sequencer.js?v=456';
import {
    pressKey,
    releaseKey,
    heldNoteDown,
    heldNoteUp,
    isInActiveScale,
    soundingSemitones,
    syncVisibilityUI,
    KEYBOARD_SEMI_MIN,
    KEYBOARD_SEMI_MAX,
} from './keyboard.js?v=276';
import { needsHeldNoteSet } from './held-notes.js?v=13';
import { isPolyWriteMode, polyWriteNoteDown, polyWriteNoteUp } from './pattern-write.js?v=160';

/** Ableton home-row octave: relative semitones from A-key root. */
const NOTE_CODES = {
    KeyA: 0,
    KeyW: 1,
    KeyS: 2,
    KeyE: 3,
    KeyD: 4,
    KeyF: 5,
    KeyT: 6,
    KeyG: 7,
    KeyY: 8,
    KeyH: 9,
    KeyU: 10,
    KeyJ: 11,
    KeyK: 12,
    KeyO: 13,
    KeyL: 14,
    KeyP: 15,
    Semicolon: 16,
};

const NOTE_LETTERS = {
    KeyA: 'A',
    KeyW: 'W',
    KeyS: 'S',
    KeyE: 'E',
    KeyD: 'D',
    KeyF: 'F',
    KeyT: 'T',
    KeyG: 'G',
    KeyY: 'Y',
    KeyH: 'H',
    KeyU: 'U',
    KeyJ: 'J',
    KeyK: 'K',
    KeyO: 'O',
    KeyL: 'L',
    KeyP: 'P',
    Semicolon: ';',
};

/** Sharp row with null = spacer matching missing black keys. */
const SHARP_ROW = ['KeyW', 'KeyE', null, 'KeyT', 'KeyY', 'KeyU', null, 'KeyO', 'KeyP'];
const NATURAL_ROW = [
    'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon',
];

const MAX_REL = 16;
/** Hold mono voice across rapid key switches so pressKey can retune (piano legato). */
const LEGATO_RELEASE_MS = 55;
const pressedCodes = new Set();
let legatoReleaseTimer = null;
let activePointerId = null;
let pointerHeldCode = null;

function isTextEntryTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    // Keep real text fields protected. SELECT is NOT included — in QWERTY mode
    // letter keys must play notes, not typeahead the scale menu.
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
    return !!el.closest?.('[contenteditable="true"]');
}

function blurSelectFocus() {
    const el = document.activeElement;
    if (!el || !(el instanceof Element)) return;
    if (el.tagName === 'SELECT' || el.closest?.('select')) {
        el.blur();
    }
}

function isCommandKey(e) {
    return !!(e.metaKey || e.ctrlKey || e.altKey);
}

function isBareMetalShell() {
    return !!window.__JUCE__?.backend;
}

const ARROW_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
]);

function focusHandlesArrows(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.tagName === 'SELECT') return true;
    const role = el.getAttribute('role');
    if (role === 'slider' || role === 'spinbutton') return true;
    return !!el.closest?.('[role="slider"], [role="spinbutton"]');
}

function performanceKey(code) {
    return code === 'Space' || code === 'KeyZ' || code === 'KeyX' || code === 'KeyM'
        || Object.prototype.hasOwnProperty.call(NOTE_CODES, code);
}

/**
 * WKWebView re-sends any keydown the page does not cancel. AppKit then plays
 * the system alert (the Mac "funk") from NSView keyDown. That includes
 * auto-repeat, which used to return before preventDefault.
 */
function shouldSilenceKey(e) {
    if (isTextEntryTarget(e.target) || isCommandKey(e)) return false;
    if (e.key === 'Tab') return false;
    if (e.code === 'KeyM') return true;
    if (!state.keyboardVisible) return false;
    if (isBareMetalShell()) {
        if (ARROW_KEYS.has(e.key) && focusHandlesArrows(e.target)) return false;
        // Enter on a control is a real activation, and AppKit does not beep for it.
        if (e.key === 'Enter' && e.target instanceof Element
            && e.target.closest('button, a, [role="button"]')) return false;
        return true;
    }
    return performanceKey(e.code);
}

function blurButtonFocus() {
    const el = document.activeElement;
    if (!el || !(el instanceof Element)) return;
    if (isTextEntryTarget(el) || focusHandlesArrows(el)) return;
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
        el.blur();
    }
}

function cancelLegatoRelease() {
    if (legatoReleaseTimer == null) return;
    clearTimeout(legatoReleaseTimer);
    legatoReleaseTimer = null;
}

function scheduleLegatoRelease() {
    cancelLegatoRelease();
    legatoReleaseTimer = setTimeout(() => {
        legatoReleaseTimer = null;
        if (pressedCodes.size > 0) return;
        releaseKey();
    }, LEGATO_RELEASE_MS);
}

function clampOctave(oct) {
    const min = KEYBOARD_SEMI_MIN;
    const max = KEYBOARD_SEMI_MAX - MAX_REL;
    return Math.min(max, Math.max(min, oct));
}

function semiForCode(code) {
    const rel = NOTE_CODES[code];
    if (rel == null) return null;
    return state.computerKeyboardOctave + rel;
}

function syncToggleUI() {
    const btn = document.getElementById('computerKeyboardToggle');
    if (!btn) return;
    const on = !!state.computerKeyboardEnabled;
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', on ? 'Exit computer keyboard mode' : 'Computer keyboard mode');
}

function syncSpaceTransportUI() {
    document.querySelectorAll('.ckb-space').forEach((space) => {
        space.classList.toggle('start', !state.isPlaying);
        space.classList.toggle('stop', !!state.isPlaying);
    });
}

function setKeyDownVisual(code, down) {
    document.querySelectorAll(`[data-code="${code}"]`).forEach((el) => {
        if (el.classList.contains('ckb-key')) el.classList.toggle('is-down', down);
    });
}

function noteKeyCodeFromPoint(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return null;
    const key = el.closest?.('.ckb-key');
    if (!key || key.classList.contains('ckb-out-of-scale')) return null;
    const code = key.dataset.code;
    if (!code || !NOTE_CODES.hasOwnProperty(code)) return null;
    return code;
}

export function refreshComputerKeyboardLabels() {
    const panel = document.getElementById('computerKeyboardBoard');
    if (!panel) return;

    panel.querySelectorAll('.ckb-key[data-code]').forEach((btn) => {
        const code = btn.dataset.code;
        if (!NOTE_CODES.hasOwnProperty(code)) return;
        const semi = semiForCode(code);
        const noteEl = btn.querySelector('.ckb-note');
        if (noteEl && semi != null) {
            noteEl.textContent = semitonesToNoteName(soundingSemitones(semi));
        }
        const inScale = semi != null && isInActiveScale(semi);
        btn.classList.toggle('ckb-out-of-scale', !inScale);
        // Match chromatic keyboard: cyan border on the C4 reference cell (semi === 0)
        btn.classList.toggle('ckb-root', semi === 0);
        btn.setAttribute('aria-disabled', inScale ? 'false' : 'true');
    });
}

function makeNoteKey(code) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ckb-key pushable';
    btn.dataset.code = code;
    const front = document.createElement('span');
    front.className = 'front';
    const letter = document.createElement('span');
    letter.className = 'ckb-letter';
    letter.textContent = NOTE_LETTERS[code] || code;
    const note = document.createElement('span');
    note.className = 'ckb-note';
    front.appendChild(letter);
    front.appendChild(note);
    btn.appendChild(front);
    return btn;
}

function makeSpacer() {
    const sp = document.createElement('span');
    sp.className = 'ckb-spacer';
    sp.setAttribute('aria-hidden', 'true');
    return sp;
}

function makeOctaveKey(code, direction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ckb-key ckb-octave pushable';
    btn.dataset.code = code;
    btn.setAttribute('aria-label', direction === 'down' ? 'Octave down' : 'Octave up');
    const front = document.createElement('span');
    front.className = 'front';
    const letter = document.createElement('span');
    letter.className = 'ckb-letter';
    letter.textContent = NOTE_LETTERS[code] || code.replace('Key', '');
    const octRow = document.createElement('span');
    octRow.className = 'ckb-oct-row';
    const oct = document.createElement('span');
    oct.className = 'ckb-oct-label';
    oct.textContent = 'OCT';
    const dir = document.createElement('span');
    dir.className = `ckb-oct-dir ckb-oct-dir-${direction}`;
    dir.setAttribute('aria-hidden', 'true');
    octRow.appendChild(oct);
    octRow.appendChild(dir);
    front.appendChild(octRow);
    front.appendChild(letter);
    btn.appendChild(front);
    return btn;
}

function makeSpaceKey() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ckbSpace';
    btn.className = 'ckb-key ckb-space pushable start';
    btn.dataset.code = 'Space';
    btn.setAttribute('aria-label', 'Start or stop sequencer');
    const front = document.createElement('span');
    front.className = 'front';
    const icon = document.createElement('span');
    icon.className = 'ckb-transport-icon';
    icon.setAttribute('aria-hidden', 'true');
    front.appendChild(icon);
    btn.appendChild(front);
    return btn;
}

function makeModelMLogo() {
    const el = document.createElement('span');
    el.className = 'ckb-model-m-logo';
    el.setAttribute('aria-hidden', 'true');
    return el;
}

function buildBoard() {
    const board = document.getElementById('computerKeyboardBoard');
    if (!board) return;
    board.innerHTML = '';

    const sharpRow = document.createElement('div');
    sharpRow.className = 'ckb-row ckb-row-sharps';
    SHARP_ROW.forEach((code) => {
        if (code == null) sharpRow.appendChild(makeSpacer());
        else sharpRow.appendChild(makeNoteKey(code));
    });

    const naturalRow = document.createElement('div');
    naturalRow.className = 'ckb-row ckb-row-naturals';
    NATURAL_ROW.forEach((code) => naturalRow.appendChild(makeNoteKey(code)));

    const modRow = document.createElement('div');
    modRow.className = 'ckb-row ckb-row-mods';
    modRow.appendChild(makeOctaveKey('KeyZ', 'down'));
    modRow.appendChild(makeOctaveKey('KeyX', 'up'));
    modRow.appendChild(makeSpaceKey());
    modRow.appendChild(makeModelMLogo());

    board.appendChild(sharpRow);
    board.appendChild(naturalRow);
    board.appendChild(modRow);

    refreshComputerKeyboardLabels();
    syncSpaceTransportUI();
}

function shiftOctave(delta) {
    const next = clampOctave(state.computerKeyboardOctave + delta);
    if (next === state.computerKeyboardOctave) return;
    state.computerKeyboardOctave = next;
    refreshComputerKeyboardLabels();
}

function tryNoteDown(code) {
    const semi = semiForCode(code);
    if (semi == null) return false;
    if (!isInActiveScale(semi)) return true; // consume, don't play
    if (pressedCodes.has(code)) return true;
    cancelLegatoRelease();
    pressedCodes.add(code);
    setKeyDownVisual(code, true);
    if (isPolyWriteMode()) {
        polyWriteNoteDown(semi);
    } else if (needsHeldNoteSet()) {
        heldNoteDown(semi);
    } else {
        pressKey(semi);
    }
    return true;
}

function tryNoteUp(code) {
    if (!pressedCodes.has(code)) return false;
    pressedCodes.delete(code);
    setKeyDownVisual(code, false);
    if (isPolyWriteMode()) {
        const semi = semiForCode(code);
        if (semi != null) polyWriteNoteUp(semi);
        return true;
    }
    if (needsHeldNoteSet()) {
        const semi = semiForCode(code);
        if (semi != null) heldNoteUp(semi);
        return true;
    }
    if (pressedCodes.size === 0) {
        // Defer release: overlapping / rapid successive keys stay on one voice (legato)
        scheduleLegatoRelease();
    } else if (state.keyboardWrite) {
        // Write mode: each keydown already programmed a step. Do not pressKey
        // again on overlap (that would write duplicate steps).
        cancelLegatoRelease();
    } else {
        cancelLegatoRelease();
        const last = [...pressedCodes].at(-1);
        const semi = semiForCode(last);
        if (semi != null && isInActiveScale(semi)) pressKey(semi);
        else scheduleLegatoRelease();
    }
    return true;
}

/** Toggle the on-screen computer-keys board vs chromatic piano. QWERTY input stays active either way. */
export function setComputerKeyboardEnabled(on) {
    const next = !!on;
    if (next === state.computerKeyboardEnabled) {
        syncToggleUI();
        syncVisibilityUI();
        return;
    }
    state.computerKeyboardEnabled = next;
    if (next) {
        state.computerKeyboardOctave = clampOctave(state.computerKeyboardOctave);
        blurSelectFocus();
        refreshComputerKeyboardLabels();
        syncSpaceTransportUI();
    }
    syncToggleUI();
    syncVisibilityUI();
}

function onPointerNote(code, isDown) {
    if (!state.computerKeyboardEnabled || !state.keyboardVisible) return;
    if (isDown) tryNoteDown(code);
    else tryNoteUp(code);
}

function onBoardPointerDown(e) {
    const board = document.getElementById('computerKeyboardBoard');
    const key = e.target.closest?.('.ckb-key');
    if (!key || !state.computerKeyboardEnabled) return;
    const code = key.dataset.code;
    if (!code) return;
    e.preventDefault();

    if (code === 'Space') {
        try { key.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        key.classList.add('is-down');
        initAudio();
        togglePlay();
        syncSpaceTransportUI();
        return;
    }
    if (code === 'KeyZ') {
        try { key.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        key.classList.add('is-down');
        shiftOctave(-12);
        return;
    }
    if (code === 'KeyX') {
        try { key.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        key.classList.add('is-down');
        shiftOctave(12);
        return;
    }
    if (NOTE_CODES.hasOwnProperty(code)) {
        if (key.classList.contains('ckb-out-of-scale')) return;
        activePointerId = e.pointerId;
        pointerHeldCode = code;
        // Capture on the board so pointermove keeps firing while sliding across keys
        try {
            (board || key).setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        onPointerNote(code, true);
    }
}

function onBoardPointerMove(e) {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    if (pointerHeldCode === null) return;
    // Match chromatic keyboard: no drag-write across keys.
    // Poly / Multitudes / learn / chord arp: pressKey would heldNoteDown the
    // new key and never release the one the finger left.
    if (state.keyboardWrite || needsHeldNoteSet()) return;

    const code = noteKeyCodeFromPoint(e.clientX, e.clientY);
    if (code == null || code === pointerHeldCode) return;

    // Slide: swap held note without a full release (retune via pressKey)
    cancelLegatoRelease();
    setKeyDownVisual(pointerHeldCode, false);
    pressedCodes.delete(pointerHeldCode);
    pointerHeldCode = code;
    pressedCodes.add(code);
    setKeyDownVisual(code, true);
    const semi = semiForCode(code);
    if (semi != null) pressKey(semi);
}

function onBoardPointerUp(e) {
    if (activePointerId !== null && e.pointerId === activePointerId) {
        const code = pointerHeldCode;
        activePointerId = null;
        pointerHeldCode = null;
        if (code) onPointerNote(code, false);
        return;
    }

    const key = e.target.closest?.('.ckb-key');
    if (!key) return;
    const code = key.dataset.code;
    if (code === 'Space' || code === 'KeyZ' || code === 'KeyX') {
        key.classList.remove('is-down');
    }
}

function onKeyDown(e) {
    if (isTextEntryTarget(e.target)) return;

    // Cancel before any early return. Repeats and unmapped keys used to fall
    // through, and Bare Metal's web view beeps for each one.
    if (shouldSilenceKey(e)) {
        e.preventDefault();
        blurButtonFocus();
    }

    if (e.code === 'KeyM' && !e.repeat && !isCommandKey(e)) {
        setComputerKeyboardEnabled(!state.computerKeyboardEnabled);
        return;
    }

    // QWERTY play/octave always work when the keyboard section is on,
    // whether the chromatic piano or computer-keys board is showing.
    if (!state.keyboardVisible) return;
    if (isCommandKey(e)) return;

    if (e.code === 'Space') {
        // Own Space here so first keypress works before wireControls (post-initAudio).
        e.preventDefault();
        e.stopPropagation();
        if (e.target instanceof HTMLSelectElement || e.target?.closest?.('select')) {
            blurSelectFocus();
        }
        if (!e.repeat) {
            initAudio();
            setKeyDownVisual('Space', true);
            togglePlay();
            syncSpaceTransportUI();
        }
        return;
    }

    if (e.repeat) return;

    if (e.code === 'KeyZ') {
        e.preventDefault();
        e.stopPropagation();
        blurSelectFocus();
        setKeyDownVisual('KeyZ', true);
        shiftOctave(-12);
        return;
    }
    if (e.code === 'KeyX') {
        e.preventDefault();
        e.stopPropagation();
        blurSelectFocus();
        setKeyDownVisual('KeyX', true);
        shiftOctave(12);
        return;
    }

    if (NOTE_CODES.hasOwnProperty(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        blurSelectFocus();
        tryNoteDown(e.code);
    }
}

function onKeyUp(e) {
    if (isTextEntryTarget(e.target)) return;

    if (e.code === 'Space') {
        setKeyDownVisual('Space', false);
        syncSpaceTransportUI();
        return;
    }
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
        setKeyDownVisual(e.code, false);
        return;
    }
    if (NOTE_CODES.hasOwnProperty(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        tryNoteUp(e.code);
    }
}

function onChromaticSpacePointerDown(e) {
    const key = e.currentTarget;
    if (!(key instanceof HTMLElement)) return;
    e.preventDefault();
    try { key.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    key.classList.add('is-down');
    initAudio();
    togglePlay();
    syncSpaceTransportUI();
}

function onChromaticSpacePointerUp(e) {
    const key = e.currentTarget;
    if (!(key instanceof HTMLElement)) return;
    key.classList.remove('is-down');
}

export function initComputerKeyboard() {
    const panel = document.getElementById('computerKeyboardPanel');
    if (!panel) return;

    buildBoard();
    panel.hidden = true;

    document.getElementById('computerKeyboardToggle')?.addEventListener('click', () => {
        setComputerKeyboardEnabled(!state.computerKeyboardEnabled);
    });

    const board = document.getElementById('computerKeyboardBoard');
    board?.addEventListener('pointerdown', onBoardPointerDown);
    board?.addEventListener('pointermove', onBoardPointerMove);
    board?.addEventListener('pointerup', onBoardPointerUp);
    board?.addEventListener('pointercancel', onBoardPointerUp);
    board?.addEventListener('lostpointercapture', onBoardPointerUp);

    const chromaticSpace = document.getElementById('chromaticSpace');
    chromaticSpace?.addEventListener('pointerdown', onChromaticSpacePointerDown);
    chromaticSpace?.addEventListener('pointerup', onChromaticSpacePointerUp);
    chromaticSpace?.addEventListener('pointercancel', onChromaticSpacePointerUp);
    chromaticSpace?.addEventListener('lostpointercapture', onChromaticSpacePointerUp);

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    // keypress is the insert-text default. Cancelling it covers the path
    // where WebKit still beeps after a keydown that was not the one we saw.
    document.addEventListener('keypress', (e) => {
        if (shouldSilenceKey(e)) e.preventDefault();
    }, true);
    document.addEventListener('pointerup', () => {
        if (isBareMetalShell()) blurButtonFocus();
    }, true);

    document.addEventListener('ingysynth:keyboard-pitch-ui', () => {
        if (state.computerKeyboardEnabled) refreshComputerKeyboardLabels();
    });
    document.addEventListener('ingysynth:sequencer-start', syncSpaceTransportUI);
    document.addEventListener('ingysynth:sequencer-stop', syncSpaceTransportUI);

    syncToggleUI();
    syncVisibilityUI();
    syncSpaceTransportUI();
}
