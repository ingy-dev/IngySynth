// ACID mode: TB-303-style AD envelopes + accent sweep (Robin Whittle MEG/VEG).
// When Off, callers keep the normal ADSR path untouched.

import { state } from './state.js?v=104';
import {
    getFilterEnvAmount,
    getFilterCutoffRange,
    updateFilterCutoffRange,
} from './filter-cutoff.js?v=78';

const MIN = 0.00001;
const ACCENT_MEG_SEC = 0.2; // fixed MEG decay on accent (~200 ms)
/** Slide-chain end: short release so the glide doesn't leave a long VEG/MEG tail. */
const SLIDE_END_RELEASE_SEC = 0.12;
/** Fade previous note before attack — avoids hard-zero clicks on long VEG tails. */
const RETRIG_CLOSE_SEC = 0.004;
const RETRIG_CLOSE_HOT_SEC = 0.008;

/* Hotter TB-303-style accent (this module is Acid-only). */
const ACCENT_SWEEP_BASE_HZ = 800;
const ACCENT_SWEEP_RES_HZ = 3200;
const ACCENT_SWEEP_CAP_HZ = 7000;
/** VEG peak = 1 + ACCENT_AMP_BOOST * accentAmount */
const ACCENT_AMP_BOOST = 0.85;
/** Env Mod depth multiplier on accent: base * (1 + ACCENT_ENV_DEPTH * amt) */
const ACCENT_ENV_DEPTH = 1.35;

/** Map filter Decay knob (0–2) → MEG decay seconds (~0.2–2 s). */
export function acidMegDecaySec(accentThisStep) {
    if (accentThisStep) return ACCENT_MEG_SEC;
    const raw = parseFloat(document.getElementById('filterDecay')?.value);
    const v = Number.isFinite(raw) ? raw : 0.3;
    return 0.2 + (Math.max(0, Math.min(2, v)) / 2) * 1.8;
}

/** Map amp Decay knob (0–2) → VEG decay seconds (~0.5–3.5 s). */
export function acidVegDecaySec() {
    const raw = parseFloat(document.getElementById('decay')?.value);
    const v = Number.isFinite(raw) ? raw : 0.5;
    return 0.5 + (Math.max(0, Math.min(2, v)) / 2) * 3.0;
}

function decayTau(sec) {
    // ~95% settle in `sec`
    return Math.max(0.012, sec / 3);
}

function getAccentAmount() {
    const el = document.getElementById('accentAmount');
    return el ? Math.max(0, Math.min(1, parseFloat(el.value) / 100)) : 1;
}

function resonanceNorm() {
    const el = document.getElementById('resonance');
    const max = el ? parseFloat(el.max) || 20 : 20;
    const v = el ? parseFloat(el.value) : 1;
    return Math.max(0, Math.min(1, (Number.isFinite(v) ? v : 1) / max));
}

function cutModHot() {
    return state.lfoState
        && Math.abs(parseFloat(document.getElementById('cutoffMod')?.value) || 0) > 80
        && (Number(state.lfoAmount) || 0) > 0.02;
}

/**
 * Soft-close then attack on an AudioParam. Never hard-jumps to 0 while signal is open
 * (that was the main ACID click with long VEG overlapping the next step).
 */
