// ACID mode: TB-303-style AD envelopes + accent sweep (Robin Whittle MEG/VEG).
// When Off, callers keep the normal ADSR path untouched.
// Envelope timings restored from local commit f618f51.

import { state } from './state.js?v=120';
import { getNumber } from './params.js?v=40';
import {
    getFilterEnvAmount,
    getFilterCutoffRange,
    updateFilterCutoffRange,
} from './filter-cutoff.js?v=108';

const MIN = 0.00001;
const ACCENT_MEG_SEC = 0.2; // fixed MEG decay on accent (~200 ms)
/** Slide-chain end: short release so the glide doesn't leave a long VEG/MEG tail. */
const SLIDE_END_RELEASE_SEC = 0.12;

/* Hotter TB-303-style accent (this module is Acid-only). */
const ACCENT_SWEEP_BASE_HZ = 800;
const ACCENT_SWEEP_RES_HZ = 3200;
const ACCENT_SWEEP_CAP_HZ = 7000;
/** VEG peak = 1 + ACCENT_AMP_BOOST * accentAmount */
const ACCENT_AMP_BOOST = 0.85;
/** Env Mod depth multiplier on accent: base * (1 + ACCENT_ENV_DEPTH * amt) */
const ACCENT_ENV_DEPTH = 1.35;

/** VEG (amp) attack — TB-303 is effectively instant. */
export const ACID_VEG_ATTACK_SEC = 0.003;
/** MEG (filter) attack — TB-303 is effectively instant. */
export const ACID_MEG_ATTACK_SEC = 0.004;

export const ACID_MEG_DECAY_MIN_SEC = 0.2;
export const ACID_MEG_DECAY_MAX_SEC = 2.0;
export const ACID_VEG_DECAY_MIN_SEC = 0.5;
export const ACID_VEG_DECAY_MAX_SEC = 3.5;

function clampDecayKnob(raw, fallback) {
    const v = Number.isFinite(raw) ? raw : fallback;
    return Math.max(0, Math.min(2, v));
}

/** Map filter Decay knob (0–2) → MEG decay seconds (~0.2–2 s). */
export function acidMegDecaySec(accentThisStep) {
    if (accentThisStep) return ACCENT_MEG_SEC;
    const t = clampDecayKnob(getNumber('filterDecay', 0.3), 0.3) / 2;
    return ACID_MEG_DECAY_MIN_SEC + t * (ACID_MEG_DECAY_MAX_SEC - ACID_MEG_DECAY_MIN_SEC);
}

/** Map amp Decay knob (0–2) → VEG decay seconds (~0.5–3.5 s). */
export function acidVegDecaySec() {
    const t = clampDecayKnob(getNumber('decay', 0.5), 0.5) / 2;
    return ACID_VEG_DECAY_MIN_SEC + t * (ACID_VEG_DECAY_MAX_SEC - ACID_VEG_DECAY_MIN_SEC);
}

/**
 * Shape the Filter / Amp canvases should draw in Acid (A/S/R knobs are ignored).
 * `window` is a stable time axis so Decay stretches instead of rescaling Attack.
 */
export function acidEnvelopeDisplay(kind) {
    const filter = kind === 'filter';
    const attack = filter ? ACID_MEG_ATTACK_SEC : ACID_VEG_ATTACK_SEC;
    const decay = filter ? acidMegDecaySec(false) : acidVegDecaySec();
    const decayMax = filter ? ACID_MEG_DECAY_MAX_SEC : ACID_VEG_DECAY_MAX_SEC;
    return { attack, decay, window: attack + decayMax };
}

/** Inverse of MEG/VEG decay mapping — display seconds → Decay knob (0–2). */
export function acidDecayKnobFromSec(kind, sec) {
    const filter = kind === 'filter';
    const min = filter ? ACID_MEG_DECAY_MIN_SEC : ACID_VEG_DECAY_MIN_SEC;
    const max = filter ? ACID_MEG_DECAY_MAX_SEC : ACID_VEG_DECAY_MAX_SEC;
    const t = (Math.max(min, Math.min(max, Number(sec) || 0)) - min) / Math.max(1e-6, max - min);
    return t * 2;
}

