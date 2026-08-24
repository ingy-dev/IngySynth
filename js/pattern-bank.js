// Pattern bank: normal mode uses slots 0–7 (P1–P8). Berlin Dream uses all 8 lanes
// (O1–O4 pitch + M1–M4 modulation). Dom step strip is a view of `editSlot`.

import { state } from './state.js?v=116';
import { clampRatch, syncRatchButton } from './step-ratch.js?v=1';
import { getNumber, getString, set } from './params.js?v=13';

/** Total Berlin lanes (and bank array length). */
export const PATTERN_COUNT = 8;
/** Normal-mode P1–P8 slots. */
export const BANK_COUNT = 8;
export const STEP_SLOTS = 32;

export const OSC_LANE_COUNT = 4;
/** Legacy Berlin row index for D1 (M2). D-lanes no longer overlay the bank. */
export const DRUM_LANE_START = 5;
export const DRUM_LANE_COUNT = 3;
export const DRUM_MODELS = ['hihat', 'snare', 'bass_drum'];
/** 1-indexed On steps for factory D1 / D2 / D3 (8 steps, 1/8). */
export const FACTORY_DRUM_ONS = [
    [2, 4, 6, 8],
    [3, 7],
    [1, 3, 5, 7],
];
const DRUM_MODEL_SET = new Set(DRUM_MODELS);

export const DESTINATIONS = [
    { id: 'osc1Pitch', label: 'Osc 1 Pitch' },
    { id: 'osc2Pitch', label: 'Osc 2 Pitch' },
    { id: 'osc3Pitch', label: 'Osc 3 Pitch' },
    { id: 'osc4Pitch', label: 'Osc 4 Pitch' },
    { id: 'cutoff', label: 'Cutoff' },
    { id: 'resonance', label: 'Resonance' },
    { id: 'highpass', label: 'High Pass' },
    { id: 'off', label: 'Off' },
];

const OSC_DESTINATIONS = ['osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch'];
const MOD_DESTINATIONS = ['cutoff', 'resonance', 'highpass', 'off'];

export function isOscLane(index) {
    return (index | 0) >= 0 && (index | 0) < OSC_LANE_COUNT;
}

export function isModLane(index) {
    return (index | 0) >= OSC_LANE_COUNT && (index | 0) < PATTERN_COUNT;
}

/** Bank rows are never drums. D1–D3 live on `state.drumPatterns`. */
export function isDrumLane(_index) {
    return false;
}

export function drumLaneIndex(row) {
    return (row | 0) - DRUM_LANE_START;
}

export function clampDrumLane(lane) {
    return Math.max(0, Math.min(DRUM_LANE_COUNT - 1, lane | 0));
}

export function defaultDrumPatch(lane = 0) {
    const i = Math.max(0, Math.min(DRUM_LANE_COUNT - 1, lane | 0));
    return {
        engine: 'analog',
        model: DRUM_MODELS[i] || 'hihat',
        tune: 0.5,
        harmonics: 0.5,
        morphX: 0.5,
        morphY: 0.5,
        alt: false,
        trigPatched: true,
        vol: 0.8,
        pan: 0,
    };
}

export function clampDrumEngine(engine) {
    if (engine === 'plaits' || engine === 'digital') return 'plaits';
    return 'analog';
}

export function isAnalogDrumEngine(patch) {
    return clampDrumEngine(patch?.engine) === 'analog';
}

export function clampDrumPatch(src, lane = 0) {
    const d = defaultDrumPatch(lane);
    const model = DRUM_MODEL_SET.has(src?.model) ? src.model : d.model;
    const num = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    return {
        engine: clampDrumEngine(src?.engine ?? d.engine),
        model,
        tune: Math.max(0, Math.min(1, num(src?.tune, d.tune))),
        harmonics: Math.max(0, Math.min(1, num(src?.harmonics, d.harmonics))),
        morphX: Math.max(0, Math.min(1, num(src?.morphX, d.morphX))),
        morphY: Math.max(0, Math.min(1, num(src?.morphY, d.morphY))),
        alt: !!src?.alt,
        trigPatched: src?.trigPatched !== false,
        vol: Math.max(0, Math.min(1, num(src?.vol, d.vol))),
        pan: Math.max(-1, Math.min(1, num(src?.pan, d.pan))),
    };
}

