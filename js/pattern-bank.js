// Pattern bank: normal mode is P1–P8 (`state.patterns`). Berlin Dream is a
// separate bank (`state.berlinBank`): 8 patterns, each with all 8 lanes
// (O1–O4 pitch + M1–M4 modulation). The step strip is a view of `editSlot`.
// Repeat Pattern (×1–×8) is stored on each pattern. One cycle = one pass × repeat.
// The first time Berlin opens, each main pattern is copied onto that slot's O1.

import { state } from './state.js?v=120';
import { clampRatch, syncRatchButton } from './step-ratch.js?v=1';
import { getNumber, getString, set } from './params.js?v=40';
import { clampRepeat, nextRepeat, REPEAT_MAX } from './pattern-repeat.js?v=3';

export { clampRepeat, REPEAT_MAX };

/** Total Berlin lanes (and bank array length). */
export const PATTERN_COUNT = 8;
/** Normal-mode P1–P8 slots. */
export const BANK_COUNT = 8;
/** Hidden scratch slot. Not a P1–P8 button and not an entry in those banks. */
export const SONG_SLOT = 8;

function isSongSlot(slot) {
    return (slot | 0) === SONG_SLOT;
}
export const STEP_SLOTS = 32;

export const OSC_LANE_COUNT = 4;
/** Legacy Berlin row index for the old D1 (M2). D-lanes no longer overlay the bank. */
export const DRUM_LANE_START = 5;
export const DRUM_LANE_COUNT = 4;
/** D1 open hat, D2 closed hat, D3 snare, D4 kick. */
export const DRUM_MODELS = ['open_hat', 'hihat', 'snare', 'bass_drum'];
/** 1-indexed On steps for factory D1 / D2 / D3 / D4 (8 steps, 1/8). */
export const FACTORY_DRUM_ONS = [
    [7],
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

/** Bank rows are never drums. D1–D4 live on `state.drumPatterns` (the current drum slot). */
export function isDrumLane(_index) {
    return false;
}

export function drumLaneIndex(row) {
    return (row | 0) - DRUM_LANE_START;
}

export function clampDrumLane(lane) {
    return Math.max(0, Math.min(DRUM_LANE_COUNT - 1, lane | 0));
}

export function canonicalDrumModel(model) {
    return DRUM_MODEL_SET.has(model) ? model : 'hihat';
}

export function defaultDrumPatch(lane = 0) {
    const i = Math.max(0, Math.min(DRUM_LANE_COUNT - 1, lane | 0));
    const model = DRUM_MODELS[i] || 'hihat';
    return {
        engine: 'analog',
        model,
        tune: 0.5,
        harmonics: 0.5,
        morphX: 0.5,
        morphY: model === 'open_hat' ? 0.72 : 0.5,
        alt: false,
        trigPatched: true,
        choke: model === 'open_hat',
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
        choke: model === 'open_hat'
            ? (src?.model === 'open_hat' ? src.choke !== false : true)
            : false,
        vol: Math.max(0, Math.min(1, num(src?.vol, d.vol))),
        pan: Math.max(-1, Math.min(1, num(src?.pan, d.pan))),
    };
}

/** Old 3-lane kits were hat / snare / kick. Those become D2–D4; D1 is a new open hat. */
function shiftLegacyDrumLanes(list, makeFresh) {
    if (!Array.isArray(list)) return null;
    if (list.length === DRUM_LANE_COUNT) return list;
    if (list.length === 3) return [makeFresh(0), list[0], list[1], list[2]];
    return null;
}

export function ensureBerlinDrumKit() {
    const migrated = shiftLegacyDrumLanes(state.berlinDrum, defaultDrumPatch);
    if (migrated) state.berlinDrum = migrated;
    else state.berlinDrum = Array.from({ length: DRUM_LANE_COUNT }, (_, i) => defaultDrumPatch(i));
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

function adoptDrumLanes(list) {
    const migrated = shiftLegacyDrumLanes(list, createDrumPattern);
    if (!Array.isArray(migrated) || migrated.length !== DRUM_LANE_COUNT) return null;
    return migrated;
}

function normalizeDrumLane(p, i) {
    if (!p || typeof p !== 'object') return createDrumPattern(i);
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
    return p;
}

function createDrumBankSlot() {
    return {
        lanes: Array.from({ length: DRUM_LANE_COUNT }, (_, i) => createDrumPattern(i)),
    };
}

function ensureSongDrumLanes() {
    let lanes = state.songDrumLanes;
    if (!Array.isArray(lanes) || lanes.length !== DRUM_LANE_COUNT) {
        lanes = Array.from({ length: DRUM_LANE_COUNT }, (_, i) => createDrumPattern(i));
        state.songDrumLanes = lanes;
    }
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        lanes[i] = normalizeDrumLane(lanes[i], i);
    }
    state.songDrumLanes = lanes;
    return lanes;
}

/**
 * Eight drum patterns. `state.drumPatterns` stays pointed at the current slot's
 * lanes so the scheduler and dock keep reading the same place.
 * Sounds (kit, patch, mix) stay on `state.berlinDrum` / the mixer — not per slot.
 * Slot 8 points at `state.songDrumLanes` and does not rewrite `state.drumBank`.
 */
export function ensureDrumPatterns() {
    const onSong = isSongSlot(state.drumSlot);
    const slot = onSong ? SONG_SLOT : clampBankSlot(state.drumSlot || 0);
    if (!Array.isArray(state.drumBank) || state.drumBank.length !== BANK_COUNT) {
        const legacy = onSong ? null : adoptDrumLanes(state.drumPatterns);
        state.drumBank = Array.from({ length: BANK_COUNT }, (_, s) => (
            s === 0 && legacy ? { lanes: legacy } : createDrumBankSlot()
        ));
    }
    state.drumSlot = slot;
    for (let s = 0; s < BANK_COUNT; s++) {
        const lanes = adoptDrumLanes(state.drumBank[s]?.lanes);
        if (!lanes) {
            state.drumBank[s] = createDrumBankSlot();
            continue;
        }
        for (let i = 0; i < DRUM_LANE_COUNT; i++) {
            lanes[i] = normalizeDrumLane(lanes[i], i);
        }
        if (!onSong || state.drumBank[s]?.lanes !== lanes) {
            state.drumBank[s] = { lanes };
        }
    }
    state.drumPatterns = onSong ? ensureSongDrumLanes() : state.drumBank[state.drumSlot].lanes;
    return state.drumPatterns;
}

export function getDrumPattern(lane) {
    ensureDrumPatterns();
    return state.drumPatterns[clampDrumLane(lane)];
}

/**
 * Point the drum machine at one P1–P8 slot, or the song scratch (8), without
 * touching the synth. Slot 8 does not write `state.drumBank`.
 * `startTime` is the audio-time downbeat the four lanes should restart on.
 * The sequencer listens for `ingysynth:drum-slot` and resets the playheads.
 */
export function setDrumSlot(slot, { startTime } = {}) {
    const next = isSongSlot(slot) ? SONG_SLOT : clampBankSlot(slot);
    state.drumSlot = next;
    ensureDrumPatterns();
    const when = Number(startTime);
    document.dispatchEvent(new CustomEvent('ingysynth:drum-slot', {
        detail: {
            slot: next,
            startTime: Number.isFinite(when) ? when : undefined,
        },
    }));
    return state.drumPatterns;
}

export function isDrumPatternEnabled(lane) {
    return getDrumPattern(lane)?.enabled !== false;
}

function createPattern() {
    return {
        steps: Array.from({ length: STEP_SLOTS }, emptyStep),
        stepCount: 8,
        division: 8,
        reverse: false,
        enabled: true,
        gate: 0.9,
        repeat: 1,
    };
}

function normalizePatternSteps(pattern) {
    if (Array.isArray(pattern.steps)) {
        pattern.steps.forEach((s) => {
            if (s && s.ratch === undefined) s.ratch = 1;
            if (s) s.chord = clampChord(s.chord);
        });
        while (pattern.steps.length < STEP_SLOTS) pattern.steps.push(emptyStep());
    } else {
        pattern.steps = Array.from({ length: STEP_SLOTS }, emptyStep);
    }
}

let bankEnsured = false;

export function ensureBank() {
    if (bankEnsured
        && Array.isArray(state.patterns) && state.patterns.length === PATTERN_COUNT
        && Array.isArray(state.berlinBank) && state.berlinBank.length === BANK_COUNT) {
        return state.patterns;
    }
    if (!Array.isArray(state.patterns)) {
        state.patterns = Array.from({ length: PATTERN_COUNT }, () => createPattern());
    } else if (state.patterns.length < PATTERN_COUNT) {
        while (state.patterns.length < PATTERN_COUNT) {
            state.patterns.push(createPattern());
        }
    } else if (state.patterns.length > PATTERN_COUNT) {
        state.patterns.length = PATTERN_COUNT;
    }

    state.patterns.forEach((p, i) => {
        if (!p) {
            state.patterns[i] = createPattern();
            return;
        }
        if (p.enabled === undefined) p.enabled = true;
        if (p.gate === undefined) p.gate = 0.9;
        else p.gate = clampGate(p.gate);
        p.repeat = clampRepeat(p.repeat);
        // Lane fields belong on Berlin lanes, not the normal bank.
        delete p.destination;
        delete p.laneKind;
        delete p.amount;
        if (p.drum && typeof p.drum === 'object') {
            const lane = Math.max(0, Math.min(DRUM_LANE_COUNT - 1, i - DRUM_LANE_START));
            p.drum = clampDrumPatch(p.drum, lane);
        }
        normalizePatternSteps(p);
    });
    ensureDrumPatterns();
    ensureBerlinDrumKit();
    ensureBerlinBank();
    bankEnsured = true;
    return state.patterns;
}

function ensureSongPattern() {
    if (!state.songPattern || typeof state.songPattern !== 'object') {
        state.songPattern = createPattern();
    }
    return state.songPattern;
}

export function getPattern(slot) {
    ensureBank();
    if (isSongSlot(slot)) return ensureSongPattern();
    return state.patterns[Math.max(0, Math.min(PATTERN_COUNT - 1, slot | 0))];
}

/** Steps that actually play for a pattern (1–32). */
export function patternStepCount(pattern) {
    return Math.max(1, Math.min(STEP_SLOTS, Math.round(pattern?.stepCount) || 8));
}

export function patternGate(pattern) {
    return clampGate(pattern?.gate);
}

/** Repeat Pattern on a normal slot or a Berlin pattern (×1–×8). */
export function patternRepeat(pattern) {
    return clampRepeat(pattern?.repeat);
}

function clampLaneCount(n, fallback) {
    const v = Math.round(Number(n));
    const base = Number.isFinite(v) ? v : fallback;
    return Math.max(1, Math.min(OSC_LANE_COUNT, base));
}

function createBerlinLane(row, { rest = false } = {}) {
    const i = row | 0;
    const osc = isOscLane(i);
    return {
        steps: Array.from({ length: STEP_SLOTS }, rest ? restStep : emptyStep),
        stepCount: 8,
        division: 8,
        reverse: false,
        enabled: true,
        destination: osc ? OSC_DESTINATIONS[i] : (MOD_DESTINATIONS[i - OSC_LANE_COUNT] || 'off'),
        gate: 0.9,
        amount: 1,
        laneKind: osc ? 'osc' : 'mod',
    };
}

function copyLaneClock(lane, src) {
    if (!src) return;
    lane.stepCount = patternStepCount(src);
    lane.division = parseInt(src.division, 10) || 8;
    lane.reverse = !!src.reverse;
    if (src.destination) lane.destination = src.destination;
    lane.gate = clampGate(src.gate);
    lane.amount = lane.laneKind === 'osc'
        ? 1
        : Math.max(0, Math.min(1, Number(src.amount ?? lane.amount ?? 1)));
    lane.enabled = src.enabled !== false;
}

function createBerlinPattern(source = null, restSteps = false) {
    const lanes = [];
    for (let row = 0; row < PATTERN_COUNT; row++) {
        const lane = createBerlinLane(row, { rest: restSteps });
        if (source?.lanes?.[row]) copyLaneClock(lane, source.lanes[row]);
        lanes.push(lane);
    }
    return {
        lanes,
        oscCount: clampLaneCount(source?.oscCount, 3),
        modCount: clampLaneCount(source?.modCount, 1),
        repeat: 1,
    };
}

function normalizeBerlinLane(lane, row) {
    const fresh = createBerlinLane(row);
    if (!lane || typeof lane !== 'object') return fresh;
    if (lane.enabled === undefined) lane.enabled = true;
    lane.gate = clampGate(lane.gate);
    lane.stepCount = patternStepCount(lane);
    lane.division = parseInt(lane.division, 10) || 8;
    lane.reverse = !!lane.reverse;
    if (isOscLane(row)) {
        lane.destination = OSC_DESTINATIONS[row];
        lane.amount = 1;
        lane.laneKind = 'osc';
    } else {
        lane.laneKind = 'mod';
        lane.amount = Math.max(0, Math.min(1, Number(lane.amount ?? 1)));
        if (!MOD_DESTINATIONS.includes(lane.destination)) {
            lane.destination = fresh.destination;
        }
    }
    if (Array.isArray(lane.steps)) {
        lane.steps.forEach((s) => {
            if (s && s.ratch === undefined) s.ratch = 1;
            if (s) s.chord = clampChord(s.chord);
        });
        while (lane.steps.length < STEP_SLOTS) lane.steps.push(emptyStep());
    } else {
        lane.steps = fresh.steps;
    }
    return lane;
}

function normalizeBerlinPattern(pattern) {
    pattern.oscCount = clampLaneCount(pattern.oscCount, 3);
    pattern.modCount = clampLaneCount(pattern.modCount, 1);
    pattern.repeat = clampRepeat(pattern.repeat);
    if (!Array.isArray(pattern.lanes)) pattern.lanes = [];
    for (let row = 0; row < PATTERN_COUNT; row++) {
        pattern.lanes[row] = normalizeBerlinLane(pattern.lanes[row], row);
    }
    pattern.lanes.length = PATTERN_COUNT;
    return pattern;
}

function berlinPatternShapeOk(pattern) {
    return !!pattern && Array.isArray(pattern.lanes) && pattern.lanes.length === PATTERN_COUNT;
}

let berlinEnsured = false;

/** Eight Berlin patterns. Every pattern starts with all steps on; P2–P8 copy P1's clock. */
export function ensureBerlinBank() {
    if (berlinEnsured
        && Array.isArray(state.berlinBank) && state.berlinBank.length === BANK_COUNT) {
        return state.berlinBank;
    }
    if (!Array.isArray(state.berlinBank) || state.berlinBank.length !== BANK_COUNT) {
        const first = createBerlinPattern();
        state.berlinBank = [first];
        for (let i = 1; i < BANK_COUNT; i++) {
            state.berlinBank.push(createBerlinPattern(first));
        }
    }
    if (!berlinPatternShapeOk(state.berlinBank[0])) {
        state.berlinBank[0] = createBerlinPattern();
    }
    for (let i = 1; i < BANK_COUNT; i++) {
        if (!berlinPatternShapeOk(state.berlinBank[i])) {
            state.berlinBank[i] = createBerlinPattern(state.berlinBank[0]);
        }
    }
    state.berlinBank.forEach((p) => normalizeBerlinPattern(p));
    if (!isSongSlot(state.berlinSlot)
        && ((state.berlinSlot | 0) < 0 || (state.berlinSlot | 0) >= BANK_COUNT)) {
        state.berlinSlot = 0;
    }
    berlinEnsured = true;
    return state.berlinBank;
}

function ensureSongBerlinPattern() {
    if (!berlinPatternShapeOk(state.songBerlinPattern)) {
        state.songBerlinPattern = createBerlinPattern();
    }
    return normalizeBerlinPattern(state.songBerlinPattern);
}

export function getBerlinPattern(slot = state.berlinSlot) {
    ensureBerlinBank();
    if (isSongSlot(slot)) return ensureSongBerlinPattern();
    const i = Math.max(0, Math.min(BANK_COUNT - 1, slot | 0));
    return state.berlinBank[i];
}

export function getBerlinLane(row, slot = state.berlinSlot) {
    const pattern = getBerlinPattern(slot);
    const i = Math.max(0, Math.min(PATTERN_COUNT - 1, row | 0));
    if (!pattern.lanes[i]) pattern.lanes[i] = createBerlinLane(i);
    return pattern.lanes[i];
}

let berlinO1Seeded = false;

/**
 * First Berlin open: copy each main-stage pattern onto that slot's O1 lane.
 * Steps, clock, gate, repeat, and automation come across. Later opens keep
 * whatever Berlin has become. O2–O4 and the mod lanes stay as they are.
 */
export function seedBerlinO1FromMain() {
    if (berlinO1Seeded) return false;
    ensureBank();
    ensureBerlinBank();
    for (let slot = 0; slot < BANK_COUNT; slot++) {
        const src = state.patterns[slot];
        const berlin = state.berlinBank[slot];
        const lane = berlin.lanes[0];
        lane.steps = cloneSteps(src.steps);
        lane.stepCount = patternStepCount(src);
        lane.division = parseInt(src.division, 10) || 8;
        lane.reverse = !!src.reverse;
        lane.gate = clampGate(src.gate);
        lane.enabled = src.enabled !== false;
        lane.destination = OSC_DESTINATIONS[0];
        lane.amount = 1;
        lane.laneKind = 'osc';
        berlin.repeat = patternRepeat(src);
        const snap = automationBridge?.snapshot?.(normalBankKey(slot));
        if (snap) automationBridge.apply?.(berlinBankKey(slot), snap);
    }
    berlinO1Seeded = true;
    return true;
}

function normalBankKey(slot) {
    return `n${Math.max(0, Math.min(BANK_COUNT - 1, slot | 0))}`;
}

function berlinBankKey(slot) {
    return `b${Math.max(0, Math.min(BANK_COUNT - 1, slot | 0))}`;
}

/** Automation snapshot hooks. Registered by automation.js (avoids an import cycle). */
let automationBridge = null;

export function setPatternAutomationBridge(bridge) {
    automationBridge = bridge || null;
}

export function patternHasAutomation(slot, berlin = !!state.berlinMode) {
    const key = berlin ? berlinBankKey(slot) : normalBankKey(slot);
    return !!automationBridge?.has?.(key);
}

// --- Clipboard --------------------------------------------------------------
// The step clipboard is shared with Berlin lanes and individual drum lanes
// (copyBerlinLane / copyDrumPatternContent / pasteDrumPatternContent), so a
// row of steps can land on a synth pattern, a Berlin lane, or one drum lane.
// A P-slot copy does not carry that slot's drums. The whole D1–D4 pattern
// has its own clipboard (copyDrumBank / pasteDrumBank / clearDrumBank).
// Copy P1 / Paste P1 / Clear P1 copies the current synth pattern, or the
// whole Berlin pattern.

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

function emptyAutomationSnap() {
    return { lanes: {}, offsets: {} };
}

/** Deep copy of one drum slot's four lanes. Slot 8 reads the song scratch. */
export function snapshotDrumSlot(slot) {
    const lanes = isSongSlot(slot)
        ? ensureSongDrumLanes()
        : (ensureDrumPatterns(), state.drumBank[clampBankSlot(slot)]?.lanes || []);
    return lanes.map((lane) => ({
        steps: cloneSteps(lane.steps),
        stepCount: patternStepCount(lane),
        division: parseInt(lane.division, 10) || 8,
        reverse: !!lane.reverse,
        enabled: lane.enabled !== false,
        gate: clampGate(lane.gate),
    }));
}

/** Deep-write four drum lanes. Slot 8 writes `songDrumLanes` only. */
export function writeDrumSlot(slot, lanes) {
    if (!Array.isArray(lanes)) return;
    const song = isSongSlot(slot);
    if (!song) ensureDrumPatterns();
    const next = song ? SONG_SLOT : clampBankSlot(slot);
    const dest = song ? ensureSongDrumLanes() : state.drumBank[next].lanes;
    lanes.forEach((snap, i) => {
        const lane = dest[i];
        if (!lane || !snap) return;
        lane.steps = cloneSteps(snap.steps);
        lane.stepCount = snap.stepCount;
        lane.division = snap.division;
        lane.reverse = !!snap.reverse;
        lane.enabled = snap.enabled !== false;
        lane.gate = clampGate(snap.gate);
    });
    if (next !== (state.drumSlot | 0)) return;
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        const ph = state.drumPlayheads?.[i];
        if (!ph || !Number.isFinite(ph.currentStep)) continue;
        ph.currentStep = Math.min(ph.currentStep, patternStepCount(dest[i]) - 1);
    }
}

