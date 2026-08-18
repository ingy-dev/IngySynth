// Berlin Dream-960: eight lanes on one tempo — O1–O4 pitch+amp, M1–M4 filter CV.
// Acid and Poly are mutually exclusive with it.

import { state } from './state.js?v=114';
import { BASE_FREQ, getGlobalTune, getActiveScale, quantizeToScale } from './tuning.js?v=79';
import { updateNoteVisualizer, clearNoteVisualizer } from './visualizers.js?v=100';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=82';
import { setPolyMode } from './poly-voice.js?v=68';
import { setMultitudesMode } from './keyboard-multitudes-panel.js?v=28';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=15';
import { bindKnob, refreshKnobDial } from './knobs.js?v=121';
import { setBerlinDots, refreshParamStatusIndicators } from './param-status.js?v=7';
import { getNumber, set } from './params.js?v=13';
import {
    PATTERN_COUNT,
    BANK_COUNT,
    STEP_SLOTS,
    DESTINATIONS,
    OSC_LANE_COUNT,
    isOscLane,
    isModLane,
    ensureBank,
    getPattern,
    patternStepCount,
    patternGate,
    flushDomToPattern,
    hydratePatternToDom,
    copyPatternContent,
    pastePatternContent,
    clearPatternSteps,
    flashCopiedToast,
    syncPatternClipboardUi,
} from './pattern-bank.js?v=12';
import { clampRatch, nextRatch, syncRatchButton } from './step-ratch.js?v=1';

/** Warm phosphor (O1–O4) then blue→white (M1–M4). */
export const BERLIN_COLORS = [
    '#FF2A2A', '#FF7A18', '#FFC107', '#C8F000',
    '#1E6BFF', '#4DA3FF', '#A8D4FF', '#E8F2FF',
];

const MOD_DESTINATIONS = DESTINATIONS.filter((d) => (
    d.id === 'cutoff' || d.id === 'resonance' || d.id === 'highpass' || d.id === 'off'
));

const OSC_DEST_BY_LANE = ['osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch'];

export { isOscLane, isModLane, patternGate };

const DIVISIONS = [
    { value: 2, label: '1/2' },
    { value: 4, label: '1/4' },
    { value: 8, label: '1/8' },
    { value: 16, label: '1/16' },
];

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
    return clamp(Math.round(state.berlinOscCount) || 3, 1, OSC_LANE_COUNT);
}

export function berlinModCount() {
    return clamp(Math.round(state.berlinModCount) || 1, 1, OSC_LANE_COUNT);
}

/** Total visible lanes (osc + mod). */
export function berlinActiveCount() {
    return berlinOscCount() + berlinModCount();
}

/** Row indexes that are live right now (visible OSC/MOD sets — mute is separate). */
export function berlinActiveRows() {
    const osc = berlinOscCount();
    const mod = berlinModCount();
    const rows = [];
    for (let i = 0; i < osc; i++) rows.push(i);
    for (let i = 0; i < mod; i++) rows.push(OSC_LANE_COUNT + i);
    return rows;
}

/** Output mute: pattern stays visible/editable; playhead keeps phase. */
export function isRowEnabled(rowIndex) {
    const pattern = getPattern(rowIndex);
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
        const secs = rowLoopSeconds(getPattern(i), tempo);
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

/** Notify sequencer to release independent voices for an osc lane that went silent. */
function notifyOscLaneSilenced(row) {
    if (!isOscLane(row)) return;
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-osc-muted', {
        detail: { row, oscIndex: row },
    }));
}

/** Osc lane index → that oscillator; mod lanes have no pitch target. */
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
        const pattern = getPattern(i);
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

