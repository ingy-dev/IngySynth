// Loop-phase automation (Ableton Session latch style):
// Rec armed + pattern playing → touch a param → record that curve until
// the pattern loop wraps → punch out → playback on subsequent loops.
// Rec off + existing lane → knob tweaks set a persistent offset (curve shape kept).

import { state } from './state.js?v=120';
import { applyPitchBend, getBendRangeSemitones } from './pitch-bend.js?v=141';
import { followXYPadAutomation, getXYPadAutomationKeys } from './xy-pad.js?v=106';
import { ensureDisplayStep } from './knobs.js?v=191';
import {
    bindAutomationStatusSource,
    refreshParamStatusIndicators,
} from './param-status.js?v=33';
import { isBerlinOn, masterLoopSeconds } from './berlin.js?v=123';
import { getNumber, getString, get, set as setParam, subscribe } from './params.js?v=44';
import { PARAMS, clampToCatalog, getParam } from './param-catalog.js?v=13';
import { midiControlId } from './midi-learn.js?v=35';
import {
    flashCopiedToast,
    getPattern,
    getBerlinPattern,
    patternRepeat,
    setPatternAutomationBridge,
} from './pattern-bank.js?v=50';

const PITCH_BEND_KEY = 'pitchBend';
/** Samples per loop — continuous enough for filter rides, cheap to store. */
const RESOLUTION = 128;

// Every catalog range param is automatable (Plaits, digital slots, Ingy 6, filter env
// amount ...), minus the transport / step-write keys below and per-step keys.

/** Transport / pattern / write µTUNE — never automate. */
const EXCLUDE_IDS = new Set([
    'tempo', 'stepCount', 'division', 'slideTime', 'accentAmount', 'gateLength', 'swing',
    'kbSlideTime', 'kbAccentAmount', 'kbGateLength', 'kbSwing',
    'keyboardMasterTune', 'kbTuningMasterTune', 'kbXyTuningMasterTune', 'kbWriteFineProxy',
]);

function isAutomatableKey(key) {
    if (!key || EXCLUDE_IDS.has(key)) return false;
    const spec = getParam(key);
    return !!spec && spec.type === 'range' && !spec.stepField;
}

/** Index-valued params: a lerped curve must land on a real division / switch position. */
const SNAP_KEYS = new Set([
    'lfoSyncDivision', 'ingy6LfoSyncDivision', 'scTimeSyncDivision',
    'octaveSwitch', 'semitoneSwitch',
]);

/** Keyboard + main-panel sequencer / step-record UI roots. */
const BLOCKED_UI_SELECTORS = [
    '.keyboard-transport-fieldset',
    '.keyboard-write-fieldset',
    '.keyboard-tuning-fieldset',
    '#keyboardTuningFieldset',
    '#keyboardXyTuningFieldset',
    '.keyboard-steps-fieldset',
    '#keyboardStepsFieldset',
    '.keyboard-pattern-fieldset',
    '#keyboardPatternFieldset',
    '#keyboardAutomationFieldset',
    '.sequencer-step',
    '.keyboard-step',
    '.sequencer-controls',
    '#steps',
];

/** Last value seen while a take is active (survives release for latch). */
const takeValues = new Map();
/** Last sample index written during the current take (for gap-fill replace). */
const takeWriteIndex = new Map();
/** Last applied playback value per param (for epsilon / smooth updates). */
const lastApplied = new Map();

/** Per-pattern automation. Keys are n0–n7 (normal), b0–b7 (Berlin), and s while a song plays. */
const automationBanks = {};
let activeBankKey = 'n0';

function ensureAutomationBank(key) {
    const k = key || 'n0';
    if (!automationBanks[k]) automationBanks[k] = { lanes: {}, offsets: new Map() };
    return automationBanks[k];
}

/** Active bank. Reassigned by useAutomationBank; every lane read goes through these. */
let lanes = ensureAutomationBank(activeBankKey).lanes;
let offsets = ensureAutomationBank(activeBankKey).offsets;

function dispatchAutomationChanged() {
    document.dispatchEvent(new CustomEvent('ingysynth:automation-changed'));
}

function bankKeyFromState() {
    if (state.songPlaying) return 's';
    if (state.berlinMode) {
        const slot = Math.max(0, Math.min(7, state.berlinSlot | 0));
        return `b${slot}`;
    }
    const slot = Math.max(0, Math.min(7, state.editSlot | 0));
    return `n${slot}`;
}

function patternNameForBank(key) {
    const n = parseInt(String(key).slice(1), 10);
    return `P${(Number.isFinite(n) ? n : 0) + 1}`;
}

function updateAutomationButtonLabels() {
    const name = patternNameForBank(activeBankKey);
    const labels = [
        ['kbAutomationClear', `Clear ${name} automation`],
        ['kbAutomationCopy', `Copy ${name} automation`],
        ['kbAutomationPaste', `Paste automation to ${name}`],
    ];
    labels.forEach(([id, label]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.setAttribute('aria-label', label);
        btn.title = label;
    });
}