/** Whole P1–P8 drum pattern. Separate from the step clipboard. */
let drumBankClipboard = null;

export function hasDrumBankClipboard() {
    return !!drumBankClipboard;
}

export function copyDrumBank(slot = state.drumSlot) {
    drumBankClipboard = snapshotDrumSlot(slot);
    return true;
}

/** @returns {boolean} false when nothing has been copied. */
export function pasteDrumBank(slot = state.drumSlot) {
    if (!drumBankClipboard) return false;
    writeDrumSlot(slot, drumBankClipboard);
    return true;
}

/** Rests on D1–D4. Keeps each lane's stepCount, division, reverse, gate, and enabled. */
export function clearDrumBank(slot = state.drumSlot) {
    const song = isSongSlot(slot);
    if (!song) ensureDrumPatterns();
    const dest = song ? ensureSongDrumLanes() : state.drumBank[clampBankSlot(slot)].lanes;
    for (let i = 0; i < DRUM_LANE_COUNT; i++) {
        const lane = dest[i];
        if (!lane) continue;
        if (!Array.isArray(lane.steps)) lane.steps = [];
        for (let s = 0; s < STEP_SLOTS; s++) lane.steps[s] = restStep();
    }
    return true;
}

function automationKey(kind, slot) {
    if (isSongSlot(slot)) return null;
    if (kind === 'b') return berlinBankKey(slot);
    if (kind === 'n') return normalBankKey(slot);
    return null;
}

