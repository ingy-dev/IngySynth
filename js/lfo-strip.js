// Unipolar LFO amount strip on the keyboard play row (hardware mod-wheel style).
// Latches on release; scales lfoMasterGain when LFO is On.

import { state } from './state.js?v=120';
import { beginMidiLearn } from './midi-learn.js?v=35';
import { getFilterCutoffRange, getFilterEnvAmount, refreshFilterCutoffRange } from './filter-cutoff.js?v=111';
import { getLfoRateHz } from './lfo-rate.js?v=70';
import { getNumber, getString, set } from './params.js?v=44';

const AMOUNT_RAMP = 0.08;
/** Extra fade when opening from silence — avoids filter/pitch zipper clicks. */
const OPEN_RAMP = 0.14;
const CLOSE_RAMP = 0.08;
/** setTargetAtTime time-constant while dragging the strip. */
const DRAG_TAU = 0.045;

/** Last scheduled master level (AudioParam.value is unreliable after automation). */
let lastMasterGain = 0;

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

export function getLfoAmount() {
    const n = Number(state.lfoAmount);
    return Number.isFinite(n) ? clamp(n, 0, 1) : 0;
}

/**
 * Soft-knee amount for the audio graph — strip still reads 0…1, but full throw
 * lands ~0.65 so deep CUT + 100% LFO doesn't clip the filter/output.
 */
export function getLfoAmountAudio() {
    const a = getLfoAmount();
    // a=0→0, a=0.5→0.40, a=1→0.65
    return a * (0.95 - 0.30 * a);
}

/**
 * Rate / waveform-aware smoothing so high-speed square/saw don't zipper the filter.
 * Also eases the cutoff-only slew filter (pitch destinations stay more responsive).
 */
export function updateLfoSmoothing() {
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    const rate = Math.max(0.05, getLfoRateHz());
    const type = state.lfo?.type || getString('lfoWaveform', 'sine');

    let smoothFc;
    if (type === 'square' || type === 'sawtooth') {
        // Strong edge kill — at high rates this becomes near-sine
        smoothFc = Math.min(16, Math.max(5, rate * 1.2));
    } else if (type === 'triangle') {
        smoothFc = Math.min(24, Math.max(7, rate * 2.2));
    } else {
        smoothFc = Math.min(36, Math.max(10, rate * 3.5));
    }

    if (state.lfoSmooth) {
        const p = state.lfoSmooth.frequency;
        p.cancelScheduledValues(now);
        p.setTargetAtTime(smoothFc, now, 0.05);
    }

    // Extra pole on cutoff path only — high rate + deep CUT was slamming the filter floor
    if (state.lfoFilterSlew) {
        const slewFc = Math.min(12, Math.max(3.5, rate * 0.85));
        const sp = state.lfoFilterSlew.frequency;
        sp.cancelScheduledValues(now);
        sp.setTargetAtTime(slewFc, now, 0.05);
    }
    if (state.lfoHpSlew) {
        // Heavier than CUT — HP near the floor chirps easily with square/saw
        const hpSlewFc = Math.min(8, Math.max(2.2, rate * 0.5));
        const hp = state.lfoHpSlew.frequency;
        hp.cancelScheduledValues(now);
        hp.setTargetAtTime(hpSlewFc, now, 0.05);
    }

    updateLfoCutoffSafety();
    updateLfoHighpassSafety();
}

/**
 * Scale CUT LFO with the live filter-env floor (not just the cutoff knob).
 * When env is on, closed cutoff ≈ minFreq — pad against that or LFO rails to 0Hz.
 */