export function useAutomationBank(key) {
    const next = key || bankKeyFromState();
    if (next === activeBankKey) return;
    punchOutAllTakes();
    const rec = ensureAutomationBank(next);
    lanes = rec.lanes;
    offsets = rec.offsets;
    activeBankKey = next;
    lastApplied.clear();
    refreshParamStatusIndicators();
    updateAutomationButtonLabels();
    dispatchAutomationChanged();
}

/** Params currently latch-recording until loop wrap. */
const activeTakes = new Set();

/** Pre-take lane snapshots — committed to undo on punch-out. */
const takeBefore = new Map();
/** Pre-gesture snapshots for Rec-off offset tweaks. */
const offsetGestureBefore = new Map();

const HISTORY_MAX = 40;
/** @type {object[]} */
const undoStack = [];
/** @type {object[]} */
const redoStack = [];

/** @type {string|null} */
let highlightKey = null;
/** @type {Element|null} */
let highlightEl = null;

let armed = false;
let applying = false;
/** Suppress history while applying undo/redo restores. */
let historyLocked = false;
/** Audio time of the current loop's phase-0 anchor. */
let loopEpoch = 0;
/** True after we've seen at least one loop anchor this play session. */
let anchoredOnce = false;
let lastPhase = 0;
let rafId = 0;

function stepCount() {
    return Math.max(1, Math.min(32, Math.round(getNumber('stepCount', 8)) || 8));
}

function patternDuration() {
    const tempoN = getNumber('tempo', 120);
    const tempo = Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
    // One cycle = one pass × Repeat Pattern. Berlin's pass is the longest lane.
    if (isBerlinOn()) {
        const repeat = patternRepeat(getBerlinPattern(state.berlinSlot));
        return Math.max(0.001, masterLoopSeconds(tempo) * repeat);
    }
    const fromStr = parseInt(getString('division', '8'), 10);
    const fromNum = getNumber('division', 8);
    const division = Number.isFinite(fromStr) && fromStr > 0
        ? fromStr
        : (Number.isFinite(fromNum) && fromNum > 0 ? fromNum : 8);
    const n = stepCount();
    const stepDur = (60 / tempo) * (4 / division);
    const repeat = patternRepeat(getPattern(state.editSlot));
    return Math.max(0.001, n * stepDur * repeat);
}

function emptySamples() {
    return Array.from({ length: RESOLUTION }, () => null);
}

function ensureLane(key) {
    if (!lanes[key]) lanes[key] = { samples: emptySamples() };
    return lanes[key];
}

function snapshotLane(key) {
    const lane = lanes[key];
    return {
        samples: lane ? lane.samples.slice() : null,
        offset: offsets.get(key) || 0,
    };
}

function snapshotsEqual(a, b) {
    if (!a || !b) return a === b;
    if ((a.offset || 0) !== (b.offset || 0)) return false;
    const as = a.samples;
    const bs = b.samples;
    if (as == null && bs == null) return true;
    if (as == null || bs == null) return false;
    if (as.length !== bs.length) return false;
    for (let i = 0; i < as.length; i++) {
        if (as[i] !== bs[i]) return false;
    }
    return true;
}

function applyLaneSnapshot(key, snap, bankKey = activeBankKey) {
    const rec = ensureAutomationBank(bankKey);
    if (!snap || snap.samples == null || !snap.samples.some((s) => s != null)) {
        delete rec.lanes[key];
        rec.offsets.delete(key);
    } else {
        rec.lanes[key] = { samples: snap.samples.slice() };
        if (snap.offset) rec.offsets.set(key, snap.offset);
        else rec.offsets.delete(key);
    }
    if (bankKey === activeBankKey) {
        lastApplied.delete(key);
        refreshParamStatusIndicators(key);
    }
}