/** Snapshot a normal pattern: steps, clock, repeat, and automation. Drums stay put. */
export function copyPatternContent(slot) {
    const pattern = getPattern(slot);
    const key = automationKey('n', slot);
    patternClipboard = {
        kind: 'pattern',
        source: `P${(slot | 0) + 1}`,
        steps: cloneSteps(pattern.steps),
        stepCount: patternStepCount(pattern),
        division: parseInt(pattern.division, 10) || 8,
        reverse: !!pattern.reverse,
        amount: 1,
        gate: clampGate(pattern.gate),
        repeat: patternRepeat(pattern),
        automation: (key && automationBridge?.snapshot?.(key)) || emptyAutomationSnap(),
    };
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'copy', slot },
    }));
    return true;
}

/** Paste into a normal slot. Lane copies bring steps and clock, not repeat or automation. */
export function pastePatternContent(slot) {
    if (!patternClipboard) return false;
    const pattern = getPattern(slot);
    pattern.steps = cloneSteps(patternClipboard.steps);
    pattern.stepCount = patternClipboard.stepCount;
    pattern.division = patternClipboard.division;
    pattern.reverse = !!patternClipboard.reverse;
    pattern.gate = clampGate(patternClipboard.gate ?? pattern.gate);
    if (patternClipboard.kind !== 'lane') {
        pattern.repeat = clampRepeat(patternClipboard.repeat);
        const key = automationKey('n', slot);
        if (key) {
            automationBridge?.apply?.(
                key,
                patternClipboard.automation || emptyAutomationSnap(),
            );
        }
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'paste', slot },
    }));
    return true;
}