function decayTau(sec) {
    // ~95% settle in `sec`
    return Math.max(0.012, sec / 3);
}

/** Sequencer GATE as a fraction of the step. Acid default is 100% (full step). */
function acidGateFrac() {
    const v = getNumber('gateLength', 100);
    return Math.max(0.05, Math.min(1, v / 100));
}

/**
 * Dump a VEG/MEG gain at GATE close. Slide hold skips this (gate stays open).
 * Clamped so a full GATE still leaves a hair before the next step's retrigger.
 */
function gateDumpAt(t0, stepDuration) {
    const raw = t0 + stepDuration * acidGateFrac();
    return Math.min(t0 + stepDuration - 0.005, Math.max(t0 + 0.012, raw));
}

function scheduleGateDump(gainParam, t0, stepDuration) {
    if (!gainParam || !(stepDuration > 0)) return;
    const dumpAt = gateDumpAt(t0, stepDuration);
    try {
        if (typeof gainParam.cancelAndHoldAtTime === 'function') {
            gainParam.cancelAndHoldAtTime(dumpAt);
        }
    } catch (_) { /* ignore */ }
    gainParam.setTargetAtTime(MIN, dumpAt, decayTau(SLIDE_END_RELEASE_SEC));
}

function getAccentAmount() {
    return Math.max(0, Math.min(1, getNumber('accentAmount', 100) / 100));
}

function resonanceNorm() {
    const max = 20;
    const v = getNumber('resonance', 1);
    return Math.max(0, Math.min(1, v / max));
}

/**
 * Retrigger from the held level (BA662 / dest-clean path).
 * linearRamp after setTarget(MIN) jumps to the target (silence) in Chrome —
 * dest skips this and stays clean. setTarget attack continues from the hold.
 */
function softRetriggerGain(gainParam, t0, peak, attackSec, decayTauSec) {
    let held = false;
    if (typeof gainParam.cancelAndHoldAtTime === 'function') {
        try {
            gainParam.cancelAndHoldAtTime(t0);
            held = true;
        } catch (_) { /* fall through */ }
    }
    if (!held) gainParam.cancelScheduledValues(t0);
    const attack = Math.max(0.002, attackSec);
    const attackTau = Math.max(0.0008, attack / 3);
    gainParam.setTargetAtTime(peak, t0, attackTau);
    const decayStart = t0 + attack;
    if (typeof gainParam.cancelAndHoldAtTime === 'function') {
        try { gainParam.cancelAndHoldAtTime(decayStart); } catch (_) { /* ignore */ }
    }
    gainParam.setTargetAtTime(MIN, decayStart, decayTauSec);
    return attack;
}

/** Fade accent-sweep charge to 0 (stop / leave ACID). */
export function clearAccentSweep(when = null) {
    if (!state.accentSweepGain || !state.audioContext) return;
    const t = when ?? state.audioContext.currentTime;
    const g = state.accentSweepGain.gain;
    const cur = Math.max(0, Number(g.value) || 0);
    g.cancelScheduledValues(t);
    g.setValueAtTime(cur, t);
    g.setTargetAtTime(0, t, 0.08);
}

/**
 * Accent Sweep Circuit: diode-ish charge into a virtual cap, bleed scaled by Resonance.
 * Leftover charge stacks on consecutive accents.
 */