export function updateLfoCutoffSafety() {
    if (!state.lfoFilterPad || !state.audioContext) return;

    const knob = Math.max(20, getNumber('cutoff', 1000));
    const envAmt = getFilterEnvAmount();
    const { minFreq, maxFreq, depth } = getFilterCutoffRange(Math.max(40, knob), envAmt);
    const sustain = envAmt > 0
        ? clamp(getNumber('filterSustain', 0), 0, 1)
        : 1;
    const inverted = envAmt > 0 && !!state.filterEnvInvert;
    // Normal: idle near min; invert: idle near max and sweeps down toward min.
    // Bias safety toward the low end of the sweep so CUT LFO can't rail to ~0Hz.
    const typicalHz = inverted
        ? maxFreq - sustain * depth
        : minFreq + sustain * depth;
    const safetyHz = envAmt > 0
        ? (inverted
            ? (typicalHz * 0.55 + minFreq * 0.45)
            : (minFreq * 0.6 + typicalHz * 0.4))
        : knob;

    const modAbs = Math.abs(getNumber('cutoffMod', 0));
    const amount = Math.max(getLfoAmountAudio(), 0.05);
    const floorHz = 90;
    const headroom = Math.max(30, safetyHz - floorHz);
    const knobDemand = Math.max(1, modAbs * 0.9 * amount);

    const relativeSwing = safetyHz * 0.65;
    const safeSwing = headroom * 0.9;
    const allowedSwing = Math.min(knobDemand, relativeSwing, safeSwing);

    let pad = allowedSwing / knobDemand;
    if (safetyHz < 350) {
        pad *= Math.max(0.22, safetyHz / 350);
    }
    if (envAmt > 0) {
        // Extra ease while env is sweeping the same AudioParam as the LFO
        pad *= 0.55;
    }

    const now = state.audioContext.currentTime;
    const g = state.lfoFilterPad.gain;
    const target = clamp(pad, 0.03, 1);
    g.cancelScheduledValues(now);
    g.setTargetAtTime(target, now, 0.05);
}

/**
 * Scale HP LFO with the highpass base. At ~20Hz HP is effectively open, so LFO
 * can't change the tone much — pad stays small there to avoid floor clicks.
 * Raise HP into ~80–400Hz and depth opens up (audible bass scoop wobble).
 */
export function updateLfoHighpassSafety() {
    if (!state.lfoHpPad || !state.audioContext) return;

    const hpBase = Math.max(20, getNumber('highPass', 20));
    const modAbs = Math.abs(getNumber('highpassMod', 0));
    const amount = Math.max(getLfoAmountAudio(), 0.05);
    const floorHz = 22;
    const downRoom = Math.max(6, hpBase - floorHz);
    const knobDemand = Math.max(1, modAbs * 0.9 * amount);

    // Relative throw grows with HP so midband scoop really moves
    const relativeSwing = Math.max(70, hpBase * 1.2);
    const safeDown = downRoom * 0.88;
    const allowedSwing = Math.min(knobDemand, relativeSwing, safeDown);

    let pad = allowedSwing / knobDemand;
    // Ease only when parked near the floor (HP ≈ bypass)
    if (hpBase < 100) {
        pad *= Math.max(0.35, hpBase / 100);
    }

    const now = state.audioContext.currentTime;
    const g = state.lfoHpPad.gain;
    const target = clamp(pad, 0.04, 1);
    g.cancelScheduledValues(now);
    g.setTargetAtTime(target, now, 0.05);
}

/**
 * Soft-ramp master gain to On?amount : 0.
 * @param {{ ramp?: number, mode?: 'ramp' | 'drag' }} [opts]
 */
export function applyLfoMasterGain({ ramp = AMOUNT_RAMP, mode = 'ramp' } = {}) {
    if (!state.lfoMasterGain || !state.audioContext) return;
    const now = state.audioContext.currentTime;
    const target = state.lfoState ? getLfoAmountAudio() : 0;
    const g = state.lfoMasterGain.gain;
    const from = Number.isFinite(lastMasterGain) ? lastMasterGain : 0;

    if (mode === 'drag') {
        // Retarget without cancel — cancel+restart zippers while dragging
        g.setTargetAtTime(target, now, DRAG_TAU);
        lastMasterGain = target;
        updateLfoCutoffSafety();
        updateLfoHighpassSafety();
        // Floor refresh only on settle — per-frame cancel fights the env ADSR
        return;
    }

    let t = ramp;
    if (from < 0.02 && target > from + 0.01) {
        t = Math.max(t, OPEN_RAMP);
    } else if (target < 0.02 && from > target + 0.01) {
        t = Math.max(t, CLOSE_RAMP);
    }

    g.cancelScheduledValues(now);
    g.setValueAtTime(from, now);
    if (t > 0) {
        g.linearRampToValueAtTime(target, now + t);
    } else {
        g.setValueAtTime(target, now);
    }
    lastMasterGain = target;
    updateLfoCutoffSafety();
    updateLfoHighpassSafety();
    refreshFilterCutoffRange(Math.max(0.04, t));
}