function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('kbAutomationUndo');
    const redoBtn = document.getElementById('kbAutomationRedo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

function pushHistory(entry) {
    if (historyLocked || !entry) return;
    if (!entry.bankKey) entry.bankKey = activeBankKey;
    undoStack.push(entry);
    while (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
    updateUndoRedoButtons();
}

function snapshotAllLanes() {
    /** @type {Record<string, { samples: (number|null)[] }>} */
    const out = {};
    Object.keys(lanes).forEach((k) => {
        out[k] = { samples: lanes[k].samples.slice() };
    });
    return out;
}

function snapshotAllOffsets() {
    /** @type {Record<string, number>} */
    const out = {};
    offsets.forEach((v, k) => {
        out[k] = v;
    });
    return out;
}

function restoreAllLanes(laneMap, offsetMap) {
    const prevKeys = Object.keys(lanes);
    prevKeys.forEach((k) => delete lanes[k]);
    offsets.clear();
    lastApplied.clear();
    Object.keys(laneMap || {}).forEach((k) => {
        lanes[k] = { samples: laneMap[k].samples.slice() };
    });
    Object.keys(offsetMap || {}).forEach((k) => {
        offsets.set(k, offsetMap[k]);
    });
    const keys = new Set([...prevKeys, ...Object.keys(laneMap || {})]);
    keys.forEach((k) => refreshParamStatusIndicators(k));
    refreshParamStatusIndicators();
}

function commitOffsetGestures() {
    if (!offsetGestureBefore.size) return;
    offsetGestureBefore.forEach((before, key) => {
        const after = snapshotLane(key);
        if (!snapshotsEqual(before, after)) {
            pushHistory({ type: 'lane', key, before, after });
        }
    });
    offsetGestureBefore.clear();
}

function fillRecord(rec, laneMap, offsetMap) {
    Object.keys(rec.lanes).forEach((k) => delete rec.lanes[k]);
    rec.offsets.clear();
    Object.keys(laneMap || {}).forEach((k) => {
        const samples = laneMap[k]?.samples;
        if (!samples) return;
        rec.lanes[k] = { samples: samples.slice() };
    });
    const entries = offsetMap instanceof Map
        ? [...offsetMap.entries()]
        : Object.entries(offsetMap || {});
    entries.forEach(([k, v]) => {
        if (v) rec.offsets.set(k, v);
    });
}

function applyHistoryEntry(entry, direction) {
    if (!entry) return;
    const bankKey = entry.bankKey || activeBankKey;
    const live = bankKey === activeBankKey;
    historyLocked = true;
    try {
        if (entry.type === 'clear') {
            const rec = ensureAutomationBank(bankKey);
            if (direction === 'undo') fillRecord(rec, entry.beforeLanes, entry.beforeOffsets);
            else fillRecord(rec, entry.afterLanes || {}, entry.afterOffsets || {});
            if (live) {
                lastApplied.clear();
                refreshParamStatusIndicators();
            }
        } else if (entry.type === 'lane' && entry.key) {
            applyLaneSnapshot(entry.key, direction === 'undo' ? entry.before : entry.after, bankKey);
        }
    } finally {
        historyLocked = false;
    }
    if (!live) return;
    // Nudge playback/UI to match restored curves on the pattern that's showing
    const phase = state.isPlaying ? getPhase() : 0;
    if (entry.type === 'clear') {
        Object.keys(lanes).forEach((key) => {
            const v = playedValueAtPhase(key, phase);
            if (v != null) setParamValue(key, v);
        });
    } else if (entry.type === 'lane' && entry.key) {
        const v = playedValueAtPhase(entry.key, phase);
        if (v != null) setParamValue(entry.key, v);
    }
}

function abandonActiveTakes() {
    if (!activeTakes.size) return;
    activeTakes.forEach((key) => {
        const before = takeBefore.get(key);
        if (before) applyLaneSnapshot(key, before);
        takeBefore.delete(key);
    });
    activeTakes.clear();
    takeValues.clear();
    takeWriteIndex.clear();
    clearHighlight();
}

function undoAutomation() {
    // Unfinished Rec-off drag: revert it as the undo step
    if (offsetGestureBefore.size) {
        offsetGestureBefore.forEach((before, key) => applyLaneSnapshot(key, before));
        offsetGestureBefore.clear();
        updateUndoRedoButtons();
        dispatchAutomationChanged();
        return;
    }
    // Unfinished take: cancel without touching history stacks
    if (activeTakes.size) {
        abandonActiveTakes();
        updateUndoRedoButtons();
        dispatchAutomationChanged();
        return;
    }
    const entry = undoStack.pop();
    if (!entry) {
        updateUndoRedoButtons();
        return;
    }
    applyHistoryEntry(entry, 'undo');
    redoStack.push(entry);
    updateUndoRedoButtons();
    dispatchAutomationChanged();
}

function redoAutomation() {
    if (offsetGestureBefore.size) {
        offsetGestureBefore.forEach((before, key) => applyLaneSnapshot(key, before));
        offsetGestureBefore.clear();
    }
    if (activeTakes.size) abandonActiveTakes();
    const entry = redoStack.pop();
    if (!entry) {
        updateUndoRedoButtons();
        return;
    }
    applyHistoryEntry(entry, 'redo');
    undoStack.push(entry);
    updateUndoRedoButtons();
    dispatchAutomationChanged();
}

function canEngageTake() {
    return armed && state.isPlaying && !state.isArping && !applying && !!state.audioContext;
}

function getPhase() {
    if (!state.audioContext || !state.isPlaying) return 0;
    const dur = patternDuration();
    const t = state.audioContext.currentTime - loopEpoch;
    // Loop epoch is the *scheduled* downbeat (lookahead) — stay at 0 until it arrives
    if (!Number.isFinite(t) || t < 0) return 0;
    let p = (t / dur) % 1;
    if (!Number.isFinite(p) || p < 0) return 0;
    return p;
}

function phaseIndex(phase) {
    const i = Math.floor(phase * RESOLUTION);
    return Math.max(0, Math.min(RESOLUTION - 1, i));
}

function isBlockedAutomationUi(el) {
    if (!el || !(el instanceof Element)) return false;
    return BLOCKED_UI_SELECTORS.some((sel) => el.closest(sel));
}

function paramKeyFromInput(input) {
    if (!input || input.tagName !== 'INPUT' || input.type !== 'range') return null;
    if (isBlockedAutomationUi(input)) return null;
    if (input.classList.contains('step-tune') || input.classList.contains('step-fine')) return null;
    if (input.classList.contains('kb-step-fine')) return null;
    if (EXCLUDE_IDS.has(input.id)) return null;
    if (input.classList.contains('osc-vol') && input.dataset.osc != null) {
        return `osc-vol-${input.dataset.osc}`;
    }
    if (input.classList.contains('osc-tune') && input.dataset.osc != null) {
        return `osc-tune-${input.dataset.osc}`;
    }
    if (input.classList.contains('osc-pan') && input.dataset.osc != null) {
        return `osc-pan-${input.dataset.osc}`;
    }
    if (input.classList.contains('kb-osc-fine') && input.dataset.osc != null) {
        return `osc-fine-${input.dataset.osc}`;
    }
    const key = midiControlId(input);
    return isAutomatableKey(key) ? key : null;
}

function resolveInput(key) {
    if (key === PITCH_BEND_KEY) return null;
    if (key.startsWith('osc-vol-')) {
        return document.querySelector(`.osc-vol[data-osc="${key.slice(8)}"]`);
    }
    if (key.startsWith('osc-tune-')) {
        return document.querySelector(`.osc-tune[data-osc="${key.slice(9)}"]`);
    }
    if (key.startsWith('osc-pan-')) {
        return document.querySelector(`.osc-pan[data-osc="${key.slice(8)}"]`);
    }
    if (key.startsWith('osc-fine-')) {
        return document.querySelector(`.kb-osc-fine[data-osc="${key.slice(9)}"]`);
    }
    return document.getElementById(key);
}

function getParamValue(key) {
    if (key === PITCH_BEND_KEY) return state.pitchBendSemitones || 0;
    const n = getNumber(key, NaN);
    return Number.isFinite(n) ? n : null;
}

function setPitchBendVisual(semitones) {
    const el = document.getElementById('keyboardPitchBend');
    if (!el) return;
    const range = getBendRangeSemitones();
    const norm = range > 0 ? semitones / range : 0;
    el.style.setProperty('--bend', String(norm));
    el.setAttribute('aria-valuenow', String(Math.round(norm * 100) / 100));
    el.classList.toggle('active', Math.abs(norm) > 0.001);
}

function clampParam(key, value) {
    if (!Number.isFinite(value)) return value;
    if (key === PITCH_BEND_KEY) {
        const range = getBendRangeSemitones();
        return Math.max(-range, Math.min(range, value));
    }
    if (getParam(key)?.type === 'range') return clampToCatalog(key, value);
    const input = resolveInput(key);
    if (!input) return value;
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return value;
    return Math.max(min, Math.min(max, value));
}

function laneHasData(key) {
    const lane = lanes[key];
    if (!lane) return false;
    return lane.samples.some((s) => s != null);
}

function firstLaneSample(key) {
    const lane = lanes[key];
    if (!lane) return null;
    for (let i = 0; i < RESOLUTION; i++) {
        if (lane.samples[i] != null) return lane.samples[i];
    }
    return null;
}

/** Curve at phase plus Rec-off offset, clamped to the control range. */
function playedValueAtPhase(key, phase) {
    const curve = valueAtPhase(key, phase);
    if (curve == null) return null;
    return clampParam(key, curve + (offsets.get(key) || 0));
}

/**
 * Rec off: keep the recorded shape, shift baseline so the control matches
 * the user's value at the current (or reference) phase.
 */
function applyManualOffset(key, userValue) {
    if (!Number.isFinite(userValue) || !laneHasData(key)) return;
    if (!historyLocked && !offsetGestureBefore.has(key)) {
        offsetGestureBefore.set(key, snapshotLane(key));
    }
    const phase = state.isPlaying ? getPhase() : 0;
    let curve = valueAtPhase(key, phase);
    if (curve == null) curve = firstLaneSample(key);
    if (curve == null) return;
    offsets.set(key, userValue - curve);
    lastApplied.delete(key);
}

function setParamValue(key, value) {
    if (value == null || !Number.isFinite(value)) return;
    value = clampParam(key, value);
    if (SNAP_KEYS.has(key)) value = Math.round(value);

    const prev = lastApplied.get(key);
    if (prev != null && Math.abs(prev - value) < 1e-5) return;
    lastApplied.set(key, value);

    if (key === PITCH_BEND_KEY) {
        applying = true;
        try {
            setPitchBendVisual(value);
            applyPitchBend(value, { ramp: 0.008 });
        } finally {
            applying = false;
        }
        return;
    }
    applying = true;
    try {
        setParam(key, value);
    } finally {
        applying = false;
    }
}

/**
 * Smooth read: lerp between surrounding non-null samples along the loop.
 * Before the first written sample in the loop → null (leave control alone).
 * After the last sample → hold that value.
 */
function valueAtPhase(key, phase) {
    const lane = lanes[key];
    if (!lane) return null;
    const samples = lane.samples;
    const exact = Math.max(0, Math.min(RESOLUTION - 1e-9, phase * RESOLUTION));
    const iFloor = Math.floor(exact);

    let leftIdx = -1;
    for (let i = iFloor; i >= 0; i--) {
        if (samples[i] != null) {
            leftIdx = i;
            break;
        }
    }
    if (leftIdx < 0) return null;

    let rightIdx = -1;
    for (let i = leftIdx + 1; i < RESOLUTION; i++) {
        if (samples[i] != null) {
            rightIdx = i;
            break;
        }
    }

    const left = samples[leftIdx];
    if (rightIdx < 0) return left;

    const right = samples[rightIdx];
    if (exact <= leftIdx) return left;
    if (exact >= rightIdx) return right;

    const t = (exact - leftIdx) / (rightIdx - leftIdx);
    return left + (right - left) * t;
}

/** Clear punch-in region so a new take fully replaces old data to loop end. */
function clearLaneFromIndex(key, fromIdx) {
    const lane = ensureLane(key);
    const start = Math.max(0, Math.min(RESOLUTION - 1, fromIdx));
    for (let i = start; i < RESOLUTION; i++) {
        lane.samples[i] = null;
    }
}

/**
 * Write value at phase, filling every bucket from the previous write index
 * so retakes can't leave stale samples between frames.
 */
function writeSample(key, phase, value) {
    if (value == null || !Number.isFinite(value)) return;
    const lane = ensureLane(key);
    const idx = phaseIndex(phase);

    if (takeWriteIndex.has(key)) {
        const prev = takeWriteIndex.get(key);
        if (idx >= prev) {
            for (let i = prev; i <= idx; i++) {
                lane.samples[i] = value;
            }
        } else {
            // Unexpected backward jump mid-take — replace this bucket only
            lane.samples[idx] = value;
        }
    } else {
        lane.samples[idx] = value;
    }
    takeWriteIndex.set(key, idx);
}

function highlightTargetForKey(key, fromEl) {
    if (fromEl) {
        const knob = fromEl.closest?.('.synth-knob');
        if (knob) return knob;
        const control = fromEl.closest?.('.control');
        if (control) return control;
        if (fromEl.id === 'keyboardPitchBend' || fromEl.closest?.('#keyboardPitchBend')) {
            return document.getElementById('keyboardPitchBend');
        }
        if (fromEl.id === 'keyboardMasterTune' || fromEl.id === 'kbTuningMasterTune'
            || fromEl.id === 'kbXyTuningMasterTune'
            || fromEl.closest?.('.keyboard-master-tune')) {
            return fromEl.closest('.keyboard-master-tune') || fromEl;
        }
    }
    if (key === PITCH_BEND_KEY) return document.getElementById('keyboardPitchBend');
    if (key === 'masterTune') {
        return document.querySelector('.keyboard-master-tune')
            || document.getElementById('masterTune')?.closest('.control');
    }
    const touched = lastTouch && lastTouch.key === key && performance.now() - lastTouch.at < 2000
        ? lastTouch.host : null;
    if (touched?.isConnected) return touched.closest?.('.synth-knob, .ingy6-fader, .control') || touched;
    const input = resolveInput(key);
    if (!input) return null;
    const kbKnob = document.querySelector(`.synth-knob[data-param="${key}"]`);
    if (kbKnob) return kbKnob;
    const kbCtl = document.querySelector(`.keyboard-pattern-ctl[data-param="${key}"]`);
    if (kbCtl) return kbCtl;
    if (key.startsWith('osc-vol-')) {
        const osc = key.slice(8);
        return document.querySelector(`#kbOsc${parseInt(osc, 10) + 1}VolKnob`)?.closest('.synth-knob')
            || input.closest('.control');
    }
    if (key.startsWith('osc-tune-')) {
        const osc = key.slice(9);
        return document.querySelector(`#kbOsc${parseInt(osc, 10) + 1}TuneKnob`)?.closest('.synth-knob')
            || input.closest('.control');
    }
    if (key.startsWith('osc-pan-')) {
        const osc = key.slice(8);
        return document.querySelector(`.kb-osc-pan[data-osc="${osc}"]`)?.closest('.keyboard-osc-pan-row')
            || input.closest('.control');
    }
    if (key.startsWith('osc-fine-')) {
        return input.closest('.keyboard-osc-fine-row') || input;
    }
    return input.closest('.control') || input;
}

function clearHighlight() {
    if (highlightEl) {
        highlightEl.classList.remove('automation-highlight');
        highlightEl = null;
    }
    highlightKey = null;
}

function setHighlight(key, fromEl) {
    if (!armed) return;
    const target = highlightTargetForKey(key, fromEl);
    if (!target) return;
    if (highlightEl === target && highlightKey === key) return;
    clearHighlight();
    highlightKey = key;
    highlightEl = target;
    target.classList.add('automation-highlight');
}

function punchOutAllTakes() {
    if (!activeTakes.size) return;
    const keys = [...activeTakes];
    keys.forEach((key) => {
        const before = takeBefore.get(key);
        if (before && !historyLocked) {
            const after = snapshotLane(key);
            if (!snapshotsEqual(before, after)) {
                pushHistory({ type: 'lane', key, before, after });
            }
        }
        takeBefore.delete(key);
    });
    activeTakes.clear();
    takeValues.clear();
    takeWriteIndex.clear();
    clearHighlight();
    dispatchAutomationChanged();
}

function beginTake(key, fromEl) {
    if (!key || !canEngageTake()) {
        if (armed && key) setHighlight(key, fromEl);
        return;
    }
    // Snapshot once per take cycle (retake keeps original before-state)
    if (!takeBefore.has(key)) {
        takeBefore.set(key, snapshotLane(key));
    }
    const phase = getPhase();
    // Punch-in replace: wipe this param from here to loop end, then write fresh
    clearLaneFromIndex(key, phaseIndex(phase));
    takeWriteIndex.delete(key);
    lastApplied.delete(key);
    // New absolute take — drop any Rec-off baseline shift
    offsets.delete(key);

    activeTakes.add(key);
    setHighlight(key, fromEl);
    const v = getParamValue(key);
    if (v != null) {
        takeValues.set(key, v);
        writeSample(key, phase, v);
    }
    refreshParamStatusIndicators(key);
}

function setArmed(next) {
    armed = !!next;
    const btn = document.getElementById('kbAutomationRecord');
    if (btn) {
        btn.classList.toggle('off', !armed);
        btn.classList.toggle('active', armed);
        btn.setAttribute('aria-pressed', armed ? 'true' : 'false');
    }
    document.body.classList.toggle('automation-mode-active', armed);
    if (!armed) {
        punchOutAllTakes();
    }
    if (armed && state.midiMappingMode) {
        document.getElementById('midiMapping')?.click();
    }
}

function clearAllLanes() {
    commitOffsetGestures();
    // Drop in-progress takes without committing — Clear replaces them
    if (activeTakes.size) abandonActiveTakes();

    const keys = Object.keys(lanes);
    if (!keys.length && !offsets.size) return;

    const beforeLanes = snapshotAllLanes();
    const beforeOffsets = snapshotAllOffsets();
    pushHistory({
        type: 'clear',
        beforeLanes,
        beforeOffsets,
        afterLanes: {},
        afterOffsets: {},
    });

    keys.forEach((k) => delete lanes[k]);
    lastApplied.clear();
    offsets.clear();
    keys.forEach((k) => refreshParamStatusIndicators(k));
    refreshParamStatusIndicators();
    dispatchAutomationChanged();
}

function keyFromEventTarget(target) {
    if (!target || !(target instanceof Element)) return null;
    // Sequencer transport, step write, steps grid — never record
    if (isBlockedAutomationUi(target)) return null;
    if (target.id === 'keyboardPitchBend' || target.closest?.('#keyboardPitchBend')) {
        return PITCH_BEND_KEY;
    }
    const dial = target.closest?.('.synth-knob-dial');
    if (dial) {
        if (dial.id === 'kbWriteFineKnob') return null;
        if (isBlockedAutomationUi(dial)) return null;
        const knob = dial.closest('.synth-knob');
        const param = knob?.dataset?.param;
        if (param === 'write-fine') return null;
        if (param === 'tempo' || param === 'division' || param === 'steps') {
            return null;
        }
        if (param === 'lfoSpeed' && get('lfoSyncToggle')) return 'lfoSyncDivision';
        if (param === 'scTimeMs' && get('scTimeSyncToggle')) return 'scTimeSyncDivision';
        if (isAutomatableKey(param)) return param;
        const dialId = dial.id || '';
        if (dialId.startsWith('kbStepTuneDial') || dialId === 'kbWriteFineKnob'
            || dialId === 'kbTempoKnob' || dialId === 'kbDivisionKnob' || dialId === 'kbStepsKnob') {
            return null;
        }
        const oscTune = dialId.match(/^kbOsc(\d)TuneKnob$/);
        if (oscTune) return `osc-tune-${parseInt(oscTune[1], 10) - 1}`;
        const oscVol = dialId.match(/^kbOsc(\d)VolKnob$/);
        if (oscVol) return `osc-vol-${parseInt(oscVol[1], 10) - 1}`;
        if (dialId === 'kbUnisonDetuneKnob') return 'unisonDetune';
        if (dialId === 'kbCompThresholdKnob') return 'compThreshold';
        if (dialId === 'kbScDepthKnob') return 'scDepth';
        if (dialId === 'kbScTimeKnob') return get('scTimeSyncToggle') ? 'scTimeSyncDivision' : 'scTimeMs';
    }
    if (target.id === 'keyboardMasterTune' || target.id === 'kbTuningMasterTune'
        || target.id === 'kbXyTuningMasterTune') return 'masterTune';
    if (target.matches?.('input[type="range"]')) return paramKeyFromInput(target);
    const range = target.closest?.('input[type="range"]');
    if (range) return paramKeyFromInput(range);
    return null;
}

function tick() {
    rafId = 0;
    if (!state.isPlaying || !state.audioContext) return;

    const phase = getPhase();

    // Backup wrap detect (in case anchor callback is missed)
    if (lastPhase > 0.85 && phase < 0.15) {
        punchOutAllTakes();
    }
    lastPhase = phase;

    // Latch: keep writing active takes at current phase (even after release)
    activeTakes.forEach((key) => {
        const v = takeValues.has(key) ? takeValues.get(key) : getParamValue(key);
        writeSample(key, phase, v);
    });

    // Playback for params not mid-take (curve + Rec-off offset)
    Object.keys(lanes).forEach((key) => {
        if (activeTakes.has(key)) return;
        const v = playedValueAtPhase(key, phase);
        if (v != null) setParamValue(key, v);
    });

    // XY dot follows mapped axes only after those params have automation data
    syncXYPadPointer(phase);

    rafId = requestAnimationFrame(tick);
}

/** Move the XY pointer for axes whose lanes are playing (or mid-take). */
function syncXYPadPointer(phase) {
    const keys = getXYPadAutomationKeys();
    const axes = { x: false, y: false };
    if (keys.x && lanes[keys.x]
        && (activeTakes.has(keys.x) || valueAtPhase(keys.x, phase) != null)) {
        axes.x = true;
    }
    if (keys.y && lanes[keys.y]
        && (activeTakes.has(keys.y) || valueAtPhase(keys.y, phase) != null)) {
        axes.y = true;
    }
    if (axes.x || axes.y) followXYPadAutomation(axes);
}

function startTicker() {
    if (rafId) return;
    lastPhase = 0;
    rafId = requestAnimationFrame(tick);
}

function stopTicker() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
    }
    punchOutAllTakes();
    lastApplied.clear();
    anchoredOnce = false;
    loopEpoch = 0;
    lastPhase = 0;
}