export function chargeAccentSweep(t0, accentAmount) {
    if (!state.acidMode || !state.accentSweepGain || !state.audioContext) return;
    const amt = Math.max(0, Math.min(1, accentAmount ?? getAccentAmount()));
    if (amt <= 0.001) return;

    const resN = resonanceNorm();
    const pulseHz = amt * (ACCENT_SWEEP_BASE_HZ + resN * ACCENT_SWEEP_RES_HZ);
    const sweepTau = 0.06 + resN * 0.16;
    const g = state.accentSweepGain.gain;
    const cur = Math.max(0, Number(g.value) || 0);
    const charged = Math.min(ACCENT_SWEEP_CAP_HZ, cur + pulseHz);
    const chargeT = 0.012 + resN * 0.02;

    g.cancelScheduledValues(t0);
    g.setValueAtTime(cur, t0);
    g.linearRampToValueAtTime(charged, t0 + chargeT);
    g.setTargetAtTime(0, t0 + chargeT, sweepTau);
}

/** Snappy bleed-out so a non-accent step doesn't inherit the previous accent sweep. */
function decayAccentSweep(t0, tau = 0.03) {
    if (!state.accentSweepGain) return;
    const g = state.accentSweepGain.gain;
    const cur = Math.max(0, Number(g.value) || 0);
    g.cancelScheduledValues(t0);
    g.setValueAtTime(cur, t0);
    if (cur <= 0.001) {
        g.setValueAtTime(0, t0);
        return;
    }
    g.setTargetAtTime(0, t0, Math.max(0.01, tau));
}

/** Temporarily raise Env Mod depth for an accented Acid step (restores at step end). */
function applyAccentEnvDepthBoost(t0, accentAmount, stepDuration) {
    if (!state.acidMode || !state.filterEnvDepth) return;
    const amt = Math.max(0, Math.min(1, accentAmount ?? 0));
    if (amt <= 0.001) return;
    const amount = getFilterEnvAmount();
    if (amount === 0) return;

    const baseCutoff = Math.max(40, getNumber('cutoff', 1000));
    const { signedDepth: baseSignedDepth } = getFilterCutoffRange(baseCutoff, amount);
    const boostedDepth = baseSignedDepth * (1 + ACCENT_ENV_DEPTH * amt);
    const depthParam = state.filterEnvDepth.gain;
    const edge = 0.006;
    const stepEnd = t0 + Math.max(0.05, Number(stepDuration) || ACCENT_MEG_SEC);

    depthParam.cancelScheduledValues(t0);
    depthParam.setValueAtTime(depthParam.value, t0);
    depthParam.linearRampToValueAtTime(boostedDepth, t0 + edge);
    const restoreAt = Math.max(t0 + edge + 0.01, stepEnd - edge);
    depthParam.setValueAtTime(boostedDepth, restoreAt);
    depthParam.linearRampToValueAtTime(baseSignedDepth, stepEnd);
}

/**
 * Filter MEG: snappy attack → exponential decay to silence.
 * Slide hold: leave current schedule alone.
 */
export function scheduleAcidFilterEnvelope({
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
    nextIsRest = false,
}) {
    if (!state.filterEnvGain) return;

    const amount = getFilterEnvAmount();
    if (amount === 0) return;

    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const gainParam = state.filterEnvGain.gain;
    const baseCutoff = Math.max(40, getNumber('cutoff', 1000));
    updateFilterCutoffRange(baseCutoff, t0, 0.012);

    if (accentThisStep) {
        chargeAccentSweep(t0, accentAmount);
        applyAccentEnvDepthBoost(t0, accentAmount, stepDuration);
    } else {
        decayAccentSweep(t0, 0.03);
    }

    if (slideThisStep) {
        // Dest is still gated: do not dump MEG at dest start.
        if (!nextStepWillSlide) {
            scheduleGateDump(gainParam, t0, stepDuration);
            state.filterEnvelopeHeld = false;
        } else {
            state.filterEnvelopeHeld = true;
        }
        return;
    }

    softRetriggerGain(
        gainParam,
        t0,
        1,
        ACID_MEG_ATTACK_SEC,
        decayTau(acidMegDecaySec(!!accentThisStep)),
    );

    if (!nextStepWillSlide) {
        scheduleGateDump(gainParam, t0, stepDuration);
        state.filterEnvelopeHeld = false;
    } else {
        state.filterEnvelopeHeld = true;
    }
}