export function ensureBerlinDrumKit() {
    if (!Array.isArray(state.berlinDrum) || state.berlinDrum.length !== DRUM_LANE_COUNT) {
        state.berlinDrum = Array.from({ length: DRUM_LANE_COUNT }, (_, i) => defaultDrumPatch(i));
    }
    state.berlinDrum.forEach((p, i) => {
        state.berlinDrum[i] = clampDrumPatch(p, i);
    });
    return state.berlinDrum;
}

export function mirrorDrumKitToPatterns() {
    ensureBerlinDrumKit();
}

export function hydrateDrumKitFromPatterns() {
    ensureBerlinDrumKit();
}

function clampGate(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0.9;
    return Math.max(0.05, Math.min(1, v));
}

/** 1 root + extras. Drop highest when a capture exceeds this. */
export const POLY_CHORD_MAX = 6;

export function clampChord(src) {
    if (!Array.isArray(src)) return [];
    const seen = new Set();
    const out = [];
    for (const n of src) {
        const iv = Math.round(Number(n));
        if (!Number.isFinite(iv) || iv === 0) continue;
        if (seen.has(iv)) continue;
        seen.add(iv);
        out.push(iv);
    }
    out.sort((a, b) => a - b);
    return out.slice(0, POLY_CHORD_MAX - 1);
}

/** Lowest note = root; extras relative. Drops highest if more than 6 pitches. */
export function chordFromCellNotes(notes) {
    const uniq = [...new Set(
        (notes || [])
            .map((n) => Math.round(Number(n)))
            .filter((n) => Number.isFinite(n)),
    )].sort((a, b) => a - b);
    if (!uniq.length) return { tune: 0, chord: [] };
    const kept = uniq.slice(0, POLY_CHORD_MAX);
    const tune = kept[0];
    return { tune, chord: kept.slice(1).map((n) => n - tune) };
}

export function stepCellNotes(data) {
    const root = Math.round(Number(data?.tune) || 0);
    return [root, ...clampChord(data?.chord).map((iv) => root + iv)];
}

export function stepChordCount(data) {
    return 1 + clampChord(data?.chord).length;
}

export function soundingIntervalsFromStep(data) {
    return [0, ...clampChord(data?.chord)];
}

export function paintStepChordMarker(index, data) {
    const i = Math.max(0, Math.min(STEP_SLOTS - 1, index | 0));
    const extras = clampChord(data?.chord);
    const has = extras.length > 0;
    const n = 1 + extras.length;
    document.querySelectorAll(
        `.keyboard-step[data-step="${i}"], .sequencer-step[data-step="${i}"]`,
    ).forEach((el) => {
        el.classList.toggle('has-chord', has);
        if (has) el.dataset.chordCount = String(n);
        else el.removeAttribute('data-chord-count');
    });
}

export function paintAllStepChordMarkers(steps) {
    const list = Array.isArray(steps) ? steps : getPattern(state.editSlot).steps;
    for (let i = 0; i < STEP_SLOTS; i++) {
        paintStepChordMarker(i, list[i]);
    }
}

function emptyStep() {
    return { tune: 0, fine: 0, on: true, accent: false, slide: false, ratch: 1, chord: [] };
}

function restStep() {
    return { tune: 0, fine: 0, on: false, accent: false, slide: false, ratch: 1, chord: [] };
}

function factoryDrumSteps(ones) {
    const steps = Array.from({ length: STEP_SLOTS }, restStep);
    (ones || []).forEach((n) => {
        const i = (n | 0) - 1;
        if (i >= 0 && i < STEP_SLOTS) steps[i] = { ...restStep(), on: true };
    });
    return steps;
}

function createDrumPattern(lane = 0) {
    const i = clampDrumLane(lane);
    return {
        steps: factoryDrumSteps(FACTORY_DRUM_ONS[i]),
        stepCount: 8,
        division: 8,
        reverse: false,
        enabled: true,
        gate: 0.9,
        amount: 1,
        laneKind: 'drum',
    };
}