/** One Berlin lane (steps + clock). Shares the step clipboard with normal patterns. */
export function copyBerlinLane(row, slot = state.berlinSlot) {
    const pattern = getBerlinLane(row, slot);
    const laneName = isOscLane(row)
        ? `OSC ${(row | 0) + 1}`
        : `MOD ${(row | 0) - OSC_LANE_COUNT + 1}`;
    patternClipboard = {
        kind: 'lane',
        source: laneName,
        steps: cloneSteps(pattern.steps),
        stepCount: patternStepCount(pattern),
        division: parseInt(pattern.division, 10) || 8,
        reverse: !!pattern.reverse,
        amount: Math.max(0, Math.min(1, Number(pattern.amount ?? 1))),
        gate: clampGate(pattern.gate),
    };
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'copy', slot: `b${(slot | 0) + 1}-lane${(row | 0) + 1}` },
    }));
    return true;
}

export function pasteBerlinLane(row, slot = state.berlinSlot) {
    if (!patternClipboard) return false;
    const pattern = getBerlinLane(row, slot);
    pattern.steps = cloneSteps(patternClipboard.steps);
    pattern.stepCount = patternClipboard.stepCount;
    pattern.division = patternClipboard.division;
    pattern.reverse = !!patternClipboard.reverse;
    if (isOscLane(row)) {
        pattern.gate = clampGate(patternClipboard.gate ?? 0.9);
        pattern.amount = 1;
        pattern.destination = OSC_DESTINATIONS[row];
    } else {
        pattern.amount = Math.max(0, Math.min(1, Number(patternClipboard.amount ?? 1)));
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'paste', slot: `b${(slot | 0) + 1}-lane${(row | 0) + 1}` },
    }));
    return true;
}