function softRetriggerGain(gainParam, t0, peak, attackSec, decayTauSec) {
    const cur = Math.max(MIN, Number(gainParam.value) || MIN);
    const closeT = cur > MIN * 2
        ? (cutModHot() ? RETRIG_CLOSE_HOT_SEC : RETRIG_CLOSE_SEC)
        : 0;
    let attackStart = t0;

    gainParam.cancelScheduledValues(t0);
    gainParam.setValueAtTime(cur, t0);
    if (closeT > 0) {
        gainParam.linearRampToValueAtTime(MIN, t0 + closeT);
        attackStart = t0 + closeT;
    } else {
        gainParam.setValueAtTime(MIN, t0);
    }
    const attack = Math.max(0.002, attackSec);
    gainParam.linearRampToValueAtTime(peak, attackStart + attack);
    gainParam.setTargetAtTime(MIN, attackStart + attack, decayTauSec);
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
    // Peak add in Hz — stronger at high resonance; short bleed so it doesn't paint the next steps
    const pulseHz = amt * (ACCENT_SWEEP_BASE_HZ + resN * ACCENT_SWEEP_RES_HZ);
    // ~60–220 ms τ → ~95% gone in ~0.2–0.65 s (was up to ~1.2 s τ)
    const sweepTau = 0.06 + resN * 0.16;
    const g = state.accentSweepGain.gain;
    const cur = Math.max(0, Number(g.value) || 0);
    const charged = Math.min(ACCENT_SWEEP_CAP_HZ, cur + pulseHz);
    // Softer charge edge — fast Hz jumps into a resonant LP click hard
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

    const baseCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
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
}) {
    if (!state.filterEnvGain) return;

    // Ensure Env Mod path has depth when ACID is on
    const amount = getFilterEnvAmount();
    if (amount === 0) return;

    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const gainParam = state.filterEnvGain.gain;
    const baseCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
    updateFilterCutoffRange(baseCutoff, t0, 0.012);

    if (accentThisStep) {
        chargeAccentSweep(t0, accentAmount);
        applyAccentEnvDepthBoost(t0, accentAmount, stepDuration);
    } else {
        // Consecutive Accents may still stack via chargeAccentSweep; Acc→normal clears
        decayAccentSweep(t0, 0.03);
    }

    if (slideThisStep) {
        // Gate held open — keep decaying / sustained schedule; release only if chain ends
        if (!nextStepWillSlide) {
            const cur = Math.max(MIN, Number(gainParam.value) || MIN);
            gainParam.cancelScheduledValues(t0);
            gainParam.setValueAtTime(cur, t0);
            gainParam.setTargetAtTime(MIN, t0, decayTau(SLIDE_END_RELEASE_SEC));
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
        0.004,
        decayTau(acidMegDecaySec(!!accentThisStep)),
    );

    state.filterEnvelopeHeld = !!nextStepWillSlide;
}

/**
 * Amp VEG: soft retrigger → fast attack → long exponential decay.
 * Accent raises peak (MEG→VCA). Slide hold skips retrigger.
 */
export function scheduleAcidAmpEnvelope({
    startTime,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
}) {
    if (!state.envelope) return 0.002;

    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const amt = Math.max(0, Math.min(1, accentAmount ?? 0));
    // Accent raises VEG peak (MEG→VCA); soft-retrigger prevents the click
    const peak = accentThisStep ? 1 + ACCENT_AMP_BOOST * amt : 1;
    const tau = decayTau(acidVegDecaySec());
    const g = state.envelope.gain;

    if (slideThisStep) {
        if (!nextStepWillSlide) {
            const cur = Math.max(MIN, Number(g.value) || MIN);
            g.cancelScheduledValues(t0);
            g.setValueAtTime(cur, t0);
            g.setTargetAtTime(MIN, t0, decayTau(SLIDE_END_RELEASE_SEC));
            state.envelopeHeld = false;
        } else {
            state.envelopeHeld = true;
        }
        return 0.002;
    }

    const attack = softRetriggerGain(g, t0, peak, 0.003, tau);
    state.envelopeHeld = !!nextStepWillSlide;
    return attack;
}

/** Live keyboard note-on under ACID (no per-step accent). */
export function triggerAcidLiveAmp(now, { fromCurrent = false } = {}) {
    if (!state.envelope) return;
    const tau = decayTau(acidVegDecaySec());
    const g = state.envelope.gain;
    if (fromCurrent) {
        softRetriggerGain(g, now, 1, 0.003, tau);
    } else {
        softRetriggerGain(g, now, 1, 0.003, tau);
    }
    state.envelopeHeld = true;
}

export function triggerAcidLiveFilter(now, { fromCurrent = false } = {}) {
    if (!state.filterEnvGain || getFilterEnvAmount() === 0) return;
    const baseCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
    updateFilterCutoffRange(baseCutoff, now, 0.012);
    softRetriggerGain(
        state.filterEnvGain.gain,
        now,
        1,
        0.004,
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