/**
 * Amp VEG: soft retrigger → fast attack → long exponential decay.
 * Accent raises peak (MEG→VCA). Slide hold skips retrigger.
 */
export function scheduleAcidAmpEnvelope({
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
    nextIsRest = false,
}) {
    if (!state.envelope) return 0.002;

    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const amt = Math.max(0, Math.min(1, accentAmount ?? 0));
    const peak = accentThisStep ? 1 + ACCENT_AMP_BOOST * amt : 1;
    const tau = decayTau(acidVegDecaySec());
    const g = state.envelope.gain;

    if (slideThisStep) {
        // Dest is still gated: leave VEG decaying; dump at dest gate end.
        if (!nextStepWillSlide) {
            scheduleGateDump(g, t0, stepDuration);
            state.envelopeHeld = false;
        } else {
            state.envelopeHeld = true;
        }
        return 0.002;
    }

    const attack = softRetriggerGain(g, t0, peak, ACID_VEG_ATTACK_SEC, tau);
    if (!nextStepWillSlide) {
        scheduleGateDump(g, t0, stepDuration);
        state.envelopeHeld = false;
    } else {
        state.envelopeHeld = true;
    }
    return attack;
}

/** Live keyboard note-on under ACID (no per-step accent). */
export function triggerAcidLiveAmp(now, { fromCurrent = false } = {}) {
    if (!state.envelope) return;
    const tau = decayTau(acidVegDecaySec());
    const g = state.envelope.gain;
    softRetriggerGain(g, now, 1, ACID_VEG_ATTACK_SEC, tau);
    state.envelopeHeld = true;
}

export function triggerAcidLiveFilter(now, { fromCurrent = false } = {}) {
    if (!state.filterEnvGain || getFilterEnvAmount() === 0) return;
    const baseCutoff = Math.max(40, getNumber('cutoff', 1000));
    updateFilterCutoffRange(baseCutoff, now, 0.012);
    softRetriggerGain(
        state.filterEnvGain.gain,
        now,
        1,
        ACID_MEG_ATTACK_SEC,
        decayTau(acidMegDecaySec(false)),
    );
    state.filterEnvelopeHeld = true;
}

/** Live note-off: keep exponential fall from current level. */
export function releaseAcidLiveEnvelopes(now) {
    const minValue = MIN;
    if (state.envelope) {
        const cur = Math.max(minValue, Number(state.envelope.gain.value) || minValue);
        state.envelope.gain.cancelScheduledValues(now);
        state.envelope.gain.setValueAtTime(cur, now);
        state.envelope.gain.setTargetAtTime(minValue, now, decayTau(Math.min(1.2, acidVegDecaySec())));
        state.envelopeHeld = false;
    }
    if (state.filterEnvGain) {
        const cur = Math.max(minValue, Number(state.filterEnvGain.gain.value) || minValue);
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(cur, now);
        state.filterEnvGain.gain.setTargetAtTime(minValue, now, decayTau(acidMegDecaySec(false)));
        state.filterEnvelopeHeld = false;
    }
}

/** Rest/OFF: close held VEG/MEG without pinning AudioParam.value (lookahead click). */
export function releaseAcidHeldEnvelopes(startTime) {
    if (!state.audioContext) return;
    const t0 = Math.max(state.audioContext.currentTime, startTime);
    const dumpNow = (param) => {
        try {
            if (typeof param.cancelAndHoldAtTime === 'function') {
                param.cancelAndHoldAtTime(t0);
            }
        } catch (_) { /* ignore */ }
        param.setTargetAtTime(MIN, t0, decayTau(SLIDE_END_RELEASE_SEC));
    };
    if (state.envelopeHeld && state.envelope) {
        dumpNow(state.envelope.gain);
        state.envelopeHeld = false;
    }
    if (state.filterEnvelopeHeld && state.filterEnvGain) {
        dumpNow(state.filterEnvGain.gain);
        state.filterEnvelopeHeld = false;
    }
}