export function clearBerlinLane(row, slot = state.berlinSlot) {
    const pattern = getBerlinLane(row, slot);
    for (let i = 0; i < STEP_SLOTS; i++) pattern.steps[i] = emptyStep();
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'clear', slot: `b${(slot | 0) + 1}-lane${(row | 0) + 1}` },
    }));
}

export function copyDrumPatternContent(lane) {
    const pattern = getDrumPattern(lane);
    patternClipboard = {
        kind: 'lane',
        source: `DRM ${clampDrumLane(lane) + 1}`,
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

/** Reset step slots only — clock / repeat / mute stay put. */
export function clearPatternSteps(slot) {
    const pattern = getPattern(slot);
    for (let i = 0; i < STEP_SLOTS; i++) {
        pattern.steps[i] = emptyStep();
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'clear', slot },
    }));
}

/** @type {null | { kind: 'berlin', lanes: object[], oscCount: number, modCount: number, repeat: number, automation: object }} */
let berlinPatternClipboard = null;

function cloneBerlinLaneRecord(lane, row) {
    const src = lane || createBerlinLane(row);
    return {
        steps: cloneSteps(src.steps),
        stepCount: patternStepCount(src),
        division: parseInt(src.division, 10) || 8,
        reverse: !!src.reverse,
        enabled: src.enabled !== false,
        destination: src.destination,
        gate: clampGate(src.gate),
        amount: Math.max(0, Math.min(1, Number(src.amount ?? 1))),
        laneKind: isOscLane(row) ? 'osc' : 'mod',
    };
}

export function hasBerlinPatternClipboard() {
    return !!berlinPatternClipboard;
}

/** Whole Berlin pattern — not interchangeable with a normal P1–P8 copy. */
export function copyBerlinPattern(slot = state.berlinSlot) {
    const pattern = getBerlinPattern(slot);
    const key = automationKey('b', slot);
    berlinPatternClipboard = {
        kind: 'berlin',
        source: `P${(slot | 0) + 1}`,
        lanes: pattern.lanes.map((lane, row) => cloneBerlinLaneRecord(lane, row)),
        oscCount: pattern.oscCount,
        modCount: pattern.modCount,
        repeat: patternRepeat(pattern),
        automation: (key && automationBridge?.snapshot?.(key)) || emptyAutomationSnap(),
    };
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'copy', slot: `berlin-${(slot | 0) + 1}` },
    }));
    return true;
}

export function pasteBerlinPattern(slot = state.berlinSlot) {
    if (!berlinPatternClipboard) return false;
    const pattern = getBerlinPattern(slot);
    berlinPatternClipboard.lanes.forEach((lane, row) => {
        const dest = getBerlinLane(row, slot);
        dest.steps = cloneSteps(lane.steps);
        dest.stepCount = lane.stepCount;
        dest.division = lane.division;
        dest.reverse = !!lane.reverse;
        dest.enabled = lane.enabled !== false;
        dest.gate = clampGate(lane.gate);
        dest.amount = isOscLane(row) ? 1 : Math.max(0, Math.min(1, Number(lane.amount ?? 1)));
        dest.destination = isOscLane(row) ? OSC_DESTINATIONS[row] : (lane.destination || dest.destination);
        dest.laneKind = isOscLane(row) ? 'osc' : 'mod';
    });
    pattern.oscCount = clampLaneCount(berlinPatternClipboard.oscCount, 3);
    pattern.modCount = clampLaneCount(berlinPatternClipboard.modCount, 1);
    pattern.repeat = clampRepeat(berlinPatternClipboard.repeat);
    state.berlinOscCount = pattern.oscCount;
    state.berlinModCount = pattern.modCount;
    const key = automationKey('b', slot);
    if (key) {
        automationBridge?.apply?.(
            key,
            berlinPatternClipboard.automation || emptyAutomationSnap(),
        );
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'paste', slot: `berlin-${(slot | 0) + 1}` },
    }));
    return true;
}

/** Clear every lane's steps. Clock, lane counts, and repeat stay. */
export function clearBerlinPattern(slot = state.berlinSlot) {
    for (let row = 0; row < PATTERN_COUNT; row++) {
        const lane = getBerlinLane(row, slot);
        for (let i = 0; i < STEP_SLOTS; i++) lane.steps[i] = emptyStep();
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'clear', slot: `berlin-${(slot | 0) + 1}` },
    }));
}

function copyNormalFields(pattern, data) {
    pattern.steps = cloneSteps(data?.steps);
    pattern.stepCount = patternStepCount(data);
    pattern.division = parseInt(data?.division, 10) || 8;
    pattern.reverse = !!data?.reverse;
    pattern.gate = clampGate(data?.gate ?? pattern.gate);
    pattern.repeat = clampRepeat(data?.repeat);
    if (data && data.enabled !== undefined) pattern.enabled = data.enabled !== false;
}

function copyBerlinFields(slot, data) {
    const pattern = getBerlinPattern(slot);
    const lanes = Array.isArray(data?.lanes) ? data.lanes : [];
    lanes.forEach((lane, row) => {
        if (row >= PATTERN_COUNT) return;
        const dest = getBerlinLane(row, slot);
        dest.steps = cloneSteps(lane.steps);
        dest.stepCount = patternStepCount(lane);
        dest.division = parseInt(lane.division, 10) || 8;
        dest.reverse = !!lane.reverse;
        dest.enabled = lane.enabled !== false;
        dest.gate = clampGate(lane.gate);
        dest.amount = isOscLane(row) ? 1 : Math.max(0, Math.min(1, Number(lane.amount ?? 1)));
        dest.destination = isOscLane(row) ? OSC_DESTINATIONS[row] : (lane.destination || dest.destination);
        dest.laneKind = isOscLane(row) ? 'osc' : 'mod';
    });
    pattern.oscCount = clampLaneCount(data?.oscCount, pattern.oscCount ?? 3);
    pattern.modCount = clampLaneCount(data?.modCount, pattern.modCount ?? 1);
    pattern.repeat = clampRepeat(data?.repeat ?? pattern.repeat);
    return pattern;
}

function applySlotAutomation(kind, slot, automation) {
    if (automation === undefined) return;
    if (kind !== 'n' && kind !== 'b') return;
    const key = automationKey(kind, slot);
    if (!key) return;
    automationBridge?.apply?.(key, automation);
}