export function ensureDrumPatterns() {
    if (!Array.isArray(state.drumPatterns) || state.drumPatterns.length !== DRUM_LANE_COUNT) {
        state.drumPatterns = Array.from({ length: DRUM_LANE_COUNT }, (_, i) => createDrumPattern(i));
    }
    state.drumPatterns.forEach((p, i) => {
        if (!p) {
            state.drumPatterns[i] = createDrumPattern(i);
            return;
        }
        if (p.enabled === undefined) p.enabled = true;
        if (p.gate === undefined) p.gate = 0.9;
        else p.gate = clampGate(p.gate);
        p.amount = 1;
        p.laneKind = 'drum';
        if (p.stepCount === undefined) p.stepCount = 8;
        if (p.division === undefined) p.division = 8;
        if (p.reverse === undefined) p.reverse = false;
        if (Array.isArray(p.steps)) {
            p.steps.forEach((s) => {
                if (s && s.ratch === undefined) s.ratch = 1;
                if (s) s.chord = clampChord(s.chord);
            });
            while (p.steps.length < STEP_SLOTS) p.steps.push(restStep());
        } else {
            p.steps = factoryDrumSteps(FACTORY_DRUM_ONS[i]);
        }
    });
    return state.drumPatterns;
}

export function getDrumPattern(lane) {
    ensureDrumPatterns();
    return state.drumPatterns[clampDrumLane(lane)];
}

export function isDrumPatternEnabled(lane) {
    return getDrumPattern(lane)?.enabled !== false;
}

function createPattern(index) {
    const i = index | 0;
    if (isOscLane(i)) {
        return {
            steps: Array.from({ length: STEP_SLOTS }, emptyStep),
            stepCount: 8,
            division: 8,
            reverse: false,
            enabled: true,
            destination: OSC_DESTINATIONS[i],
            gate: 0.9,
            amount: 1,
            laneKind: 'osc',
        };
    }
    return {
        steps: Array.from({ length: STEP_SLOTS }, emptyStep),
        stepCount: 8,
        division: 8,
        reverse: false,
        enabled: true,
        destination: MOD_DESTINATIONS[i - OSC_LANE_COUNT] || 'off',
        gate: 0.9,
        amount: 1,
        laneKind: 'mod',
    };
}

export function ensureBank() {
    if (!Array.isArray(state.patterns)) {
        state.patterns = Array.from({ length: PATTERN_COUNT }, (_, i) => createPattern(i));
    } else if (state.patterns.length < PATTERN_COUNT) {
        // Grow 4 → 8 without wiping existing slots
        while (state.patterns.length < PATTERN_COUNT) {
            state.patterns.push(createPattern(state.patterns.length));
        }
    } else if (state.patterns.length > PATTERN_COUNT) {
        state.patterns.length = PATTERN_COUNT;
    }

    state.patterns.forEach((p, i) => {
        if (!p) {
            state.patterns[i] = createPattern(i);
            return;
        }
        if (p.enabled === undefined) p.enabled = true;
        if (p.gate === undefined) p.gate = 0.9;
        else p.gate = clampGate(p.gate);
        if (p.amount === undefined) p.amount = 1;
        if (isOscLane(i)) {
            p.destination = OSC_DESTINATIONS[i];
            p.laneKind = 'osc';
            p.amount = 1;
        } else {
            p.laneKind = 'mod';
            if (!MOD_DESTINATIONS.includes(p.destination) && p.destination !== 'off') {
                // Drop pitch dests on mod lanes after migration
                if (OSC_DESTINATIONS.includes(p.destination)) {
                    p.destination = MOD_DESTINATIONS[i - OSC_LANE_COUNT] || 'off';
                }
            }
        }
        if (p.drum && typeof p.drum === 'object') {
            const lane = Math.max(0, Math.min(DRUM_LANE_COUNT - 1, i - DRUM_LANE_START));
            p.drum = clampDrumPatch(p.drum, lane);
        }
        if (Array.isArray(p.steps)) {
            p.steps.forEach((s) => {
                if (s && s.ratch === undefined) s.ratch = 1;
                if (s) s.chord = clampChord(s.chord);
            });
        } else {
            p.steps = Array.from({ length: STEP_SLOTS }, emptyStep);
        }
    });
    ensureDrumPatterns();
    ensureBerlinDrumKit();
    return state.patterns;
}

