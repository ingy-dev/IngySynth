// Berlin Dream-960: eight lanes on one tempo — O1–O4 pitch+amp, M1–M4 filter CV.
// Acid and Poly are mutually exclusive with it.

import { state } from './state.js?v=120';
import { BASE_FREQ, getGlobalTune, getActiveScale, quantizeToScale, oscFineSemis } from './tuning.js?v=108';
import { updateNoteVisualizer, clearNoteVisualizer } from './visualizers.js?v=150';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=111';
import { setPolyMode, bumpSeqEngine } from './poly-voice.js?v=202';
import { setMultitudesMode } from './keyboard-multitudes-panel.js?v=90';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=46';
import { bindKnob, refreshKnobDial } from './knobs.js?v=192';
import { setBerlinDots, refreshParamStatusIndicators } from './param-status.js?v=33';
import { get, getNumber, set } from './params.js?v=44';
import {
    PATTERN_COUNT,
    BANK_COUNT,
    STEP_SLOTS,
    DESTINATIONS,
    OSC_LANE_COUNT,
    DRUM_LANE_COUNT,
    DRUM_MODELS,
    isOscLane,
    isModLane,
    isDrumLane,
    clampDrumLane,
    clampDrumPatch,
    isAnalogDrumEngine,
    ensureBank,
    ensureBerlinBank,
    getPattern,
    getBerlinLane,
    getBerlinPattern,
    seedBerlinO1FromMain,
    getDrumPattern,
    copyBerlinLane,
    pasteBerlinLane,
    clearBerlinLane,
    patternStepCount,
    patternGate,
    flushDomToPattern,
    hydratePatternToDom,
    flashCopiedToast,
    syncPatternClipboardUi,
    ensureBerlinDrumKit,
    ensureDrumPatterns,
} from './pattern-bank.js?v=51';
import { ensurePlaitsWorklet, applyBerlinDrumKitToLive, routeBerlinDrumPanners } from './osc-source.js?v=157';
import { clampRatch, nextRatch, syncRatchButton } from './step-ratch.js?v=1';
import { berlinHooks } from './berlin-hooks.js?v=1';
import { berlinLaneMidiChannels, setBerlinLaneMidiChannel } from './berlin-lane-midi.js?v=2';

/** Warm phosphor (O1–O4) then blue→white (M1–M4). */
export const BERLIN_COLORS = [
    '#FF2A2A', '#FF7A18', '#FFC107', '#C8F000',
    '#1E6BFF', '#4DA3FF', '#A8D4FF', '#E8F2FF',
];

const MOD_DESTINATIONS = DESTINATIONS.filter((d) => (
    d.id === 'cutoff' || d.id === 'resonance' || d.id === 'highpass' || d.id === 'off'
));

const OSC_DEST_BY_LANE = ['osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch'];

export { isOscLane, isModLane, isDrumLane, patternGate };

const DIVISIONS = [
    { value: 2, label: '1/2' },
    { value: 3, label: '1/2T' },
    { value: 4, label: '1/4' },
    { value: 6, label: '1/4T' },
    { value: 8, label: '1/8' },
    { value: 12, label: '1/8T' },
    { value: 16, label: '1/16' },
    { value: 24, label: '1/16T' },
    { value: 48, label: '1/32T' },
];

const DRUM_TONE_LABELS = {
    bass_drum: { harmonics: 'DRIVE', timbre: 'TONE', morph: 'DECAY', tune: 'TUNE' },
    snare: { harmonics: 'TONE/N', timbre: 'TONE', morph: 'DECAY', tune: 'TUNE' },
    hihat: { harmonics: 'METAL', timbre: 'COLOR', morph: 'DECAY', tune: 'TUNE' },
    open_hat: { harmonics: 'METAL', timbre: 'COLOR', morph: 'DECAY', tune: 'TUNE' },
};
const ANALOG_TONE_LABELS = {
    bass_drum: { harmonics: '—', timbre: 'TONE', morph: 'DECAY', tune: 'TUNE' },
    snare: { harmonics: 'SNAPPY', timbre: 'TONE', morph: 'DECAY', tune: 'TUNE' },
    hihat: { harmonics: '—', timbre: 'TONE', morph: 'DECAY', tune: 'TUNE' },
    open_hat: { harmonics: '—', timbre: 'TONE', morph: 'DECAY', tune: 'TUNE' },
};
const DRUM_MODE_LABELS = { m1: 'DRONE', m2: 'HIT' };
const DRUM_MODEL_LABELS = {
    open_hat: 'Open Hat',
    hihat: 'Hi-Hat',
    snare: 'Snare',
    bass_drum: 'Bass Drum',
};

const PITCH_DESTINATIONS = {
    osc1Pitch: 0,
    osc2Pitch: 1,
    osc3Pitch: 2,
    osc4Pitch: 3,
};

const DOT_HOST_KEYS = {
    osc1Pitch: 'osc-tune-0',
    osc2Pitch: 'osc-tune-1',
    osc3Pitch: 'osc-tune-2',
    osc4Pitch: 'osc-tune-3',
    cutoff: 'cutoff',
    resonance: 'resonance',
    highpass: 'highPass',
};

let uiBuilt = false;
let berlinStepCache = null;
const berlinActiveStep = [];

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function readRange(id, fallback) {
    return getNumber(id, fallback);
}

// --- Mode state ------------------------------------------------------------

export function isBerlinOn() {
    return !!state.berlinMode;
}

export function berlinOscCount() {
    const n = clamp(Math.round(getBerlinPattern(state.berlinSlot)?.oscCount) || 3, 1, OSC_LANE_COUNT);
    state.berlinOscCount = n;
    return n;
}

export function berlinModCount() {
    const n = clamp(Math.round(getBerlinPattern(state.berlinSlot)?.modCount) || 1, 1, OSC_LANE_COUNT);
    state.berlinModCount = n;
    return n;
}

/** Total visible lanes (osc + mod). */
export function berlinActiveCount() {
    return berlinOscCount() + berlinModCount();
}

/** Row indexes that are live right now (visible OSC + MOD — drums are not bank rows). */
export function berlinActiveRows() {
    const osc = berlinOscCount();
    const mod = berlinModCount();
    const rows = [];
    for (let i = 0; i < osc; i++) rows.push(i);
    for (let i = 0; i < mod; i++) rows.push(OSC_LANE_COUNT + i);
    return rows;
}

function isPitchLane(rowIndex) {
    return isOscLane(rowIndex) || isDrumLane(rowIndex);
}

/**
 * Berlin Write monitor: the O lane being written, or null (Write off, not
 * Berlin, or the Write lane is an M lane — then every O lane plays as usual).
 */
export function berlinWriteMonitorRow() {
    if (!state.berlinMode || !state.keyboardWrite) return null;
    const row = state.writeBerlinRow;
    if (!isOscLane(row) || !berlinActiveRows().includes(row)) return null;
    return row;
}

let lastSilencedMask = 0;

/**
 * Recompute which lanes are silenced right now (Solo, Write monitor, On/Off),
 * release voices on lanes that just went quiet, repaint the rows and tell the
 * engine. Call after anything that can change isRowSounding().
 */
export function refreshBerlinSounding() {
    let mask = 0;
    for (let row = 0; row < PATTERN_COUNT; row++) {
        if (!isRowSounding(row)) mask |= 1 << row;
    }
    const newlySilent = mask & ~lastSilencedMask;
    lastSilencedMask = mask;
    for (let row = 0; row < PATTERN_COUNT; row++) {
        if (newlySilent & (1 << row)) notifySoundingRowSilenced(row);
    }
    syncAllRowEnableUi();
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-sounding', { detail: { mask } }));
}

/** Output mute: pattern stays visible/editable; playhead keeps phase. */
export function isRowEnabled(rowIndex) {
    const pattern = getBerlinLane(rowIndex);
    return pattern?.enabled !== false;
}

/** Exclusive Solo target, or null when Solo is off. */
export function getSoloRow() {
    const n = state.berlinSoloRow;
    if (n === null || n === undefined) return null;
    const row = Math.round(n);
    if (!berlinActiveRows().includes(row)) return null;
    return row;
}

/**
 * Whether a row's CV/pitch should sound right now.
 * Solo is exclusive and forces the soloed row audible even if On/Off is Off;
 * other rows stay silent without touching their remembered mute state.
 */
export function isRowSounding(rowIndex) {
    // Write monitor: on an O lane you hear only that oscillator. M lanes keep
    // their normal mix, so the filter you are writing still moves the sound.
    const monitor = berlinWriteMonitorRow();
    if (monitor !== null && isOscLane(rowIndex)) return rowIndex === monitor;
    const solo = getSoloRow();
    if (solo !== null) return solo === rowIndex;
    return isRowEnabled(rowIndex);
}

/** Step duration in seconds for one row at the shared tempo. */
export function rowStepDuration(pattern, tempo) {
    const div = parseInt(pattern?.division, 10) || 8;
    return (60 / Math.max(1, tempo)) * (4 / div);
}