/**
 * Called from the sequencer when a new loop begins (step 0 at its audio time).
 * Punches out latch takes from the previous loop, then re-anchors phase.
 */
export function notifyAutomationLoopAnchor(audioTime) {
    if (anchoredOnce) {
        punchOutAllTakes();
    }
    loopEpoch = audioTime;
    anchoredOnce = true;
    lastPhase = 0;
    if (state.isPlaying) startTicker();
}

/** @deprecated step API removed — kept so old imports fail softly if cached */
export function applyAutomationForStep() { /* no-op */ }

/** Rotate curves with pattern shift. delta in steps, across the whole Repeat cycle. */
export function rotateAutomationLanes(delta) {
    const n = stepCount();
    const repeat = patternRepeat(getPattern(state.editSlot));
    const cycle = n * repeat;
    if (cycle < 2) return;
    let d = Math.round(Number(delta)) || 0;
    d = ((d % cycle) + cycle) % cycle;
    if (!d) return;
    const shift = Math.round((d / cycle) * RESOLUTION);

    if (!shift) return;
    Object.values(lanes).forEach((lane) => {
        const src = lane.samples.slice();
        for (let i = 0; i < RESOLUTION; i++) {
            lane.samples[i] = src[(i + shift) % RESOLUTION];
        }
    });
    lastApplied.clear();
    dispatchAutomationChanged();
}