export function getPattern(slot) {
    ensureBank();
    return state.patterns[Math.max(0, Math.min(PATTERN_COUNT - 1, slot | 0))];
}

/** Steps that actually play for a pattern (1–32). */
export function patternStepCount(pattern) {
    return Math.max(1, Math.min(STEP_SLOTS, Math.round(pattern?.stepCount) || 8));
}

export function patternGate(pattern) {
    return clampGate(pattern?.gate);
}

// --- Clipboard (shared Berlin ↔ normal bank) -------------------------------
// Carries steps + clock/amount/gate. Never Dest, On/Off, or Solo.

/** @type {null | { steps: object[], stepCount: number, division: number, reverse: boolean, amount: number, gate: number }} */
let patternClipboard = null;

export function cloneStep(s) {
    const src = s || emptyStep();
    return {
        tune: Math.round(Number(src.tune) || 0),
        fine: Math.round(Number(src.fine) || 0),
        on: src.on !== false,
        accent: !!src.accent,
        slide: !!src.slide,
        ratch: clampRatch(src.ratch),
        chord: clampChord(src.chord),
    };
}

function cloneSteps(steps) {
    return Array.from({ length: STEP_SLOTS }, (_, i) => cloneStep(steps?.[i]));
}

/** Live step record for the strip's edit slot (what classic play reads). */
export function getLiveStep(index) {
    const pattern = getPattern(state.editSlot);
    const i = Math.max(0, Math.min(STEP_SLOTS - 1, index | 0));
    if (!pattern.steps[i]) pattern.steps[i] = emptyStep();
    return pattern.steps[i];
}

export function snapshotStep(index) {
    return cloneStep(getLiveStep(index));
}

/** Clone this/prev/next at schedule time so a bank edit cannot tear a playing step. */
export function snapshotStepNeighborhood(step, stepCount, reverse) {
    const n = Math.max(1, Math.min(STEP_SLOTS, Math.round(Number(stepCount)) || 8));
    const s = ((Math.round(Number(step)) % n) + n) % n;
    const next = reverse ? (s - 1 + n) % n : (s + 1) % n;
    const prev = reverse ? (s + 1) % n : (s - 1 + n) % n;
    return {
        index: s,
        nextIndex: next,
        prevIndex: prev,
        this: snapshotStep(s),
        next: snapshotStep(next),
        prev: snapshotStep(prev),
    };
}

let applyingStepToDom = false;

export function syncLiveStepFromDom(index) {
    if (applyingStepToDom) return;
    const i = Math.max(0, Math.min(STEP_SLOTS - 1, index | 0));
    getPattern(state.editSlot).steps[i] = captureStepFromDom(i);
}

function bindLiveStepSync() {
    if (globalThis.__ingySynthLiveStepSync) return;
    globalThis.__ingySynthLiveStepSync = true;
    const selector = '.step-tune, .step-fine, .step-accent, .step-slide, .step-ratch, .step-toggle';
    const handle = (e) => {
        if (applyingStepToDom) return;
        const el = e.target instanceof Element ? e.target.closest(selector) : null;
        if (!el || el.closest('.keyboard-step, .berlin-step')) return;
        const i = parseInt(el.dataset.step, 10);
        if (!Number.isFinite(i)) return;
        syncLiveStepFromDom(i);
    };
    // Capture: run before slider `input` listeners so readouts see the store.
    document.addEventListener('input', handle, true);
    document.addEventListener('change', handle, true);
    // Bubble: after On/Acc/Sld/Ratch click handlers have toggled the button.
    document.addEventListener('click', handle);
}

export function hasPatternClipboard() {
    return !!patternClipboard;
}

/** Snapshot pattern content into the shared clipboard (skips Dest / mute / Solo). */
export function copyPatternContent(slot) {
    const pattern = getPattern(slot);
    patternClipboard = {
        steps: cloneSteps(pattern.steps),
        stepCount: patternStepCount(pattern),
        division: parseInt(pattern.division, 10) || 8,
        reverse: !!pattern.reverse,
        amount: Math.max(0, Math.min(1, Number(pattern.amount ?? 1))),
        gate: clampGate(pattern.gate),
    };
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'copy', slot },
    }));
    return true;
}