export function rowLoopSeconds(pattern, tempo) {
    return patternStepCount(pattern) * rowStepDuration(pattern, tempo);
}

/**
 * Longest visible row, time-wise — muted rows still count so muting the
 * longest pattern does not yank the automation loop shorter mid-take.
 */
export function masterLoopSeconds(tempo) {
    let best = 0;
    berlinActiveRows().forEach((i) => {
        const secs = rowLoopSeconds(getBerlinLane(i), tempo);
        if (secs > best) best = secs;
    });
    return best || (60 / Math.max(1, tempo)) * 4;
}

/** First sounding osc lane — keyboard step highlight only (no shared amp). */
export function keyboardHighlightRow() {
    for (const i of berlinActiveRows()) {
        if (!isOscLane(i)) continue;
        if (!isRowSounding(i)) continue;
        return i;
    }
    return null;
}

/** Notify sequencer to release independent voices for a silenced audio row. */
function notifySoundingRowSilenced(row) {
    if (isOscLane(row)) {
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-osc-muted', {
            detail: { row, oscIndex: row },
        }));
        return;
    }
}

/** Osc lane index → that oscillator; mod/drum lanes have no synth-osc target. */
export function rowTargetOsc(rowIndex) {
    if (isOscLane(rowIndex)) return rowIndex | 0;
    return null;
}

// --- Playheads -------------------------------------------------------------

function makePlayhead() {
    return {
        currentStep: 0,
        nextStepTime: 0,
        semi: 0,
        fine: 0,
        sounded: false,
        prevSlide: false,
        prevGliss: false,
    };
}

export function ensurePlayheads() {
    if (!Array.isArray(state.berlinPlayheads) || state.berlinPlayheads.length !== PATTERN_COUNT) {
        state.berlinPlayheads = Array.from({ length: PATTERN_COUNT }, makePlayhead);
    }
    return state.berlinPlayheads;
}

export function resetBerlinPlayheads(startTime) {
    ensurePlayheads();
    for (let i = 0; i < PATTERN_COUNT; i++) {
        const pattern = getBerlinLane(i);
        const ph = state.berlinPlayheads[i];
        ph.currentStep = pattern.reverse ? patternStepCount(pattern) - 1 : 0;
        ph.nextStepTime = startTime;
        ph.semi = 0;
        ph.fine = 0;
        ph.sounded = false;
        ph.prevSlide = false;
        ph.prevGliss = false;
    }
    state.berlinLoopAnchor = startTime;
}

export function ensureDrumPlayheads() {
    ensureDrumPatterns();
    if (!Array.isArray(state.drumPlayheads) || state.drumPlayheads.length !== DRUM_LANE_COUNT) {
        state.drumPlayheads = Array.from({ length: DRUM_LANE_COUNT }, makePlayhead);
    }
    if (!state.scSourcePlayhead) state.scSourcePlayhead = makePlayhead();
    return state.drumPlayheads;
}

export function resetDrumPlayheads(startTime) {
    ensureDrumPlayheads();
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        const pattern = getDrumPattern(i);
        const ph = state.drumPlayheads[i];
        ph.currentStep = pattern.reverse ? patternStepCount(pattern) - 1 : 0;
        ph.nextStepTime = startTime;
        ph.semi = 0;
        ph.fine = 0;
        ph.sounded = false;
        ph.prevSlide = false;
        ph.prevGliss = false;
    }
    const sc = state.scSourcePlayhead;
    sc.currentStep = 0;
    sc.nextStepTime = startTime;
    sc.semi = 0;
    sc.fine = 0;
    sc.sounded = false;
    sc.prevSlide = false;
    sc.prevGliss = false;
}

export function advanceDrumPlayhead(lane) {
    const pattern = getDrumPattern(lane);
    const ph = state.drumPlayheads[clampDrumLane(lane)];
    const n = patternStepCount(pattern);
    ph.currentStep = pattern.reverse
        ? (ph.currentStep - 1 + n) % n
        : (ph.currentStep + 1) % n;
}

export function advancePlayhead(rowIndex) {
    const pattern = getBerlinLane(rowIndex);
    const ph = state.berlinPlayheads[rowIndex];
    const n = patternStepCount(pattern);
    ph.currentStep = pattern.reverse
        ? (ph.currentStep - 1 + n) % n
        : (ph.currentStep + 1) % n;
}

/** Semitone/cents the dedicated osc lane is holding for that oscillator. */
export function berlinPitchForOsc(oscIndex) {
    ensurePlayheads();
    const row = oscIndex | 0;
    if (!isOscLane(row)) return null;
    if (!berlinActiveRows().includes(row) || !isRowSounding(row)) return null;
    const ph = state.berlinPlayheads[row];
    return { semi: ph.semi, fine: ph.fine };
}

/** Semitones a pitch row emits: Amount-scaled, then snapped to the active scale. */
export function berlinPitchSemitones(semi) {
    const value = Math.round(semi);
    const scale = getActiveScale();
    return scale ? quantizeToScale(value, scale.degrees) : value;
}

/** Absolute frequency for a Berlin pitch value on one oscillator slot. */
export function berlinFrequency(semi, fine, oscIndex, keyboardTranspose = true) {
    const kb = keyboardTranspose ? (state.keyboardTranspose || 0) : 0;
    const total = berlinPitchSemitones(semi)
        + getGlobalTune()
        + kb
        + (state.oscTunes?.[oscIndex] || 0)
        + oscFineSemis(oscIndex)
        + (fine || 0) / 100;
    return BASE_FREQ * Math.pow(2, total / 12);
}

/**
 * Preview an oscillator-lane step on the note VFD while editing tune/µtune.
 * Mod lanes and Berlin playback do not drive the VFD.
 */
function previewBerlinOscStepNote(row, stepIndex) {
    if (!isPitchLane(row)) return;
    const { semi, fine } = rowStepValue(getBerlinLane(row), stepIndex, row);
    const totalTune = berlinPitchSemitones(semi) + getGlobalTune();
    updateNoteVisualizer(totalTune, fine);

    window.noteVisualizerPreviewActive = true;
    if (window.noteVisualizerPreviewTimeout) {
        clearTimeout(window.noteVisualizerPreviewTimeout);
    }
    window.noteVisualizerPreviewTimeout = setTimeout(() => {
        window.noteVisualizerPreviewActive = false;
        // No Berlin playback note on the VFD — return to idle after preview.
        clearNoteVisualizer();
    }, 2000);
}

/**
 * What a step readout should show: the value the row actually emits, so pitch
 * rows follow the scale the way the main strip does. CV rows are not pitches,
 * so they stay unquantized.
 */
export function berlinStepDisplayValue(pattern, stepIndex, rowIndex = null) {
    const step = pattern.steps[stepIndex] || {};
    const osc = rowIndex !== null ? isPitchLane(rowIndex) : PITCH_DESTINATIONS[pattern.destination] !== undefined;
    // Osc lanes: full pitch depth (Amount unused). Mod lanes: Amount scales CV.
    const amount = osc ? 1 : clamp(Number(pattern.amount ?? 1), 0, 1);
    const scaled = (step.tune || 0) * amount;
    if (!osc) return Math.round(scaled);
    return berlinPitchSemitones(scaled);
}

/** Row step value — Amount on mod lanes only; osc lanes always full depth. */
export function rowStepValue(pattern, stepIndex, rowIndex = null) {
    const step = pattern.steps[stepIndex] || { tune: 0, fine: 0 };
    const osc = rowIndex !== null
        ? isPitchLane(rowIndex)
        : PITCH_DESTINATIONS[pattern.destination] !== undefined;
    const amount = osc ? 1 : clamp(Number(pattern.amount ?? 1), 0, 1);
    return {
        semi: (step.tune || 0) * amount,
        fine: (step.fine || 0) * amount,
        on: step.on !== false,
        accent: !!step.accent,
        slide: !!step.slide,
        ratch: clampRatch(step.ratch),
        gate: patternGate(pattern),
    };
}

// --- CV destinations -------------------------------------------------------

function applyCvNow(destination, semi, slideSeconds) {
    const ctx = state.audioContext;
    if (!ctx) return;
    const now = ctx.currentTime;
    const ramp = Math.max(0.005, slideSeconds || 0.01);

    if (destination === 'cutoff') {
        const base = Math.max(40, getNumber('cutoff'));
        const target = clamp(base * Math.pow(2, semi / 12), 40, 12000);
        // Drive the cutoff constant-source graph (LFO/env still sum on top)
        updateFilterCutoffRange(target, now, ramp);
        return;
    }
    if (destination === 'resonance') {
        if (!state.filter) return;
        const base = readRange('resonance', 1);
        // ~0.75 Q per semitone so ±12 reads clearly against the knob
        const target = clamp(base + semi * 0.75, 0.0001, 20);
        const param = state.filter.Q;
        param.cancelScheduledValues(now);
        param.setValueAtTime(Math.max(0.0001, param.value || base), now);
        param.linearRampToValueAtTime(target, now + ramp);
        return;
    }
    if (destination === 'highpass') {
        if (!state.highPassFilter) return;
        const base = Math.max(20, readRange('highPass', 20));
        const target = clamp(base * Math.pow(2, semi / 12), 20, 2000);
        const param = state.highPassFilter.frequency;
        param.cancelScheduledValues(now);
        param.setValueAtTime(Math.max(20, param.value || base), now);
        try {
            param.exponentialRampToValueAtTime(target, now + ramp);
        } catch (_) {
            param.linearRampToValueAtTime(target, now + ramp);
        }
    }
}