export function isAutomationArmed() {
    return armed;
}

function recordableKeys() {
    return Object.keys(PARAMS).filter(isAutomatableKey);
}

function onStoreParam(key, value) {
    if (applying) return;
    if (!isAutomatableKey(key)) return;
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(n)) return;

    // Rec off + existing curve → shift baseline, keep shape
    if (!armed && laneHasData(key)) {
        applyManualOffset(key, n);
        return;
    }
    if (!armed) return;

    // highlightEl belongs to whichever control was grabbed last; only reuse it for that key.
    const fromEl = highlightKey === key ? highlightEl : null;
    if (!activeTakes.has(key)) {
        beginTake(key, fromEl);
    } else if (canEngageTake()) {
        takeValues.set(key, n);
        writeSample(key, getPhase(), n);
        setHighlight(key, fromEl);
    } else {
        setHighlight(key, fromEl);
    }
}

function wireStoreRecording() {
    recordableKeys().forEach((key) => {
        subscribe(key, (value) => onStoreParam(key, value));
    });
}

/** Last knob / fader grab announced by midi-learn (key + host), for latch and highlight. */
let lastTouch = null;

function onControlTouch(e) {
    const key = e.detail?.key;
    if (!isAutomatableKey(key)) return;
    const host = e.detail?.host instanceof Element ? e.detail.host : null;
    lastTouch = { key, host, at: performance.now() };
    if (!armed) return;
    if (host && isBlockedAutomationUi(host)) return;
    if (activeTakes.has(key)) {
        setHighlight(key, host);
        return;
    }
    beginTake(key, host);
}