export function advancePlayhead(rowIndex) {
    const pattern = getPattern(rowIndex);
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
export function berlinFrequency(semi, fine, oscIndex) {
    const total = berlinPitchSemitones(semi)
        + getGlobalTune()
        + (state.keyboardTranspose || 0)
        + (state.oscTunes?.[oscIndex] || 0)
        + (fine || 0) / 100;
    return BASE_FREQ * Math.pow(2, total / 12);
}

/**
 * Preview an oscillator-lane step on the note VFD while editing tune/µtune.
 * Mod lanes and Berlin playback do not drive the VFD.
 */
function previewBerlinOscStepNote(row, stepIndex) {
    if (!isOscLane(row)) return;
    const { semi, fine } = rowStepValue(getPattern(row), stepIndex, row);
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
    const osc = rowIndex !== null ? isOscLane(rowIndex) : PITCH_DESTINATIONS[pattern.destination] !== undefined;
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
        ? isOscLane(rowIndex)
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
        if (!isRowSounding(i)) return;
        const key = DOT_HOST_KEYS[getPattern(i).destination];
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
    return isOscLane(row) ? `O${row + 1}` : `M${row - OSC_LANE_COUNT + 1}`;
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
                </label>
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
    const pattern = getPattern(row);
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
    const pattern = getPattern(row);
    document.querySelectorAll(`.berlin-step[data-row="${row}"] .berlin-step-value`)
        .forEach((el) => {
            const step = parseInt(el.closest('.berlin-step').dataset.step, 10);
            el.textContent = String(berlinStepDisplayValue(pattern, step, row));
        });
}

function syncRowVisibleSteps(row) {
    const count = patternStepCount(getPattern(row));
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
    fieldset.classList.toggle('is-solo-silenced', solo !== null && !isSolo);
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
    const pattern = getPattern(row);
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
    if (wasSounding && !isRowSounding(row)) notifyOscLaneSilenced(row);
}

/**
 * Exclusive Solo. Turning Solo on for a row clears any other Solo.
 * Turning it off restores the normal On/Off mix without mutating those flags.
 */
export function setRowSolo(row, on) {
    const next = Math.max(0, Math.min(PATTERN_COUNT - 1, row | 0));
    const prevSounding = new Set(
        berlinActiveRows().filter((i) => isOscLane(i) && isRowSounding(i))
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
        if (!isRowSounding(i)) notifyOscLaneSilenced(i);
    });
}

export function clearBerlinSolo() {
    if (state.berlinSoloRow === null || state.berlinSoloRow === undefined) return;
    state.berlinSoloRow = null;
    syncAllRowEnableUi();
    refreshBerlinDots();
}