/**
 * CV rows land close to their step time rather than being pre-scheduled: the
 * base value is read from the live knob, so it has to be read at that moment.
 */
export function scheduleBerlinCv(destination, semi, atTime, slideSeconds) {
    const ctx = state.audioContext;
    if (!ctx) return;
    const generation = state.playGeneration;
    const delayMs = Math.max(0, (atTime - ctx.currentTime) * 1000);
    setTimeout(() => {
        if (!state.berlinMode || generation !== state.playGeneration) return;
        applyCvNow(destination, semi, slideSeconds);
    }, delayMs);
}

// --- Destination dots ------------------------------------------------------

export function refreshBerlinDots() {
    if (!state.berlinMode) {
        setBerlinDots({});
        // Re-paint automation/MIDI on every host — Berlin may have been the
        // only pass that walked the full host list for a key.
        refreshParamStatusIndicators();
        return;
    }
    const map = {};
    berlinActiveRows().forEach((i) => {
        if (!isRowSounding(i) || isDrumLane(i)) return;
        const key = DOT_HOST_KEYS[getBerlinLane(i).destination];
        if (!key) return;
        if (!map[key]) map[key] = [];
        map[key].push(BERLIN_COLORS[i]);
    });
    setBerlinDots(map);
    refreshParamStatusIndicators();
}

// --- UI --------------------------------------------------------------------

function stepDialId(row, step) {
    return `berlinDial-${row}-${step}`;
}

function formatBerlinCents(cents) {
    const n = Math.round(Number(cents) || 0);
    return `${n > 0 ? '+' : ''}${n}¢`;
}

function snapBerlinCents(value) {
    if (!state.microtuneLock) return Math.max(-100, Math.min(100, Math.round(value)));
    return Math.max(-100, Math.min(100, Math.round(value / 25) * 25));
}

function berlinFineStepAttr() {
    return state.microtuneLock ? '25' : '1';
}

function buildStepCell(row, step) {
    const cell = document.createElement('div');
    cell.className = 'berlin-step';
    cell.dataset.row = String(row);
    cell.dataset.step = String(step);
    cell.innerHTML = `
        <span class="berlin-step-num">${String(step + 1).padStart(2, '0')}</span>
        <div class="synth-knob berlin-step-knob">
            <div class="synth-knob-dial-wrap">
                <div class="synth-knob-dial" id="${stepDialId(row, step)}" role="slider"
                     aria-label="Pattern ${row + 1} step ${step + 1} semitones"
                     aria-valuemin="-24" aria-valuemax="24" tabindex="0">
                    <span class="synth-knob-indicator"></span>
                </div>
            </div>
        </div>
        <span class="berlin-step-value">0</span>
        <input type="range" class="berlin-step-tune" min="-24" max="24" value="0" step="1"
               aria-hidden="true" tabindex="-1">
        <input type="range" class="berlin-step-fine" min="-100" max="100" value="0"
               step="${berlinFineStepAttr()}"
               aria-label="Pattern ${row + 1} step ${step + 1} microtune cents">
        <span class="berlin-step-fine-value">0¢</span>
        <div class="berlin-step-buttons">
            <button type="button" class="berlin-step-btn berlin-step-acc off" aria-pressed="false">A</button>
            <button type="button" class="berlin-step-btn berlin-step-sld off" aria-pressed="false">S</button>
            <button type="button" class="berlin-step-btn berlin-step-ratch off" data-ratch="1" aria-pressed="false">Ratch</button>
            <button type="button" class="berlin-step-btn berlin-step-on" aria-pressed="true">On</button>
        </div>
    `;
    return cell;
}

function rowLegend(row) {
    return isOscLane(row) ? `OSC ${row + 1}` : `MOD ${row - OSC_LANE_COUNT + 1}`;
}