function onPointerDownCapture(e) {
    if (!armed) return;
    const key = keyFromEventTarget(e.target);
    if (!key) return;
    beginTake(key, e.target instanceof Element ? e.target : null);
}

function onSequencerStart() {
    anchoredOnce = false;
    // Tentative epoch until first step-0 anchor arrives
    if (state.audioContext) {
        loopEpoch = state.audioContext.currentTime + 0.1;
    }
    startTicker();
}

function onSequencerStop() {
    stopTicker();
}

function wireUi() {
    document.querySelectorAll('input[type="range"]').forEach(ensureDisplayStep);

    const recordBtn = document.getElementById('kbAutomationRecord');
    const undoBtn = document.getElementById('kbAutomationUndo');
    const redoBtn = document.getElementById('kbAutomationRedo');
    const clearBtn = document.getElementById('kbAutomationClear');

    recordBtn?.addEventListener('click', () => setArmed(!armed));
    undoBtn?.addEventListener('click', () => undoAutomation());
    redoBtn?.addEventListener('click', () => redoAutomation());
    clearBtn?.addEventListener('click', () => clearAllLanes());
    document.getElementById('kbAutomationCopy')?.addEventListener('click', (e) => {
        copyActiveAutomation(e.currentTarget);
    });
    document.getElementById('kbAutomationPaste')?.addEventListener('click', () => {
        pasteActiveAutomation();
    });

    if (recordBtn) {
        recordBtn.classList.add('off');
        recordBtn.classList.remove('active');
        recordBtn.setAttribute('aria-pressed', 'false');
    }
    updateUndoRedoButtons();
    updateAutomationButtonLabels();
    syncAutomationClipboardUi();

    wireStoreRecording();
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('ingysynth:control-touch', onControlTouch);
    document.addEventListener('pointerup', commitOffsetGestures, true);
    document.addEventListener('pointercancel', commitOffsetGestures, true);
    document.addEventListener('change', commitOffsetGestures, true);
    document.addEventListener('ingysynth:pitch-bend', (e) => {
        if (applying) return;
        const semis = e.detail?.semitones;
        if (!Number.isFinite(semis)) return;
        const el = e.detail?.el || document.getElementById('keyboardPitchBend');
        if (!armed && laneHasData(PITCH_BEND_KEY)) {
            applyManualOffset(PITCH_BEND_KEY, semis);
            return;
        }
        if (!activeTakes.has(PITCH_BEND_KEY)) {
            beginTake(PITCH_BEND_KEY, el);
        } else if (canEngageTake()) {
            writeSample(PITCH_BEND_KEY, getPhase(), semis);
            setHighlight(PITCH_BEND_KEY, el);
        }
    });
    document.addEventListener('ingysynth:sequencer-start', onSequencerStart);
    document.addEventListener('ingysynth:sequencer-stop', onSequencerStop);
    document.addEventListener('ingysynth:pattern-slot', () => {
        if (!state.berlinMode) useAutomationBank(bankKeyFromState());
    });
    document.addEventListener('ingysynth:berlin-slot', () => {
        if (state.berlinMode) useAutomationBank(bankKeyFromState());
    });
    document.addEventListener('ingysynth:berlin-mode', () => {
        useAutomationBank(bankKeyFromState());
    });
}

