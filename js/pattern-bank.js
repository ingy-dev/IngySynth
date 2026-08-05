// Pattern bank: normal mode uses slots 0–3 (P1–P4). Berlin Dream uses all 8 lanes
// (O1–O4 pitch + M1–M4 modulation). Dom step strip is a view of `editSlot`.

import { state } from './state.js?v=104';
import { clampRatch, syncRatchButton } from './step-ratch.js?v=1';

/** Total Berlin lanes (and bank array length). */
export const PATTERN_COUNT = 8;
/** Normal-mode P1–P4 slots only. */
export const BANK_COUNT = 4;
export const STEP_SLOTS = 32;

export const OSC_LANE_COUNT = 4;

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

function clampGate(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0.9;
    return Math.max(0.05, Math.min(1, v));
}

function emptyStep() {
    return { tune: 0, fine: 0, on: true, accent: false, slide: false, ratch: 1 };
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
        if (Array.isArray(p.steps)) {
            p.steps.forEach((s) => {
                if (s && s.ratch === undefined) s.ratch = 1;
            });
        } else {
            p.steps = Array.from({ length: STEP_SLOTS }, emptyStep);
        }
    });
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

function cloneSteps(steps) {
    return Array.from({ length: STEP_SLOTS }, (_, i) => {
        const s = steps?.[i] || emptyStep();
        return {
            tune: Math.round(Number(s.tune) || 0),
            fine: Math.round(Number(s.fine) || 0),
            on: s.on !== false,
            accent: !!s.accent,
            slide: !!s.slide,
            ratch: clampRatch(s.ratch),
        };
    });
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
    if (isOscLane(slot)) {
        pattern.gate = clampGate(patternClipboard.gate ?? 0.9);
        pattern.amount = 1;
        pattern.destination = OSC_DESTINATIONS[slot];
    } else {
        pattern.amount = Math.max(0, Math.min(1, Number(patternClipboard.amount ?? 1)));
        // Keep mod Dest; only paste amount/clock/steps
    }
    document.dispatchEvent(new CustomEvent('ingysynth:pattern-clipboard', {
        detail: { action: 'paste', slot },
    }));
    return true;
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
    return {
        tune: tune ? (parseInt(tune.value, 10) || 0) : 0,
        fine: fine ? (parseInt(fine.value, 10) || 0) : 0,
        accent: accent ? !accent.classList.contains('off') : false,
        slide: slide ? !slide.classList.contains('off') : false,
        on: front ? front.textContent.trim() === 'On' : true,
        ratch: clampRatch(parseInt(ratch?.dataset?.ratch, 10) || 1),
    };
}

export function applyStepToDom(i, data) {
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
}

function readClockFromDom() {
    const stepsEl = document.getElementById('stepCount');
    const divEl = document.getElementById('division');
    return {
        stepCount: Math.max(1, Math.min(STEP_SLOTS, parseInt(stepsEl?.value, 10) || 8)),
        division: parseInt(divEl?.value, 10) || 8,
        reverse: !!state.isReverse,
    };
}

function writeClockToDom(pattern) {
    const stepsEl = document.getElementById('stepCount');
    if (stepsEl && String(stepsEl.value) !== String(pattern.stepCount)) {
        stepsEl.value = String(pattern.stepCount);
        stepsEl.dispatchEvent(new Event('input', { bubbles: true }));
        stepsEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const divEl = document.getElementById('division');
    if (divEl && String(divEl.value) !== String(pattern.division)) {
        divEl.value = String(pattern.division);
        divEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (state.isReverse !== !!pattern.reverse) {
        state.isReverse = !!pattern.reverse;
        document.dispatchEvent(new CustomEvent('ingysynth:reverse-sync'));
    }
}

/** Copy the live step strip into a slot (defaults to the current edit slot). */
export function flushDomToPattern(slot = state.editSlot) {
    const pattern = getPattern(slot);
    for (let i = 0; i < STEP_SLOTS; i++) {
        pattern.steps[i] = captureStepFromDom(i);
    }
    Object.assign(pattern, readClockFromDom());
    return pattern;
}

/** Paint a slot into the live step strip. */
export function hydratePatternToDom(slot = state.editSlot) {
    const pattern = getPattern(slot);
    for (let i = 0; i < STEP_SLOTS; i++) {
        applyStepToDom(i, pattern.steps[i] || emptyStep());
    }
    writeClockToDom(pattern);
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

/** P1–P4 press: instant when stopped, armed for the next loop while playing. */
export function requestSlot(slot) {
    const next = clampBankSlot(slot);
    const running = state.isPlaying || state.isArping;

    if (state.berlinMode) {
        // Every row is already live; P1–P4 only moves the edit focus among bank slots.
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