function revealSynthSlot(kind, slot) {
    if (kind === 'n' && !state.berlinMode && (state.editSlot | 0) === (slot | 0)) {
        hydratePatternToDom(slot);
        syncPatternSlotUi();
        return;
    }
    if (kind === 'b' && state.berlinMode && (state.berlinSlot | 0) === (slot | 0)) {
        const pattern = getBerlinPattern(slot);
        state.berlinOscCount = pattern.oscCount;
        state.berlinModCount = pattern.modCount;
        syncPatternSlotUi();
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-slot', {
            detail: { slot },
        }));
    }
}

/** Deep copy of a normal or Berlin slot, including the song scratch. */
export function snapshotSynthSlot(kind, slot) {
    if (kind === 'b') {
        const pattern = getBerlinPattern(slot);
        return {
            lanes: pattern.lanes.map((lane, row) => cloneBerlinLaneRecord(lane, row)),
            oscCount: pattern.oscCount,
            modCount: pattern.modCount,
            repeat: patternRepeat(pattern),
        };
    }
    if (kind !== 'n') return null;
    const pattern = getPattern(slot);
    return {
        steps: cloneSteps(pattern.steps),
        stepCount: patternStepCount(pattern),
        division: parseInt(pattern.division, 10) || 8,
        reverse: !!pattern.reverse,
        gate: clampGate(pattern.gate),
        repeat: patternRepeat(pattern),
        enabled: pattern.enabled !== false,
    };
}

/**
 * Deep-write a normal or Berlin slot.
 * `automation` is applied for P1–P8 (n0–n7 / b0–b7) when it is not undefined.
 * Slot 8 has no automation key.
 */
export function writeSynthSlot(kind, slot, data, automation) {
    if (kind === 'n') {
        copyNormalFields(getPattern(slot), data);
        applySlotAutomation('n', slot, automation);
        revealSynthSlot('n', slot);
        return true;
    }
    if (kind === 'b') {
        copyBerlinFields(slot, data);
        applySlotAutomation('b', slot, automation);
        revealSynthSlot('b', slot);
        return true;
    }
    return false;
}