function recordHasData(rec) {
    if (!rec) return false;
    const laneData = Object.keys(rec.lanes).some((k) => rec.lanes[k]?.samples?.some((s) => s != null));
    return laneData || rec.offsets.size > 0;
}

function snapshotRecord(rec) {
    const laneMap = {};
    Object.keys(rec?.lanes || {}).forEach((k) => {
        laneMap[k] = { samples: rec.lanes[k].samples.slice() };
    });
    const offsetMap = {};
    rec?.offsets?.forEach((v, k) => {
        offsetMap[k] = v;
    });
    return { lanes: laneMap, offsets: offsetMap };
}

/** Automation-only clipboard. Not tied to normal vs Berlin, so a curve can cross modes. */
let automationClipboard = null;

function syncAutomationClipboardUi() {
    const btn = document.getElementById('kbAutomationPaste');
    if (!btn) return;
    const has = !!automationClipboard;
    btn.disabled = !has;
    btn.setAttribute('aria-disabled', has ? 'false' : 'true');
    btn.classList.toggle('is-disabled', !has);
}

function copyActiveAutomation(btn) {
    commitOffsetGestures();
    automationClipboard = snapshotRecord(ensureAutomationBank(activeBankKey));
    flashCopiedToast(btn);
    syncAutomationClipboardUi();
}