function buildRow(row) {
    const fieldset = document.createElement('fieldset');
    const osc = isOscLane(row);
    fieldset.className = `berlin-row ${osc ? 'berlin-row-osc' : 'berlin-row-mod'}`;
    fieldset.dataset.row = String(row);
    fieldset.dataset.lane = osc ? 'osc' : 'mod';
    fieldset.style.setProperty('--berlin-color', BERLIN_COLORS[row]);

    const destOptions = (osc ? DESTINATIONS.filter((d) => d.id === OSC_DEST_BY_LANE[row]) : MOD_DESTINATIONS)
        .map((d) => `<option value="${d.id}">${d.label}</option>`)
        .join('');
    const divOptions = DIVISIONS
        .map((d) => `<option value="${d.value}">${d.label}</option>`)
        .join('');
    const legend = rowLegend(row);
    // Each O lane can send its notes on its own MIDI channel (berlin-lane-midi.js).
    const midiOptions = ['<option value="0">Main</option>']
        .concat(Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`))
        .join('');
    const midiCtl = osc ? `
                <label class="berlin-ctl berlin-ctl-midi">
                    <span class="berlin-ctl-label">MIDI CH</span>
                    <select class="berlin-row-midi" aria-label="${legend} MIDI out channel">${midiOptions}</select>
                </label>` : '';

    fieldset.innerHTML = `
        <legend>
            <button type="button" class="legend-hex berlin-row-enable"
                    aria-label="${legend} on or off" aria-pressed="true">${legend}</button>
        </legend>
        <fieldset class="berlin-row-controls">
            <div class="berlin-row-controls-body">
                <button type="button" class="berlin-row-solo berlin-step-btn off"
                        aria-label="${legend} solo" aria-pressed="false">Solo</button>
                <label class="berlin-ctl">
                    <span class="berlin-ctl-label">STEPS</span>
                    <input type="range" class="berlin-row-steps keyboard-master-tune-slider" min="1" max="32" value="8" step="1">
                    <span class="berlin-ctl-value berlin-row-steps-value">8</span>
                </label>
                <label class="berlin-ctl">
                    <span class="berlin-ctl-label">LENGTH</span>
                    <select class="berlin-row-division">${divOptions}</select>
                </label>
                <button type="button" class="berlin-row-rev berlin-step-btn off" aria-pressed="false">Rev</button>
                <label class="berlin-ctl berlin-ctl-dest${osc ? ' berlin-ctl-hidden' : ''}">
                    <span class="berlin-ctl-label">DEST</span>
                    <select class="berlin-row-dest" ${osc ? 'disabled' : ''}>${destOptions}</select>
                </label>
                <label class="berlin-ctl berlin-ctl-amount${osc ? ' berlin-ctl-hidden' : ''}">
                    <span class="berlin-ctl-label">AMOUNT</span>
                    <input type="range" class="berlin-row-amount keyboard-master-tune-slider" min="0" max="100" value="100" step="1">
                    <span class="berlin-ctl-value berlin-row-amount-value">100</span>
                </label>
                <label class="berlin-ctl berlin-ctl-gate${osc ? '' : ' berlin-ctl-hidden'}">
                    <span class="berlin-ctl-label">GATE</span>
                    <input type="range" class="berlin-row-gate keyboard-master-tune-slider" min="5" max="100" value="90" step="1">
                    <span class="berlin-ctl-value berlin-row-gate-value">90</span>
                </label>${midiCtl}
                <div class="berlin-row-clipboard" role="group" aria-label="${legend} clipboard">
                    <button type="button" class="berlin-row-copy berlin-step-btn pattern-copy-btn"
                            aria-label="Copy ${legend}">Copy</button>
                    <button type="button" class="berlin-row-paste berlin-step-btn pattern-paste-btn is-disabled"
                            aria-label="Paste into ${legend}" aria-disabled="true" disabled>Paste</button>
                    <button type="button" class="berlin-row-clear berlin-step-btn pattern-clear-btn"
                            aria-label="Clear ${legend} steps">Clear</button>
                </div>
            </div>
        </fieldset>
        <div class="berlin-row-steps-grid"></div>
    `;

    const grid = fieldset.querySelector('.berlin-row-steps-grid');
    for (let s = 0; s < STEP_SLOTS; s++) {
        grid.appendChild(buildStepCell(row, s));
    }
    return fieldset;
}

function syncStepCell(row, step) {
    const pattern = getBerlinLane(row);
    const data = pattern.steps[step] || {};
    const cell = document.querySelector(`.berlin-step[data-row="${row}"][data-step="${step}"]`);
    if (!cell) return;

    const input = cell.querySelector('.berlin-step-tune');
    const valueEl = cell.querySelector('.berlin-step-value');
    const tune = Math.round(Number(data.tune) || 0);
    if (input) {
        if (tune < parseFloat(input.min)) input.min = String(tune);
        if (tune > parseFloat(input.max)) input.max = String(tune);
        input.value = String(tune);
        refreshKnobDial(document.getElementById(stepDialId(row, step)), input, null);
    }
    if (valueEl) valueEl.textContent = String(berlinStepDisplayValue(pattern, step, row));

    const fine = cell.querySelector('.berlin-step-fine');
    const fineValue = cell.querySelector('.berlin-step-fine-value');
    const cents = Math.round(Number(data.fine) || 0);
    if (fine) {
        fine.step = berlinFineStepAttr();
        fine.value = String(cents);
    }
    if (fineValue) fineValue.textContent = formatBerlinCents(cents);

    const acc = cell.querySelector('.berlin-step-acc');
    const sld = cell.querySelector('.berlin-step-sld');
    const on = cell.querySelector('.berlin-step-on');
    const ratch = cell.querySelector('.berlin-step-ratch');
    acc?.classList.toggle('off', !data.accent);
    acc?.setAttribute('aria-pressed', data.accent ? 'true' : 'false');
    sld?.classList.toggle('off', !data.slide);
    sld?.setAttribute('aria-pressed', data.slide ? 'true' : 'false');
    const isOn = data.on !== false;
    if (on) {
        on.textContent = isOn ? 'On' : 'Off';
        on.classList.toggle('off', !isOn);
        on.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    syncRatchButton(ratch, data.ratch);
}

/** Repaint one lane step after an outside edit (Write mode). */
export function syncBerlinStep(row, step) {
    syncStepCell(row, step);
}

/** Lane name for the VFD: o1–o4, m1–m4. */
export function berlinLaneVfdLabel(row) {
    return isOscLane(row) ? `o${row + 1}` : `m${row - OSC_LANE_COUNT + 1}`;
}

/** Keep Berlin µtune sliders on the same Lock / Full step as the main strip. */
export function syncBerlinMicrotuneSteps() {
    const step = berlinFineStepAttr();
    document.querySelectorAll('.berlin-step-fine').forEach((slider) => {
        slider.step = step;
    });
}

/** Repaint step readouts after a scale, Amount or destination change. */
export function refreshBerlinStepReadouts(row) {
    if (row === undefined) {
        for (let i = 0; i < PATTERN_COUNT; i++) refreshBerlinStepReadouts(i);
        return;
    }
    const pattern = getBerlinLane(row);
    document.querySelectorAll(`.berlin-step[data-row="${row}"] .berlin-step-value`)
        .forEach((el) => {
            const step = parseInt(el.closest('.berlin-step').dataset.step, 10);
            el.textContent = String(berlinStepDisplayValue(pattern, step, row));
        });
}

function syncRowVisibleSteps(row) {
    const count = patternStepCount(getBerlinLane(row));
    document.querySelectorAll(`.berlin-step[data-row="${row}"]`).forEach((cell) => {
        const step = parseInt(cell.dataset.step, 10);
        cell.classList.toggle('hidden', step >= count);
    });
    const grid = document.querySelector(`.berlin-row[data-row="${row}"] .berlin-row-steps-grid`);
    if (grid) {
        grid.style.setProperty('--berlin-step-cols', String(Math.min(count, 16)));
        grid.style.setProperty('--berlin-step-cols-mobile', String(Math.min(count, 8)));
    }
}

function syncRowEnableUi(row, fieldset = document.querySelector(`.berlin-row[data-row="${row}"]`)) {
    if (!fieldset) return;
    const enabled = isRowEnabled(row);
    const solo = getSoloRow();
    const isSolo = solo === row;
    fieldset.classList.toggle('is-muted', !enabled);
    fieldset.classList.toggle('is-solo', isSolo);
    // Dim lanes Solo or the Write monitor silence (their own On/Off is untouched)
    fieldset.classList.toggle('is-solo-silenced', enabled && !isSolo && !isRowSounding(row));
    const btn = fieldset.querySelector('.berlin-row-enable');
    if (btn) {
        btn.classList.toggle('off', !enabled);
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    }
    const soloBtn = fieldset.querySelector('.berlin-row-solo');
    if (soloBtn) {
        soloBtn.classList.toggle('off', !isSolo);
        soloBtn.setAttribute('aria-pressed', isSolo ? 'true' : 'false');
    }
}

function syncAllRowEnableUi() {
    for (let i = 0; i < PATTERN_COUNT; i++) syncRowEnableUi(i);
}

/**
 * Mute / unmute a visible pattern. Playhead keeps running so re-enable lands
 * in phase; CV holds its last value. During Solo, On/Off is remembered only —
 * the soloed row stays audible until Solo is cleared.
 */
export function setRowEnabled(row, enabled) {
    const pattern = getBerlinLane(row);
    const next = !!enabled;
    const wasSounding = isRowSounding(row);
    if ((pattern.enabled !== false) === next) {
        syncRowEnableUi(row);
        return;
    }
    pattern.enabled = next;
    const ph = state.berlinPlayheads?.[row];
    if (ph && !next && getSoloRow() === null) {
        // Avoid a stale slide-in when the row comes back (Solo forces audible)
        ph.sounded = false;
        ph.prevSlide = false;
        ph.prevGliss = false;
    }
    syncRowEnableUi(row);
    refreshBerlinDots();
    if (wasSounding && !isRowSounding(row)) notifySoundingRowSilenced(row);
    refreshBerlinSounding();
}

/**
 * Exclusive Solo. Turning Solo on for a row clears any other Solo.
 * Turning it off restores the normal On/Off mix without mutating those flags.
 */
export function setRowSolo(row, on) {
    const next = Math.max(0, Math.min(PATTERN_COUNT - 1, row | 0));
    const prevSounding = new Set(
        berlinActiveRows().filter((i) => isPitchLane(i) && isRowSounding(i))
    );
    if (on) {
        state.berlinSoloRow = next;
        const ph = state.berlinPlayheads?.[next];
        if (ph) {
            ph.sounded = false;
            ph.prevSlide = false;
            ph.prevGliss = false;
        }
    } else if (state.berlinSoloRow === next) {
        state.berlinSoloRow = null;
    } else {
        syncAllRowEnableUi();
        return;
    }
    syncAllRowEnableUi();
    refreshBerlinDots();
    prevSounding.forEach((i) => {
        if (!isRowSounding(i)) notifySoundingRowSilenced(i);
    });
    refreshBerlinSounding();
}

export function clearBerlinSolo() {
    if (state.berlinSoloRow === null || state.berlinSoloRow === undefined) return;
    state.berlinSoloRow = null;
    syncAllRowEnableUi();
    refreshBerlinDots();
    refreshBerlinSounding();
}

export function syncBerlinRowUi(row) {
    const pattern = getBerlinLane(row);
    const fieldset = document.querySelector(`.berlin-row[data-row="${row}"]`);
    if (!fieldset) return;

    // Older bank loads may lack the flag — treat missing as On
    if (pattern.enabled === undefined) pattern.enabled = true;
    syncRowEnableUi(row, fieldset);

    const steps = fieldset.querySelector('.berlin-row-steps');
    const stepsValue = fieldset.querySelector('.berlin-row-steps-value');
    if (steps) steps.value = String(patternStepCount(pattern));
    if (stepsValue) stepsValue.textContent = String(patternStepCount(pattern));

    const div = fieldset.querySelector('.berlin-row-division');
    if (div) div.value = String(pattern.division);

    const midi = fieldset.querySelector('.berlin-row-midi');
    if (midi) midi.value = String(berlinLaneMidiChannels()[row] || 0);

    const rev = fieldset.querySelector('.berlin-row-rev');
    if (rev) {
        rev.classList.toggle('off', !pattern.reverse);
        rev.setAttribute('aria-pressed', pattern.reverse ? 'true' : 'false');
    }

    if (isOscLane(row)) {
        pattern.destination = OSC_DEST_BY_LANE[row];
        pattern.amount = 1;
    }

    const drum = isDrumLane(row);
    fieldset.classList.toggle('berlin-row-drum', drum);
    fieldset.classList.toggle('berlin-row-mod', !isOscLane(row) && !drum);
    fieldset.dataset.lane = isOscLane(row) ? 'osc' : (drum ? 'drum' : 'mod');
    const enableBtn = fieldset.querySelector('.berlin-row-enable');
    if (enableBtn) {
        const legend = rowLegend(row);
        enableBtn.textContent = legend;
        enableBtn.setAttribute('aria-label', `${legend} on or off`);
    }

    fieldset.querySelector('.berlin-ctl-dest')?.classList.toggle('berlin-ctl-hidden', isOscLane(row) || drum);
    fieldset.querySelector('.berlin-ctl-amount')?.classList.toggle('berlin-ctl-hidden', isOscLane(row) || drum);
    fieldset.querySelector('.berlin-ctl-gate')?.classList.toggle('berlin-ctl-hidden', !(isOscLane(row) || drum));

    const dest = fieldset.querySelector('.berlin-row-dest');
    if (dest) dest.value = pattern.destination;

    const amount = fieldset.querySelector('.berlin-row-amount');
    const amountValue = fieldset.querySelector('.berlin-row-amount-value');
    const pct = Math.round(clamp(Number(pattern.amount ?? 1), 0, 1) * 100);
    if (amount) amount.value = String(pct);
    if (amountValue) amountValue.textContent = String(pct);

    const gate = fieldset.querySelector('.berlin-row-gate');
    const gateValue = fieldset.querySelector('.berlin-row-gate-value');
    const gatePct = Math.round(patternGate(pattern) * 100);
    if (gate) gate.value = String(gatePct);
    if (gateValue) gateValue.textContent = String(gatePct);

    for (let s = 0; s < STEP_SLOTS; s++) syncStepCell(row, s);
    syncRowVisibleSteps(row);
}

export function syncBerlinUi() {
    ensureBank();
    ensureBerlinDrumKit();
    const oscCount = berlinOscCount();
    const modCount = berlinModCount();
    const active = new Set(berlinActiveRows());

    document.querySelectorAll('.berlin-row').forEach((el) => {
        if (el.classList.contains('keyboard-drum-row')) return;
        const row = parseInt(el.dataset.row, 10);
        el.classList.toggle('hidden', !active.has(row));
    });

    document.querySelectorAll('.berlin-count-btn').forEach((btn) => {
        const n = parseInt(btn.dataset.count, 10);
        const kind = btn.dataset.laneKind;
        btn.classList.remove('berlin-locked');
        const activeCount = kind === 'mod' ? modCount : oscCount;
        const on = n <= activeCount;
        btn.classList.toggle('off', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    const toggle = document.getElementById('berlinToggle');
    if (toggle) {
        toggle.classList.toggle('off', !state.berlinMode);
        toggle.classList.toggle('on', !!state.berlinMode);
        toggle.setAttribute('aria-pressed', state.berlinMode ? 'true' : 'false');
    }

    const panel = document.getElementById('berlinPanel');
    if (panel) panel.hidden = !state.berlinMode;

    document.body.classList.toggle('drum-mode', !!state.berlinDrumMode);
    document.body.classList.toggle('berlin-drum-mode', !!(state.berlinMode && state.berlinDrumMode));
    syncDrumBarUi();

    for (let row = 0; row < PATTERN_COUNT; row++) syncBerlinRowUi(row);
    refreshBerlinDots();
}

export function invalidateBerlinStepCache() {
    berlinStepCache = null;
}

function ensureBerlinStepCache() {
    if (berlinStepCache) return berlinStepCache;
    berlinStepCache = [];
    document.querySelectorAll('.berlin-step').forEach((el) => {
        const r = parseInt(el.dataset.row, 10);
        const s = parseInt(el.dataset.step, 10);
        if (!Number.isFinite(r) || !Number.isFinite(s)) return;
        if (!berlinStepCache[r]) berlinStepCache[r] = [];
        berlinStepCache[r][s] = el;
    });
    return berlinStepCache;
}

export function setBerlinStepActive(row, step) {
    const t0 = performance.now();
    const cache = ensureBerlinStepCache();
    const prev = berlinActiveStep[row];
    if (prev !== step) {
        if (prev != null) cache[row]?.[prev]?.classList.remove('active');
        if (step !== null && step !== undefined) {
            cache[row]?.[step]?.classList.add('active');
        }
        berlinActiveStep[row] = step;
    }
    const p = (window.__ingyProf ||= {});
    const ms = performance.now() - t0;
    if (ms > (p.domMax || 0)) p.domMax = ms;
    p.domN = (p.domN || 0) + 1;
}

export function clearBerlinStepActive() {
    const cache = ensureBerlinStepCache();
    for (let row = 0; row < berlinActiveStep.length; row++) {
        const step = berlinActiveStep[row];
        if (step != null) cache[row]?.[step]?.classList.remove('active');
    }
    berlinActiveStep.length = 0;
}

function wireRow(row) {
    const fieldset = document.querySelector(`.berlin-row[data-row="${row}"]`);
    if (!fieldset) return;
    // Live lookup: switching P1–P8 must edit the pattern now on screen, not the one wired at build time.
    const pattern = new Proxy({}, {
        get(_target, prop) {
            const lane = getBerlinLane(row);
            const value = lane[prop];
            return typeof value === 'function' ? value.bind(lane) : value;
        },
        set(_target, prop, value) {
            getBerlinLane(row)[prop] = value;
            return true;
        },
    });

    fieldset.querySelector('.berlin-row-enable')?.addEventListener('click', () => {
        setRowEnabled(row, !isRowEnabled(row));
    });

    fieldset.querySelector('.berlin-row-solo')?.addEventListener('click', () => {
        const soloed = getSoloRow() === row;
        setRowSolo(row, !soloed);
    });

    fieldset.querySelector('.berlin-row-copy')?.addEventListener('click', (e) => {
        copyBerlinLane(row);
        flashCopiedToast(e.currentTarget);
    });

    fieldset.querySelector('.berlin-row-paste')?.addEventListener('click', () => {
        if (!pasteBerlinLane(row)) return;
        const ph = state.berlinPlayheads?.[row];
        if (ph) {
            ph.currentStep = Math.min(ph.currentStep, patternStepCount(getBerlinLane(row)) - 1);
            ph.sounded = false;
            ph.prevSlide = false;
            ph.prevGliss = false;
        }
        syncBerlinRowUi(row);
    });

    fieldset.querySelector('.berlin-row-clear')?.addEventListener('click', () => {
        clearBerlinLane(row);
        const ph = state.berlinPlayheads?.[row];
        if (ph) {
            ph.sounded = false;
            ph.prevSlide = false;
            ph.prevGliss = false;
        }
        syncBerlinRowUi(row);
    });

    fieldset.querySelector('.berlin-row-steps')?.addEventListener('input', (e) => {
        pattern.stepCount = clamp(parseInt(e.target.value, 10) || 8, 1, STEP_SLOTS);
        const label = fieldset.querySelector('.berlin-row-steps-value');
        if (label) label.textContent = String(pattern.stepCount);
        const ph = state.berlinPlayheads?.[row];
        if (ph) ph.currentStep = Math.min(ph.currentStep, pattern.stepCount - 1);
        syncRowVisibleSteps(row);
    });

    fieldset.querySelector('.berlin-row-division')?.addEventListener('change', (e) => {
        pattern.division = parseInt(e.target.value, 10) || 8;
    });

    fieldset.querySelector('.berlin-row-midi')?.addEventListener('change', (e) => {
        setBerlinLaneMidiChannel(row, parseInt(e.target.value, 10) || 0);
    });

    fieldset.querySelector('.berlin-row-rev')?.addEventListener('click', (e) => {
        pattern.reverse = !pattern.reverse;
        e.currentTarget.classList.toggle('off', !pattern.reverse);
        e.currentTarget.setAttribute('aria-pressed', pattern.reverse ? 'true' : 'false');
    });

    fieldset.querySelector('.berlin-row-dest')?.addEventListener('change', (e) => {
        if (isOscLane(row) || isDrumLane(row)) {
            if (isOscLane(row)) {
                pattern.destination = OSC_DEST_BY_LANE[row];
                e.target.value = pattern.destination;
            }
            return;
        }
        pattern.destination = e.target.value;
        refreshBerlinDots();
        refreshBerlinStepReadouts(row);
    });

    fieldset.querySelector('.berlin-row-amount')?.addEventListener('input', (e) => {
        if (isOscLane(row) || isDrumLane(row)) return;
        const pct = clamp(parseInt(e.target.value, 10) || 0, 0, 100);
        pattern.amount = pct / 100;
        const label = fieldset.querySelector('.berlin-row-amount-value');
        if (label) label.textContent = String(pct);
        refreshBerlinStepReadouts(row);
    });

    fieldset.querySelector('.berlin-row-gate')?.addEventListener('input', (e) => {
        if (!isOscLane(row) && !isDrumLane(row)) return;
        const pct = clamp(parseInt(e.target.value, 10) || 90, 5, 100);
        pattern.gate = pct / 100;
        const label = fieldset.querySelector('.berlin-row-gate-value');
        if (label) label.textContent = String(pct);
    });

    for (let s = 0; s < STEP_SLOTS; s++) {
        const cell = fieldset.querySelector(`.berlin-step[data-step="${s}"]`);
        if (!cell) continue;
        const input = cell.querySelector('.berlin-step-tune');
        const dial = document.getElementById(stepDialId(row, s));
        const valueEl = cell.querySelector('.berlin-step-value');

        if (input && dial) {
            bindKnob(dial, input, null);
            input.addEventListener('input', () => {
                pattern.steps[s].tune = Math.round(parseFloat(input.value) || 0);
                if (valueEl) valueEl.textContent = String(berlinStepDisplayValue(pattern, s, row));
                previewBerlinOscStepNote(row, s);
            });
        }

        const fine = cell.querySelector('.berlin-step-fine');
        const fineValue = cell.querySelector('.berlin-step-fine-value');
        if (fine) {
            fine.addEventListener('input', () => {
                let cents = parseInt(fine.value, 10) || 0;
                if (state.microtuneLock) {
                    cents = snapBerlinCents(cents);
                    fine.value = String(cents);
                }
                pattern.steps[s].fine = cents;
                if (fineValue) fineValue.textContent = formatBerlinCents(cents);
                previewBerlinOscStepNote(row, s);
            });
        }

        cell.querySelector('.berlin-step-acc')?.addEventListener('click', (e) => {
            pattern.steps[s].accent = !pattern.steps[s].accent;
            e.currentTarget.classList.toggle('off', !pattern.steps[s].accent);
            e.currentTarget.setAttribute('aria-pressed', pattern.steps[s].accent ? 'true' : 'false');
        });
        cell.querySelector('.berlin-step-sld')?.addEventListener('click', (e) => {
            pattern.steps[s].slide = !pattern.steps[s].slide;
            e.currentTarget.classList.toggle('off', !pattern.steps[s].slide);
            e.currentTarget.setAttribute('aria-pressed', pattern.steps[s].slide ? 'true' : 'false');
        });
        cell.querySelector('.berlin-step-on')?.addEventListener('click', (e) => {
            const next = pattern.steps[s].on === false;
            pattern.steps[s].on = next;
            e.currentTarget.textContent = next ? 'On' : 'Off';
            e.currentTarget.classList.toggle('off', !next);
            e.currentTarget.setAttribute('aria-pressed', next ? 'true' : 'false');
        });
        cell.querySelector('.berlin-step-ratch')?.addEventListener('click', (e) => {
            if (state.acidMode) return;
            const next = nextRatch(pattern.steps[s].ratch);
            pattern.steps[s].ratch = next;
            syncRatchButton(e.currentTarget, next);
        });
    }
}

function formatDrumTone(v) {
    return (Math.max(0, Math.min(1, Number(v) || 0))).toFixed(2);
}

function drumToneLabels(model, analog = false) {
    if (analog) return ANALOG_TONE_LABELS[model] || ANALOG_TONE_LABELS.hihat;
    return DRUM_TONE_LABELS[model] || DRUM_TONE_LABELS.hihat;
}

function drumLaneFieldset(lane) {
    return document.querySelector(`.keyboard-drum-row[data-drum-lane="${clampDrumLane(lane)}"]`);
}

function writeDrumPatch(lane, partial) {
    ensureBerlinDrumKit();
    const i = clampDrumLane(lane);
    const prev = state.berlinDrum[i];
    const next = clampDrumPatch({ ...prev, ...partial }, i);
    if (prev.engine !== next.engine || prev.model !== next.model) {
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-drum-muted', {
            detail: { row: null, lane: i },
        }));
    }
    state.berlinDrum[i] = next;
    if (prev.engine !== next.engine) routeBerlinDrumPanners();
    if (next.engine === 'plaits' && state.audioContext) ensurePlaitsWorklet(state.audioContext);
    applyBerlinDrumKitToLive(i);
    const fieldset = drumLaneFieldset(i);
    if (fieldset) {
        ensureDrumChrome(fieldset, i);
        syncDrumChrome(fieldset, i);
    }
    document.dispatchEvent(new CustomEvent('ingysynth:drum-kit', { detail: { lane: i } }));
}

function ensureDrumBar() {}

function syncDrumBarUi() {
    const toggle = document.getElementById('kbDrumMode');
    if (toggle) {
        const on = !!state.berlinDrumMode;
        toggle.classList.toggle('off', !on);
        toggle.classList.toggle('on', on);
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const filt = document.getElementById('kbDrumFilt');
    if (filt) {
        const on = !!state.berlinDrumFilt;
        const drumOn = !!state.berlinDrumMode;
        filt.hidden = !drumOn;
        filt.disabled = !drumOn;
        filt.classList.toggle('off', !on);
        filt.classList.toggle('on', on);
        filt.classList.toggle('is-grey', !drumOn);
        filt.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const hide = document.getElementById('kbDrumHide');
    if (hide) {
        const drumOn = !!state.berlinDrumMode;
        const lanesHidden = !!state.berlinDrumLanesHidden;
        hide.hidden = !drumOn;
        hide.disabled = !drumOn;
        hide.classList.toggle('off', !lanesHidden);
        hide.classList.toggle('on', lanesHidden);
        hide.setAttribute('aria-pressed', lanesHidden ? 'true' : 'false');
        hide.textContent = lanesHidden ? 'Hidden' : 'Hide';
    }
    const lanes = document.getElementById('keyboardDrumLanes');
    if (lanes) lanes.hidden = !state.berlinDrumMode || !!state.berlinDrumLanesHidden;
    document.body.classList.toggle('drum-mode', !!state.berlinDrumMode);
}

function ensureDrumChrome(fieldset, lane) {
    if (!fieldset || fieldset.querySelector('.berlin-drum-toolbar')) return;
    lane = clampDrumLane(lane);
    const controls = fieldset.querySelector('.berlin-row-controls');
    if (!controls) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'berlin-drum-toolbar';
    const modelOpts = DRUM_MODELS.map((m) => (
        `<option value="${m}">${DRUM_MODEL_LABELS[m]}</option>`
    )).join('');
    toolbar.innerHTML = `
        <div class="berlin-drum-engine-switch" role="group" aria-label="DRM ${lane + 1} engine">
            <button type="button" class="ingy6-switch-btn berlin-drum-engine-btn" data-engine="analog"
                    aria-pressed="true">ANALOG</button>
            <button type="button" class="ingy6-switch-btn berlin-drum-engine-btn off" data-engine="digital"
                    aria-pressed="false">DIGITAL</button>
        </div>
        <label class="berlin-ctl berlin-drum-model-ctl">
            <span class="berlin-ctl-label">MODEL</span>
            <select class="berlin-drum-model">${modelOpts}</select>
        </label>
        <button type="button" class="ingy6-switch-btn berlin-drum-choke off" aria-pressed="false">Choke</button>
        <div class="berlin-drum-tones">
            ${['tune', 'harmonics', 'timbre', 'morph'].map((tone) => `
                <div class="synth-knob berlin-drum-knob" data-drum-tone="${tone}">
                    <span class="synth-knob-label berlin-drum-tone-label">${tone === 'tune' ? 'TUNE' : tone}</span>
                    <div class="synth-knob-dial-wrap">
                        <div class="synth-knob-dial berlin-drum-dial" role="slider"
                             aria-valuemin="0" aria-valuemax="1" tabindex="0">
                            <span class="synth-knob-indicator"></span>
                        </div>
                    </div>
                    <span class="synth-knob-value berlin-drum-tone-value">0.50</span>
                    <input type="range" class="berlin-drum-tone-input" min="0" max="1" step="0.01" value="0.5"
                           aria-hidden="true" tabindex="-1">
                </div>
            `).join('')}
        </div>
        <div class="berlin-drum-switches" role="group" aria-label="ALT and MODE">
            <button type="button" class="ingy6-switch-btn berlin-drum-alt off" aria-pressed="false">ALT</button>
            <button type="button" class="ingy6-switch-btn berlin-drum-mode-btn" aria-pressed="true">HIT</button>
        </div>
        <label class="berlin-ctl">
            <span class="berlin-ctl-label">VOL</span>
            <input type="range" class="berlin-drum-vol keyboard-master-tune-slider" min="0" max="100" value="80" step="1">
            <span class="berlin-ctl-value berlin-drum-vol-value">80</span>
        </label>
        <label class="berlin-ctl">
            <span class="berlin-ctl-label">PAN</span>
            <input type="range" class="berlin-drum-pan keyboard-master-tune-slider" min="-100" max="100" value="0" step="1">
            <span class="berlin-ctl-value berlin-drum-pan-value">0</span>
        </label>
    `;
    // Gate/STEPS toolbar stays first; drum tone bar sits under it
    controls.after(toolbar);

    toolbar.querySelectorAll('.berlin-drum-knob').forEach((knob) => {
        const dial = knob.querySelector('.berlin-drum-dial');
        const input = knob.querySelector('.berlin-drum-tone-input');
        const valueEl = knob.querySelector('.berlin-drum-tone-value');
        if (dial && input) bindKnob(dial, input, valueEl);
        input?.addEventListener('input', () => {
            if (knob.classList.contains('is-disabled')) return;
            const tone = knob.dataset.drumTone;
            const v = clamp(parseFloat(input.value) || 0, 0, 1);
            if (tone === 'tune') writeDrumPatch(lane, { tune: v });
            else if (tone === 'harmonics') writeDrumPatch(lane, { harmonics: v });
            else if (tone === 'timbre') writeDrumPatch(lane, { morphX: v });
            else writeDrumPatch(lane, { morphY: v });
        });
    });

    toolbar.querySelectorAll('.berlin-drum-engine-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            writeDrumPatch(lane, {
                engine: btn.dataset.engine === 'digital' ? 'plaits' : 'analog',
            });
        });
    });
    toolbar.querySelector('.berlin-drum-model')?.addEventListener('change', (e) => {
        writeDrumPatch(lane, { model: e.target.value });
    });
    toolbar.querySelector('.berlin-drum-choke')?.addEventListener('click', () => {
        const patch = ensureBerlinDrumKit()[lane];
        if (patch.model !== 'open_hat') return;
        writeDrumPatch(lane, { choke: patch.choke === false });
    });
    toolbar.querySelector('.berlin-drum-alt')?.addEventListener('click', () => {
        const patch = ensureBerlinDrumKit()[lane];
        writeDrumPatch(lane, { alt: !patch.alt });
    });
    toolbar.querySelector('.berlin-drum-mode-btn')?.addEventListener('click', () => {
        const patch = ensureBerlinDrumKit()[lane];
        if (patch.model !== 'bass_drum') return;
        writeDrumPatch(lane, { trigPatched: !patch.trigPatched });
    });
    toolbar.querySelector('.berlin-drum-vol')?.addEventListener('input', (e) => {
        writeDrumPatch(lane, { vol: clamp(parseInt(e.target.value, 10) || 0, 0, 100) / 100 });
    });
    toolbar.querySelector('.berlin-drum-pan')?.addEventListener('input', (e) => {
        writeDrumPatch(lane, { pan: clamp(parseInt(e.target.value, 10) || 0, -100, 100) / 100 });
    });
}

function setDrumKnobDisabled(knob, off) {
    const dial = knob?.querySelector('.berlin-drum-dial');
    const input = knob?.querySelector('.berlin-drum-tone-input');
    if (dial) {
        if (off) dial.setAttribute('aria-disabled', 'true');
        else dial.removeAttribute('aria-disabled');
        dial.tabIndex = off ? -1 : 0;
    }
    if (input) input.disabled = !!off;
    knob?.classList.toggle('is-disabled', !!off);
}

function syncDrumChrome(fieldset, lane) {
    const toolbar = fieldset?.querySelector('.berlin-drum-toolbar');
    if (!toolbar) return;
    toolbar.hidden = false;
    ensureBerlinDrumKit();
    lane = clampDrumLane(lane);
    const patch = state.berlinDrum[lane];
    const analog = isAnalogDrumEngine(patch);
    toolbar.classList.toggle('is-analog', analog);
    toolbar.querySelectorAll('.berlin-drum-engine-btn').forEach((btn) => {
        const digi = btn.dataset.engine === 'digital';
        const active = digi ? !analog : analog;
        btn.classList.toggle('off', !active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.title = digi ? 'Digital Plaits' : 'Analog 808';
    });
    const model = toolbar.querySelector('.berlin-drum-model');
    if (model) model.value = patch.model;
    const labels = drumToneLabels(patch.model, analog);
    const toneMap = {
        tune: patch.tune,
        harmonics: patch.harmonics,
        timbre: patch.morphX,
        morph: patch.morphY,
    };
    const greyHarmonics = analog && patch.model !== 'snare';
    toolbar.querySelectorAll('.berlin-drum-knob').forEach((knob) => {
        const tone = knob.dataset.drumTone;
        const labelEl = knob.querySelector('.berlin-drum-tone-label');
        const input = knob.querySelector('.berlin-drum-tone-input');
        const valueEl = knob.querySelector('.berlin-drum-tone-value');
        const dial = knob.querySelector('.berlin-drum-dial');
        if (labelEl) labelEl.textContent = labels[tone] || tone;
        const v = toneMap[tone] ?? 0.5;
        if (input) input.value = String(v);
        if (dial) {
            refreshKnobDial(dial, input, valueEl);
            dial.setAttribute('aria-label', labels[tone] || tone);
        } else if (valueEl) {
            valueEl.textContent = formatDrumTone(v);
        }
        if (tone === 'tune') knob.style.order = '0';
        else if (analog && patch.model === 'snare') {
            knob.style.order = ({ timbre: 1, harmonics: 2, morph: 3 }[tone] || 4).toString();
        } else if (analog) {
            knob.style.order = ({ timbre: 1, morph: 2, harmonics: 3 }[tone] || 4).toString();
        } else {
            knob.style.order = ({ harmonics: 1, timbre: 2, morph: 3 }[tone] || 4).toString();
        }
        setDrumKnobDisabled(knob, tone === 'harmonics' && greyHarmonics);
    });
    const altBtn = toolbar.querySelector('.berlin-drum-alt');
    if (altBtn) {
        altBtn.classList.toggle('off', !patch.alt);
        altBtn.setAttribute('aria-pressed', patch.alt ? 'true' : 'false');
    }
    const chokeBtn = toolbar.querySelector('.berlin-drum-choke');
    if (chokeBtn) {
        const chokeLive = patch.model === 'open_hat';
        const chokeOn = chokeLive && patch.choke !== false;
        chokeBtn.disabled = !chokeLive;
        chokeBtn.classList.toggle('is-grey', !chokeLive);
        chokeBtn.classList.toggle('off', !chokeOn);
        chokeBtn.setAttribute('aria-pressed', chokeOn ? 'true' : 'false');
        chokeBtn.title = chokeLive
            ? (chokeOn
                ? 'Choke on — closed hat cuts this open hat, and this open hat cuts the closed hat'
                : 'Choke off — open hat rings through the closed hat')
            : 'Choke is for the open hat';
    }
    const modeBtn = toolbar.querySelector('.berlin-drum-mode-btn');
    if (modeBtn) {
        const modeActive = !analog && patch.model === 'bass_drum';
        const mode2 = patch.trigPatched !== false;
        modeBtn.disabled = !modeActive;
        modeBtn.classList.toggle('is-grey', !modeActive);
        modeBtn.classList.toggle('off', !mode2);
        modeBtn.setAttribute('aria-pressed', modeActive && mode2 ? 'true' : 'false');
        modeBtn.textContent = mode2 ? DRUM_MODE_LABELS.m2 : DRUM_MODE_LABELS.m1;
        modeBtn.title = modeActive
            ? (mode2 ? 'MODE 2 — HIT (TRIG patched)' : 'MODE 1 — DRONE')
            : 'MODE unavailable for this model';
    }
    const vol = toolbar.querySelector('.berlin-drum-vol');
    const volVal = toolbar.querySelector('.berlin-drum-vol-value');
    if (vol) vol.value = String(Math.round(patch.vol * 100));
    if (volVal) volVal.textContent = String(Math.round(patch.vol * 100));
    const pan = toolbar.querySelector('.berlin-drum-pan');
    const panVal = toolbar.querySelector('.berlin-drum-pan-value');
    if (pan) pan.value = String(Math.round(patch.pan * 100));
    if (panVal) panVal.textContent = String(Math.round(patch.pan * 100));
}

export function setDrumMode(on) {
    const next = !!on;
    ensureBank();
    ensureBerlinDrumKit();
    if (state.berlinDrumMode === next) {
        syncDrumBarUi();
        return;
    }
    if (next) {
        if (state.audioContext) {
            ensurePlaitsWorklet(state.audioContext);
            routeBerlinDrumPanners();
        }
    } else {
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-drum-muted', {
            detail: { row: null, lane: null, all: true },
        }));
    }
    state.berlinDrumMode = next;
    if (get('drumModeToggle') !== next) set('drumModeToggle', next);
    syncBerlinUi();
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-drum-mode', {
        detail: { on: next },
    }));
}

export const setBerlinDrumMode = setDrumMode;

export function setBerlinDrumFilt(on) {
    let next = !!on;
    if (next && (state.keyboardPoly || state.keyboardMultitudes)) {
        next = false;
    }
    state.berlinDrumFilt = next;
    if (get('drumFiltToggle') !== next) set('drumFiltToggle', next);
    routeBerlinDrumPanners();
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-drum-filt', {
        detail: { on: state.berlinDrumFilt },
    }));
    syncDrumBarUi();
}

/** Hide D-lane UI only. Drum Mode and audio stay on. */
export function setDrumLanesHidden(on) {
    state.berlinDrumLanesHidden = !!on;
    syncDrumBarUi();
}

export function attachDrumChrome(fieldset, lane) {
    ensureDrumChrome(fieldset, lane);
    syncDrumChrome(fieldset, lane);
}

function buildUi() {
    if (uiBuilt) return;
    const rows = document.getElementById('berlinRows');
    if (!rows) return;
    ensureBank();
    rows.innerHTML = '';
    invalidateBerlinStepCache();
    for (let row = 0; row < PATTERN_COUNT; row++) {
        rows.appendChild(buildRow(row));
    }
    ensureBerlinStepCache();
    for (let row = 0; row < PATTERN_COUNT; row++) wireRow(row);
    ensureDrumBar();
    uiBuilt = true;
    syncPatternClipboardUi();
}

// --- Mode switching --------------------------------------------------------

/** Pre-Berlin master GATE (%); restored on exit so normal steps keep their value. */
let stashedMasterGatePct = null;

function readMasterGatePct() {
    const v = getNumber('gateLength', 90);
    return Math.max(5, Math.min(100, Number.isFinite(v) ? v : 90));
}

/** Drive main GATE so the Steps mirror (`kbGateLength`) stays in sync. */
function setMasterGatePct(pct) {
    set('gateLength', Math.max(5, Math.min(100, Math.round(pct))));
}

function applyBerlinMasterGateEnter() {
    stashedMasterGatePct = readMasterGatePct();
    setMasterGatePct(100);
}

function applyBerlinMasterGateExit() {
    if (stashedMasterGatePct == null) return;
    setMasterGatePct(stashedMasterGatePct);
    stashedMasterGatePct = null;
}

// Each O lane plays its own oscillator, so going into Berlin switches all four on.
// Leaving puts the switches back as they were before. A loaded project sets the mode
// with its own switches, so neither step runs for it (`fromDocument`).
let stashedOscToggles = null;

function applyBerlinOscsEnter() {
    stashedOscToggles = [0, 1, 2, 3].map((i) => !!get(`osc-toggle-${i}`));
    for (let i = 0; i < 4; i++) set(`osc-toggle-${i}`, true);
}

function applyBerlinOscsExit() {
    if (!stashedOscToggles) return;
    stashedOscToggles.forEach((on, i) => set(`osc-toggle-${i}`, on));
    stashedOscToggles = null;
}

/** Controls that make no sense while Berlin lanes drive the voice in parallel.
 *  Acid stays clickable so it can take the voice back (same mutex as Berlin-from-Acid).
 *  Main Rev / DIV are per-lane in Berlin — grey them out on the transport. */
function setBerlinLockedUi(on) {
    document.body.classList.toggle('berlin-mode', !!on);
    [
        'kbRev',
        'patternShiftBack',
        'patternShiftForward',
        'kbPatternShiftBack',
        'kbPatternShiftForward',
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        // Class-only lock: `disabled` belongs to whichever module owns the button.
        el.classList.toggle('berlin-locked', !!on);
        if (on) el.setAttribute('aria-disabled', 'true');
        else if (!el.disabled) el.removeAttribute('aria-disabled');
    });

    // DIV + STEPS knobs — lanes own length/division
    [
        ['division', 'kbDivisionKnob'],
        ['steps', 'kbStepsKnob'],
    ].forEach(([param, dialId]) => {
        document.querySelector(
            `.keyboard-transport-fieldset .synth-knob[data-param="${param}"]`
        )?.classList.toggle('berlin-locked', !!on);
        const dial = document.getElementById(dialId);
        if (!dial) return;
        if (on) dial.setAttribute('aria-disabled', 'true');
        else dial.removeAttribute('aria-disabled');
    });
}

export function setBerlinMode(on, { fromDocument = false } = {}) {
    const next = !!on;
    if (state.berlinMode === next) {
        syncBerlinUi();
        return;
    }

    if (next) {
        // Acid and Poly own the voice in ways Berlin lanes cannot share.
        forceAcidOffForPoly();
        if (state.keyboardPoly) setPolyMode(false);
        if (state.keyboardMultitudes) setMultitudesMode(false);
        bumpSeqEngine();
        // The single strip is a view of the edit slot — bank it before hiding.
        flushDomToPattern(state.editSlot);
        state.pendingEditSlot = null;
        state.berlinPendingSlot = null;
        state.berlinCyclePass = 0;
        state.berlinCycleFirstPass = true;
        state.berlinMode = true;
        ensureBank();
        ensureBerlinBank();
        // Once per load: P1–P8 land on each Berlin pattern's O1 before the rows paint.
        if (seedBerlinO1FromMain()) {
            state.berlinSlot = Math.max(0, Math.min(BANK_COUNT - 1, state.editSlot | 0));
            const shown = getBerlinPattern(state.berlinSlot);
            state.berlinOscCount = shown.oscCount;
            state.berlinModCount = shown.modCount;
        }
        ensurePlayheads();
        resetBerlinPlayheads(state.audioContext ? state.audioContext.currentTime : 0);
        buildUi();
        if (state.berlinDrumMode && state.audioContext) {
            ensurePlaitsWorklet(state.audioContext);
            routeBerlinDrumPanners();
        }
        setBerlinLockedUi(true);
        // Master GATE at 100% = unity over per-lane gates (stash for exit)
        applyBerlinMasterGateEnter();
        if (fromDocument) stashedOscToggles = null;
        else applyBerlinOscsEnter();
    } else {
        bumpSeqEngine();
        state.berlinMode = false;
        state.berlinSoloRow = null;
        state.berlinPendingSlot = null;
        state.cyclePass = 0;
        state.cycleFirstPass = true;
        setBerlinLockedUi(false);
        clearBerlinStepActive();
        applyBerlinMasterGateExit();
        if (fromDocument) stashedOscToggles = null;
        else applyBerlinOscsExit();
        // Normal bank is P1–P8
        if (state.editSlot >= BANK_COUNT) state.editSlot = 0;
        hydratePatternToDom(state.editSlot);
        // The single-row clock stood still while Berlin ran — rejoin it now
        if (state.isPlaying && state.audioContext) {
            const pattern = getPattern(state.editSlot);
            state.currentStep = pattern.reverse ? patternStepCount(pattern) - 1 : 0;
            state.nextStepTime = state.audioContext.currentTime + 0.05;
        }
    }

    syncBerlinUi();
    refreshBerlinSounding();
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-mode', {
        detail: { on: state.berlinMode },
    }));
}

export function toggleBerlinMode() {
    setBerlinMode(!state.berlinMode);
}

export function setBerlinOscCount(count) {
    const next = clamp(Math.round(count) || 3, 1, OSC_LANE_COUNT);
    const pattern = getBerlinPattern(state.berlinSlot);
    if (pattern.oscCount === next) {
        syncBerlinUi();
        return;
    }
    const prevSounding = new Set(
        berlinActiveRows().filter((i) => isOscLane(i) && isRowSounding(i))
    );
    pattern.oscCount = next;
    state.berlinOscCount = next;
    if (state.berlinSoloRow !== null && isOscLane(state.berlinSoloRow)
        && state.berlinSoloRow >= next) {
        state.berlinSoloRow = null;
    }
    syncBerlinUi();
    prevSounding.forEach((i) => {
        if (i >= next || !isRowSounding(i)) notifySoundingRowSilenced(i);
    });
    refreshBerlinSounding();
}

export function setBerlinModCount(count) {
    const next = clamp(Math.round(count) || 1, 1, OSC_LANE_COUNT);
    const pattern = getBerlinPattern(state.berlinSlot);
    if (pattern.modCount === next) {
        syncBerlinUi();
        return;
    }
    pattern.modCount = next;
    state.berlinModCount = next;
    if (state.berlinSoloRow !== null && isModLane(state.berlinSoloRow)
        && (state.berlinSoloRow - OSC_LANE_COUNT) >= next) {
        state.berlinSoloRow = null;
    }
    syncBerlinUi();
    refreshBerlinSounding();
}

export function initBerlin() {
    ensureBank();
    ensureBerlinBank();
    ensurePlayheads();

    document.addEventListener('ingysynth:berlin-slot', (e) => {
        syncBerlinUi();
        refreshBerlinSounding();
        if (!state.isPlaying || !state.audioContext) return;
        // Paste / Clear refresh the rows without a start time and must not
        // jump the running lanes back to step 1. A real P1–P8 switch passes one.
        const t = Number(e.detail?.startTime);
        if (!Number.isFinite(t)) return;
        resetBerlinPlayheads(t);
    });

    document.getElementById('berlinToggle')?.addEventListener('click', () => {
        toggleBerlinMode();
    });

    document.querySelectorAll('.berlin-count-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const n = parseInt(btn.dataset.count, 10);
            if (btn.dataset.laneKind === 'mod') {
                setBerlinModCount(n);
            } else setBerlinOscCount(n);
        });
    });

    // Acid / Poly grab the voice back — Berlin steps aside.
    document.addEventListener('ingysynth:exit-berlin', () => {
        if (state.berlinMode) setBerlinMode(false);
    });

    syncBerlinUi();
}

// pattern-write.js reaches these through berlin-hooks.js (no import cycle)
Object.assign(berlinHooks, {
    isBerlinOn,
    berlinActiveRows,
    syncBerlinStep,
    berlinLaneVfdLabel,
    refreshBerlinSounding,
});