export function syncBerlinRowUi(row) {
    const pattern = getPattern(row);
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

    const rev = fieldset.querySelector('.berlin-row-rev');
    if (rev) {
        rev.classList.toggle('off', !pattern.reverse);
        rev.setAttribute('aria-pressed', pattern.reverse ? 'true' : 'false');
    }

    if (isOscLane(row)) {
        pattern.destination = OSC_DEST_BY_LANE[row];
        pattern.amount = 1;
    }

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
    const oscCount = berlinOscCount();
    const modCount = berlinModCount();

    document.querySelectorAll('.berlin-row').forEach((el) => {
        const row = parseInt(el.dataset.row, 10);
        const hidden = isOscLane(row)
            ? row >= oscCount
            : (row - OSC_LANE_COUNT) >= modCount;
        el.classList.toggle('hidden', hidden);
    });

    document.querySelectorAll('.berlin-count-btn').forEach((btn) => {
        const n = parseInt(btn.dataset.count, 10);
        const kind = btn.dataset.laneKind;
        const active = kind === 'mod' ? modCount : oscCount;
        const on = n <= active;
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

    for (let row = 0; row < PATTERN_COUNT; row++) syncBerlinRowUi(row);
    refreshBerlinDots();
}

export function setBerlinStepActive(row, step) {
    document.querySelectorAll(`.berlin-step[data-row="${row}"].active`)
        .forEach((el) => el.classList.remove('active'));
    if (step === null || step === undefined) return;
    document.querySelector(`.berlin-step[data-row="${row}"][data-step="${step}"]`)
        ?.classList.add('active');
}

export function clearBerlinStepActive() {
    document.querySelectorAll('.berlin-step.active').forEach((el) => el.classList.remove('active'));
}

function wireRow(row) {
    const fieldset = document.querySelector(`.berlin-row[data-row="${row}"]`);
    if (!fieldset) return;
    const pattern = getPattern(row);

    fieldset.querySelector('.berlin-row-enable')?.addEventListener('click', () => {
        setRowEnabled(row, !isRowEnabled(row));
    });

    fieldset.querySelector('.berlin-row-solo')?.addEventListener('click', () => {
        const soloed = getSoloRow() === row;
        setRowSolo(row, !soloed);
    });

    fieldset.querySelector('.berlin-row-copy')?.addEventListener('click', (e) => {
        copyPatternContent(row);
        flashCopiedToast(e.currentTarget);
    });

    fieldset.querySelector('.berlin-row-paste')?.addEventListener('click', () => {
        if (!pastePatternContent(row)) return;
        const ph = state.berlinPlayheads?.[row];
        if (ph) {
            ph.currentStep = Math.min(ph.currentStep, patternStepCount(getPattern(row)) - 1);
            ph.sounded = false;
            ph.prevSlide = false;
            ph.prevGliss = false;
        }
        syncBerlinRowUi(row);
    });

    fieldset.querySelector('.berlin-row-clear')?.addEventListener('click', () => {
        clearPatternSteps(row);
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

    fieldset.querySelector('.berlin-row-rev')?.addEventListener('click', (e) => {
        pattern.reverse = !pattern.reverse;
        e.currentTarget.classList.toggle('off', !pattern.reverse);
        e.currentTarget.setAttribute('aria-pressed', pattern.reverse ? 'true' : 'false');
    });

    fieldset.querySelector('.berlin-row-dest')?.addEventListener('change', (e) => {
        if (isOscLane(row)) {
            pattern.destination = OSC_DEST_BY_LANE[row];
            e.target.value = pattern.destination;
            return;
        }
        pattern.destination = e.target.value;
        refreshBerlinDots();
        refreshBerlinStepReadouts(row);
    });

    fieldset.querySelector('.berlin-row-amount')?.addEventListener('input', (e) => {
        if (isOscLane(row)) return;
        const pct = clamp(parseInt(e.target.value, 10) || 0, 0, 100);
        pattern.amount = pct / 100;
        const label = fieldset.querySelector('.berlin-row-amount-value');
        if (label) label.textContent = String(pct);
        refreshBerlinStepReadouts(row);
    });

    fieldset.querySelector('.berlin-row-gate')?.addEventListener('input', (e) => {
        if (!isOscLane(row)) return;
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

function buildUi() {
    if (uiBuilt) return;
    const rows = document.getElementById('berlinRows');
    if (!rows) return;
    ensureBank();
    rows.innerHTML = '';
    for (let row = 0; row < PATTERN_COUNT; row++) {
        rows.appendChild(buildRow(row));
    }
    for (let row = 0; row < PATTERN_COUNT; row++) wireRow(row);
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

/** Controls that make no sense while Berlin lanes drive the voice in parallel.
 *  Acid stays clickable so it can take the voice back (same mutex as Berlin-from-Acid).
 *  Main Rev / DIV are per-lane in Berlin — grey them out on the transport. */
function setBerlinLockedUi(on) {
    document.body.classList.toggle('berlin-mode', !!on);
    [
        'keyboardPolyToggle',
        'keyboardMultitudesToggle',
        'kbWrite',
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

export function setBerlinMode(on) {
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
        // The single strip is a view of the edit slot — bank it before hiding.
        flushDomToPattern(state.editSlot);
        state.pendingEditSlot = null;
        state.berlinMode = true;
        ensureBank();
        ensurePlayheads();
        resetBerlinPlayheads(state.audioContext ? state.audioContext.currentTime : 0);
        buildUi();
        setBerlinLockedUi(true);
        // Master GATE at 100% = unity over per-lane gates (stash for exit)
        applyBerlinMasterGateEnter();
    } else {
        state.berlinMode = false;
        state.berlinSoloRow = null;
        setBerlinLockedUi(false);
        clearBerlinStepActive();
        applyBerlinMasterGateExit();
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
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-mode', {
        detail: { on: state.berlinMode },
    }));
}

export function toggleBerlinMode() {
    setBerlinMode(!state.berlinMode);
}

export function setBerlinOscCount(count) {
    const next = clamp(Math.round(count) || 3, 1, OSC_LANE_COUNT);
    if (state.berlinOscCount === next) {
        syncBerlinUi();
        return;
    }
    const prevSounding = new Set(
        berlinActiveRows().filter((i) => isOscLane(i) && isRowSounding(i))
    );
    state.berlinOscCount = next;
    if (state.berlinSoloRow !== null && isOscLane(state.berlinSoloRow)
        && state.berlinSoloRow >= next) {
        state.berlinSoloRow = null;
    }
    syncBerlinUi();
    prevSounding.forEach((i) => {
        if (i >= next || !isRowSounding(i)) notifyOscLaneSilenced(i);
    });
}

export function setBerlinModCount(count) {
    const next = clamp(Math.round(count) || 1, 1, OSC_LANE_COUNT);
    if (state.berlinModCount === next) {
        syncBerlinUi();
        return;
    }
    state.berlinModCount = next;
    if (state.berlinSoloRow !== null && isModLane(state.berlinSoloRow)
        && (state.berlinSoloRow - OSC_LANE_COUNT) >= next) {
        state.berlinSoloRow = null;
    }
    syncBerlinUi();
}

export function initBerlin() {
    ensureBank();
    ensurePlayheads();

    document.getElementById('berlinToggle')?.addEventListener('click', () => {
        toggleBerlinMode();
    });

    document.querySelectorAll('.berlin-count-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const n = parseInt(btn.dataset.count, 10);
            if (btn.dataset.laneKind === 'mod') setBerlinModCount(n);
            else setBerlinOscCount(n);
        });
    });

    // Acid / Poly grab the voice back — Berlin steps aside.
    document.addEventListener('ingysynth:exit-berlin', () => {
        if (state.berlinMode) setBerlinMode(false);
    });

    syncBerlinUi();
}