function pasteActiveAutomation() {
    if (!automationClipboard) return;
    commitOffsetGestures();
    if (activeTakes.size) abandonActiveTakes();

    const clip = automationClipboard;
    pushHistory({
        type: 'clear',
        beforeLanes: snapshotAllLanes(),
        beforeOffsets: snapshotAllOffsets(),
        afterLanes: clip.lanes,
        afterOffsets: clip.offsets,
    });
    fillRecord(ensureAutomationBank(activeBankKey), clip.lanes, clip.offsets);
    lastApplied.clear();
    refreshParamStatusIndicators();
    dispatchAutomationChanged();
}

export function hasAutomation(bankKey) {
    return recordHasData(automationBanks[bankKey]);
}

export function snapshotBankAutomation(bankKey) {
    const rec = automationBanks[bankKey];
    if (!rec) return { lanes: {}, offsets: {} };
    return snapshotRecord(rec);
}

export function applyBankAutomation(bankKey, snap) {
    const rec = ensureAutomationBank(bankKey);
    fillRecord(rec, snap?.lanes, snap?.offsets);
    if (bankKey === activeBankKey) {
        lastApplied.clear();
        refreshParamStatusIndicators();
    }
    dispatchAutomationChanged();
}

export function initAutomation() {
    setPatternAutomationBridge({
        snapshot: snapshotBankAutomation,
        apply: applyBankAutomation,
        has: hasAutomation,
    });
    bindAutomationStatusSource(
        laneHasData,
        () => Object.keys(lanes).filter((k) => laneHasData(k)),
    );
    wireUi();
    useAutomationBank(bankKeyFromState());
    refreshParamStatusIndicators();
}