/** Paste clipboard into a slot. Returns false if the clipboard is empty. */
export function pastePatternContent(slot) {
    if (!patternClipboard) return false;
    const pattern = getPattern(slot);
    pattern.steps = cloneSteps(patternClipboard.steps);
    pattern.stepCount = patternClipboard.stepCount;
    pattern.division = patternClipboard.division;
    pattern.reverse = !!patternClipboard.reverse;
    if (isOscLane(slot) || isDrumLane(slot)) {
        pattern.gate = clampGate(patternClipboard.gate ?? 0.9);
        pattern.amount = 1;
        if (isOscLane(slot)) pattern.destination = OSC_DESTINATIONS[slot];
        // Drum kit / FILT / vol / pan stay on the slot
    } else {
        pattern.amount = Math.max(0, Math.min(1, Number(patternClipboard.amount ?? 1)));
        // Keep mod Dest; only paste amount/clock/steps
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'paste', slot },
    }));
    return true;
}

export function copyDrumPatternContent(lane) {
    const pattern = getDrumPattern(lane);
    patternClipboard = {
        steps: cloneSteps(pattern.steps),
        stepCount: patternStepCount(pattern),
        division: parseInt(pattern.division, 10) || 8,
        reverse: !!pattern.reverse,
        amount: 1,
        gate: clampGate(pattern.gate),
    };
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'copy', slot: `d${clampDrumLane(lane) + 1}` },
    }));
    return true;
}

export function pasteDrumPatternContent(lane) {
    if (!patternClipboard) return false;
    const pattern = getDrumPattern(lane);
    pattern.steps = cloneSteps(patternClipboard.steps);
    pattern.stepCount = patternClipboard.stepCount;
    pattern.division = patternClipboard.division;
    pattern.reverse = !!patternClipboard.reverse;
    pattern.gate = clampGate(patternClipboard.gate ?? 0.9);
    pattern.amount = 1;
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'paste', slot: `d${clampDrumLane(lane) + 1}` },
    }));
    return true;
}

export function clearDrumPatternSteps(lane) {
    const pattern = getDrumPattern(lane);
    for (let i = 0; i < STEP_SLOTS; i++) {
        pattern.steps[i] = restStep();
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'clear', slot: `d${clampDrumLane(lane) + 1}` },
    }));
}

/** Reset step slots only — clock / Dest / mute stay put. */
export function clearPatternSteps(slot) {
    const pattern = getPattern(slot);
    for (let i = 0; i < STEP_SLOTS; i++) {
        pattern.steps[i] = emptyStep();
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'clear', slot },
    }));
}

/** MIDI-style "Copied!" pill on a control (caller supplies phosphor via CSS var). */
export function flashCopiedToast(el) {
    if (!el) return;
    el.classList.remove('pattern-copied');
    // Retrigger CSS if the class was already present
    void el.offsetWidth;
    el.classList.add('pattern-copied');
    clearTimeout(el._patternCopiedTimer);
    el._patternCopiedTimer = setTimeout(() => {
        el.classList.remove('pattern-copied');
    }, 2000);
}

export function syncPatternClipboardUi() {
    const has = hasPatternClipboard();
    document.querySelectorAll('.pattern-paste-btn').forEach((btn) => {
        btn.disabled = !has;
        btn.setAttribute('aria-disabled', has ? 'false' : 'true');
        btn.classList.toggle('is-disabled', !has);
    });
}

// --- DOM <-> pattern -------------------------------------------------------

function tuneInput(i) { return document.querySelector(`.step-tune[data-step="${i}"]`); }
function fineInput(i) { return document.querySelector(`.step-fine[data-step="${i}"]`); }
function accentBtn(i) { return document.querySelector(`.step-accent[data-step="${i}"]`); }
function slideBtn(i) { return document.querySelector(`.step-slide[data-step="${i}"]`); }
function toggleBtn(i) { return document.querySelector(`.step-toggle[data-step="${i}"]`); }
function ratchBtn(i) { return document.querySelector(`.step-ratch[data-step="${i}"]`); }

function formatCentsLabel(cents) {
    return `${cents > 0 ? '+' : ''}${cents}&cent;`;
}