/** Update On/Off UI + state without requiring a click on #lfoToggle. */
export function setLfoEnabled(on, { ramp = AMOUNT_RAMP } = {}) {
    state.lfoState = !!on;
    const mainBtn = document.getElementById('lfoToggle');
    if (mainBtn) {
        const front = mainBtn.querySelector('.front');
        if (front) front.textContent = state.lfoState ? 'On' : 'Off';
        mainBtn.classList.toggle('off', !state.lfoState);
    }
    applyLfoMasterGain({ ramp });
    document.dispatchEvent(new CustomEvent('ingysynth:lfo-enabled', {
        detail: { enabled: state.lfoState },
    }));
}

export function setLfoAmount(amount, { ramp = AMOUNT_RAMP, enableIfPositive = true, mode = 'ramp' } = {}) {
    state.lfoAmount = clamp(amount, 0, 1);
    if (enableIfPositive && state.lfoAmount > 0.001 && !state.lfoState) {
        set('lfoToggle', true);
        return;
    }
    applyLfoMasterGain({ ramp, mode });
    document.dispatchEvent(new CustomEvent('ingysynth:lfo-amount', {
        detail: { amount: state.lfoAmount },
    }));
}

function setStripVisual(el, norm) {
    el.style.setProperty('--lfo', String(norm));
    el.setAttribute('aria-valuenow', String(Math.round(norm * 100) / 100));
    el.classList.toggle('active', norm > 0.001);
}

function normFromClientX(el, clientX) {
    const track = el.querySelector('.keyboard-lfo-strip-track') || el;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    // Map full width: left = 0, right = 1
    return clamp((clientX - rect.left) / rect.width, 0, 1);
}

export function initLfoStrip() {
    const el = document.getElementById('keyboardLfoStrip');
    if (!el) return;

    let dragging = false;
    let activePointerId = null;

    const setFromNorm = (norm, { ramp, mode } = {}) => {
        setStripVisual(el, norm);
        setLfoAmount(norm, { ramp, enableIfPositive: true, mode });
    };

    el.addEventListener('pointerdown', (e) => {
        if (beginMidiLearn(e, null, el)) return;
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        try {
            el.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        // First touch: longer open fade if coming from silence
        setFromNorm(normFromClientX(el, e.clientX), { ramp: OPEN_RAMP, mode: 'ramp' });
    });

    el.addEventListener('pointermove', (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        e.stopPropagation();
        setFromNorm(normFromClientX(el, e.clientX), { mode: 'drag' });
    });

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        // Settle to final latched amount with a short clean ramp
        applyLfoMasterGain({ ramp: 0.05, mode: 'ramp' });
    };

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);

    el.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        let norm = parseFloat(el.style.getPropertyValue('--lfo'));
        if (!Number.isFinite(norm)) norm = getLfoAmount();
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            setFromNorm(clamp(norm + step, 0, 1), { ramp: AMOUNT_RAMP, mode: 'ramp' });
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            setFromNorm(clamp(norm - step, 0, 1), { ramp: AMOUNT_RAMP, mode: 'ramp' });
        } else if (e.key === 'Home' || e.key === 'Escape') {
            e.preventDefault();
            setFromNorm(0, { ramp: CLOSE_RAMP, mode: 'ramp' });
        } else if (e.key === 'End') {
            e.preventDefault();
            setFromNorm(1, { ramp: OPEN_RAMP, mode: 'ramp' });
        } else {
            return;
        }
    });

    setStripVisual(el, getLfoAmount());
    lastMasterGain = state.lfoState ? getLfoAmountAudio() : 0;
}

/** Half of max positive cutoff mod (−5000…+5000) — startup only; HTML defaultValue stays 0 for dblclick reset. */
export const LFO_STARTUP_CUTOFF_MOD = 1500;

/**
 * Factory play patch: LFO On, strip at 0, CUT dest at 50% positive.
 * Does not change input.defaultValue so double-click still resets CUT to 0.
 */
export function applyLfoStartupDefaults() {
    state.lfoAmount = 0;
    lastMasterGain = 0;

    const strip = document.getElementById('keyboardLfoStrip');
    if (strip) setStripVisual(strip, 0);

    set('cutoffMod', LFO_STARTUP_CUTOFF_MOD);
    set('lfoToggle', true);
    const cutoff = document.getElementById('cutoffMod');
    if (cutoff) {
        const span = document.getElementById('cutoffModValue');
        if (span) span.textContent = String(LFO_STARTUP_CUTOFF_MOD);
    }

    setLfoEnabled(true, { ramp: 0 });
    updateLfoCutoffSafety();
    updateLfoHighpassSafety();
}