/** Deep-copy into the song scratch only. Does not select a slot or dispatch. */
export function loadSongSlot(kind, data) {
    if (kind === 'n') {
        copyNormalFields(ensureSongPattern(), data);
        return true;
    }
    if (kind === 'b') {
        copyBerlinFields(SONG_SLOT, data);
        return true;
    }
    if (kind === 'd') {
        const lanes = Array.isArray(data) ? data : data?.lanes;
        if (!Array.isArray(lanes)) return false;
        writeDrumSlot(SONG_SLOT, lanes);
        return true;
    }
    return false;
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        const text = JSON.stringify(value);
        return text === undefined ? 'null' : text;
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function plainRecord(value) {
    if (!value) return {};
    if (value instanceof Map) {
        const out = {};
        value.forEach((item, key) => { out[key] = item; });
        return out;
    }
    if (typeof value === 'object') return value;
    return {};
}

function automationForHash(kind, slot) {
    const key = automationKey(kind, slot);
    if (!key || !automationBridge?.snapshot) return emptyAutomationSnap();
    const snap = automationBridge.snapshot(key);
    if (!snap || typeof snap !== 'object') return emptyAutomationSnap();
    return {
        lanes: plainRecord(snap.lanes),
        offsets: plainRecord(snap.offsets),
    };
}

/** Stable JSON of steps, clock, repeat, and lanes. Key order does not change the hash. */
export function patternHash(kind, slot) {
    if (kind === 'd') return stableStringify({ lanes: snapshotDrumSlot(slot) });
    if (kind === 'b') {
        const pattern = snapshotSynthSlot('b', slot);
        return stableStringify({
            lanes: pattern?.lanes || [],
            repeat: pattern?.repeat ?? 1,
            oscCount: pattern?.oscCount,
            modCount: pattern?.modCount,
            automation: automationForHash('b', slot),
        });
    }
    const pattern = snapshotSynthSlot('n', slot);
    return stableStringify({
        steps: pattern?.steps || [],
        clock: {
            stepCount: pattern?.stepCount,
            division: pattern?.division,
            reverse: pattern?.reverse,
            gate: pattern?.gate,
        },
        repeat: pattern?.repeat ?? 1,
        automation: automationForHash('n', slot),
    });
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

/** Name on the pattern-select Paste button: the slot in memory, not the slot on screen. */
export function patternSlotPasteLabel() {
    const clip = state.berlinMode ? berlinPatternClipboard : patternClipboard;
    return clip?.source ? `Paste ${clip.source}` : 'Paste';
}

export function syncPatternClipboardUi() {
    const laneHas = hasPatternClipboard();
    const berlinHas = hasBerlinPatternClipboard();
    const slotHas = state.berlinMode ? berlinHas : laneHas;
    document.querySelectorAll('.pattern-paste-btn, .pattern-slot-paste-btn').forEach((btn) => {
        const has = btn.classList.contains('pattern-slot-paste-btn') ? slotHas : laneHas;
        btn.disabled = !has;
        btn.setAttribute('aria-disabled', has ? 'false' : 'true');
        btn.classList.toggle('is-disabled', !has);
    });
    syncPatternClipboardLabels();
}

function syncPatternClipboardLabels() {
    const p = `P${(shownSlot() | 0) + 1}`;
    const copy = document.getElementById('patternSlotCopy');
    const paste = document.getElementById('patternSlotPaste');
    const clearBtn = document.getElementById('patternSlotClear');
    if (copy) {
        const text = `Copy ${p}`;
        copy.textContent = text;
        copy.setAttribute('aria-label', text);
    }
    if (paste) {
        const text = patternSlotPasteLabel();
        paste.textContent = text;
        paste.setAttribute('aria-label', text);
    }
    if (clearBtn) {
        const text = `Clear ${p}`;
        clearBtn.textContent = text;
        clearBtn.setAttribute('aria-label', text);
    }
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
    const toggle = toggleBtn(i);
    const live = getPattern(state.editSlot).steps[i];
    return {
        tune: tune ? (parseInt(tune.value, 10) || 0) : 0,
        fine: fine ? (parseInt(fine.value, 10) || 0) : 0,
        accent: accent ? !accent.classList.contains('off') : false,
        slide: slide ? !slide.classList.contains('off') : false,
        on: toggle ? !toggle.classList.contains('off') : (live?.on !== false),
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
    if (toggle) {
        toggle.classList.toggle('off', !data.on);
        toggle.setAttribute('aria-pressed', data.on ? 'true' : 'false');
    }
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

function clampBankSlot(slot) {
    return Math.max(0, Math.min(BANK_COUNT - 1, slot | 0));
}

function shownSlot() {
    return state.berlinMode ? (state.berlinSlot | 0) : (state.editSlot | 0);
}

function realPendingSlot() {
    return state.berlinMode ? state.berlinPendingSlot : state.pendingEditSlot;
}

/**
 * The queued button keeps flashing until the switch is heard.
 * The audio swap happens at schedule time; this only holds the paint.
 */
let armedVisualSlot = null;
let armedVisualGen = 0;

function pendingSlot() {
    if (armedVisualSlot != null) return armedVisualSlot;
    return realPendingSlot();
}

function clearArmedVisual() {
    armedVisualSlot = null;
    armedVisualGen += 1;
}

function holdArmedVisual(slot, untilTime) {
    armedVisualSlot = slot;
    const gen = ++armedVisualGen;
    syncPatternSlotUi();
    const ctx = state.audioContext;
    const latency = ctx
        ? Math.min(0.5, Math.max(0, (Number(ctx.baseLatency) || 0) + (Number(ctx.outputLatency) || 0)))
        : 0;
    const when = Number(untilTime);
    const delay = ctx && Number.isFinite(when)
        ? Math.max(0, (when + latency - ctx.currentTime) * 1000)
        : 0;
    setTimeout(() => {
        if (gen !== armedVisualGen) return;
        armedVisualSlot = null;
        syncPatternSlotUi();
    }, delay);
}

function shownRepeat() {
    if (state.berlinMode) return patternRepeat(getBerlinPattern(state.berlinSlot));
    return patternRepeat(getPattern(state.editSlot));
}

/** Audio-time window of the pass currently being heard. */
let meterWindow = null;
let meterRaf = 0;

function repeatButton() {
    return document.getElementById('patternRepeatBtn');
}

function syncRepeatButton() {
    const btn = repeatButton();
    if (!btn) return;
    const n = shownRepeat();
    btn.textContent = `x${n}`;
    btn.classList.remove('off');
    btn.setAttribute('aria-pressed', n > 1 ? 'true' : 'false');
    btn.setAttribute('aria-label', n === 1 ? 'Repeat pattern once' : `Repeat pattern ${n} times`);
}

function meterClockNow() {
    const ctx = state.audioContext;
    if (!ctx) return 0;
    const latency = Math.min(0.5, Math.max(0, (Number(ctx.baseLatency) || 0) + (Number(ctx.outputLatency) || 0)));
    return ctx.currentTime - latency;
}

function syncMeterTicks(meter, repeat) {
    const host = meter.querySelector('.pattern-cycle-meter-ticks');
    if (!host) return;
    const n = repeat > 1 ? repeat : 1;
    if (host.dataset.repeat === String(n)) return;
    host.dataset.repeat = String(n);
    host.replaceChildren();
    for (let i = 1; i < n; i++) {
        const tick = document.createElement('span');
        tick.style.left = `${(i / n) * 100}%`;
        host.appendChild(tick);
    }
}

function paintCycleMeter({ playing } = {}) {
    const meter = document.getElementById('patternCycleMeter');
    if (!meter) return;
    const repeat = shownRepeat();
    const pass = playing
        ? Math.max(1, Math.min(repeat, meterWindow?.pass || 1))
        : 1;
    let remaining = 0;
    if (playing) {
        const now = meterClockNow();
        const start = meterWindow?.start;
        const end = meterWindow?.end;
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
            remaining = Math.max(0, Math.min(1, (end - now) / (end - start)));
        } else {
            remaining = 1;
        }
    }
    meter.style.setProperty('--repeat', String(repeat));
    meter.style.setProperty('--pass', String(pass));
    meter.style.setProperty('--remaining', String(remaining));
    meter.classList.toggle('is-playing', !!playing);
    const label = document.getElementById('patternCycleLabel');
    const text = `${pass}/${repeat}`;
    if (label && label.textContent !== text) label.textContent = text;
    meter.setAttribute('aria-valuenow', playing ? remaining.toFixed(3) : '0');
    meter.setAttribute('aria-valuetext', playing
        ? `Repeat ${pass} of ${repeat}, ${Math.round(remaining * 100)}% of this pattern left`
        : 'Stopped');
    syncMeterTicks(meter, repeat);
}

function stopMeterClock() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = 0;
    meterWindow = null;
}

function tickMeter() {
    meterRaf = 0;
    if (!state.isPlaying || !meterWindow) {
        paintCycleMeter({ playing: !!state.isPlaying });
        return;
    }
    paintCycleMeter({ playing: true });
    meterRaf = requestAnimationFrame(tickMeter);
}

function armCycleMeter(detail) {
    if (!state.isPlaying) return;
    const start = Number(detail?.passStart);
    const end = Number(detail?.passEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return;
    const repeat = clampRepeat(detail?.repeat ?? shownRepeat());
    const pass = Math.max(1, Math.min(repeat, Math.round(Number(detail?.pass)) || 1));
    meterWindow = { start, end, pass, repeat };
    if (!meterRaf) meterRaf = requestAnimationFrame(tickMeter);
}

function syncSlotButton(btn, slot) {
    const shown = shownSlot();
    const active = slot === shown && slot >= 0 && slot < BANK_COUNT;
    const armed = pendingSlot() === slot;
    const berlin = !!state.berlinMode;
    btn.classList.toggle('off', !active);
    btn.classList.toggle('is-armed', armed);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (armed) btn.setAttribute('aria-describedby', 'patternQueuedHint');
    else btn.removeAttribute('aria-describedby');

    const dot = btn.querySelector('.pattern-slot-auto');
    if (dot) dot.hidden = !patternHasAutomation(slot, berlin);
}

export function syncPatternSlotUi() {
    slotButtons().forEach((btn) => {
        syncSlotButton(btn, parseInt(btn.dataset.slot, 10));
    });
    syncRepeatButton();
    paintCycleMeter({ playing: !!state.isPlaying });
    syncPatternClipboardLabels();
}

export function setShownPatternRepeat(repeat) {
    const next = clampRepeat(repeat);
    if (state.berlinMode) getBerlinPattern(state.berlinSlot).repeat = next;
    else getPattern(state.editSlot).repeat = next;
    syncPatternSlotUi();
}

/** Swap normal slots right now (stopped, or to land an armed switch). */
export function selectSlot(slot, { flush = true, startTime, followDrums = true } = {}) {
    const next = isSongSlot(slot) ? SONG_SLOT : clampBankSlot(slot);
    if (flush) flushDomToPattern(state.editSlot);
    state.editSlot = next;
    state.pendingEditSlot = null;
    if (followDrums) setDrumSlot(next, { startTime });
    hydratePatternToDom(next);
    syncPatternSlotUi();
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-slot', { detail: { slot: next } }));
}

/**
 * Swap the Berlin pattern. Does not touch the normal bank.
 * `startTime` is the cycle boundary the new lanes should start on.
 */
export function selectBerlinSlot(slot, { startTime, followDrums = true } = {}) {
    ensureBerlinBank();
    const next = isSongSlot(slot) ? SONG_SLOT : clampBankSlot(slot);
    state.berlinSlot = next;
    state.berlinPendingSlot = null;
    state.berlinSoloRow = null;
    const pattern = getBerlinPattern(next);
    state.berlinOscCount = pattern.oscCount;
    state.berlinModCount = pattern.modCount;
    if (followDrums) setDrumSlot(next, { startTime });
    syncPatternSlotUi();
    document.dispatchEvent(new CustomEvent('ingysynth:berlin-slot', {
        detail: { slot: next, startTime },
    }));
}

/**
 * P1–P8 press. Stopped: switch now. Playing: queue for the end of the
 * current Repeat cycle (normal or Berlin). Arp-only playback never emits
 * `ingysynth:loop-start`, so a queue waits until the sequencer is playing.
 */
export function requestSlot(slot) {
    if (state.songPlaying) return;
    const next = clampBankSlot(slot);
    const running = state.isPlaying || state.isArping;
    if (armedVisualSlot != null) {
        clearArmedVisual();
        syncPatternSlotUi();
    }

    if (state.berlinMode) {
        if (!running) {
            selectBerlinSlot(next);
            return;
        }
        if (next === state.berlinSlot) {
            state.berlinPendingSlot = null;
            syncPatternSlotUi();
            return;
        }
        state.berlinPendingSlot = next;
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

/** Called at each cycle start while playing — lands any armed pattern in time. */
export function commitPendingSlot(startTime) {
    if (state.songPlaying) return false;
    if (state.berlinMode) {
        if (state.berlinPendingSlot === null) return false;
        const next = state.berlinPendingSlot;
        if (next === state.berlinSlot) {
            state.berlinPendingSlot = null;
            syncPatternSlotUi();
            return false;
        }
        selectBerlinSlot(next, { startTime });
        holdArmedVisual(next, startTime);
        return true;
    }
    if (state.pendingEditSlot === null) return false;
    const next = state.pendingEditSlot;
    if (next === state.editSlot) {
        state.pendingEditSlot = null;
        syncPatternSlotUi();
        return false;
    }
    selectSlot(next, { startTime });
    holdArmedVisual(next, startTime);
    return true;
}

/** Synth strip clipboard. Same clipboard as a Berlin lane or a drum lane. */
function copyMainPattern(btn) {
    flushDomToPattern(state.editSlot);
    copyPatternContent(state.editSlot);
    flashCopiedToast(btn);
}

function pasteMainPattern() {
    flushDomToPattern(state.editSlot);
    if (!pastePatternContent(state.editSlot)) return;
    hydratePatternToDom(state.editSlot);
}

function clearMainPattern() {
    clearPatternSteps(state.editSlot);
    hydratePatternToDom(state.editSlot);
}

function copyEditSlot(btn) {
    if (state.berlinMode) {
        copyBerlinPattern(state.berlinSlot);
        flashCopiedToast(btn);
        return;
    }
    flushDomToPattern(state.editSlot);
    copyPatternContent(state.editSlot);
    flashCopiedToast(btn);
}

function pasteEditSlot() {
    if (state.berlinMode) {
        if (!pasteBerlinPattern(state.berlinSlot)) return;
        syncPatternSlotUi();
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-slot', {
            detail: { slot: state.berlinSlot },
        }));
        return;
    }
    flushDomToPattern(state.editSlot);
    if (!pastePatternContent(state.editSlot)) return;
    hydratePatternToDom(state.editSlot);
    syncPatternSlotUi();
}

function clearEditSlot() {
    if (state.berlinMode) {
        clearBerlinPattern(state.berlinSlot);
        document.dispatchEvent(new CustomEvent('ingysynth:berlin-slot', {
            detail: { slot: state.berlinSlot },
        }));
        return;
    }
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

    repeatButton()?.addEventListener('click', () => {
        setShownPatternRepeat(nextRepeat(shownRepeat()));
    });

    document.getElementById('patternBankCopy')?.addEventListener('click', (e) => {
        copyMainPattern(e.currentTarget);
    });
    document.getElementById('patternBankPaste')?.addEventListener('click', () => {
        pasteMainPattern();
    });
    document.getElementById('patternBankClear')?.addEventListener('click', () => {
        clearMainPattern();
    });
    document.getElementById('patternSlotCopy')?.addEventListener('click', (e) => {
        copyEditSlot(e.currentTarget);
    });
    document.getElementById('patternSlotPaste')?.addEventListener('click', () => {
        pasteEditSlot();
    });
    document.getElementById('patternSlotClear')?.addEventListener('click', () => {
        clearEditSlot();
    });

    document.addEventListener('ingysynth:pattern-clipboard', () => {
        syncPatternClipboardUi();
    });

    document.addEventListener('ingysynth:loop-start', (e) => {
        commitPendingSlot(e.detail?.startTime);
    });

    document.addEventListener('ingysynth:cycle-progress', (e) => {
        armCycleMeter(e.detail);
    });
    document.addEventListener('ingysynth:sequencer-start', () => {
        stopMeterClock();
        paintCycleMeter({ playing: true });
    });
    document.addEventListener('ingysynth:sequencer-stop', () => {
        clearArmedVisual();
        stopMeterClock();
        syncPatternSlotUi();
    });
    document.addEventListener('ingysynth:automation-changed', () => {
        syncPatternSlotUi();
    });
    document.addEventListener('ingysynth:berlin-mode', () => {
        syncPatternSlotUi();
        syncPatternClipboardUi();
        alignDrumsToShown();
    });
}

/** The P1–P8 button shows a different slot when Berlin opens or closes. Drums follow it. */
function alignDrumsToShown() {
    if (state.songPlaying) return;
    const slot = shownSlot();
    ensureDrumPatterns();
    if ((state.drumSlot | 0) === slot) return;
    let startTime;
    if (state.isPlaying && state.audioContext) {
        const t = state.berlinMode ? state.berlinLoopAnchor : state.nextStepTime;
        if (Number.isFinite(t)) startTime = t;
    }
    setDrumSlot(slot, { startTime });
}