export function captureStepFromDom(i) {
    const tune = tuneInput(i);
    const fine = fineInput(i);
    const accent = accentBtn(i);
    const slide = slideBtn(i);
    const ratch = ratchBtn(i);
    const front = toggleBtn(i)?.querySelector('.front');
    const live = getPattern(state.editSlot).steps[i];
    return {
        tune: tune ? (parseInt(tune.value, 10) || 0) : 0,
        fine: fine ? (parseInt(fine.value, 10) || 0) : 0,
        accent: accent ? !accent.classList.contains('off') : false,
        slide: slide ? !slide.classList.contains('off') : false,
        on: front ? front.textContent.trim() === 'On' : true,
        ratch: clampRatch(parseInt(ratch?.dataset?.ratch, 10) || 1),
        chord: clampChord(live?.chord),
    };
}

export function applyStepToDom(i, data) {
    applyingStepToDom = true;
    try {
        applyStepToDomUnguarded(i, data);
    } finally {
        applyingStepToDom = false;
    }
}

function applyStepToDomUnguarded(i, data) {
    const tune = tuneInput(i);
    const fine = fineInput(i);
    const accent = accentBtn(i);
    const slide = slideBtn(i);
    const toggle = toggleBtn(i);
    const front = toggle?.querySelector('.front');

    if (tune) {
        // Widen first: a Write-Mode value can sit outside the manual knob window.
        const v = Math.round(Number(data.tune) || 0);
        if (v < parseFloat(tune.min)) tune.min = String(v);
        if (v > parseFloat(tune.max)) tune.max = String(v);
        tune.value = String(v);
        tune.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (fine) {
        fine.value = String(Math.round(Number(data.fine) || 0));
        if (fine.nextElementSibling) {
            fine.nextElementSibling.innerHTML = formatCentsLabel(parseInt(fine.value, 10) || 0);
        }
    }
    if (accent) accent.classList.toggle('off', !data.accent);
    if (slide) slide.classList.toggle('off', !data.slide);
    if (front) front.textContent = data.on ? 'On' : 'Off';
    if (toggle) toggle.classList.toggle('off', !data.on);
    syncRatchButton(ratchBtn(i), data.ratch);
    paintStepChordMarker(i, data);
}

function stepBusPresent() {
    return !!tuneInput(0);
}

function readClockFromDom() {
    const stepsEl = document.getElementById('stepCount');
    const divEl = document.getElementById('division');
    const stepCount = stepsEl
        ? Math.max(1, Math.min(STEP_SLOTS, parseInt(stepsEl.value, 10) || 8))
        : Math.max(1, Math.min(STEP_SLOTS, Math.round(getNumber('stepCount', 8)) || 8));
    let division;
    if (divEl) {
        division = parseInt(divEl.value, 10) || 8;
    } else {
        const fromStr = parseInt(getString('division', '8'), 10);
        const fromNum = getNumber('division', 8);
        division = Number.isFinite(fromStr) && fromStr > 0
            ? fromStr
            : (Number.isFinite(fromNum) && fromNum > 0 ? fromNum : 8);
    }
    return {
        stepCount,
        division,
        reverse: !!state.isReverse,
    };
}

function writeClockToStore(pattern) {
    set('stepCount', pattern.stepCount);
    set('division', pattern.division);
    if (state.isReverse !== !!pattern.reverse) {
        state.isReverse = !!pattern.reverse;
        document.dispatchEvent(new CustomEvent('ingysynth:reverse-sync'));
    }
}

/** Copy the live step strip into a slot (defaults to the current edit slot). */
export function flushDomToPattern(slot = state.editSlot) {
    const pattern = getPattern(slot);
    if (stepBusPresent()) {
        for (let i = 0; i < STEP_SLOTS; i++) {
            pattern.steps[i] = captureStepFromDom(i);
        }
    }
    Object.assign(pattern, readClockFromDom());
    return pattern;
}

/** Paint a slot into the live step strip. */
export function hydratePatternToDom(slot = state.editSlot, { clock = true } = {}) {
    const pattern = getPattern(slot);
    if (stepBusPresent()) {
        for (let i = 0; i < STEP_SLOTS; i++) {
            applyStepToDom(i, pattern.steps[i] || emptyStep());
        }
    }
    if (clock) writeClockToStore(pattern);
    paintAllStepChordMarkers(pattern.steps);
    document.dispatchEvent(new CustomEvent('ingysynth-kb-steps-sync'));
    return pattern;
}

// --- Slot selection --------------------------------------------------------

function slotButtons() {
    return Array.from(document.querySelectorAll('.pattern-slot-btn'));
}

export function syncPatternSlotUi() {
    slotButtons().forEach((btn) => {
        const slot = parseInt(btn.dataset.slot, 10);
        const active = slot === state.editSlot;
        const armed = state.pendingEditSlot === slot;
        btn.classList.toggle('off', !active);
        btn.classList.toggle('is-armed', armed);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function clampBankSlot(slot) {
    return Math.max(0, Math.min(BANK_COUNT - 1, slot | 0));
}

/** Swap slots right now (used when stopped, and to land an armed switch). */
export function selectSlot(slot, { flush = true } = {}) {
    const next = clampBankSlot(slot);
    if (flush) flushDomToPattern(state.editSlot);
    state.editSlot = next;
    state.pendingEditSlot = null;
    hydratePatternToDom(next);
    syncPatternSlotUi();
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-slot', { detail: { slot: next } }));
}

/** P1–P8 press: instant when stopped, armed for the next loop while playing. */
export function requestSlot(slot) {
    const next = clampBankSlot(slot);
    const running = state.isPlaying || state.isArping;

    if (state.berlinMode) {
        // Every row is already live; pattern buttons only move edit focus.
        state.editSlot = next;
        state.pendingEditSlot = null;
        syncPatternSlotUi();
        return;
    }
    if (!running) {
        selectSlot(next);
        return;
    }
    if (next === state.editSlot) {
        state.pendingEditSlot = null;
        syncPatternSlotUi();
        return;
    }
    state.pendingEditSlot = next;
    syncPatternSlotUi();
}

/** Called at each loop start while playing — lands any armed slot in time. */
export function commitPendingSlot() {
    if (state.pendingEditSlot === null || state.berlinMode) return false;
    const next = state.pendingEditSlot;
    if (next === state.editSlot) {
        state.pendingEditSlot = null;
        syncPatternSlotUi();
        return false;
    }
    selectSlot(next);
    return true;
}

/** Normal-mode clipboard ops against the strip's editSlot (flush/hydrate DOM). */
function copyEditSlot(btn) {
    if (state.berlinMode) return;
    flushDomToPattern(state.editSlot);
    copyPatternContent(state.editSlot);
    flashCopiedToast(btn);
}

function pasteEditSlot() {
    if (state.berlinMode) return;
    flushDomToPattern(state.editSlot);
    if (!pastePatternContent(state.editSlot)) return;
    hydratePatternToDom(state.editSlot);
}

function clearEditSlot() {
    if (state.berlinMode) return;
    clearPatternSteps(state.editSlot);
    hydratePatternToDom(state.editSlot);
}

export function initPatternBank() {
    ensureBank();
    bindLiveStepSync();
    // Slot 1 starts as whatever the page loaded with.
    flushDomToPattern(0);
    for (let i = 1; i < BANK_COUNT; i++) {
        const src = state.patterns[0];
        const dst = state.patterns[i];
        dst.stepCount = src.stepCount;
        dst.division = src.division;
        dst.reverse = src.reverse;
    }
    if (state.editSlot >= BANK_COUNT) state.editSlot = 0;
    syncPatternSlotUi();
    syncPatternClipboardUi();

    slotButtons().forEach((btn) => {
        btn.addEventListener('click', () => {
            requestSlot(parseInt(btn.dataset.slot, 10));
        });
    });

    document.getElementById('patternBankCopy')?.addEventListener('click', (e) => {
        copyEditSlot(e.currentTarget);
    });
    document.getElementById('patternBankPaste')?.addEventListener('click', () => {
        pasteEditSlot();
    });
    document.getElementById('patternBankClear')?.addEventListener('click', () => {
        clearEditSlot();
    });

    document.addEventListener('ingysynth:pattern-clipboard', () => {
        syncPatternClipboardUi();
    });

    document.addEventListener('ingysynth:loop-start', () => {
        commitPendingSlot();
    });
}
