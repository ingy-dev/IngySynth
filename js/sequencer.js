import { state } from './state.js?v=120';
import { get, getNumber, getString, getOscType, getOscVol } from './params.js?v=40';
import {
    getStepTotalTune,
    getStepFineCents,
    getQuantizedStepTune,
    getStepTotalTuneFromRaw,
    frequencyFromStepData,
    midiNoteFromStepData,
    midiPitchBendValue,
    getGlobalTune,
    semitonesToFrequency,
} from './tuning.js?v=104';
import { updateNoteVisualizer, updateChordVisualizer, clearNoteVisualizer, previewNoteVisualizer, soundingNotesForStep, hideLogoOverlay, showLogoOverlay } from './visualizers.js?v=147';
import { updateFilterCutoffRange, getFilterEnvAmount, getFilterCutoffRange } from './filter-cutoff.js?v=108';
import { forceNoteOff } from './voice.js?v=188';
import { retriggerLfoIfNeeded } from './lfo-rate.js?v=65';
import { bentFrequency } from './pitch-bend.js?v=138';
import { applyVfdChar, VFD_BRAND_SCROLL } from './vfd-charset.js?v=73';
import { setKeyboardStepActive } from './keyboard-steps.js?v=174';
import { spawnOscStack, firePhaseResetOscStack, stopDisabledOscStacks, voiceTargetFreq, getUnisonVoices, getUnisonSpread, unisonCents, readOscPanValue } from './unison.js?v=211';
import { analogLogicalWave, createOscSource, createPlaitsSource, softStartVoiceGain, wtAttackSecForFilter, wtFilterClickRisk, hasDarkOscActive, fadeStopOsc, DRUM_ENGINES, isTriggeredEngine, OSC4_INDEX, ENGINE_TAIL_SEC, routeBerlinDrumPanners, warmPlaitsPool, warmAnalogShells, startAnalogOsc } from './osc-source.js?v=151';
import { createAnalog808Voice, analogKitHz, digitalDrumTuneHz } from './analog-808.js?v=21';
import { notifyAutomationLoopAnchor } from './automation.js?v=97';
import { nextCyclePass } from './pattern-repeat.js?v=3';
import { buildOrderList, getChordArpSourceNotes, expandArpNotesByRange } from './held-notes.js?v=13';
import {
    scheduleAcidAmpEnvelope,
    scheduleAcidFilterEnvelope,
    clearAccentSweep,
    acidVegDecaySec,
    releaseAcidHeldEnvelopes,
} from './acid-env.js?v=72';
import {
    isBerlinOn,
    berlinActiveRows,
    ensurePlayheads,
    resetBerlinPlayheads,
    advancePlayhead,
    ensureDrumPlayheads,
    resetDrumPlayheads,
    advanceDrumPlayhead,
    rowStepDuration,
    masterLoopSeconds,
    keyboardHighlightRow,
    rowStepValue,
    berlinFrequency,
    scheduleBerlinCv,
    setBerlinStepActive,
    clearBerlinStepActive,
    refreshBerlinStepReadouts,
    syncBerlinMicrotuneSteps,
    isRowSounding,
    isOscLane,
    patternGate,
} from './berlin.js?v=118';
import {
    getPattern,
    getBerlinLane,
    getBerlinPattern,
    getDrumPattern,
    snapshotStepNeighborhood,
    isAnalogDrumEngine,
    DRUM_LANE_COUNT,
    canonicalDrumModel,
    soundingIntervalsFromStep,
    stepCellNotes,
    stepChordCount,
    patternRepeat,
    patternStepCount,
} from './pattern-bank.js?v=46';
import { schedulePolySeqVoicing, bumpSeqEngine, releasePolySeqHold } from './poly-voice.js?v=188';
import { isPolyChordMemoryOn, getPolyChordIntervals } from './chord-memory.js?v=49';
import { setDrumStepActive, clearDrumStepActive } from './drum-dock.js?v=49';
import { parseScSource, scheduleSidechainDuck, resetSidechainDucker } from './sc-time.js?v=46';
import {
    clampRatch,
    nextRatch,
    readRatchFromButton,
    syncRatchButton,
} from './step-ratch.js?v=1';

// Classic play reads `pattern.steps[]`, snapshotted at schedule time.
// Do not create `#stepParamBus` here — no import-time bus on `#synthContainer`
// or `document.body`. Stage knobs bind catalog keys.

// Slide / Accent toggles — bind once globally.
// Different ?v= query strings create separate ES module instances; without this
// guard each instance re-binds and one click toggles twice (ends up unchanged).
if (!globalThis.__ingySynthStepFlagBound) {
    globalThis.__ingySynthStepFlagBound = true;
    document.querySelectorAll('.step-slide').forEach(button => {
        button.addEventListener('click', function () {
            this.classList.toggle('off');
        });
    });
    document.querySelectorAll('.step-accent').forEach(button => {
        button.addEventListener('click', function () {
            this.classList.toggle('off');
        });
    });
    document.querySelectorAll('.step-ratch').forEach((button) => {
        syncRatchButton(button, 1);
        button.addEventListener('click', function () {
            if (state.acidMode) return;
            syncRatchButton(this, nextRatch(readRatchFromButton(this)));
        });
    });
}

function getSlideTime() {
    return getNumber('slideTime') / 1000;
}

function getAccentAmount() {
    return getNumber('accentAmount', 100) / 100;
}

/** Gate length as fraction of step (0.05–1). Default 0.9 matches prior hard-coded note length. */
function getGateLength() {
    const v = getNumber('gateLength', 90);
    return Math.max(0.05, Math.min(1, v / 100));
}

/** Main/Acid independent hits live in `berlinOscVoices` (shared panner/mute path). */
function mainIndependentVoicesRinging() {
    return !isBerlinOn()
        && Array.isArray(state.berlinOscVoices)
        && state.berlinOscVoices.length > 0;
}

// Note preview shared by the tune and fine sliders
function previewStepNote(step) {
    previewNoteVisualizer(
        getStepTotalTune(step),
        getStepFineCents(step),
        soundingNotesForStep(step),
    );
}

// Add event listeners to step tune sliders for note preview
document.querySelectorAll('.step-tune').forEach(slider => {
    slider.addEventListener('input', function() {
        // Update the value display (shows the scale-quantized value when scale mode is on)
        const step = parseInt(this.dataset.step);
        this.nextElementSibling.textContent = getQuantizedStepTune(step);
        previewStepNote(step);
    });
});

// Re-display every step readout (used when the scale is toggled or changed)
export function refreshStepTuneReadouts() {
    document.querySelectorAll('.step-tune').forEach(slider => {
        slider.nextElementSibling.textContent = getQuantizedStepTune(parseInt(slider.dataset.step));
    });
    document.querySelectorAll('.kb-step-tune-value').forEach(el => {
        el.textContent = String(getQuantizedStepTune(parseInt(el.dataset.step, 10)));
    });
    refreshBerlinStepReadouts();
}

const MICROTUNE_LOCK_STEP = 25;

function snapCents(value, step = MICROTUNE_LOCK_STEP) {
    if (!step) return value;
    return Math.max(-100, Math.min(100, Math.round(value / step) * step));
}

function formatCentsLabel(cents) {
    return `${cents > 0 ? '+' : ''}${cents}&cent;`;
}

function syncMicrotuneUI() {
    const locked = !!state.microtuneLock;

    const toggle = document.getElementById('microtuneLockToggle');
    if (toggle) {
        const front = toggle.querySelector('.front');
        if (front) {
            front.textContent = locked ? 'Microtuning: Lock' : 'Microtuning: Full';
        }
        toggle.classList.toggle('off', !locked);
        toggle.classList.toggle('on', locked);
        toggle.setAttribute('aria-pressed', locked ? 'true' : 'false');
    }

    document.querySelectorAll('#kbMicrotuneLock, #kbStepsMicrotuneLock').forEach(kbToggle => {
        kbToggle.textContent = locked ? 'Lock' : 'Full';
        kbToggle.classList.toggle('off', !locked);
        kbToggle.setAttribute('aria-pressed', locked ? 'true' : 'false');
    });

    // Update slider step for future moves, but do not rewrite existing values.
    // Off-grid fine amounts stay until that step's slider is touched.
    const sliderStep = locked ? String(MICROTUNE_LOCK_STEP) : '1';
    document.querySelectorAll('.step-fine').forEach(slider => {
        slider.step = sliderStep;
    });
    document.querySelectorAll('.kb-step-fine').forEach(slider => {
        slider.step = sliderStep;
    });
    syncBerlinMicrotuneSteps();
    const writeProxy = document.getElementById('kbWriteFineProxy');
    if (writeProxy) writeProxy.step = sliderStep;
}

function toggleMicrotuneLock() {
    state.microtuneLock = !state.microtuneLock;
    syncMicrotuneUI();
}

// Fine-tune (cents) sliders: update readout and preview the microtuned note
document.querySelectorAll('.step-fine').forEach(slider => {
    slider.addEventListener('input', function() {
        let cents = parseInt(this.value, 10) || 0;
        if (state.microtuneLock) {
            cents = snapCents(cents);
            this.value = String(cents);
        }
        this.nextElementSibling.innerHTML = formatCentsLabel(cents);
        previewStepNote(parseInt(this.dataset.step));
    });
});

document.getElementById('microtuneLockToggle')?.addEventListener('click', toggleMicrotuneLock);
document.getElementById('kbMicrotuneLock')?.addEventListener('click', toggleMicrotuneLock);
document.getElementById('kbStepsMicrotuneLock')?.addEventListener('click', toggleMicrotuneLock);

syncMicrotuneUI();

function scaleAdsrTime(value) {
    if (value < 0.1) return value * 0.1;
    if (value < 1.0) return 0.01 + (value - 0.1) * 0.3;
    return 0.28 + (value - 1.0) * 0.7;
}

const ACCENT_FILTER_DECAY = 0.2; // TB-303 MEG-on-accent ≈ 200 ms (normal ADSR path)
/** Accent VEG peak boost mirrored from acid-env for parallel ratch voices. */
const RATCH_ACCENT_AMP_BOOST = 0.85;

/** Release-knob tau (~95% settle in `seconds`). Do not clamp to the step end. */
function seqReleaseTau(seconds) {
    const releaseTime = Math.max(0.02, Number(seconds) || 0);
    return Math.max(0.008, releaseTime / 3);
}

/** Start a bus release at `offAt`. No cancelScheduledValues — lookahead already wrote the next ON. */
function scheduleBusRelease(gainParam, offAt, tau) {
    if (!gainParam) return;
    try {
        if (typeof gainParam.cancelAndHoldAtTime === 'function') {
            try { gainParam.cancelAndHoldAtTime(offAt); } catch (_) { /* ignore */ }
        }
        gainParam.setTargetAtTime(0.00001, offAt, Math.max(0.008, tau));
    } catch (_) { /* ignore */ }
}

// Schedule the per-step filter envelope (0–1 gain scaled by cutoff range).
function scheduleStepFilterEnvelope({
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
    releaseUntil = null,
    gateLen = null,
    nextIsRest = false,
}) {
    if (state.acidMode) {
        scheduleAcidFilterEnvelope({
            startTime,
            stepDuration,
            slideThisStep,
            nextStepWillSlide,
            accentThisStep,
            accentAmount,
            nextIsRest,
        });
        return;
    }

    const amount = getFilterEnvAmount();
    if (amount === 0 || !state.filterEnvGain) return;

    const attack = getNumber('filterAttack');
    const decay = getNumber('filterDecay');
    const sustain = getNumber('filterSustain');
    const release = getNumber('filterRelease');

    const gainParam = state.filterEnvGain.gain;
    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const stepEnd = t0 + stepDuration;
    const hardEnd = releaseUntil != null ? Math.max(stepEnd, releaseUntil) : stepEnd;
    const minValue = 0.00001;
    const releaseTime = Math.max(0.005, release * 0.3);

    const baseCutoff = Math.max(40, getNumber('cutoff', 1000));
    const { signedDepth: baseSignedDepth } = getFilterCutoffRange(baseCutoff, amount);
    const cutModHot = state.lfoState
        && Math.abs(getNumber('cutoffMod', 0)) > 80
        && (Number(state.lfoAmount) || 0) > 0.02;

    // Accent: temporarily boost filter-env depth for this step (≈2× at full amount)
    // Depth may be negative when invert is on — preserve sign (do not clamp to 0).
    if (accentThisStep && state.filterEnvDepth && accentAmount > 0) {
        const depthParam = state.filterEnvDepth.gain;
        const boostedDepth = baseSignedDepth * (1 + accentAmount);
        const edge = cutModHot ? 0.012 : 0.006;
        depthParam.cancelScheduledValues(t0);
        depthParam.setValueAtTime(depthParam.value, t0);
        depthParam.linearRampToValueAtTime(boostedDepth, t0 + edge);
        const restoreAt = Math.max(t0 + edge + 0.01, stepEnd - edge);
        depthParam.setValueAtTime(boostedDepth, restoreAt);
        depthParam.linearRampToValueAtTime(baseSignedDepth, stepEnd);
    }

    // Lookahead-safe boundary (same stale-.value bug as amp env — logs: R)
    let heldAtBoundary = false;
    if (typeof gainParam.cancelAndHoldAtTime === 'function') {
        try {
            gainParam.cancelAndHoldAtTime(t0);
            heldAtBoundary = true;
        } catch (_) { /* fall through */ }
    }
    if (!heldAtBoundary) gainParam.cancelScheduledValues(t0);

    if (slideThisStep) {
        const gateFrac = gateLen == null
            ? getGateLength()
            : Math.max(0.05, Math.min(1, Number(gateLen) || 0.9));
        if (!heldAtBoundary) {
            gainParam.setValueAtTime(Math.max(minValue, sustain), t0);
        }
        if (!nextStepWillSlide) {
            const offAt = Math.max(t0 + 0.02, t0 + stepDuration * gateFrac);
            scheduleBusRelease(gainParam, offAt, seqReleaseTau(release));
            state.filterEnvelopeHeld = false;
        } else {
            state.filterEnvelopeHeld = true;
        }
        return;
    }

    const gateFrac = gateLen == null
        ? getGateLength()
        : Math.max(0.05, Math.min(1, Number(gateLen) || 0.9));
    const gateWindow = stepDuration * gateFrac;
    // High-Q: sweeping cutoff in 2ms rings the filter (pings every step).
    // Scale the attack floor with resonance so the sweep stays under the ring threshold.
    const qNow = getNumber('resonance', 0);
    const qFloor = Math.max(0, Math.min(1, (qNow - 6) / 14)) * 0.014;
    const minAttack = Math.max(cutModHot ? 0.01 : 0.002, qFloor);
    const safeAttackTime = Math.max(minAttack, scaleAdsrTime(attack));
    const availableDecayTime = Math.max(0, gateWindow * 0.8 - safeAttackTime);
    // Accent forces short filter decay (~200 ms), matching TB-303 MEG-on-accent
    const decaySource = accentThisStep ? ACCENT_FILTER_DECAY : scaleAdsrTime(decay);
    const safeDecayTime = Math.max(0.002, Math.min(decaySource, availableDecayTime));

    // Hold-then-setTarget: linearRamp after a future hold starts at currentTime (lookahead swell).
    if (!heldAtBoundary) {
        gainParam.setValueAtTime(minValue, t0);
    }
    gainParam.setTargetAtTime(1, t0, Math.max(0.0008, safeAttackTime / 3));
    const decayStart = t0 + safeAttackTime;
    gainParam.setTargetAtTime(Math.max(minValue, sustain), decayStart, Math.max(0.004, safeDecayTime / 3));

    if (nextStepWillSlide) {
        state.filterEnvelopeHeld = true;
        return;
    }

    const gateEnd = t0 + gateWindow;
    const offAt = Math.max(t0 + 0.008, gateEnd);
    scheduleBusRelease(gainParam, offAt, seqReleaseTau(release));
    state.filterEnvelopeHeld = false;
}

// Schedule the per-step amp envelope. Release starts at gate-off and may run
// into OFF steps; the next ON interrupts from the held level.
function scheduleStepEnvelope({
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
    softRetrigger = false,
    releaseUntil = null,
    nextIsRest = false,
}) {
    // Drum models are self-enveloped inside the worklet — keep the shared amp open
    // so ADSR doesn't fight the internal drum envelopes.
    if (
        state.osc4Wavetable
        && state.oscStates?.[OSC4_INDEX]
        && DRUM_ENGINES.has(state.osc4Model)
    ) {
        const nowT = state.audioContext?.currentTime || 0;
        const t0 = Math.max(nowT, startTime);
        // Reopen with a short pre-ramp: a hard set to 1 while the off-step
        // drum ring-out (180ms+) is still mid-ramp steps the VCA over a
        // ringing tail — tiny click at the drum's start.
        const tPre = Math.max(nowT, t0 - 0.012);
        try {
            const g = state.envelope.gain;
            if (typeof g.cancelAndHoldAtTime === 'function') {
                g.cancelAndHoldAtTime(tPre);
            } else {
                g.cancelScheduledValues(tPre);
                g.setValueAtTime(Math.max(0.00001, Number(g.value) || 0.00001), tPre);
            }
            g.linearRampToValueAtTime(1, t0);
        } catch (_) { /* ignore */ }
        state.envelopeHeld = true;
        return 0.002;
    }
    if (state.acidMode) {
        return scheduleAcidAmpEnvelope({
            startTime,
            stepDuration,
            slideThisStep,
            nextStepWillSlide,
            accentThisStep,
            accentAmount,
            nextIsRest,
        });
    }

    const attack = getNumber('attack');
    const decay = getNumber('decay');
    const sustain = getNumber('sustain');
    const release = getNumber('release');

    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const stepEnd = t0 + stepDuration;
    const hardEnd = releaseUntil != null ? Math.max(stepEnd, releaseUntil) : stepEnd;
    const minValue = 0.00001;
    const releaseTime = Math.max(0.005, release * 0.3);
    // Accent raises amp peak: 1 → 1.5 at full amount (~+3.5 dB)
    const ampPeak = accentThisStep ? 1 + 0.5 * accentAmount : 1;
    const ampSustain = accentThisStep ? Math.min(1, sustain) * ampPeak : sustain;

    // Dark waves (sine/tri/WT) into high-Q/open filter: 2ms hard VCA retrigger
    // is the remaining click (logs: L). Saw/square mask it — keep them punchy.
    const darkOsc = hasDarkOscActive();
    const clickRisk = darkOsc ? wtFilterClickRisk() : 0;
    const useSoftRetrigger = !slideThisStep && (softRetrigger || darkOsc || !!state.phaseResetEnabled);

    // Note-OFF, not note-on, is where the Master click lives: transients measured
    // at ~77ms into a 125ms step = gate end (logs: phase analysis). Closing the
    // shared post-filter VCA in ~5ms after a resonant filter ticks; Berlin never
    // closes it, which is why Berlin Dream is clean.
    const releaseFloorRaw = darkOsc ? Math.max(0.025, wtAttackSecForFilter() * 0.8) : 0;
    // Never eat more than ~30% of the step, or 16ths turn to mush
    const releaseFloor = Math.min(releaseFloorRaw, Math.max(0.01, stepDuration * 0.3));
    const safeReleaseTime = Math.max(releaseTime, releaseFloor);

    // Lookahead-safe boundary: reading .value now and pinning it at future t0
    // jumps when the env is still moving (16ths clicked, 8ths didn't — logs: R).
    let heldAtBoundary = false;
    if ((useSoftRetrigger || slideThisStep) && typeof state.envelope.gain.cancelAndHoldAtTime === 'function') {
        try {
            state.envelope.gain.cancelAndHoldAtTime(t0);
            heldAtBoundary = true;
        } catch (_) { /* fall through to cancel below */ }
    }
    if (!heldAtBoundary) state.envelope.gain.cancelScheduledValues(t0);

    if (slideThisStep) {
        // Dest is a held gate. Release starts at dest gate-off (not clamped to step end).
        if (!heldAtBoundary) {
            state.envelope.gain.setValueAtTime(Math.max(minValue, sustain), t0);
        }
        if (!nextStepWillSlide) {
            const offAt = Math.max(t0 + 0.02, t0 + stepDuration * getGateLength());
            scheduleBusRelease(state.envelope.gain, offAt, seqReleaseTau(release));
            state.envelopeHeld = false;
        } else {
            state.envelopeHeld = true;
        }
        return 0.002;
    }

    const gateLen = getGateLength();
    const gateWindow = stepDuration * gateLen;
    const wtAmpFloor = darkOsc ? Math.max(0.008, wtAttackSecForFilter() * 0.55) : 0.002;
    const safeAttackTime = Math.max(wtAmpFloor, scaleAdsrTime(attack));
    const availableDecayTime = Math.max(0, gateWindow * 0.8 - safeAttackTime);
    const safeDecayTime = Math.max(0.002, Math.min(scaleAdsrTime(decay), availableDecayTime));
    const attackTau = darkOsc
        ? Math.max(0.012, safeAttackTime / 3)
        : Math.max(0.0008, safeAttackTime / 3);

    // setTarget after hold (or an explicit 0 pin). linearRamp from a future hold
    // starts at currentTime — that is the OFF-step swell (analog-808 comment).
    if (!heldAtBoundary) {
        state.envelope.gain.setValueAtTime(0, t0);
    }
    state.envelope.gain.setTargetAtTime(ampPeak, t0, attackTau);
    const decayStart = t0 + safeAttackTime;
    state.envelope.gain.setTargetAtTime(
        Math.max(minValue, ampSustain),
        decayStart,
        Math.max(0.004, safeDecayTime / 3),
    );

    if (nextStepWillSlide) {
        state.envelopeHeld = true;
        return safeAttackTime;
    }

    const gateEnd = t0 + gateWindow;
    const offAt = Math.max(t0 + 0.008, gateEnd);
    scheduleBusRelease(state.envelope.gain, offAt, seqReleaseTau(release));
    state.envelopeHeld = false;
    return safeAttackTime;
}

/** Stop main phase-reset oscs so they don't fight independent ratch voices. */
function silenceMainPhaseResetOscs(atTime) {
    if (!state.phaseResetEnabled || !Array.isArray(state.activeOscillators)) return;
    const t = Math.max(state.audioContext.currentTime, atTime);
    const envLevel = Number(state.envelope?.gain?.value) || 0;
    // If the VCA is still open (drum ring across offs), delay the worklet
    // release so we don't cut a kick at full level into the bus.
    const drumDelay = envLevel > 0.05 ? 0.07 : 0;
    state.activeOscillators.forEach((osc) => {
        if (osc?.isTriggered && osc?.isDrum) {
            const stopAt = t + drumDelay;
            try {
                osc.stop(stopAt, { hard: true, silent: true, fadeSec: 0.05 });
            } catch (_) {
                fadeStopOsc(osc, stopAt, { fadeSec: 0.08, hard: true });
            }
            return;
        }
        fadeStopOsc(osc, t, { fadeSec: osc.isWavetable ? 0.055 : 0.02, hard: !!osc.isTriggered });
    });
    state.activeOscillators = [];
}

/**
 * Schedule a full ADSR (or Acid VEG) on an AudioParam.
 * @returns {number} audio time when the voice is safe to tear down
 */
function scheduleFullNoteOnGain(gainParam, {
    startTime,
    stepDuration,
    accentThisStep,
    accentAmount,
    peakScale = 1,
    gateLen = null,
    holdForDrum = false,
}) {
    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const minValue = 0.00001;

    // Ratch voices: self-enveloped drums must not be chopped by the ADSR
    // (same mechanism as the main-path drum hold — logs: BD-OFF). Hold the
    // amp open for the hit, then ring out gently.
    const holdDrum = holdForDrum && !!(
        state.osc4Wavetable
        && state.oscStates?.[OSC4_INDEX]
        && DRUM_ENGINES.has(state.osc4Model)
    );
    if (holdDrum) {
        const peak = (accentThisStep ? 1 + 0.5 * accentAmount : 1) * peakScale;
        const relStart = t0 + stepDuration;
        const relLen = 0.18;
        gainParam.cancelScheduledValues(t0);
        gainParam.setValueAtTime(0, t0);
        gainParam.linearRampToValueAtTime(peak, t0 + 0.002);
        gainParam.setValueAtTime(peak, relStart);
        gainParam.exponentialRampToValueAtTime(minValue, relStart + relLen);
        return relStart + relLen + 0.05;
    }

    if (state.acidMode) {
        const peak = (accentThisStep ? 1 + RATCH_ACCENT_AMP_BOOST * accentAmount : 1) * peakScale;
        const vegSec = acidVegDecaySec();
        const tau = Math.max(0.012, vegSec / 3);
        gainParam.cancelScheduledValues(t0);
        gainParam.setValueAtTime(minValue, t0);
        gainParam.linearRampToValueAtTime(peak, t0 + 0.003);
        gainParam.setTargetAtTime(minValue, t0 + 0.003, tau);
        const gateFrac = getGateLength();
        const dumpAt = Math.min(t0 + stepDuration - 0.005, Math.max(t0 + 0.012, t0 + stepDuration * gateFrac));
        try {
            if (typeof gainParam.cancelAndHoldAtTime === 'function') {
                gainParam.cancelAndHoldAtTime(dumpAt);
            }
        } catch (_) { /* ignore */ }
        gainParam.setTargetAtTime(minValue, dumpAt, Math.max(0.012, 0.12 / 3));
        return t0 + Math.max(stepDuration, vegSec * 3) + 0.08;
    }

    const attack = getNumber('attack');
    const decay = getNumber('decay');
    const sustain = getNumber('sustain');
    const release = getNumber('release');
    const stepEnd = t0 + stepDuration;
    const releaseTime = Math.max(0.005, release * 0.3);
    const ampPeak = (accentThisStep ? 1 + 0.5 * accentAmount : 1) * peakScale;
    const ampSustain = (accentThisStep ? Math.min(1, sustain) * (1 + 0.5 * accentAmount) : sustain) * peakScale;
    const gateFrac = gateLen == null
        ? getGateLength()
        : Math.max(0.05, Math.min(1, Number(gateLen) || 0.9));
    const gateWindow = stepDuration * gateFrac;
    // Dark/WT click floor is for sustained digital tones into a high-Q filter.
    // Triggered engines (pluck/modal/drums) put their transient in the first few
    // ms — applying wtAttackSecForFilter() here opens the VCA after the hit.
    const triggeredDigital = !!(
        state.osc4Wavetable
        && state.oscStates?.[OSC4_INDEX]
        && isTriggeredEngine(state.osc4Model)
    );
    const wtFloor = (
        state.osc4Wavetable
        && state.oscStates?.[OSC4_INDEX]
        && !triggeredDigital
    ) ? wtAttackSecForFilter() : 0.002;
    const safeAttackTime = Math.max(wtFloor, scaleAdsrTime(attack));
    const availableDecayTime = Math.max(0, gateWindow * 0.8 - safeAttackTime);
    const safeDecayTime = Math.max(0.002, Math.min(scaleAdsrTime(decay), availableDecayTime));

    gainParam.cancelScheduledValues(t0);
    gainParam.setValueAtTime(0, t0);
    gainParam.linearRampToValueAtTime(ampPeak, t0 + safeAttackTime);
    const decayEnd = t0 + safeAttackTime + safeDecayTime;
    gainParam.linearRampToValueAtTime(Math.max(minValue, ampSustain), decayEnd);

    const gateEnd = t0 + gateWindow;
    const releaseStart = Math.min(
        stepEnd - 0.005,
        Math.max(decayEnd + 0.01, gateEnd)
    );
    const effectiveRelease = Math.min(releaseTime, Math.max(0.005, stepEnd - releaseStart - 0.001));
    gainParam.setValueAtTime(Math.max(minValue, ampSustain), releaseStart);
    gainParam.exponentialRampToValueAtTime(minValue, releaseStart + effectiveRelease);
    return releaseStart + effectiveRelease + 0.05;
}

/**
 * Fire N independent full-note voices on the ratchet grid.
 * Per enabled OSC (and noise) → Berlin shared panner/mute → ring/filter/SC/dirt.
 */
function scheduleParallelRatchHits({
    startTime,
    stepDuration,
    hits,
    accentThisStep,
    accentAmount,
    glissRoll = false,
    slideIn = false,
    slideTime = 0.05,
    freqForOsc,
    nextFreqForOsc = null,
}) {
    if (typeof freqForOsc !== 'function') return;
    const before = state.berlinOscVoices?.length || 0;
    armBerlinSharedAmpPath(startTime);
    silenceMainPhaseResetOscs(startTime);
    const peakScale = 1 / Math.sqrt(Math.max(1, hits));
    const subDur = stepDuration / Math.max(1, hits);
    const gateLen = getGateLength();
    const oscCount = state.oscStates?.length || 0;

    for (let k = 0; k < hits; k++) {
        const tHit = startTime + k * subDur;
        for (let i = 0; i < oscCount; i++) {
            if (!state.oscStates[i]) continue;
            const fromHz = freqForOsc(i);
            spawnBerlinOscVoice({
                oscIndex: i,
                startTime: tHit,
                stepDuration,
                gateLen,
                accentThisStep,
                accentAmount,
                peakScale,
                glissRoll,
                slideIn: hits === 1 && slideIn && k === 0,
                slideTime,
                fromHz,
                toHz: glissRoll && typeof nextFreqForOsc === 'function'
                    ? nextFreqForOsc(i)
                    : null,
            });
        }
        spawnSharedNoiseVoice({
            startTime: tHit,
            stepDuration,
            accentThisStep,
            accentAmount,
            peakScale,
            gateLen,
        });
    }
    // After spawn so slide-in still reads the previous step's pitch (Berlin does the same).
    if (state.oscStates) {
        for (let i = 0; i < oscCount; i++) {
            if (!state.oscStates[i]) continue;
            const endFreq = glissRoll && typeof nextFreqForOsc === 'function'
                ? nextFreqForOsc(i)
                : freqForOsc(i);
            state.lastStepFreqs[i] = endFreq;
        }
    }
    if (before === 0 && !(state.berlinOscVoices?.length)) {
        disarmBerlinSharedAmpPath(startTime);
    }
}

function clearStopCleanup() {
    if (state.stopCleanupTimeout) {
        clearTimeout(state.stopCleanupTimeout);
        state.stopCleanupTimeout = null;
    }
}

function stopActiveVoices(now) {
    const fadeOutTime = Math.max(0.15, getNumber('release'));
    const filterFadeOutTime = Math.max(0.15, getNumber('filterRelease'));
    const generation = state.playGeneration;

    // Apply graceful fade-out to prevent clicks
    state.envelope.gain.cancelScheduledValues(now);
    state.envelope.gain.setValueAtTime(Math.max(0.00001, state.envelope.gain.value || 0.00001), now);
    state.envelope.gain.exponentialRampToValueAtTime(0.00001, now + fadeOutTime);
    releaseBerlinOscVoices(now);
    releaseBerlinDrumVoices(now);

    if (state.filterEnvGain) {
        const baseCutoff = Math.max(40, getNumber('cutoff', 1000));
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(Math.max(0.00001, state.filterEnvGain.gain.value || 0.00001), now);
        state.filterEnvGain.gain.exponentialRampToValueAtTime(0.00001, now + filterFadeOutTime);
        updateFilterCutoffRange(baseCutoff, now, filterFadeOutTime);
    }
    clearAccentSweep(now);
    state.filterEnvelopeHeld = false;

    state.stopCleanupTimeout = setTimeout(() => {
        // Ignore this callback if playback restarted or a newer stop superseded us
        if (state.isPlaying || state.isArping || generation !== state.playGeneration) return;

        const t = state.audioContext.currentTime;

        if (state.phaseResetEnabled) {
            state.activeOscillators.forEach(osc => {
                if (!osc.started) return;
                try {
                    if (osc.gainNode) {
                        osc.gainNode.gain.cancelScheduledValues(t);
                        osc.gainNode.gain.setValueAtTime(Math.max(0.00001, osc.gainNode.gain.value || 0.00001), t);
                        osc.gainNode.gain.exponentialRampToValueAtTime(0.00001, t + 0.05);
                    }

                    setTimeout(() => {
                        if (state.isPlaying || state.isArping || generation !== state.playGeneration) return;
                        try {
                            osc.stop();
                            osc.disconnect();
                        } catch (e) {
                            console.log('Error stopping oscillator:', e);
                        }
                    }, 60);
                } catch (e) {
                    console.log('Error stopping oscillator:', e);
                }
            });
            state.activeOscillators = [];
        }

        if (state.noiseSource) {
            try {
                state.noiseGain.gain.cancelScheduledValues(t);
                state.noiseGain.gain.setValueAtTime(Math.max(0.00001, state.noiseGain.gain.value || 0.00001), t);
                state.noiseGain.gain.exponentialRampToValueAtTime(0.00001, t + 0.05);

                setTimeout(() => {
                    if (state.isPlaying || state.isArping || generation !== state.playGeneration) return;
                    try {
                        state.noiseSource.stop();
                    } catch (e) {
                        console.log('Error stopping noise source:', e);
                    }
                    state.noiseSource = null;
                }, 60);
            } catch (e) {
                console.log('Error stopping noise source:', e);
            }
        }

        state.stopCleanupTimeout = null;
    }, fadeOutTime * 1000 + 50);
}

const IDLE_MARQUEE_TEXT = VFD_BRAND_SCROLL;
const ARP_MARQUEE_TEXT = 'ArP ';
const POLY_ARP_MARQUEE_TEXT = 'ArP PoLY ';
const POLY_MARQUEE_TEXT = 'PoLY ';
const MULTITUDES_ARP_MARQUEE_TEXT = 'ArP MuLT ';
const MULTITUDES_MARQUEE_TEXT = 'MuLT ';
const WRITE_MARQUEE_TEXT = ' WritE StEPS ';
const SCALE_MARQUEE_TEXT = ' ScALE ';
const IDLE_MARQUEE_MS = 320;
let idleMarqueeTimer = null;
let idleMarqueeIndex = 0;
/** While true in Write mode, VFD scrolls "Write" instead of the step number. */
let writeAwaitingFirstProgram = false;

function isScaleEnabled() {
    return !!get('scaleToggle');
}

function setKeyboardStepDigits(pair, { lit = true, label = '', brand = false, cyan = false } = {}) {
    const el = document.getElementById('kbStepDisplay');
    if (!el) return;
    const text = String(pair).padEnd(2, ' ').slice(0, 2);
    el.dataset.value = text;
    if (label) el.setAttribute('aria-label', label);
    const t0 = performance.now();
    const digits = el.querySelectorAll('.sixteen-seg');
    applyVfdChar(digits[0], text[0], { brand });
    applyVfdChar(digits[1], text[1], { brand });
    el.classList.toggle('lit', lit);
    el.classList.toggle('vfd-cyan', !!cyan);
    const ms = performance.now() - t0;
    const p = (window.__ingyProf ||= {});
    p.dispN = (p.dispN || 0) + 1;
    if (ms > (p.dispMax || 0)) p.dispMax = ms;
}

function stopIdleMarquee() {
    if (idleMarqueeTimer !== null) {
        clearInterval(idleMarqueeTimer);
        idleMarqueeTimer = null;
    }
}

/** Berlin Dream owns DISP: static cyan "bd" (idle and while playing). */
function showBerlinBdOnVfd() {
    stopIdleMarquee();
    setKeyboardStepDigits('bd', {
        lit: true,
        label: 'Berlin Dream',
        cyan: true,
    });
}

function idleMarqueeSource() {
    if (state.keyboardWrite && writeAwaitingFirstProgram) {
        return { text: WRITE_MARQUEE_TEXT, label: 'Write Steps', brand: false, cyan: true };
    }
    if (state.keyboardMultitudes && state.keyboardArp) {
        return { text: MULTITUDES_ARP_MARQUEE_TEXT, label: 'Multitudes Arp', brand: true, cyan: true };
    }
    if (state.keyboardPoly && state.keyboardArp) {
        return { text: POLY_ARP_MARQUEE_TEXT, label: 'Poly Arp', brand: true, cyan: true };
    }
    if (state.keyboardArp) {
        return { text: ARP_MARQUEE_TEXT, label: 'Arp', brand: false, cyan: true };
    }
    if (state.keyboardMultitudes) {
        return { text: MULTITUDES_MARQUEE_TEXT, label: 'Multitudes', brand: true, cyan: true };
    }
    if (state.keyboardPoly) {
        return { text: POLY_MARQUEE_TEXT, label: 'Poly', brand: true, cyan: true };
    }
    if (isScaleEnabled()) {
        return { text: SCALE_MARQUEE_TEXT, label: 'Scale', brand: false, cyan: true };
    }
    return { text: IDLE_MARQUEE_TEXT, label: 'InGYSYnth.', brand: true, cyan: false };
}

function tickIdleMarquee() {
    // Shared state: abort even if a duplicate module instance still has a timer
    if (state.isPlaying) {
        stopIdleMarquee();
        return;
    }
    const { text, label, brand, cyan } = idleMarqueeSource();
    const len = text.length;
    const a = text[idleMarqueeIndex % len];
    const b = text[(idleMarqueeIndex + 1) % len];
    setKeyboardStepDigits(`${a}${b}`, { lit: true, label, brand, cyan: !!cyan });
    idleMarqueeIndex = (idleMarqueeIndex + 1) % len;
}

function startIdleMarquee() {
    // Sequencer play owns the VFD for step numbers — never scroll brand over it
    if (state.isPlaying) return;
    if (isBerlinOn()) {
        showBerlinBdOnVfd();
        return;
    }
    stopIdleMarquee();
    idleMarqueeIndex = 0;
    tickIdleMarquee();
    idleMarqueeTimer = setInterval(tickIdleMarquee, IDLE_MARQUEE_MS);
}

/** Refresh idle VFD (brand vs ArP vs Write vs Scale) when mode toggles. */
export function refreshIdleVfd() {
    if (isBerlinOn()) {
        clearStepsPreviewTimer();
        showBerlinBdOnVfd();
        return;
    }
    if (state.isPlaying) return;
    if (state.keyboardWrite) {
        showWriteStepOnVfd();
        return;
    }
    writeAwaitingFirstProgram = false;
    if (state.keyboardVoiceActive && !state.keyboardArp) return;
    startIdleMarquee();
}

/** Enter Write-mode VFD prompt: scroll "Write" until a step is programmed. */
export function beginWriteVfdPrompt() {
    writeAwaitingFirstProgram = true;
    clearStepsPreviewTimer();
    if (state.isPlaying) return;
    startIdleMarquee();
}

/** Stop the Write marquee and show the write-cursor step on DISP. */
export function endWriteVfdPrompt() {
    if (!state.keyboardWrite) return;
    writeAwaitingFirstProgram = false;
    showWriteStepOnVfd();
}

/** After the first programmed step in Write mode, show the write cursor. */
export function markWriteStepProgrammed() {
    endWriteVfdPrompt();
}

/** Start Scale idle VFD scroll (ScALE while Scale is on). */
export function beginScaleVfdPrompt() {
    if (state.isPlaying || state.keyboardWrite) return;
    clearStepsPreviewTimer();
    startIdleMarquee();
}

/** Leave Scale VFD scroll when Scale turns off. */
export function endScaleVfdPrompt() {
    if (state.isPlaying || state.keyboardWrite) return;
    if (state.keyboardVoiceActive && !state.keyboardArp) return;
    startIdleMarquee();
}

/** Show the write-target step on the keyboard VFD (cyan). Playback owns DISP while playing. */
export function showWriteStepOnVfd() {
    if (!state.keyboardWrite) return;
    // While sequencer runs, keep green play-step numbers on DISP
    if (state.isPlaying) return;
    clearStepsPreviewTimer();
    if (writeAwaitingFirstProgram) {
        if (idleMarqueeTimer === null) startIdleMarquee();
        return;
    }
    stopIdleMarquee();
    const text = String(state.writeStep + 1).padStart(2, '0');
    setKeyboardStepDigits(text, {
        lit: true,
        label: `Write step ${text}`,
        cyan: true,
    });
}

const STEPS_PREVIEW_MS = 900;
let stepsPreviewTimer = null;
let lastVfdStepIndex = 0;

function clearStepsPreviewTimer() {
    if (stepsPreviewTimer !== null) {
        clearTimeout(stepsPreviewTimer);
        stepsPreviewTimer = null;
    }
}

function updateKeyboardStepDisplay(stepIndex, { chordCount = 0 } = {}) {
    lastVfdStepIndex = stepIndex;
    // Keep STEPS knob preview on the VFD until its timeout ends
    if (stepsPreviewTimer !== null) return;
    if (isBerlinOn()) {
        showBerlinBdOnVfd();
        return;
    }
    // Write cursor (cyan) when stopped; during play always show green step numbers
    if (state.keyboardWrite && !state.isPlaying) {
        showWriteStepOnVfd();
        return;
    }
    // Arp mode owns the VFD (idle or actively arping) — not during sequencer play
    if (!state.isPlaying && state.keyboardArp) {
        if (idleMarqueeTimer === null) startIdleMarquee();
        return;
    }
    // Always kill marquee before painting step digits (covers stray duplicate timers)
    stopIdleMarquee();
    const text = String(stepIndex + 1).padStart(2, '0');
    setKeyboardStepDigits(text, {
        lit: true,
        label: `Step ${text}`,
        cyan: false,
    });
}

function clearKeyboardStepDisplay() {
    clearStepsPreviewTimer();
    if (isBerlinOn()) {
        showBerlinBdOnVfd();
        return;
    }
    if (state.keyboardWrite) {
        showWriteStepOnVfd();
        return;
    }
    // Don't restart the brand marquee over live step numbers (e.g. stopArp while playing)
    if (state.isPlaying) {
        stopIdleMarquee();
        const text = String(lastVfdStepIndex + 1).padStart(2, '0');
        setKeyboardStepDigits(text, { lit: true, label: `Step ${text}` });
        return;
    }
    startIdleMarquee();
}

/** Flash the step-count value on the keyboard VFD while adjusting STEPS. */
export function previewStepsOnVfd(stepCount) {
    clearStepsPreviewTimer();
    stopIdleMarquee();
    const n = Math.max(0, Math.min(99, Math.round(Number(stepCount)) || 0));
    const text = String(n).padStart(2, '0');
    setKeyboardStepDigits(text, { lit: true, label: `Steps ${text}`, cyan: true });
    stepsPreviewTimer = setTimeout(() => {
        stepsPreviewTimer = null;
        if (isBerlinOn()) {
            showBerlinBdOnVfd();
        } else if (state.keyboardWrite) {
            showWriteStepOnVfd();
        } else if (!state.isPlaying && state.keyboardArp) {
            startIdleMarquee();
        } else if (state.isPlaying || state.isArping) {
            updateKeyboardStepDisplay(lastVfdStepIndex);
        } else {
            startIdleMarquee();
        }
    }, STEPS_PREVIEW_MS);
}

function warmBerlinAnalogDrums() {
    const ctx = state.audioContext;
    if (!ctx) return;
    routeBerlinDrumPanners();
    if (!Array.isArray(state.berlinDrumVoices)) state.berlinDrumVoices = [];
    for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
        const patch = state.berlinDrum?.[lane];
        if (!isAnalogDrumEngine(patch)) continue;
        const panner = state.berlinDrumPanners?.[lane];
        if (!panner) continue;
        if (state.berlinDrumVoices.some((v) => v.lane === lane && v.isAnalog && !v.dead)) continue;
        const model = canonicalDrumModel(patch.model);
        const voice = createAnalog808Voice(ctx, {
            model,
            patch: { ...patch },
            panner,
            hz: analogKitHz(model, patch.tune, 0, 0),
            startTime: ctx.currentTime,
            warm: true,
        });
        if (!voice) continue;
        voice.lane = lane;
        voice.epoch = 1;
        state.berlinDrumVoices.push(voice);
    }
}

/** Song conductor, registered from song-conductor.js. Sequencer does not import it. */
let songConductor = null;
/** Returns true when Arrange record handled this Play press (count-in). */
let songRecordGate = null;
/** Scrub launch starts immediately instead of opening a record count-in. */
let skipRecordGate = false;
/** Seconds to advance instead of a pattern step while a song gap is silent. */
let songSilenceAdvance = null;

export function setSongConductor(c) {
    songConductor = c || null;
}

export function setSongRecordGate(fn) {
    songRecordGate = typeof fn === 'function' ? fn : null;
}

function togglePlay() {
    if (!state.audioContext) {
        songConductor?.clearContinue?.();
        return;
    }
    if (!skipRecordGate && songRecordGate && songRecordGate()) return;

    // Safari (and other browsers) can suspend the context after idle time;
    // resume on every Start/Stop click so scheduled audio actually renders.
    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }

    const arrange = document.body.classList.contains('is-arrange');
    const stoppingSong = !!state.songPlaying && !!state.isPlaying;
    const startingSong = arrange && !state.isPlaying && !!songConductor;
    if (startingSong) {
        if (!state.songPlaying) songConductor.rememberPerform();
        state.songPlaying = true;
    }

    state.isPlaying = !state.isPlaying;
    const startStopButton = document.getElementById('startStop');
    const mobileStartStopButton = document.getElementById('mobileStartStop');
    const kbStartStopButton = document.getElementById('kbStartStop');
    const ckbSpaceButtons = document.querySelectorAll('.ckb-space');
    const startStopFront = startStopButton?.querySelector('.front');
    const mobileStartStopFront = mobileStartStopButton?.querySelector('.front');
    
    if (state.isPlaying) {
        clearStepsPreviewTimer();
        stopIdleMarquee();
        clearStopCleanup();
        stopArp();
        state.playGeneration += 1;
        bumpSeqEngine();
        forceNoteOff();
        document.dispatchEvent(new CustomEvent('ingysynth:sequencer-start'));

        warmAnalogShells(state.audioContext);

        hideLogoOverlay();

        const now = state.audioContext.currentTime;
        // Cancel any pending stop fade and reset the envelope for a clean attack
        state.envelope.gain.cancelScheduledValues(now);
        state.envelope.gain.setValueAtTime(0, now);
        if (state.filterEnvGain) {
            state.filterEnvGain.gain.cancelScheduledValues(now);
            state.filterEnvGain.gain.setValueAtTime(0, now);
        }
        clearAccentSweep(now);
        
        state.currentStep = state.isReverse ? getNumber('stepCount') - 1 : 0;
        state.nextStepTime = now + 0.1;
        state.lastStepSounded = false;
        state.envelopeHeld = false;
        state.filterEnvelopeHeld = false;
        state.cyclePass = 0;
        state.cycleFirstPass = true;
        state.berlinCyclePass = 0;
        // Berlin's start anchor below IS pass 1. Normal mode's first step consumes cycleFirstPass.
        state.berlinCycleFirstPass = false;
        if (state.songPlaying && songConductor) {
            songConductor.begin(state.nextStepTime, { allowContinue: true });
        }
        // Every Berlin row restarts from its own beginning on the same downbeat
        if (isBerlinOn()) {
            warmPlaitsPool(state.audioContext, 6);
            warmAnalogShells(state.audioContext);
            warmBerlinAnalogDrums();
            if (state.songPlaying && songConductor) {
                const info = songConductor.armBerlin(state.nextStepTime);
                if (info?.armed && !info?.silent) {
                    queuePatternPass(
                        state.nextStepTime,
                        (state.berlinCyclePass | 0) + 1,
                        patternRepeat(getBerlinPattern(state.berlinSlot)),
                    );
                }
            } else {
                resetBerlinPlayheads(state.nextStepTime);
                notifyAutomationLoopAnchor(state.nextStepTime);
                queuePatternPass(
                    state.nextStepTime,
                    1,
                    patternRepeat(getBerlinPattern(state.berlinSlot)),
                );
            }
        }
        if (state.berlinDrumMode) {
            warmPlaitsPool(state.audioContext, 6);
            warmAnalogShells(state.audioContext);
            warmBerlinAnalogDrums();
        }
        if (!(state.songPlaying && songConductor)) resetDrumPlayheads(state.nextStepTime);
        resetSidechainDucker(state.nextStepTime);
        scheduleNextStep();
        
        // Update all start/stop buttons
        if (startStopFront) startStopFront.textContent = 'Stop';
        startStopButton?.classList.remove('start');
        startStopButton?.classList.add('stop');
        
        if (mobileStartStopFront) mobileStartStopFront.textContent = 'Stop';
        mobileStartStopButton?.classList.remove('start');
        mobileStartStopButton?.classList.add('stop');

        if (kbStartStopButton) {
            kbStartStopButton.classList.remove('start');
            kbStartStopButton.classList.add('stop');
        }
        ckbSpaceButtons.forEach((btn) => {
            btn.classList.remove('start');
            btn.classList.add('stop');
        });
    } else {
        if (stoppingSong && songConductor) songConductor.restorePerformSlots();
        state.playGeneration += 1;
        bumpSeqEngine();
        midiAllNotesOff();
        clearLastPolySounding();
        clearStopCleanup();

        // Show logo again when stopping, but with a delay
        showLogoOverlay(1500);
        
        stopActiveVoices(state.audioContext.currentTime);
        resetSidechainDucker(state.audioContext.currentTime);
        document.dispatchEvent(new CustomEvent('ingysynth:sequencer-stop'));
        
        // Update all start/stop buttons
        if (startStopFront) startStopFront.textContent = 'Start';
        startStopButton?.classList.remove('stop');
        startStopButton?.classList.add('start');
        
        if (mobileStartStopFront) mobileStartStopFront.textContent = 'Start';
        mobileStartStopButton?.classList.remove('stop');
        mobileStartStopButton?.classList.add('start');

        if (kbStartStopButton) {
            kbStartStopButton.classList.remove('stop');
            kbStartStopButton.classList.add('start');
        }
        ckbSpaceButtons.forEach((btn) => {
            btn.classList.remove('stop');
            btn.classList.add('start');
        });

        clearKeyboardStepDisplay();
        setKeyboardStepActive(null);
        clearBerlinStepActive();
        clearDrumStepActive();
        // Idle note matrix: "Note" (cyan knob preview can override while stopped)
        window.noteVisualizerPreviewActive = false;
        if (window.noteVisualizerPreviewTimeout) {
            clearTimeout(window.noteVisualizerPreviewTimeout);
            window.noteVisualizerPreviewTimeout = null;
        }
        clearNoteVisualizer();
        if (stoppingSong) {
            state.songPlaying = false;
            if (songConductor) songConductor.finishSong();
        }
    }
}

function chokeBus(param, now) {
    if (!param) return;
    const cur = Math.max(0.00001, param.value || 0.00001);
    param.cancelScheduledValues(now);
    param.setValueAtTime(cur, now);
    param.exponentialRampToValueAtTime(0.00001, now + 0.012);
}

function hardRelocateArrangement(tick) {
    const ctx = state.audioContext;
    const now = ctx.currentTime;
    const when = now + 0.03;
    state.playGeneration += 1;
    clearStopCleanup();
    bumpSeqEngine();
    forceNoteOff();
    midiAllNotesOff();
    clearLastPolySounding();
    releaseSongHold(now);
    stopActiveVoices(now);
    chokeBus(state.envelope?.gain, now);
    chokeBus(state.filterEnvGain?.gain, now);
    clearAccentSweep(now);
    state.song.playheadTick = tick;
    state.nextStepTime = when;
    state.lastStepSounded = false;
    state.envelopeHeld = false;
    state.filterEnvelopeHeld = false;
    state.cyclePass = 0;
    state.cycleFirstPass = true;
    state.berlinCyclePass = 0;
    state.berlinCycleFirstPass = false;
    songSilenceAdvance = null;
    songConductor.clearContinue?.();
    songConductor.begin(when, { allowContinue: false });
    if (isBerlinOn()) {
        const info = songConductor.armBerlin(when);
        ensurePlayheads();
        for (const ph of state.berlinPlayheads) {
            if (ph) ph.nextStepTime = when;
        }
        state.berlinLoopAnchor = when;
        if (info?.armed && !info.silent) {
            queuePatternPass(
                when,
                (state.berlinCyclePass | 0) + 1,
                patternRepeat(getBerlinPattern(state.berlinSlot)),
            );
        }
    }
}

/** Move arrangement playback to a tick. Starts playback when transport is stopped. */
function relocateArrangement(tick) {
    if (!state.song) return false;
    const t = Math.max(0, Math.round(Number(tick) || 0));
    if (!state.audioContext || !songConductor?.begin) {
        state.song.playheadTick = t;
        return false;
    }
    if (!document.body.classList.contains('is-arrange')) return false;
    songConductor.clearContinue?.();
    if (!state.isPlaying) {
        state.song.playheadTick = t;
        skipRecordGate = true;
        try {
            togglePlay();
        } finally {
            skipRecordGate = false;
        }
        return !!state.isPlaying;
    }
    if (!state.songPlaying) return false;
    hardRelocateArrangement(t);
    return true;
}

function currentStepDuration() {
    const tempoN = getNumber('tempo', 120);
    const tempo = Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
    const division = Math.max(1, getNumber('division', 8) || 8);
    return (60 / tempo) * (4 / division);
}

/** 0–1 through the Repeat cycle, plus the audio-time window of this pass. */
function normalPassMeter(stepIndex, stepDuration, startTime) {
    const pattern = getPattern(state.editSlot);
    const n = patternStepCount(pattern);
    const repeat = patternRepeat(pattern);
    const idxRaw = pattern.reverse ? (n - 1 - stepIndex) : stepIndex;
    const idx = Math.max(0, Math.min(Math.max(0, n - 1), idxRaw));
    const dur = Number(stepDuration) > 0 ? Number(stepDuration) : 0;
    const total = n * repeat;
    const progress = total <= 0 ? 0 : Math.max(0, Math.min(1, (state.cyclePass * n + idx + 1) / total));
    const pass = Math.max(1, Math.min(repeat, (state.cyclePass | 0) + 1));
    const passStart = startTime - idx * dur;
    const passEnd = passStart + Math.max(1, n) * dur;
    return { progress, pass, repeat, passStart, passEnd };
}

function berlinPassMeter(atTime) {
    const tempoN = getNumber('tempo', 120);
    const tempo = Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
    const loop = masterLoopSeconds(tempo);
    const repeat = patternRepeat(getBerlinPattern(state.berlinSlot));
    const anchor = state.berlinLoopAnchor;
    const into = loop > 0.001 ? (atTime - anchor) / loop : 0;
    const clamped = Math.max(0, Math.min(1, into));
    const progress = Math.max(0, Math.min(1, (state.berlinCyclePass + clamped) / Math.max(1, repeat)));
    const pass = Math.max(1, Math.min(repeat, (state.berlinCyclePass | 0) + 1));
    return {
        progress,
        pass,
        repeat,
        passStart: anchor,
        passEnd: anchor + Math.max(0, loop),
    };
}

function meterDetailFrom(item) {
    if (!item || item.passEnd == null || item.passStart == null) return null;
    return {
        progress: item.cycleProgress,
        pass: item.cyclePass,
        repeat: item.cycleRepeat,
        passStart: item.passStart,
        passEnd: item.passEnd,
    };
}

function queuePatternPass(startTime, pass, repeat) {
    if (!state.audioContext) return;
    const generation = state.playGeneration;
    const heardAt = startTime + uiOutputLatency();
    const delay = Math.max(0, (heardAt - state.audioContext.currentTime) * 1000);
    setTimeout(() => {
        if (generation !== state.playGeneration || !state.isPlaying) return;
        document.dispatchEvent(new CustomEvent('ingysynth:pattern-pass', {
            detail: { pass, repeat, startTime },
        }));
    }, delay);
}

function scheduleNextStep() {
    if (!state.isPlaying || !state.audioContext) return;

    if (isBerlinOn()) {
        const seqT0 = performance.now();
        scheduleBerlinSteps();
        scheduleDrumLanes();
        const p = (window.__ingyProf ||= {});
        const seqMs = performance.now() - seqT0;
        if (seqMs > (p.seqMax || 0)) p.seqMax = seqMs;
        setTimeout(scheduleNextStep, 25);
        return;
    }

    // Look ahead far enough to survive Safari main-thread gaps (~200 ms).
    const lookAheadTime = 0.3; // 300ms
    const seqT0 = performance.now();
    
    // Schedule notes in the next scheduling window.
    // Duration is re-read after each step: a cycle-boundary switch can change division.
    let songSpins = 0;
    while (state.nextStepTime < state.audioContext.currentTime + lookAheadTime) {
        if (state.songPlaying && ++songSpins > 64) break;
        let startTime = state.nextStepTime;
        if (state.songPlaying && songConductor) {
            const prep = songConductor.prepareStepTime(startTime);
            if (prep?.rewind) {
                state.nextStepTime = prep.time;
                continue;
            }
            if (prep && Number.isFinite(prep.time)) startTime = prep.time;
        }
        // Finish the current drum pattern on this downbeat before a queued P switch
        // restarts all four lanes at step 1.
        if (!state.songPlaying && upcomingNormalCycleStart(state.currentStep)) {
            scheduleDrumLanesUntil(startTime);
        }
        playStep(state.currentStep, startTime, currentStepDuration(), null);

        if (state.songPlaying && songSilenceAdvance != null) {
            const adv = songSilenceAdvance;
            songSilenceAdvance = null;
            let next = startTime + adv;
            const cap = songConductor?.nextNormalAdvanceCap?.(startTime);
            if (Number.isFinite(cap) && cap < next) next = cap;
            if (!(next > startTime + 1e-5)) next = startTime + Math.max(adv, 1e-3);
            state.nextStepTime = next;
            continue;
        }

        // Re-read: an armed bank switch can swap pattern length mid-window
        const stepCount = getNumber('stepCount', 8);
        const stepDuration = currentStepDuration();

        // Advance to next step
        if (state.isReverse) {
            state.currentStep = (state.currentStep - 1 + stepCount) % stepCount;
        } else {
            state.currentStep = (state.currentStep + 1) % stepCount;
        }
        
        state.nextStepTime += stepDuration;
        if (state.songPlaying && songConductor) {
            const cap = songConductor.nextNormalAdvanceCap(startTime);
            if (Number.isFinite(cap) && cap > startTime + 1e-5 && state.nextStepTime > cap) {
                state.nextStepTime = cap;
            }
        }
    }
    scheduleDrumLanes();
    const seqMs = performance.now() - seqT0;
    const p = (window.__ingyProf ||= {});
    if (seqMs > (p.seqMax || 0)) p.seqMax = seqMs;

    // Use setTimeout with lookahead for better timing stability
    const timeUntilNextSchedule = 25; // ms
    setTimeout(scheduleNextStep, timeUntilNextSchedule);
}

// --- Berlin Dream-960: one clock, eight independent lanes ---------------------

const BERLIN_LOOKAHEAD = 0.1;
const UI_DUE_SLACK = 0.008;

/**
 * Seconds between an AudioContext time and that audio leaving the speaker.
 * Lights are armed against context time, so without this they lead the sound
 * by the whole output buffer. Desktop and iOS sit near 10-30 ms. Android
 * Chrome with the 'playback' hint runs 100 ms or more behind, enough that the
 * step strip visibly fires before the note. Read live: latency changes when
 * a Bluetooth sink connects.
 */
export function uiOutputLatency() {
    const ctx = state.audioContext;
    if (!ctx) return 0;
    const total = (Number(ctx.baseLatency) || 0) + (Number(ctx.outputLatency) || 0);
    if (!Number.isFinite(total) || total <= 0) return 0;
    return Math.min(0.5, total);
}

let playUiQueue = [];
let playUiTimer = null;
let playUiAt = Infinity;
/** Last sequenced poly chord for slide into the next poly step. */
let lastPolySounding = null;
/** True when the last poly step left per-voice gates held (slide-out). */
let lastPolySeqHeld = false;

function clearLastPolySounding() {
    lastPolySounding = null;
    lastPolySeqHeld = false;
}

function midiChannelNibble() {
    return ((state.selectedMidiChannel || 1) - 1) & 0x0f;
}

function midiAllNotesOff() {
    const out = state.selectedMidiOutput;
    if (!state.sendMidiEnabled || !out) return;
    try {
        out.send([0xB0 | midiChannelNibble(), 123, 0]);
    } catch (_) { /* ignore */ }
}

function seqMidiStillValid(playGen, engineGen) {
    return playGen === state.playGeneration
        && engineGen === state.seqEngineGeneration;
}

/** N note-on/off for a sequenced poly voicing. Timeouts are play + engine keyed. */
function seqMidiChord({
    soundingRoot,
    intervals,
    startTime,
    gateSec,
    accentThisStep,
    fineCents,
    engineGen,
}) {
    if (!state.sendMidiEnabled || !state.selectedMidiOutput || !state.audioContext) return;
    const playGen = state.playGeneration;
    const eng = engineGen ?? state.seqEngineGeneration;
    const ch = midiChannelNibble();
    const vel = accentThisStep ? 127 : 100;
    const ivs = (Array.isArray(intervals) && intervals.length) ? intervals : [0];
    const bendRangeEl = document.getElementById('bendRange');
    const bendRange = bendRangeEl ? parseInt(bendRangeEl.value, 10) : 2;
    const onDelay = Math.max(0, (startTime - state.audioContext.currentTime) * 1000);
    const offDelay = Math.max(0, (startTime + gateSec - state.audioContext.currentTime) * 1000);
    setTimeout(() => {
        if (!seqMidiStillValid(playGen, eng) || !state.selectedMidiOutput) return;
        if (fineCents != null && fineCents !== state.lastSentBendCents) {
            const bend = midiPitchBendValue(fineCents, bendRange);
            state.selectedMidiOutput.send([0xE0 | ch, bend & 0x7F, bend >> 7]);
            state.lastSentBendCents = fineCents;
        }
        for (const iv of ivs) {
            const n = Math.min(127, Math.max(0, state.midiBaseNote + soundingRoot + iv));
            state.selectedMidiOutput.send([0x90 | ch, n, vel]);
        }
    }, onDelay);
    setTimeout(() => {
        if (!seqMidiStillValid(playGen, eng) || !state.selectedMidiOutput) return;
        for (const iv of ivs) {
            const n = Math.min(127, Math.max(0, state.midiBaseNote + soundingRoot + iv));
            state.selectedMidiOutput.send([0x80 | ch, n, 0]);
        }
    }, offDelay);
}

function onSeqEngineBump() {
    const now = state.audioContext?.currentTime ?? 0;
    silenceMainPhaseResetOscs(now);
    releaseBerlinOscVoices(now);
    midiAllNotesOff();
    clearLastPolySounding();
    if (!state.isPlaying || !state.audioContext) return;
    if (isBerlinOn()) {
        resetBerlinPlayheads(now);
    } else {
        state.nextStepTime = now;
    }
    state.lastStepSounded = false;
}
let berlinHlQueue = [];
let berlinHlTimer = null;
let berlinHlAt = Infinity;

function armTimedFlush(queue, timerKey, flush) {
    if (!queue.length || !state.audioContext) return;
    let soonest = queue[0].atTime;
    for (let i = 1; i < queue.length; i++) {
        if (queue[i].atTime < soonest) soonest = queue[i].atTime;
    }
    const armedAt = timerKey === 'play' ? playUiAt : berlinHlAt;
    const armedId = timerKey === 'play' ? playUiTimer : berlinHlTimer;
    if (armedId != null && armedAt <= soonest + 0.0005) return;
    if (armedId != null) clearTimeout(armedId);
    const heardAt = soonest + uiOutputLatency();
    const delay = Math.max(0, (heardAt - state.audioContext.currentTime) * 1000);
    const id = setTimeout(flush, delay);
    if (timerKey === 'play') {
        playUiTimer = id;
        playUiAt = soonest;
    } else {
        berlinHlTimer = id;
        berlinHlAt = soonest;
    }
}

function flushPlayStepUi() {
    playUiTimer = null;
    playUiAt = Infinity;
    if (!state.audioContext) {
        playUiQueue = [];
        return;
    }
    const t = state.audioContext.currentTime - uiOutputLatency();
    const due = [];
    const later = [];
    for (const item of playUiQueue) {
        if (item.atTime <= t + UI_DUE_SLACK) due.push(item);
        else later.push(item);
    }
    playUiQueue = later;
    // Dispatch now: window rAF is frozen while a WebXR session is presenting.
    const live = [];
    for (const item of due) {
        if (item.generation !== state.playGeneration) continue;
        if (!state.isPlaying && !state.isArping) continue;
        live.push(item);
        document.dispatchEvent(new CustomEvent('ingysynth:seq-step-ui', {
            detail: {
                step: item.step,
                on: item.on,
                cellNotes: item.cellNotes || [],
                chordCount: item.chordCount || 0,
                tune: item.tune,
                fine: item.fine,
            },
        }));
    }
    let heardMeter = null;
    for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].passEnd != null) {
            heardMeter = meterDetailFrom(live[i]);
            break;
        }
    }
    if (heardMeter) {
        document.dispatchEvent(new CustomEvent('ingysynth:cycle-progress', {
            detail: heardMeter,
        }));
    }
    const paintDom = () => {
        const t0 = performance.now();
        for (const item of live) {
            try {
                updateKeyboardStepDisplay(item.step, { chordCount: item.chordCount || 0 });
                setKeyboardStepActive(item.step);
            } catch (_) { /* VR has no 2D step strip */ }
            try {
                if (item.on && item.tune != null && !window.noteVisualizerPreviewActive) {
                    const notes = item.cellNotes || [];
                    if (notes.length > 1) {
                        const root = notes[0];
                        const sounding = notes.map((n) => n - root + item.tune);
                        updateChordVisualizer(sounding, { cents: item.fine });
                    } else {
                        updateNoteVisualizer(item.tune, item.fine);
                    }
                }
            } catch (_) { /* VR has no 2D note VFD */ }
        }
        const p = (window.__ingyProf ||= {});
        const ms = performance.now() - t0;
        if (ms > (p.domMax || 0)) p.domMax = ms;
        p.domN = (p.domN || 0) + live.length;
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paintDom);
    else paintDom();
    if (playUiQueue.length) armTimedFlush(playUiQueue, 'play', flushPlayStepUi);
}

function queuePlayStepUi(item) {
    playUiQueue.push(item);
    armTimedFlush(playUiQueue, 'play', flushPlayStepUi);
}

function flushBerlinHighlights() {
    berlinHlTimer = null;
    berlinHlAt = Infinity;
    if (!state.audioContext) {
        berlinHlQueue = [];
        return;
    }
    const t = state.audioContext.currentTime - uiOutputLatency();
    const due = [];
    const later = [];
    for (const item of berlinHlQueue) {
        if (item.atTime <= t + UI_DUE_SLACK) due.push(item);
        else later.push(item);
    }
    berlinHlQueue = later;
    let kbStep = null;
    const lastByRow = new Map();
    for (const item of due) {
        if (item.generation !== state.playGeneration) continue;
        if (!state.berlinMode || !state.isPlaying) continue;
        lastByRow.set(item.row, item);
    }
    lastByRow.forEach((item) => {
        if (item.syncKeyboard) kbStep = item.step;
    });
    if (kbStep != null) {
        try {
            const row = keyboardHighlightRow();
            const data = row == null ? null : getBerlinLane(row).steps?.[kbStep];
            if (data) {
                document.dispatchEvent(new CustomEvent('ingysynth:seq-step-ui', {
                    detail: {
                        step: kbStep,
                        on: data.on !== false,
                        tune: data.on === false ? null : getStepTotalTuneFromRaw(data.tune),
                        fine: Math.round(Number(data.fine) || 0),
                        cellNotes: [],
                        chordCount: 0,
                    },
                }));
            }
        } catch (_) { /* */ }
    }
    let heardMeter = null;
    for (let i = due.length - 1; i >= 0; i--) {
        if (due[i].generation !== state.playGeneration) continue;
        if (due[i].passEnd != null) {
            heardMeter = meterDetailFrom(due[i]);
            break;
        }
    }
    if (heardMeter && state.berlinMode && state.isPlaying) {
        document.dispatchEvent(new CustomEvent('ingysynth:cycle-progress', {
            detail: heardMeter,
        }));
    }
    const paintBerlin = () => {
        const t0 = performance.now();
        lastByRow.forEach((item) => {
            try { setBerlinStepActive(item.row, item.step); } catch (_) { /* */ }
        });
        if (kbStep != null) {
            try {
                updateKeyboardStepDisplay(kbStep);
                setKeyboardStepActive(kbStep);
            } catch (_) { /* VR has no 2D step strip */ }
        }
        const p = (window.__ingyProf ||= {});
        const ms = performance.now() - t0;
        if (ms > (p.domMax || 0)) p.domMax = ms;
        p.domN = (p.domN || 0) + lastByRow.size;
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paintBerlin);
    else paintBerlin();
    if (berlinHlQueue.length) armTimedFlush(berlinHlQueue, 'berlin', flushBerlinHighlights);
}

/** Highlights land at audio time, not schedule time. Coalesce to one rAF. */
function scheduleBerlinHighlight(row, step, atTime, syncKeyboard) {
    const meter = berlinPassMeter(atTime);
    berlinHlQueue.push({
        row,
        step,
        atTime,
        syncKeyboard,
        generation: state.playGeneration,
        cycleProgress: meter.progress,
        cyclePass: meter.pass,
        cycleRepeat: meter.repeat,
        passStart: meter.passStart,
        passEnd: meter.passEnd,
    });
    armTimedFlush(berlinHlQueue, 'berlin', flushBerlinHighlights);
}

function disposeBerlinOscVoice(voice) {
    if (!voice || voice.disposed) return;
    voice.disposed = true;
    voice.dead = true;
    voice.epoch = (voice.epoch || 0) + 1;
    const t = state.audioContext?.currentTime ?? 0;
    if (voice.noiseSource) {
        try {
            voice.noiseGain?.gain.cancelScheduledValues(t);
            voice.noiseGain?.gain.setValueAtTime(0, t);
            voice.noiseSource.stop(t + 0.01);
            voice.noiseSource.disconnect();
            voice.noiseGain?.disconnect();
        } catch (_) { /* ignore */ }
    }
    voice.oscs?.forEach(({ osc, gain }) => {
        try {
            if (gain) {
                gain.gain.cancelScheduledValues(t);
                gain.gain.setValueAtTime(0, t);
            }
            // Triggered engines (pluck/drums): amp already closed — hard-free the
            // worklet so Berlin cannot bank 16 silent 8s rings then steal/silence.
            if (osc?.isTriggered) {
                osc.stop(t + 0.01, { hard: true, silent: true, fadeSec: 0.02 });
            } else {
                osc.stop(t + 0.01);
            }
            osc.disconnect();
            gain?.disconnect();
        } catch (_) { /* ignore */ }
    });
    try { voice.amp?.disconnect(); } catch (_) { /* ignore */ }
    try { voice.mix?.disconnect(); } catch (_) { /* ignore */ }
    if (Array.isArray(state.berlinOscVoices)) {
        state.berlinOscVoices = state.berlinOscVoices.filter((v) => v !== voice);
    }
}

/**
 * Berlin voices gate before the shared filter so mod-lane CV (cutoff/res/HP)
 * is actually audible. Main envelope stays open; main osc/noise gains are muted
 * so persistent oscillators cannot drone through that open VCA.
 * Main/Acid ratch uses the same bus gate.
 */
function armBerlinSharedAmpPath(atTime) {
    const ctx = state.audioContext;
    if (!ctx || !state.envelope) return;
    const t = Math.max(ctx.currentTime, atTime ?? 0);

    state.oscGains?.forEach((g) => {
        try {
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(0, t);
        } catch (_) { /* ignore */ }
    });
    if (state.noiseGain) {
        try {
            state.noiseGain.gain.cancelScheduledValues(t);
            state.noiseGain.gain.setValueAtTime(0, t);
        } catch (_) { /* ignore */ }
    }

    try {
        state.envelope.gain.cancelScheduledValues(t);
        state.envelope.gain.setValueAtTime(1, t);
        state.envelopeHeld = true;
    } catch (_) { /* ignore */ }
    state.berlinSharedPathArmed = true;
}

function restoreMainBusGains(atTime) {
    const t = Math.max(state.audioContext?.currentTime ?? 0, atTime ?? 0);
    state.oscGains?.forEach((g, i) => {
        const vol = getOscVol(i);
        const on = !!state.oscStates?.[i];
        try {
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(on && Number.isFinite(vol) ? vol : 0, t);
        } catch (_) { /* ignore */ }
    });
    if (state.noiseGain) {
        const nv = state.noiseState ? (getNumber('noiseVol', 0)) : 0;
        try {
            state.noiseGain.gain.cancelScheduledValues(t);
            state.noiseGain.gain.setValueAtTime(nv, t);
        } catch (_) { /* ignore */ }
    }
}

function disarmBerlinSharedAmpPath(atTime) {
    if (!state.berlinSharedPathArmed) return;
    const t = Math.max(state.audioContext?.currentTime ?? 0, atTime ?? 0);
    state.berlinSharedPathArmed = false;
    restoreMainBusGains(t);
    if (state.envelope) {
        try {
            state.envelope.gain.cancelScheduledValues(t);
            state.envelope.gain.setValueAtTime(0, t);
            state.envelopeHeld = false;
        } catch (_) { /* ignore */ }
    }
}

/**
 * Leave the ratch-voice bus without wiping the next main-stage envelope.
 * Pending ratch dispose timers still call disarm, which no-ops once unarmed.
 */
function handOffIndependentVoicesToMain(atTime) {
    const t = Math.max(state.audioContext?.currentTime ?? 0, atTime ?? 0);
    const n = state.berlinOscVoices?.length || 0;
    if (Array.isArray(state.berlinOscVoices)) {
        state.berlinOscVoices.forEach((voice) => {
            try {
                const g = voice.amp?.gain;
                if (!g) return;
                if (typeof g.cancelAndHoldAtTime === 'function') {
                    try { g.cancelAndHoldAtTime(t); } catch (_) { /* ignore */ }
                }
                g.setTargetAtTime(0.00001, t, 0.012);
            } catch (_) { /* ignore */ }
        });
    }
    restoreMainBusGains(t);
    state.berlinSharedPathArmed = false;
    return n;
}

/** Fade and drop Berlin per-osc voices (optionally one osc index only). */
function releaseBerlinOscVoices(now, oscIndex = null) {
    const list = state.berlinOscVoices;
    if (!Array.isArray(list) || list.length === 0) {
        state.berlinOscVoices = [];
        if (oscIndex === null && !berlinFiltDrumsActive()) disarmBerlinSharedAmpPath(now);
        return;
    }
    const t = now ?? state.audioContext?.currentTime ?? 0;
    const victims = oscIndex === null
        ? [...list]
        : list.filter((v) => v.oscIndex === oscIndex);
    victims.forEach((voice) => {
        voice.epoch = (voice.epoch || 0) + 1;
        try {
            voice.amp?.gain.cancelScheduledValues(t);
            voice.amp?.gain.setValueAtTime(Math.max(0.00001, voice.amp.gain.value || 0.00001), t);
            voice.amp?.gain.exponentialRampToValueAtTime(0.00001, t + 0.05);
        } catch (_) { /* ignore */ }
        setTimeout(() => disposeBerlinOscVoice(voice), 70);
    });
    if (oscIndex === null) {
        state.berlinOscVoices = [];
        if (!berlinFiltDrumsActive()) disarmBerlinSharedAmpPath(t);
    } else {
        state.berlinOscVoices = list.filter((v) => v.oscIndex !== oscIndex);
        if (state.berlinOscVoices.length === 0 && !berlinFiltDrumsActive()) disarmBerlinSharedAmpPath(t);
    }
}

/**
 * Berlin lane private-amp ADSR. Same attack/release as the main bus:
 * cancelAndHold + setTarget attack; Release knob from gate-off; no step-end clamp.
 */
function scheduleBerlinLaneEnvelope(gainParam, {
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
    gateLen,
}) {
    if (!gainParam) return;
    const attack = getNumber('attack');
    const decay = getNumber('decay');
    const sustain = getNumber('sustain');
    const release = getNumber('release');
    const now = state.audioContext.currentTime;
    const t0 = Math.max(now, startTime);
    const minValue = 0.00001;
    const ampPeak = accentThisStep ? 1 + 0.5 * accentAmount : 1;
    const ampSustain = accentThisStep ? Math.min(1, sustain) * ampPeak : sustain;
    const gateFrac = Math.max(0.05, Math.min(1, Number(gateLen) || getGateLength()));

    const darkOsc = hasDarkOscActive();
    const useSoftRetrigger = !slideThisStep && (darkOsc || !!state.phaseResetEnabled);

    let heldAtBoundary = false;
    if ((useSoftRetrigger || slideThisStep) && typeof gainParam.cancelAndHoldAtTime === 'function') {
        try {
            gainParam.cancelAndHoldAtTime(t0);
            heldAtBoundary = true;
        } catch (_) { /* fall through */ }
    }
    if (!heldAtBoundary) gainParam.cancelScheduledValues(t0);

    if (slideThisStep) {
        if (!heldAtBoundary) {
            gainParam.setValueAtTime(Math.max(minValue, sustain), t0);
        }
        if (!nextStepWillSlide) {
            const offAt = Math.max(t0 + 0.02, t0 + stepDuration * gateFrac);
            scheduleBusRelease(gainParam, offAt, seqReleaseTau(release));
        }
        return;
    }

    const gateWindow = stepDuration * gateFrac;
    const wtAmpFloor = darkOsc ? Math.max(0.008, wtAttackSecForFilter() * 0.55) : 0.002;
    const safeAttackTime = Math.max(wtAmpFloor, scaleAdsrTime(attack));
    const availableDecayTime = Math.max(0, gateWindow * 0.8 - safeAttackTime);
    const safeDecayTime = Math.max(0.002, Math.min(scaleAdsrTime(decay), availableDecayTime));
    const attackTau = darkOsc
        ? Math.max(0.012, safeAttackTime / 3)
        : Math.max(0.0008, safeAttackTime / 3);

    if (!heldAtBoundary) {
        gainParam.setValueAtTime(0, t0);
    }
    gainParam.setTargetAtTime(ampPeak, t0, attackTau);
    const decayStart = t0 + safeAttackTime;
    gainParam.setTargetAtTime(
        Math.max(minValue, ampSustain),
        decayStart,
        Math.max(0.004, safeDecayTime / 3),
    );

    if (nextStepWillSlide) return;

    const offAt = Math.max(t0 + 0.008, t0 + gateWindow);
    scheduleBusRelease(gainParam, offAt, seqReleaseTau(release));
}

function findLiveBerlinOscVoice(oscIndex) {
    const list = state.berlinOscVoices || [];
    const live = list.filter((v) => (
        v
        && !v.dead
        && !v.isNoise
        && v.oscIndex === oscIndex
        && v.amp
        && v.oscs?.length
    ));
    if (live.length > 1) {
        live.slice(1).forEach((v) => disposeBerlinOscVoice(v));
    }
    return live[0] || null;
}

function berlinAnalogWaveMismatch(voice, wantWave) {
    const oscs = voice?.oscs;
    if (!oscs?.length) return false;
    for (const { osc } of oscs) {
        if (!osc || osc.isWavetable) continue;
        if ((analogLogicalWave(osc) || 'sawtooth') !== wantWave) return true;
    }
    return false;
}

/** Fade a reused Berlin voice so the next spawn can pick up a new analog wave. */
function fadeStopBerlinOscVoice(voice, atTime) {
    if (!voice || voice.dead) return;
    const t = Math.max(state.audioContext?.currentTime ?? 0, atTime ?? 0);
    voice.dead = true;
    voice.epoch = (voice.epoch || 0) + 1;
    try {
        const g = voice.amp?.gain;
        if (g) {
            g.cancelScheduledValues(t);
            g.setValueAtTime(Math.max(0.00001, g.value || 0.00001), t);
            g.exponentialRampToValueAtTime(0.00001, t + 0.022);
        }
    } catch (_) { /* ignore */ }
    setTimeout(() => disposeBerlinOscVoice(voice), 40);
}

function applyBerlinOscPitch(voice, {
    startTime,
    stepDuration,
    fromHz,
    toHz = null,
    glissRoll = false,
    slideIn = false,
    slideTime = 0.05,
}) {
    const ctx = state.audioContext;
    if (!ctx || !voice?.oscs) return;
    const oscIndex = voice.oscIndex;
    const t0 = Math.max(ctx.currentTime, startTime);
    const slideFromBase = (slideIn && state.lastStepFreqs?.[oscIndex] > 0)
        ? state.lastStepFreqs[oscIndex]
        : null;
    voice.oscs.forEach(({ osc, unisonCents }) => {
        if (!osc?.frequency) return;
        const targetHz = voiceTargetFreq({ unisonCents }, fromHz);
        try {
            if (slideFromBase != null) {
                const slideFrom = voiceTargetFreq({ unisonCents }, slideFromBase);
                osc.frequency.cancelScheduledValues(t0);
                osc.frequency.setValueAtTime(slideFrom, t0);
                try {
                    osc.frequency.setTargetAtTime(targetHz, t0, Math.max(0.01, slideTime) / 3);
                } catch (_) {
                    osc.frequency.setValueAtTime(targetHz, t0);
                }
            } else if (glissRoll && toHz != null) {
                const endHz = voiceTargetFreq({ unisonCents }, toHz);
                osc.frequency.cancelScheduledValues(t0);
                osc.frequency.setValueAtTime(targetHz, t0);
                osc.frequency.linearRampToValueAtTime(endHz, startTime + stepDuration);
            } else {
                osc.frequency.cancelScheduledValues(t0);
                osc.frequency.setValueAtTime(targetHz, t0);
            }
        } catch (_) { /* ignore */ }
    });
    const panner = state.oscPanners?.[oscIndex];
    if (panner) {
        try {
            panner.pan.setValueAtTime(readOscPanValue(oscIndex), t0);
        } catch (_) { /* ignore */ }
    }
}

function retriggerBerlinTriggeredEngines(voice, when, fromHz) {
    voice?.oscs?.forEach(({ osc, unisonCents }) => {
        if (!osc?.isTriggered || typeof osc.retrigger !== 'function') return;
        const hz = voiceTargetFreq({ unisonCents }, fromHz);
        try { osc.retrigger(when, hz); } catch (_) { /* ignore */ }
    });
}

function scheduleBerlinOscVoiceUntil(voice, until) {
    const ctx = state.audioContext;
    if (!ctx || !voice || voice.dead) return;
    voice.until = Math.max(voice.until || 0, until);
    voice.epoch = (voice.epoch || 0) + 1;
    const epoch = voice.epoch;
    const generation = state.playGeneration;
    const tick = () => {
        const delay = Math.max(0, (voice.until - ctx.currentTime) * 1000) + 40;
        setTimeout(() => {
            if (generation !== state.playGeneration || voice.dead || voice.epoch !== epoch) return;
            if (ctx.currentTime + 0.015 < voice.until) {
                tick();
                return;
            }
            disposeBerlinOscVoice(voice);
            maybeDisarmBerlinSharedPath(ctx.currentTime);
        }, delay);
    };
    tick();
}

/**
 * Independent osc voice: unison stack → amp → shared panner/mute → ring/filter/HP.
 * Shared envelope stays open (bus gate). Berlin OSC lanes reuse this graph.
 */
function createBerlinOscVoice({
    oscIndex,
    startTime,
    stepDuration,
    glissRoll = false,
    slideIn = false,
    slideTime = 0.05,
    fromHz,
    toHz = null,
}) {
    const ctx = state.audioContext;
    const dest = state.ringModInput || state.filterInputPad || state.filter;
    if (!ctx || !dest) return null;
    if (!state.oscStates?.[oscIndex]) return null;

    const wave = getOscType(oscIndex);
    const vol = getOscVol(oscIndex);
    if (!(vol > 0.0001)) return null;

    armBerlinSharedAmpPath(startTime);
    silenceMainPhaseResetOscs(startTime);

    const mix = ctx.createGain();
    mix.gain.value = 1;
    const amp = ctx.createGain();
    amp.gain.value = 0;

    mix.connect(amp);
    const panner = state.oscPanners?.[oscIndex];
    amp.connect(panner || dest);

    const n = getUnisonVoices();
    const spread = getUnisonSpread();
    const voiceVol = vol / n;
    const t0 = Math.max(ctx.currentTime, startTime);
    const lfoGain = [
        state.lfoGainOsc1Pitch,
        state.lfoGainOsc2Pitch,
        state.lfoGainOsc3Pitch,
        state.lfoGainOsc4Pitch,
    ][oscIndex] || null;

    const oscs = [];
    for (let k = 0; k < n; k++) {
        const cents = unisonCents(k, n, spread);
        const osc = createOscSource(ctx, {
            oscIndex,
            wave,
            frequency: voiceTargetFreq({ unisonCents: cents }, fromHz),
            pooled: true,
        });
        const targetHz = voiceTargetFreq({ unisonCents: cents }, fromHz);
        try { osc.frequency.setValueAtTime(targetHz, t0); } catch (_) { /* ignore */ }

        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(mix);
        const oscStart = osc.isWavetable
            ? t0
            : Math.max(ctx.currentTime, startTime - 0.002);
        softStartVoiceGain(g.gain, voiceVol, Math.max(t0, oscStart), {
            wavetable: !!osc.isWavetable,
            triggered: !!osc.isTriggered,
        });
        if (osc.isWavetable) osc.start(oscStart);
        else startAnalogOsc(osc, oscStart);
        if (lfoGain) {
            try { lfoGain.connect(osc.detune); } catch (_) { /* ignore */ }
        }
        oscs.push({ osc, gain: g, unisonCents: cents });
    }

    const voice = {
        oscIndex,
        oscs,
        mix,
        amp,
        dead: false,
        epoch: 1,
        until: 0,
    };
    if (!Array.isArray(state.berlinOscVoices)) state.berlinOscVoices = [];
    state.berlinOscVoices.push(voice);
    applyBerlinOscPitch(voice, {
        startTime,
        stepDuration,
        fromHz,
        toHz,
        glissRoll,
        slideIn,
        slideTime,
    });
    return voice;
}

/**
 * Legacy one-shot spawn (unused main ratch helper). Berlin lanes reuse a voice.
 */
function spawnBerlinOscVoice({
    oscIndex,
    startTime,
    stepDuration,
    gateLen,
    accentThisStep,
    accentAmount,
    peakScale = 1,
    glissRoll = false,
    slideIn = false,
    slideTime = 0.05,
    fromHz,
    toHz = null,
}) {
    const voice = createBerlinOscVoice({
        oscIndex,
        startTime,
        stepDuration,
        glissRoll,
        slideIn,
        slideTime,
        fromHz,
        toHz,
    });
    if (!voice) return;
    const doneAt = scheduleFullNoteOnGain(voice.amp.gain, {
        startTime,
        stepDuration,
        accentThisStep,
        accentAmount,
        peakScale,
        gateLen,
        holdForDrum: oscIndex === OSC4_INDEX,
    });
    scheduleBerlinOscVoiceUntil(voice, doneAt);
}

/** Main ratch noise: private amp → shared noiseMuteGain (mixer M/S). */
function spawnSharedNoiseVoice({
    startTime,
    stepDuration,
    accentThisStep,
    accentAmount,
    peakScale = 1,
    gateLen,
}) {
    const ctx = state.audioContext;
    const dest = state.noiseMuteGain;
    if (!ctx || !dest) return;
    if (!state.noiseState) return;
    const vol = getNumber('noiseVol', 0);
    if (!(vol > 0.0001) || !state.noiseBuffers) return;
    const noiseType = getString('noiseType', 'white');
    const buf = state.noiseBuffers[noiseType] || state.noiseBuffers.white;
    if (!buf) return;

    armBerlinSharedAmpPath(startTime);

    const amp = ctx.createGain();
    amp.gain.value = 0;
    const g = ctx.createGain();
    g.gain.value = vol;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(g);
    g.connect(amp);
    amp.connect(dest);

    const nStart = Math.max(ctx.currentTime, startTime - 0.002);
    try { src.start(nStart); } catch (_) { /* ignore */ }

    const doneAt = scheduleFullNoteOnGain(amp.gain, {
        startTime,
        stepDuration,
        accentThisStep,
        accentAmount,
        peakScale,
        gateLen,
    });

    const voice = {
        oscIndex: null,
        isNoise: true,
        oscs: [],
        noiseSource: src,
        noiseGain: g,
        amp,
    };
    if (!Array.isArray(state.berlinOscVoices)) state.berlinOscVoices = [];
    state.berlinOscVoices.push(voice);

    const generation = state.playGeneration;
    const delay = Math.max(0, (doneAt - ctx.currentTime) * 1000) + 40;
    setTimeout(() => {
        if (generation !== state.playGeneration) return;
        disposeBerlinOscVoice(voice);
        if (!state.berlinOscVoices?.length && !berlinFiltDrumsActive()) {
            disarmBerlinSharedAmpPath(ctx.currentTime);
        }
    }, delay);
}

/** Fire one osc lane: reuse the lane voice; pulse gate/release on the ratch grid. */
function triggerBerlinOscLane(row, pattern, startTime, stepDuration, data, playhead, nextPitch) {
    retriggerLfoIfNeeded(startTime);
    const oscIndex = row;
    const prevGliss = !!playhead.prevGliss;
    const slideIn = !!playhead.sounded && !!playhead.prevSlide && !prevGliss;
    const ratchN = state.acidMode ? 1 : clampRatch(data.ratch);
    const glissRoll = ratchN > 1 && !!data.slide;
    const accentAmount = getAccentAmount();
    const accentThisStep = !!data.accent && !slideIn;
    // Master GATE (toolbar) scales each OSC lane relative to its own gate
    const gateLen = Math.max(0.05, Math.min(1, patternGate(pattern) * getGateLength()));
    const fromHz = berlinFrequency(playhead.semi, playhead.fine, oscIndex);
    const toHz = nextPitch
        ? berlinFrequency(nextPitch.semi, nextPitch.fine, oscIndex)
        : fromHz;
    const hits = ratchN > 1 ? ratchN : 1;
    const subDur = stepDuration / hits;
    // Same rule as main nextStepWillSlideEnv: hold only into the next ON.
    const nextOn = rowStepValue(pattern, berlinNextStepIndex(pattern, playhead.currentStep), oscIndex).on !== false;
    const slideOut = !!data.slide && !glissRoll && nextOn;
    const pulseRatch = hits > 1 && !slideIn;
    const envHits = pulseRatch ? hits : 1;
    const envDur = pulseRatch ? subDur : stepDuration;
    const slideTime = getSlideTime();
    const selfEnveloped = oscIndex === OSC4_INDEX
        && !!state.osc4Wavetable
        && DRUM_ENGINES.has(state.osc4Model);

    armBerlinSharedAmpPath(startTime);
    silenceMainPhaseResetOscs(startTime);

    let voice = findLiveBerlinOscVoice(oscIndex);
    const wantWave = getOscType(oscIndex);
    if (voice && berlinAnalogWaveMismatch(voice, wantWave)) {
        fadeStopBerlinOscVoice(voice, startTime);
        voice = null;
    }
    const justCreated = !voice;
    if (voice) {
        applyBerlinOscPitch(voice, {
            startTime,
            stepDuration,
            fromHz,
            toHz: glissRoll ? toHz : null,
            glissRoll,
            slideIn,
            slideTime,
        });
    } else {
        voice = createBerlinOscVoice({
            oscIndex,
            startTime,
            stepDuration,
            glissRoll,
            slideIn,
            slideTime,
            fromHz,
            toHz: glissRoll ? toHz : null,
        });
    }
    if (!voice) {
        state.lastStepFreqs[oscIndex] = glissRoll ? toHz : fromHz;
        return;
    }

    if (!slideIn) {
        for (let k = justCreated ? 1 : 0; k < envHits; k++) {
            retriggerBerlinTriggeredEngines(voice, startTime + k * envDur, fromHz);
        }
    }

    for (let k = 0; k < envHits; k++) {
        const tHit = startTime + k * envDur;
        if (selfEnveloped) {
            scheduleFullNoteOnGain(voice.amp.gain, {
                startTime: tHit,
                stepDuration: envDur,
                accentThisStep,
                accentAmount,
                peakScale: 1,
                gateLen,
                holdForDrum: true,
            });
        } else {
            scheduleBerlinLaneEnvelope(voice.amp.gain, {
                startTime: tHit,
                stepDuration: envDur,
                slideThisStep: !pulseRatch && slideIn,
                nextStepWillSlide: !pulseRatch && slideOut,
                accentThisStep,
                accentAmount,
                gateLen,
            });
        }
        scheduleStepFilterEnvelope({
            startTime: Math.max(state.audioContext.currentTime, tHit),
            stepDuration: envDur,
            slideThisStep: !pulseRatch && slideIn,
            nextStepWillSlide: !pulseRatch && slideOut,
            accentThisStep,
            accentAmount,
            gateLen,
        });
    }

    const lastHit = startTime + (envHits - 1) * envDur;
    const lastGateOff = lastHit + envDur * gateLen;
    const releaseSec = Math.max(0.02, getNumber('release'));
    const until = (slideIn && slideOut)
        ? startTime + stepDuration + 1
        : lastGateOff + (selfEnveloped ? 0.28 : releaseSec * 3 + 0.1);
    scheduleBerlinOscVoiceUntil(voice, until);

    // Update after pitch so slide-in can read the previous step
    state.lastStepFreqs[oscIndex] = glissRoll ? toHz : fromHz;
}

function berlinNextStepIndex(pattern, step) {
    const n = Math.max(1, Math.round(pattern?.stepCount) || 8);
    return pattern.reverse ? (step - 1 + n) % n : (step + 1) % n;
}

const lastDrumFreqs = Array.from({ length: DRUM_LANE_COUNT }, () => 0);

function berlinFiltDrumsActive() {
    return isBerlinOn()
        && !!state.berlinDrumFilt
        && Array.isArray(state.berlinDrumVoices)
        && state.berlinDrumVoices.length > 0;
}

/** Berlin FILT holds the shared VCA open and mutes main oscs. Main/acid keep oscs. */
function armDrumFiltSharedPath(atTime) {
    if (!isBerlinOn() || !state.berlinDrumFilt) return;
    armBerlinSharedAmpPath(atTime);
    silenceMainPhaseResetOscs(atTime);
}

function maybeDisarmBerlinSharedPath(atTime) {
    if (state.berlinOscVoices?.length) return;
    if (berlinFiltDrumsActive()) return;
    disarmBerlinSharedAmpPath(atTime);
}

/** Retrigger extends `until` + epoch so the previous timer no-ops. */
function scheduleDrumVoiceUntil(voice, ctx, generation) {
    const epoch = voice.epoch || 1;
    const tick = () => {
        const delay = Math.max(0, (voice.until - ctx.currentTime) * 1000) + 20;
        setTimeout(() => {
            if (generation !== state.playGeneration || voice.dead || voice.epoch !== epoch) return;
            if (ctx.currentTime + 0.015 < voice.until) {
                tick();
                return;
            }
            disposeBerlinDrumVoice(voice);
            maybeDisarmBerlinSharedPath(ctx.currentTime);
        }, delay);
    };
    tick();
}

function applyDigitalDrumPatchLive(osc, patch, when, velocity) {
    if (!osc) return;
    try {
        osc.morphX?.setValueAtTime(patch.morphX, when);
        osc.morphY?.setValueAtTime(patch.morphY, when);
        osc.harmonics?.setValueAtTime(patch.harmonics, when);
        const n = osc._worklet;
        if (!n?.parameters) return;
        n.parameters.get('alt')?.setValueAtTime(patch.alt ? 1 : 0, when);
        n.parameters.get('trigPatched')?.setValueAtTime(patch.trigPatched !== false ? 1 : 0, when);
        n.parameters.get('openHat')?.setValueAtTime(patch.model === 'open_hat' ? 1 : 0, when);
        n.parameters.get('velocity')?.setValueAtTime(velocity, when);
        n.port.postMessage({
            alt: !!patch.alt,
            trigPatched: patch.trigPatched !== false,
            openHat: patch.model === 'open_hat',
        });
    } catch (_) { /* ignore */ }
}

function disposeBerlinDrumVoice(voice, { hard = false } = {}) {
    if (!voice || voice.dead) return;
    const t = state.audioContext?.currentTime ?? 0;
    if (voice.isAnalog && typeof voice.dispose === 'function') {
        voice.dispose(t, { hard });
        if (Array.isArray(state.berlinDrumVoices)) {
            state.berlinDrumVoices = state.berlinDrumVoices.filter((v) => v !== voice);
        }
        return;
    }
    voice.dead = true;
    try {
        if (voice.amp) {
            const cur = Math.max(0.00001, Number(voice.amp.gain.value) || 0.00001);
            if (typeof voice.amp.gain.cancelAndHoldAtTime === 'function') {
                voice.amp.gain.cancelAndHoldAtTime(t);
            } else {
                voice.amp.gain.cancelScheduledValues(t);
                voice.amp.gain.setValueAtTime(cur, t);
            }
            voice.amp.gain.exponentialRampToValueAtTime(0.00001, t + (hard ? 0.02 : 0.03));
        }
    } catch (_) { /* ignore */ }
    try {
        voice.osc?.stop(t + 0.03, { hard: true, silent: true, fadeSec: hard ? 0.02 : 0.03 });
    } catch (_) { /* ignore */ }
    const ampNode = voice.amp;
    const oscNode = voice.osc;
    setTimeout(() => {
        try { oscNode?.disconnect(); } catch (_) { /* ignore */ }
        try { ampNode?.disconnect(); } catch (_) { /* ignore */ }
    }, 50);
    if (Array.isArray(state.berlinDrumVoices)) {
        state.berlinDrumVoices = state.berlinDrumVoices.filter((v) => v !== voice);
    }
}

/** Fade and drop Berlin drum voices (optionally one D-lane only). */
function releaseBerlinDrumVoices(now, lane = null) {
    const list = state.berlinDrumVoices;
    if (!Array.isArray(list) || list.length === 0) {
        state.berlinDrumVoices = [];
        maybeDisarmBerlinSharedPath(now);
        return;
    }
    const t = now ?? state.audioContext?.currentTime ?? 0;
    const victims = lane == null
        ? [...list]
        : list.filter((v) => v.lane === lane);
    victims.forEach((voice) => {
        if (voice.isAnalog) {
            try { voice.choke?.(t); } catch (_) { /* ignore */ }
            setTimeout(() => {
                disposeBerlinDrumVoice(voice, { hard: true });
                maybeDisarmBerlinSharedPath(state.audioContext?.currentTime ?? t);
            }, 40);
            return;
        }
        try {
            voice.amp?.gain.cancelScheduledValues(t);
            const cur = Math.max(0.00001, voice.amp?.gain.value || 0.00001);
            voice.amp?.gain.setValueAtTime(cur, t);
            voice.amp?.gain.exponentialRampToValueAtTime(0.00001, t + 0.05);
        } catch (_) { /* ignore */ }
        setTimeout(() => {
            disposeBerlinDrumVoice(voice, { hard: true });
            maybeDisarmBerlinSharedPath(state.audioContext?.currentTime ?? t);
        }, 70);
    });
    if (lane == null) {
        state.berlinDrumVoices = [];
        lastDrumFreqs.fill(0);
    } else {
        state.berlinDrumVoices = list.filter((v) => v.lane !== lane);
        if (lane >= 0 && lane < lastDrumFreqs.length) lastDrumFreqs[lane] = 0;
    }
    maybeDisarmBerlinSharedPath(t);
}

/**
 * Analog 808: one circuit per lane. RATCH restarts envelopes on that graph.
 * Envelopes own length; GATE choke-cuts BD/SN. Does not wait on Plaits.
 */
function spawnAnalog808DrumVoice({
    lane,
    startTime,
    stepDuration,
    gateLen,
    accentThisStep,
    accentAmount,
    fromHz,
    ratchHits = 1,
    patch,
    panner,
}) {
    const ctx = state.audioContext;
    if (!ctx || !patch || !panner) return;
    if (state.berlinDrumFilt) {
        if (!state.ringModInput) return;
    } else if (!state.analogDrumInput) return;

    routeBerlinDrumPanners();
    armDrumFiltSharedPath(startTime);

    const t0 = Math.max(ctx.currentTime, startTime);
    const accent = accentThisStep ? Math.max(0, Math.min(1, accentAmount)) : 0;
    const model = canonicalDrumModel(patch.model);
    const hits = Math.max(1, ratchHits | 0);
    const subDur = hits > 1 ? stepDuration / hits : 0;
    const hitOpts = { patch, accent, gateLen, hz: fromHz, hitDur: subDur };

    (state.berlinDrumVoices || []).forEach((v) => {
        if (v?.lane !== lane || v.dead) return;
        if (!v.isAnalog) disposeBerlinDrumVoice(v, { hard: true });
    });

    let voice = (state.berlinDrumVoices || []).find(
        (v) => v.lane === lane && v.isAnalog && !v.dead && v.model === model,
    );
    const reused = !!(voice && typeof voice.retrigger === 'function');
    const analogT0 = performance.now();
    if (reused) {
        voice.epoch = (voice.epoch || 0) + 1;
        try {
            voice.retrigger(t0, hitOpts);
        } catch (_) { /* keep Berlin clock alive */ }
        const p = (window.__ingyProf ||= {});
        const analogMs = performance.now() - analogT0;
        if (analogMs > (p.analogMax || 0)) p.analogMax = analogMs;
        p.analogN = (p.analogN || 0) + 1;
    } else {
        (state.berlinDrumVoices || []).forEach((v) => {
            if (v?.lane === lane && v.isAnalog) disposeBerlinDrumVoice(v, { hard: true });
        });
        voice = createAnalog808Voice(ctx, {
            model,
            patch: { ...patch },
            accent,
            gateLen,
            hz: fromHz,
            startTime: t0,
            panner,
            hitDur: subDur,
        });
        const p = (window.__ingyProf ||= {});
        const analogMs = performance.now() - analogT0;
        if (analogMs > (p.analogMax || 0)) p.analogMax = analogMs;
        p.analogN = (p.analogN || 0) + 1;
        if (!voice) return;
        voice.lane = lane;
        voice.epoch = 1;
        if (!Array.isArray(state.berlinDrumVoices)) state.berlinDrumVoices = [];
        state.berlinDrumVoices.push(voice);
    }

    try {
        panner.pan.setValueAtTime(Math.max(-1, Math.min(1, Number(patch.pan) || 0)), t0);
    } catch (_) { /* ignore */ }

    if (hits > 1 && typeof voice.retrigger === 'function') {
        const now = ctx.currentTime;
        for (let k = 1; k < hits; k++) {
            const ht = startTime + k * subDur;
            if (ht < now - 0.001) continue;
            voice.retrigger(ht, hitOpts);
        }
    }

    const gateFrac = Math.max(0.05, Math.min(1, Number(gateLen) || 0.9));
    const lastHitAt = t0 + (hits - 1) * (stepDuration / hits);
    const gateOff = Math.max(t0 + stepDuration * gateFrac, lastHitAt + 0.012);
    const decaySec = Number(voice.decaySec) || 0.3;
    voice.until = Math.max(t0 + decaySec + 0.08, lastHitAt + decaySec + 0.08);

    const generation = state.playGeneration;
    const epoch = voice.epoch || 1;
    // Hats scale DECAY × GATE in the factory. BD: decay owns length.
    // Snare: GATE choke-cuts when shorter than full. Ratch keeps full analog decay.
    if (hits === 1 && model === 'snare' && gateFrac < 0.995) {
        setTimeout(() => {
            if (generation !== state.playGeneration || voice.dead || voice.epoch !== epoch) return;
            try { voice.choke?.(Math.max(ctx.currentTime, gateOff)); } catch (_) { /* ignore */ }
        }, Math.max(0, (gateOff - ctx.currentTime) * 1000));
        voice.until = Math.max(voice.until, gateOff + 0.05);
    }

    const scheduleDispose = () => {
        const delay = Math.max(0, (voice.until - ctx.currentTime) * 1000) + 20;
        setTimeout(() => {
            if (generation !== state.playGeneration || voice.dead || voice.epoch !== epoch) return;
            if (ctx.currentTime + 0.015 < voice.until) {
                scheduleDispose();
                return;
            }
            disposeBerlinDrumVoice(voice);
            maybeDisarmBerlinSharedPath(ctx.currentTime);
        }, delay);
    };
    scheduleDispose();
}

function chokeDrumVoice(voice, when) {
    if (!voice || voice.dead) return;
    const t = Math.max(0, when || 0);
    if (voice.isAnalog && typeof voice.choke === 'function') {
        try { voice.choke(t); } catch (_) { /* ignore */ }
        return;
    }
    const g = voice.amp?.gain;
    if (!g) return;
    try {
        const cur = Math.max(0.00001, g.value || 0.00001);
        g.cancelScheduledValues(t);
        g.setValueAtTime(cur, t);
        g.exponentialRampToValueAtTime(0.00001, t + 0.018);
    } catch (_) { /* ignore */ }
}

/** Closed hat cuts a choking open hat. A choking open hat cuts the closed hat. */
function chokeHatPartners(lane, model, when) {
    const kit = state.berlinDrum;
    if (!Array.isArray(kit)) return;
    const kind = canonicalDrumModel(model);
    if (kind !== 'hihat' && kind !== 'open_hat') return;
    if (kind === 'open_hat' && kit[lane]?.choke === false) return;
    const want = kind === 'hihat' ? 'open_hat' : 'hihat';
    (state.berlinDrumVoices || []).forEach((voice) => {
        if (!voice || voice.dead || voice.lane === lane) return;
        const other = canonicalDrumModel(kit[voice.lane]?.model);
        if (other !== want) return;
        if (want === 'open_hat' && kit[voice.lane]?.choke === false) return;
        chokeDrumVoice(voice, when);
    });
}

/**
 * One hit on a D-lane. Analog 808 or Plaits. No unison, OSC1 globals, filter env, or synth ADSR.
 */
function spawnBerlinDrumVoice({
    lane,
    startTime,
    stepDuration,
    gateLen,
    accentThisStep,
    accentAmount,
    glissRoll = false,
    slideIn = false,
    slideTime = 0.05,
    fromHz,
    toHz = null,
    stepHz,
    ratchHits = 1,
}) {
    const ctx = state.audioContext;
    const patch = state.berlinDrum?.[lane];
    if (!ctx || !patch || !(patch.vol > 0.0001)) return;
    const panner = state.berlinDrumPanners?.[lane];
    if (!panner) return;
    chokeHatPartners(lane, canonicalDrumModel(patch.model), Math.max(ctx.currentTime, startTime));

    if (isAnalogDrumEngine(patch)) {
        spawnAnalog808DrumVoice({
            lane,
            startTime,
            stepDuration,
            gateLen,
            accentThisStep,
            accentAmount,
            fromHz,
            ratchHits,
            patch,
            panner,
        });
        return;
    }

    if (!state.plaitsWorkletReady || !state.distortion) return;
    if (state.berlinDrumFilt) {
        if (!state.ringModInput) return;
    } else if (!state.drumFxInput) return;

    (state.berlinDrumVoices || []).forEach((v) => {
        if (v?.lane === lane && v.isAnalog) disposeBerlinDrumVoice(v, { hard: true });
    });

    routeBerlinDrumPanners();
    armDrumFiltSharedPath(startTime);

    const velocity = accentThisStep
        ? Math.max(0.05, Math.min(1, 0.55 + 0.45 * accentAmount))
        : 0.8;
    const liveLane = (state.berlinDrumVoices || []).filter((v) => v?.lane === lane && !v.dead);
    const t0 = Math.max(ctx.currentTime, startTime);
    const peak = Math.max(0.00001, Number(patch.vol) || 0.8);
    const hits = Math.max(1, ratchHits | 0);
    const model = DRUM_ENGINES.has(patch.model) ? patch.model : 'hihat';
    const tail = ENGINE_TAIL_SEC[model] || 2.5;
    const generation = state.playGeneration;

    const applyPitch = (osc) => {
        const slideFrom = (slideIn && lastDrumFreqs[lane] > 0) ? lastDrumFreqs[lane] : null;
        try {
            if (slideFrom != null) {
                osc.frequency.setValueAtTime(slideFrom, t0);
                osc.frequency.setTargetAtTime(fromHz, t0, Math.max(0.01, slideTime) / 3);
            } else {
                osc.frequency.setValueAtTime(fromHz, t0);
            }
            if (glissRoll && toHz != null) {
                osc.frequency.cancelScheduledValues(t0);
                osc.frequency.setValueAtTime(fromHz, t0);
                osc.frequency.linearRampToValueAtTime(toHz, startTime + stepDuration);
            }
        } catch (_) { /* ignore */ }
    };

    const fireRatch = (osc) => {
        if (hits <= 1 || typeof osc.retrigger !== 'function') return;
        const subDur = stepDuration / hits;
        for (let k = 1; k < hits; k++) {
            const ht = startTime + k * subDur;
            const hz = glissRoll && toHz != null
                ? fromHz + (toHz - fromHz) * (k / hits)
                : fromHz;
            osc.retrigger(ht, hz);
        }
    };

    let voice = liveLane.find((v) => !v.isAnalog && v.osc && typeof v.osc.retrigger === 'function');
    if (voice) {
        applyDigitalDrumPatchLive(voice.osc, patch, t0, velocity);
        const ok = voice.osc.retrigger(t0, fromHz);
        if (ok) {
            voice.epoch = (voice.epoch || 0) + 1;
            voice.startTime = t0;
            voice.stepHz = stepHz;
            try {
                panner.pan.setValueAtTime(Math.max(-1, Math.min(1, Number(patch.pan) || 0)), t0);
                const g = voice.amp.gain;
                const cur = Math.max(0.00001, Number(g.value) || peak);
                try {
                    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(t0);
                    else g.cancelScheduledValues(t0);
                } catch (_) { /* ignore */ }
                try { g.setValueAtTime(cur, t0); } catch (_) { /* ignore */ }
                g.linearRampToValueAtTime(peak, t0 + 0.002);
            } catch (_) { /* ignore */ }
            applyPitch(voice.osc);
            fireRatch(voice.osc);
            voice.until = t0 + tail;
            scheduleDrumVoiceUntil(voice, ctx, generation);
            return;
        }
        disposeBerlinDrumVoice(voice, { hard: true });
        voice = null;
    }

    const osc = createPlaitsSource(ctx, fromHz, { ...patch, velocity });
    if (!osc) return;

    const amp = ctx.createGain();
    amp.gain.value = 0;
    osc.connect(amp);
    amp.connect(panner);

    try {
        amp.gain.cancelScheduledValues(t0);
        amp.gain.setValueAtTime(0, t0);
        amp.gain.linearRampToValueAtTime(peak, t0 + 0.002);
    } catch (_) { /* ignore */ }

    try {
        panner.pan.setValueAtTime(Math.max(-1, Math.min(1, Number(patch.pan) || 0)), t0);
    } catch (_) { /* ignore */ }

    applyPitch(osc);
    osc.start(t0);
    fireRatch(osc);

    voice = { lane, osc, amp, startTime: t0, stepHz, isAnalog: false, epoch: 1, until: t0 + tail };
    if (!Array.isArray(state.berlinDrumVoices)) state.berlinDrumVoices = [];
    state.berlinDrumVoices.push(voice);
    scheduleDrumVoiceUntil(voice, ctx, generation);
}

function triggerBerlinDrumLane(lane, pattern, startTime, stepDuration, data, playhead, nextPitch) {
    lane = lane | 0;
    if (lane < 0 || lane >= DRUM_LANE_COUNT) return;
    const patch = state.berlinDrum?.[lane];
    if (!patch) return;
    const analog = isAnalogDrumEngine(patch);
    const prevGliss = !!playhead.prevGliss;
    const slideIn = !!playhead.sounded && !!playhead.prevSlide && !prevGliss;
    const ratchN = state.acidMode ? 1 : clampRatch(data.ratch);
    const glissRoll = !analog && ratchN > 1 && !!data.slide;
    const accentAmount = getAccentAmount();
    const accentThisStep = !!data.accent && !slideIn;
    const gateLen = Math.max(0.05, Math.min(1, patternGate(pattern) * getGateLength()));
    const allowKb = !state.songPlaying;
    const stepHz = berlinFrequency(playhead.semi, playhead.fine, undefined, allowKb);
    const stepToHz = nextPitch
        ? berlinFrequency(nextPitch.semi, nextPitch.fine, undefined, allowKb)
        : stepHz;
    const fromHz = analog
        ? analogKitHz(patch.model, patch.tune, playhead.semi, playhead.fine)
        : digitalDrumTuneHz(stepHz, patch.tune);
    const toHz = analog
        ? (nextPitch
            ? analogKitHz(patch.model, patch.tune, nextPitch.semi, nextPitch.fine)
            : fromHz)
        : digitalDrumTuneHz(stepToHz, patch.tune);

    spawnBerlinDrumVoice({
        lane,
        startTime,
        stepDuration,
        gateLen,
        accentThisStep,
        accentAmount,
        glissRoll,
        slideIn: !analog && ratchN === 1 && slideIn,
        slideTime: getSlideTime(),
        fromHz,
        toHz: glissRoll ? toHz : null,
        stepHz,
        ratchHits: ratchN > 1 ? ratchN : 1,
    });
    lastDrumFreqs[lane] = glissRoll ? toHz : fromHz;
}

function fireBerlinRow(row, pattern, playhead, startTime, stepDuration, syncKeyboard) {
    const step = playhead.currentStep;
    const data = rowStepValue(pattern, step, row);
    scheduleBerlinHighlight(row, step, startTime, syncKeyboard);

    const destination = pattern.destination;
    if (destination === 'off' && !isOscLane(row)) return;

    // Hold-last for rests (CV and pitch memory)
    if (data.on) {
        playhead.semi = data.semi;
        playhead.fine = data.fine;
    }

    const nextIdx = berlinNextStepIndex(pattern, step);
    const nextData = rowStepValue(pattern, nextIdx, row);
    const nextPitch = { semi: nextData.semi, fine: nextData.fine };
    const ratchN = state.acidMode ? 1 : clampRatch(data.ratch);
    const glissRoll = data.on && ratchN > 1 && !!data.slide;

    if (isOscLane(row)) {
        if (data.on) {
            triggerBerlinOscLane(row, pattern, startTime, stepDuration, data, playhead, nextPitch);
        }
        // Rest: do not spawn; prior lane voices release from their own gate-off
    } else {
        // Mod / CV lanes: Amount-scaled via rowStepValue; ignore Gate + RATCH
        scheduleBerlinCv(
            destination,
            playhead.semi,
            startTime,
            data.slide ? getSlideTime() : 0.01,
        );
    }

    playhead.prevSlide = !!data.slide;
    playhead.prevGliss = glissRoll;
    playhead.sounded = !!data.on;
}

function scheduleDrumHighlight(lane, step, atTime) {
    const generation = state.playGeneration;
    const heardAt = atTime + uiOutputLatency();
    const delayMs = Math.max(0, (heardAt - state.audioContext.currentTime) * 1000);
    setTimeout(() => {
        if (generation !== state.playGeneration || !state.isPlaying) return;
        if (!state.berlinDrumMode) return;
        setDrumStepActive(lane, step);
    }, delayMs);
}

function fireDrumLane(lane, pattern, playhead, startTime, stepDuration) {
    const step = playhead.currentStep;
    const data = rowStepValue(pattern, step, 0);
    scheduleDrumHighlight(lane, step, startTime);
    if (data.on) {
        playhead.semi = data.semi;
        playhead.fine = data.fine;
    }
    const nextIdx = berlinNextStepIndex(pattern, step);
    const nextData = rowStepValue(pattern, nextIdx, 0);
    const nextPitch = { semi: nextData.semi, fine: nextData.fine };
    const ratchN = state.acidMode ? 1 : clampRatch(data.ratch);
    const glissRoll = data.on && ratchN > 1 && !!data.slide;
    const enabled = pattern.enabled !== false;
    if (state.berlinDrumMode && enabled && data.on) {
        triggerBerlinDrumLane(lane, pattern, startTime, stepDuration, data, playhead, nextPitch);
    }
    const src = parseScSource();
    if (enabled && data.on && src.kind === 'drum' && src.index === lane) {
        scheduleSidechainDuck(startTime);
    }
    playhead.prevSlide = !!data.slide;
    playhead.prevGliss = glissRoll;
    playhead.sounded = !!data.on;
}

function scheduleScOscSource(oscIndex, tempo, lookAhead) {
    const ctx = state.audioContext;
    const pattern = state.berlinMode ? getBerlinLane(oscIndex) : getPattern(oscIndex);
    ensureDrumPlayheads();
    const playhead = state.scSourcePlayhead;
    const stepDuration = rowStepDuration(pattern, tempo);
    if (!(stepDuration > 0)) return;
    if (playhead.nextStepTime < ctx.currentTime - 1) playhead.nextStepTime = ctx.currentTime;
    let guard = 0;
    while (playhead.nextStepTime < ctx.currentTime + lookAhead && guard++ < 64) {
        const startTime = playhead.nextStepTime;
        const step = playhead.currentStep;
        const data = rowStepValue(pattern, step, oscIndex);
        const enabled = pattern.enabled !== false;
        if (enabled && data.on) scheduleSidechainDuck(startTime);
        const n = Math.max(1, Math.round(pattern.stepCount) || 8);
        playhead.currentStep = pattern.reverse
            ? (playhead.currentStep - 1 + n) % n
            : (playhead.currentStep + 1) % n;
        playhead.nextStepTime += stepDuration;
    }
}

function passesUntilCycleStart(cyclePass, repeat, isFirst) {
    if (isFirst) return 1;
    const n = Math.max(1, Math.round(Number(repeat)) || 1);
    const pass = Math.max(0, Math.round(Number(cyclePass)) || 0);
    return Math.max(1, n - pass);
}

/** Audio time of the next cycle boundary, so drums never schedule past a queued switch. */
function nextCycleBoundaryTime() {
    if (!state.isPlaying) return Infinity;
    if (state.berlinMode) {
        const tempoN = getNumber('tempo', 120);
        const tempo = Number.isFinite(tempoN) && tempoN > 0 ? tempoN : 120;
        const loop = masterLoopSeconds(tempo);
        if (!(loop > 0.01) || !Number.isFinite(state.berlinLoopAnchor)) return Infinity;
        const passes = passesUntilCycleStart(
            state.berlinCyclePass,
            patternRepeat(getBerlinPattern(state.berlinSlot)),
            !!state.berlinCycleFirstPass,
        );
        return state.berlinLoopAnchor + passes * loop;
    }
    const n = Math.max(1, Math.round(getNumber('stepCount', 8)) || 8);
    const dur = currentStepDuration();
    if (!(dur > 0) || !Number.isFinite(state.nextStepTime)) return Infinity;
    const reverse = !!state.isReverse;
    const target = reverse ? n - 1 : 0;
    let cur = Math.round(Number(state.currentStep)) % n;
    if (cur < 0) cur += n;
    const steps = (target - cur + n) % n;
    const passes = passesUntilCycleStart(
        state.cyclePass,
        patternRepeat(getPattern(state.editSlot)),
        !!state.cycleFirstPass,
    );
    return state.nextStepTime + (steps + (passes - 1) * n) * dur;
}

function upcomingNormalCycleStart(stepIndex) {
    const n = Math.max(1, Math.round(getNumber('stepCount', 8)) || 8);
    const reverse = !!state.isReverse;
    const idx = Math.round(Number(stepIndex)) || 0;
    const isLoopStart = reverse ? idx === n - 1 : idx === 0;
    if (!isLoopStart) return false;
    return nextCyclePass(
        state.cyclePass,
        patternRepeat(getPattern(state.editSlot)),
        !!state.cycleFirstPass,
    ).isCycleStart;
}

function scheduleDrumLanesUntil(until) {
    const ctx = state.audioContext;
    if (!ctx) return;
    const tempo = getNumber('tempo', 120);
    ensureDrumPlayheads();
    const hard = Number.isFinite(Number(until)) ? Number(until) : ctx.currentTime + 0.3;
    if (state.songPlaying && songConductor) {
        let guard = 0;
        while (guard++ < 12) {
            let head = Infinity;
            for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
                const t = state.drumPlayheads[lane]?.nextStepTime;
                if (Number.isFinite(t)) head = Math.min(head, t);
            }
            if (!Number.isFinite(head)) head = ctx.currentTime;
            const cap = songConductor.nextDrumCapFrom(head);
            const limit = Math.min(hard, Number.isFinite(cap) ? cap : hard);
            for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
                const pattern = getDrumPattern(lane);
                const playhead = state.drumPlayheads[lane];
                const stepDuration = rowStepDuration(pattern, tempo);
                if (!(stepDuration > 0)) continue;
                // Rejoin a stalled lane, but do not jump across the next drum cue.
                if (playhead.nextStepTime < ctx.currentTime - 1) {
                    const rejoin = ctx.currentTime;
                    playhead.nextStepTime = Number.isFinite(cap) ? Math.min(rejoin, cap) : rejoin;
                }
                let spins = 0;
                while (playhead.nextStepTime < limit && spins++ < 64) {
                    fireDrumLane(lane, pattern, playhead, playhead.nextStepTime, stepDuration);
                    advanceDrumPlayhead(lane);
                    playhead.nextStepTime += stepDuration;
                }
            }
            // A step can land on the cue before the lookahead reaches it.
            // Switch on that landing, or the next pass no longer sees the cue.
            let earliest = Infinity;
            for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
                const t = state.drumPlayheads[lane]?.nextStepTime;
                if (Number.isFinite(t)) earliest = Math.min(earliest, t);
            }
            const reached = Number.isFinite(cap) && earliest >= cap - 1e-4;
            if (!(reached || (Number.isFinite(cap) && cap <= hard + 1e-4))) break;
            if (!songConductor.arriveDrum(cap)) break;
        }
        return;
    }
    const boundary = nextCycleBoundaryTime();
    const limit = Math.min(hard, Number.isFinite(boundary) ? boundary : hard);
    for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
        const pattern = getDrumPattern(lane);
        const playhead = state.drumPlayheads[lane];
        const stepDuration = rowStepDuration(pattern, tempo);
        if (!(stepDuration > 0)) continue;
        if (playhead.nextStepTime < ctx.currentTime - 1) playhead.nextStepTime = ctx.currentTime;
        let guard = 0;
        while (playhead.nextStepTime < limit && guard++ < 64) {
            fireDrumLane(lane, pattern, playhead, playhead.nextStepTime, stepDuration);
            advanceDrumPlayhead(lane);
            playhead.nextStepTime += stepDuration;
        }
    }
}

function scheduleDrumLanes() {
    const ctx = state.audioContext;
    if (!ctx) return;
    scheduleDrumLanesUntil(ctx.currentTime + 0.3);
    const tempo = getNumber('tempo', 120);
    const src = parseScSource();
    if (get('scToggle') && src.kind === 'osc') scheduleScOscSource(src.index, tempo, 0.3);
}

function scheduleBerlinSteps() {
    const ctx = state.audioContext;
    const tempo = getNumber('tempo', 120);
    ensurePlayheads();
    const kbRow = keyboardHighlightRow();
    const horizon = () => ctx.currentTime + BERLIN_LOOKAHEAD;

    // Schedule every lane up to `until`, and never past the lookahead.
    // Called before a cycle boundary so the pattern that is ending still
    // plays its last steps, then again after a switch for the new pattern.
    const scheduleBerlinRows = (until) => {
        const limit = Math.min(until, horizon());
        berlinActiveRows().forEach((row) => {
            const pattern = getBerlinLane(row);
            const playhead = state.berlinPlayheads[row];
            const stepDuration = rowStepDuration(pattern, tempo);
            if (!(stepDuration > 0)) return;

            // A backgrounded tab can leave a playhead far behind — rejoin the clock
            if (playhead.nextStepTime < ctx.currentTime - 1) {
                playhead.nextStepTime = ctx.currentTime;
            }

            let guard = 0;
            while (playhead.nextStepTime < limit && guard++ < 64) {
                // Mute / Solo silence skips CV/pitch only — playhead keeps phase
                if (isRowSounding(row) && !(state.songPlaying && songConductor?.berlinSilent())) {
                    try {
                        if (state.songPlaying && songConductor?.preparePitch) {
                            songConductor.preparePitch(playhead.nextStepTime);
                        }
                        fireBerlinRow(row, pattern, playhead, playhead.nextStepTime, stepDuration, row === kbRow);
                    } catch (_) { /* keep Berlin clock alive */ }
                } else {
                    scheduleBerlinHighlight(row, playhead.currentStep, playhead.nextStepTime, false);
                }
                advancePlayhead(row);
                playhead.nextStepTime += stepDuration;
            }
        });
    };

    // Automation follows the longest active row, time-wise.
    // Re-read each pass: a cycle-boundary switch can change the master length.
    const firstLoop = masterLoopSeconds(tempo);
    if (firstLoop > 0.01) {
        if (state.berlinLoopAnchor < ctx.currentTime - firstLoop * 64) {
            state.berlinLoopAnchor = ctx.currentTime;
        }
        let guard = 0;
        while (guard++ < 64) {
            const loopSeconds = masterLoopSeconds(tempo);
            if (!(loopSeconds > 0.01)) break;
            const natural = state.berlinLoopAnchor + loopSeconds;
            let boundary = natural;
            let songCut = false;
            if (state.songPlaying && songConductor) {
                const cap = songConductor.nextSynthCapFrom(state.berlinLoopAnchor);
                if (Number.isFinite(cap) && cap <= natural + 1e-3) {
                    boundary = cap;
                    songCut = true;
                }
            }
            if (!(boundary < horizon())) break;
            // Finish this pattern through the boundary before any switch.
            scheduleBerlinRows(boundary);
            if (songCut) {
                state.berlinLoopAnchor = boundary;
                const info = songConductor.onBerlinBoundary(boundary);
                if (info?.silent) releaseBerlinOscVoices(boundary);
                if (info?.armed && !info?.silent) {
                    queuePatternPass(
                        state.berlinLoopAnchor,
                        (state.berlinCyclePass | 0) + 1,
                        patternRepeat(getBerlinPattern(state.berlinSlot)),
                    );
                }
                break;
            }
            state.berlinLoopAnchor = boundary;
            const first = !!state.berlinCycleFirstPass;
            state.berlinCycleFirstPass = false;
            const next = nextCyclePass(
                state.berlinCyclePass,
                patternRepeat(getBerlinPattern(state.berlinSlot)),
                first,
            );
            state.berlinCyclePass = next.cyclePass;
            let switched = false;
            if (next.isCycleStart) {
                // Old drum hits through this boundary; a switch then restarts them on it.
                scheduleDrumLanesUntil(boundary);
                const slotBefore = state.berlinSlot;
                notifyAutomationLoopAnchor(state.berlinLoopAnchor);
                // commitPendingSlot may swap patterns and reset every lane onto this anchor.
                document.dispatchEvent(new CustomEvent('ingysynth:loop-start', {
                    detail: { startTime: state.berlinLoopAnchor },
                }));
                switched = state.berlinSlot !== slotBefore;
            }
            const shown = patternRepeat(getBerlinPattern(state.berlinSlot));
            const pass = next.isCycleStart ? 1 : state.berlinCyclePass + 1;
            queuePatternPass(state.berlinLoopAnchor, pass, shown);
            // Let the new pattern's step 1 get scheduled before another pass is consumed.
            if (switched) break;
        }
    }

    if (state.songPlaying && songConductor) {
        const cap = songConductor.nextSynthCapFrom(state.berlinLoopAnchor);
        const until = Number.isFinite(cap) ? Math.min(horizon(), cap) : horizon();
        scheduleBerlinRows(until);
    } else {
        scheduleBerlinRows(horizon());
    }
}

// Osc / drum lane muted / solo-silenced — release that row's independent voices
document.addEventListener('ingysynth:berlin-osc-muted', (e) => {
    if (!state.berlinMode || !state.audioContext) return;
    const oscIndex = e.detail?.oscIndex;
    if (oscIndex === null || oscIndex === undefined) return;
    releaseBerlinOscVoices(state.audioContext.currentTime, oscIndex | 0);
});

document.addEventListener('ingysynth:drum-slot', (e) => {
    if (!state.isPlaying || !state.audioContext) return;
    const t = Number(e.detail?.startTime);
    if (!Number.isFinite(t)) return;
    resetDrumPlayheads(t);
    clearDrumStepActive();
});

document.addEventListener('ingysynth:berlin-drum-muted', (e) => {
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    if (e.detail?.all) {
        releaseBerlinDrumVoices(now);
        return;
    }
    const lane = e.detail?.lane;
    if (lane === null || lane === undefined) return;
    releaseBerlinDrumVoices(now, lane | 0);
});

document.addEventListener('ingysynth:berlin-drum-filt', (e) => {
    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    routeBerlinDrumPanners();
    if (e.detail?.on && isBerlinOn()) {
        if (state.berlinDrumVoices?.length) armDrumFiltSharedPath(now);
    } else {
        maybeDisarmBerlinSharedPath(now);
    }
});

document.addEventListener('ingysynth:berlin-mode', (e) => {
    if (e.detail?.on) {
        silenceMainPhaseResetOscs(state.audioContext?.currentTime ?? 0);
        // Shared path arms on first osc-lane hit so mod CV can reach the filter
        clearStepsPreviewTimer();
        showBerlinBdOnVfd();
        if (state.audioContext) {
            warmPlaitsPool(state.audioContext, 6);
            warmBerlinAnalogDrums();
        }
    } else {
        const now = state.audioContext?.currentTime ?? 0;
        releaseBerlinOscVoices(now);
        if (!state.berlinDrumMode) releaseBerlinDrumVoices(now);
        maybeDisarmBerlinSharedPath(now);
        if (state.isPlaying) {
            updateKeyboardStepDisplay(lastVfdStepIndex);
        } else {
            refreshIdleVfd();
        }
    }
});

let chordArpCycle = [];
let chordArpNotesKey = '';

function nextChordArpSemi() {
    const notes = expandArpNotesByRange(getChordArpSourceNotes(), state.arpRange || 1);
    if (!notes.length) return null;

    const notesKey = `${state.arpRange || 1}:${[...notes].sort((a, b) => a - b).join(',')}`;
    if (notesKey !== chordArpNotesKey || chordArpCycle.length === 0) {
        chordArpNotesKey = notesKey;
        chordArpCycle = buildOrderList(notes, state.arpOrder || 'up');
        state.arpChordIndex = 0;
    }

    if (!chordArpCycle.length) return null;
    if (state.arpChordIndex >= chordArpCycle.length) {
        if (state.arpOrder === 'random') {
            chordArpCycle = buildOrderList(notes, 'random');
        }
        state.arpChordIndex = 0;
    }
    const semi = chordArpCycle[state.arpChordIndex];
    state.arpChordIndex += 1;
    return semi;
}

export function invalidateChordArpOrder() {
    chordArpCycle = [];
    chordArpNotesKey = '';
    state.arpChordIndex = 0;
}

function scheduleArpNextStep(generation) {
    if (!state.isArping || !state.audioContext || generation !== state.playGeneration) return;

    const tempo = getNumber('tempo');
    const division = getNumber('division');
    const stepCount = getNumber('stepCount');
    const bps = 60 / tempo;
    const stepDuration = bps * (4 / division);
    // Keep lookahead under one step so a soft key-retune can't cancel
    // multiple already-scheduled pitch events.
    const lookAheadTime = Math.min(0.05, stepDuration * 0.5);

    while (state.nextStepTime < state.audioContext.currentTime + lookAheadTime) {
        if (state.keyboardArpChord) {
            const semi = nextChordArpSemi();
            if (semi != null) {
                if (state.keyboardPoly || state.keyboardMultitudes) {
                    playPolyArpNote(semi, state.nextStepTime, stepDuration);
                } else {
                    playChordArpNote(semi, state.nextStepTime, stepDuration);
                }
            }
        } else {
            playStep(
                state.currentStep,
                state.nextStepTime,
                stepDuration,
                snapshotStepNeighborhood(state.currentStep, stepCount, state.isReverse),
            );

            if (state.isReverse) {
                state.currentStep = (state.currentStep - 1 + stepCount) % stepCount;
            } else {
                state.currentStep = (state.currentStep + 1) % stepCount;
            }
        }

        state.nextStepTime += stepDuration;
    }

    setTimeout(() => scheduleArpNextStep(generation), 25);
}

const ARP_RETUNE_RAMP = 0.012;

/**
 * Shift sounding arp oscillators by a keyboard-transpose delta without
 * retriggering envelopes (used when dragging across keys).
 */
function retuneArpTranspose(deltaSemitones, { ramp = ARP_RETUNE_RAMP } = {}) {
    if (!state.audioContext || !state.isArping || !deltaSemitones) return;

    const now = state.audioContext.currentTime;
    const ratio = Math.pow(2, deltaSemitones / 12);

    const apply = (osc, i) => {
        const prevBase = state.lastStepFreqs[i];
        if (prevBase == null || !Number.isFinite(prevBase)) return;
        const nextBase = Math.max(20, prevBase * ratio);
        const prev = voiceTargetFreq(osc, prevBase);
        const next = voiceTargetFreq(osc, nextBase);
        try {
            osc.frequency.cancelScheduledValues(now);
            if (ramp > 0 && Math.abs(prev - next) > 0.01) {
                osc.frequency.setValueAtTime(Math.max(20, prev), now);
                osc.frequency.exponentialRampToValueAtTime(Math.max(20, next), now + ramp);
            } else {
                osc.frequency.setValueAtTime(Math.max(20, next), now);
            }
        } catch (_) { /* ignore */ }
        state.lastStepFreqs[i] = nextBase;
    };

    if (state.phaseResetEnabled) {
        state.activeOscillators.forEach(osc => {
            if (!osc.started) return;
            apply(osc, osc.oscIndex);
        });
    } else {
        state.oscillators.forEach((osc, i) => apply(osc, i));
    }
}

/** Key-gated step playback: restart pattern from the beginning (or end if reverse). */
function startArp() {
    if (!state.audioContext || state.isPlaying) return;

    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }

    clearStepsPreviewTimer();
    clearStopCleanup();
    state.playGeneration += 1;
    const generation = state.playGeneration;
    forceNoteOff();

    // Keep ArP scrolling on the VFD while the pattern runs (not during sequencer play)
    if (!state.isPlaying && idleMarqueeTimer === null) startIdleMarquee();

    const now = state.audioContext.currentTime;
    // Soft mute into the first arp step — hard zero snaps click when restarting
    const envNow = Math.max(0.00001, state.envelope.gain.value || 0.00001);
    state.envelope.gain.cancelScheduledValues(now);
    state.envelope.gain.setValueAtTime(envNow, now);
    state.envelope.gain.exponentialRampToValueAtTime(0.00001, now + 0.008);
    if (state.filterEnvGain) {
        const fNow = Math.max(0.00001, state.filterEnvGain.gain.value || 0.00001);
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(fNow, now);
        state.filterEnvGain.gain.exponentialRampToValueAtTime(0.00001, now + 0.008);
    }

    // Fade out any leftover phase-reset oscs before the new pattern starts
    if (state.phaseResetEnabled && state.activeOscillators.length > 0) {
        state.activeOscillators.forEach((osc) => fadeStopOsc(osc, now + 0.012, { fadeSec: osc.isWavetable ? 0.055 : 0.02, hard: !!osc.isTriggered }));
        state.activeOscillators = [];
    }

    state.isArping = true;
    state.currentStep = state.isReverse ? getNumber('stepCount') - 1 : 0;
    state.nextStepTime = now + 0.05;
    state.lastStepSounded = false;
    state.envelopeHeld = false;
    state.filterEnvelopeHeld = false;
    state.arpLastPolySemi = null;
    if (state.keyboardPoly || state.keyboardMultitudes) {
        // Event (not direct import) — avoids sequencer↔poly-voice circular init
        document.dispatchEvent(new CustomEvent('ingysynth:poly-arp-reset'));
    }
    invalidateChordArpOrder();

    hideLogoOverlay();
    scheduleArpNextStep(generation);
}

function stopArp() {
    if (!state.isArping) return;

    state.isArping = false;
    state.arpTranspose = 0; // drop temporary arp root; sequencer keeps keyboardTranspose
    state.arpChordIndex = 0;
    chordArpCycle = [];
    chordArpNotesKey = '';
    state.playGeneration += 1;
    clearStopCleanup();

    releasePolyArpNote();

    if (state.audioContext) {
        stopActiveVoices(state.audioContext.currentTime);
    }

    setKeyboardStepActive(null);
    clearKeyboardStepDisplay();

    if (!state.isPlaying) {
        showLogoOverlay(1500);
        if (!window.noteVisualizerPreviewActive) clearNoteVisualizer();
    }
}

function releasePolyArpNote() {
    const prev = state.arpLastPolySemi;
    state.arpLastPolySemi = null;
    if (prev != null && (state.keyboardPoly || state.keyboardMultitudes)) {
        document.dispatchEvent(new CustomEvent('ingysynth:poly-arp-off', {
            detail: { cellSemitone: prev, force: true },
        }));
    }
}

/**
 * Juno-style Poly/Multitudes Arp tick: one voice gated through the poly path.
 * Uses custom events so sequencer never imports poly-voice (circular module graph).
 */
function playPolyArpNote(cellSemitone, startTime, stepDuration) {
    if (!state.isArping || state.isPlaying || !(state.keyboardPoly || state.keyboardMultitudes)) return;

    retriggerLfoIfNeeded(startTime);

    const sounding = cellSemitone + getGlobalTune();
    if (!window.noteVisualizerPreviewActive) {
        const pool = getChordArpSourceNotes();
        if (pool.length > 1) {
            updateChordVisualizer(pool.map((n) => n + getGlobalTune()));
        } else {
            updateNoteVisualizer(sounding);
        }
    }

    document.dispatchEvent(new CustomEvent('ingysynth:chord-arp-note', {
        detail: { cellSemitone, sounding },
    }));

    const noteOnTime = startTime;
    const noteOffTime = startTime + stepDuration * getGateLength();
    const now = state.audioContext.currentTime;
    const noteOnDelay = Math.max(0, (noteOnTime - now) * 1000);
    const noteOffDelay = Math.max(0, (noteOffTime - now) * 1000);
    const gen = state.playGeneration;

    setTimeout(() => {
        if (!state.isArping || gen !== state.playGeneration || !(state.keyboardPoly || state.keyboardMultitudes)) return;
        const prev = state.arpLastPolySemi;
        if (prev != null && prev !== cellSemitone) {
            document.dispatchEvent(new CustomEvent('ingysynth:poly-arp-off', {
                detail: { cellSemitone: prev },
            }));
        }
        document.dispatchEvent(new CustomEvent('ingysynth:poly-arp-on', {
            detail: { cellSemitone, sounding },
        }));
        state.arpLastPolySemi = cellSemitone;
    }, noteOnDelay);

    setTimeout(() => {
        if (gen !== state.playGeneration) return;
        if (state.arpLastPolySemi !== cellSemitone) return;
        document.dispatchEvent(new CustomEvent('ingysynth:poly-arp-off', {
            detail: { cellSemitone },
        }));
        if (state.arpLastPolySemi === cellSemitone) state.arpLastPolySemi = null;
    }, noteOffDelay);

    if (state.sendMidiEnabled && state.selectedMidiOutput) {
        const safeNote = Math.min(127, Math.max(0, state.midiBaseNote + sounding));
        setTimeout(() => {
            state.selectedMidiOutput.send([0x90 | (state.selectedMidiChannel - 1), safeNote, 100]);
        }, noteOnDelay);
        setTimeout(() => {
            state.selectedMidiOutput.send([0x80 | (state.selectedMidiChannel - 1), safeNote, 0]);
        }, noteOffDelay);
    }
}

/** Classic chord-arp tick: one held-key pitch gated to stepDuration (no pattern/slide). */
function playChordArpNote(cellSemitone, startTime, stepDuration) {
    if (!state.isArping || state.isPlaying) return;

    const sounding = cellSemitone + getGlobalTune();
    if (!window.noteVisualizerPreviewActive) {
        const pool = getChordArpSourceNotes();
        if (pool.length > 1) {
            updateChordVisualizer(pool.map((n) => n + getGlobalTune()));
        } else {
            updateNoteVisualizer(sounding);
        }
    }

    document.dispatchEvent(new CustomEvent('ingysynth:chord-arp-note', {
        detail: { cellSemitone, sounding },
    }));

    if (state.sendMidiEnabled && state.selectedMidiOutput) {
        const safeNote = Math.min(127, Math.max(0, state.midiBaseNote + sounding));
        const noteOnTime = startTime;
        const noteOffTime = startTime + stepDuration * getGateLength();
        const noteOnDelay = Math.max(0, (noteOnTime - state.audioContext.currentTime) * 1000);
        const noteOffDelay = Math.max(0, (noteOffTime - state.audioContext.currentTime) * 1000);
        setTimeout(() => {
            state.selectedMidiOutput.send([0x90 | (state.selectedMidiChannel - 1), safeNote, 100]);
        }, noteOnDelay);
        setTimeout(() => {
            state.selectedMidiOutput.send([0x80 | (state.selectedMidiChannel - 1), safeNote, 0]);
        }, noteOffDelay);
    }

    if (state.phaseResetEnabled) {
        stopDisabledOscStacks(startTime);
        for (let i = 0; i < state.oscStates.length; i++) {
            if (state.oscStates[i]) {
                const baseFreq = semitonesToFrequency(sounding, i);
                firePhaseResetOscStack(i, baseFreq, startTime, {
                    oscStart: startTime,
                    gainRampStart: startTime,
                    gainRampEnd: startTime + 0.02,
                });
            }
        }
    } else {
        state.oscillators.forEach((osc, i) => {
            const baseFreq = semitonesToFrequency(sounding, i);
            const freq = bentFrequency(baseFreq);
            osc.frequency.cancelScheduledValues(startTime);
            osc.frequency.setValueAtTime(freq, startTime);
            state.lastStepFreqs[i] = baseFreq;
        });
    }

    if (state.noiseState && getNumber('noiseVol') > 0) {
        if (state.noiseSource) {
            const noiseGainValue = state.noiseGain.gain.value;
            state.noiseGain.gain.cancelScheduledValues(startTime - 0.005);
            state.noiseGain.gain.setValueAtTime(noiseGainValue, startTime - 0.005);
            state.noiseGain.gain.linearRampToValueAtTime(0, startTime);
            setTimeout(() => {
                try { state.noiseSource.stop(); } catch (_) { /* ignore */ }
            }, 5);
        }
        state.noiseSource = state.audioContext.createBufferSource();
        const noiseType = getString('noiseType', 'white');
        state.noiseSource.buffer = state.noiseBuffers[noiseType];
        state.noiseSource.loop = true;
        state.noiseSource.connect(state.noiseGain);
        const targetNoiseVol = getNumber('noiseVol');
        state.noiseGain.gain.cancelScheduledValues(startTime - 0.003);
        state.noiseGain.gain.setValueAtTime(0, startTime - 0.003);
        state.noiseSource.start(startTime - 0.003);
        state.noiseGain.gain.linearRampToValueAtTime(targetNoiseVol, startTime + 0.005);
    }

    retriggerLfoIfNeeded(startTime);

    const adjustedStartTime = Math.max(state.audioContext.currentTime, startTime);
    scheduleStepEnvelope({
        startTime,
        stepDuration,
        slideThisStep: false,
        nextStepWillSlide: false,
        accentThisStep: false,
        accentAmount: 0,
    });
    scheduleStepFilterEnvelope({
        startTime: adjustedStartTime,
        stepDuration,
        slideThisStep: false,
        nextStepWillSlide: false,
        accentThisStep: false,
        accentAmount: 0,
    });

    state.lastStepSounded = true;
}

function seqPolyVoiceMode() {
    return !isBerlinOn() && !!(state.keyboardPoly || state.keyboardMultitudes) && !!state.isPlaying;
}

function firePolySeqHit({
    startTime,
    gateSec,
    midiGateSec,
    soundingRoot,
    intervals,
    cellRoot,
    accentScale,
    slideTime,
    engineGen,
    unison,
    accentThisStep,
    fineCents,
    slideThisStep,
    nextStepWillSlideEnv,
    glissRoll,
    skipPitch,
    pulseRatch,
    lastRatchHit,
    slideFrom,
    nextSounding,
    glissEndTime,
}) {
    schedulePolySeqVoicing({
        startTime,
        gateSec,
        soundingRoot: soundingRoot + ((Number(fineCents) || 0) / 100),
        intervals,
        cellRoot,
        accentScale,
        slideTime,
        engineGen,
        unison,
        slideThisStep,
        nextStepWillSlideEnv,
        glissRoll,
        skipPitch,
        pulseRatch,
        lastRatchHit,
        slideFrom,
        nextSounding,
        glissEndTime,
    });
    seqMidiChord({
        soundingRoot,
        intervals,
        startTime,
        gateSec: midiGateSec ?? gateSec,
        accentThisStep,
        fineCents,
        engineGen,
    });
}

function polySeqSoundingIntervals(data) {
    if (isPolyChordMemoryOn()) {
        const mem = getPolyChordIntervals();
        return mem.length ? mem : [0];
    }
    return soundingIntervalsFromStep(data);
}

function polySeqPlaybackCellNotes(data) {
    if (!isPolyChordMemoryOn()) return stepCellNotes(data);
    const root = Math.round(Number(data?.tune) || 0);
    return getPolyChordIntervals().map((iv) => root + iv);
}

function polySeqPlaybackChordCount(data) {
    if (!isPolyChordMemoryOn()) return stepChordCount(data);
    const n = getPolyChordIntervals().length;
    return n > 0 ? n : 1;
}

/** Sequenced Ingy-6 / Multitudes branch of playStep. Never spawnOscStack / master env / ratch. */
function playPolySeqStep({
    data,
    nextData,
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlideEnv,
    glissRoll,
    accentThisStep,
    accentAmount,
    ratchHits,
    fineCents,
}) {
    const engineGen = state.seqEngineGeneration;
    const soundingRoot = getStepTotalTuneFromRaw(data.tune);
    const intervals = polySeqSoundingIntervals(data);
    const cellRoot = Math.round(Number(data.tune) || 0);
    const isChord = intervals.length > 1;
    const gateFrac = getGateLength();
    const slideTime = getSlideTime();
    const accentScale = accentThisStep ? Math.min(1.5, 1 + accentAmount * 0.5) : 1;
    const slideFrom = (slideThisStep && lastPolySounding != null) ? lastPolySounding : null;
    const nextSounding = glissRoll
        ? {
            root: getStepTotalTuneFromRaw(nextData?.tune)
                + (Math.round(Number(nextData?.fine) || 0) / 100),
            intervals: polySeqSoundingIntervals(nextData),
        }
        : null;

    const hits = Math.max(1, ratchHits | 0);
    const subDur = stepDuration / hits;
    const pulseRatch = hits > 1 && !slideThisStep;
    const envHits = pulseRatch ? hits : 1;
    const envDur = pulseRatch ? subDur : stepDuration;
    const holdGate = !!nextStepWillSlideEnv && !glissRoll;
    const unison = !isChord && !!state.keyboardPolyUnison && !!state.keyboardPoly;
    const glissEndTime = startTime + stepDuration;

    for (let k = 0; k < envHits; k++) {
        const hitStart = startTime + k * envDur;
        const audioGate = holdGate ? envDur : envDur * gateFrac;
        const midiGate = holdGate ? stepDuration * 1.1 : envDur * gateFrac;
        firePolySeqHit({
            startTime: hitStart,
            gateSec: audioGate,
            midiGateSec: midiGate,
            soundingRoot,
            intervals,
            cellRoot,
            accentScale,
            slideTime,
            engineGen,
            unison,
            accentThisStep,
            fineCents: k === 0 ? fineCents : null,
            slideThisStep: k === 0 && !!slideThisStep,
            nextStepWillSlideEnv: holdGate,
            glissRoll: k === 0 && !!glissRoll,
            skipPitch: k > 0,
            pulseRatch,
            lastRatchHit: !!pulseRatch && k === envHits - 1,
            slideFrom: k === 0 ? slideFrom : null,
            nextSounding: k === 0 ? nextSounding : null,
            glissEndTime,
        });
    }
    lastPolySounding = {
        root: soundingRoot + ((Number(fineCents) || 0) / 100),
        intervals: intervals.slice(),
    };
    lastPolySeqHeld = holdGate;
    state.lastStepSounded = true;
}

function releaseSongHold(startTime) {
    if (lastPolySeqHeld) releasePolySeqHold(startTime);
    clearLastPolySounding();
    if (state.acidMode) {
        releaseAcidHeldEnvelopes(startTime);
    } else {
        if (state.envelopeHeld && state.envelope) {
            scheduleBusRelease(state.envelope.gain, startTime, seqReleaseTau(getNumber('release')));
            state.envelopeHeld = false;
        }
        if (state.filterEnvelopeHeld && state.filterEnvGain) {
            scheduleBusRelease(state.filterEnvGain.gain, startTime, seqReleaseTau(getNumber('filterRelease')));
            state.filterEnvelopeHeld = false;
        }
    }
    state.lastStepSounded = false;
}

function playStep(step, startTime, stepDuration, scheduled) {
    if (!state.isPlaying && !state.isArping) return;

    let playIndex = step;
    let refreshSnap = !scheduled;
    if (state.isPlaying && state.songPlaying && songConductor) {
        songSilenceAdvance = null;
        const cue = songConductor.onSynthStep(startTime);
        if (cue?.action === 'silence') {
            if (cue.entered) releaseSongHold(startTime);
            songSilenceAdvance = cue.advanceSec;
            return;
        }
        if (cue?.action === 'arm') {
            step = cue.stepIndex;
            playIndex = cue.stepIndex;
            state.currentStep = cue.stepIndex;
            state.cyclePass = cue.cyclePass;
            state.cycleFirstPass = cue.cycleFirstPass;
            stepDuration = currentStepDuration();
            refreshSnap = true;
        }
    }
    // Cycle boundary: Repeat passes, then automation + a queued pattern, from step 1.
    if (state.isPlaying) {
        const stepsN = Math.max(1, Math.round(getNumber('stepCount', 8)) || 8);
        const isLoopStart = state.isReverse ? step === stepsN - 1 : step === 0;
        if (isLoopStart) {
            const first = !!state.cycleFirstPass;
            state.cycleFirstPass = false;
            const next = nextCyclePass(
                state.cyclePass,
                patternRepeat(getPattern(state.editSlot)),
                first,
            );
            state.cyclePass = next.cyclePass;
            if (next.isCycleStart) {
                notifyAutomationLoopAnchor(startTime);
                // Lands the armed pattern before this downbeat is snapshotted, so it starts at step 1.
                document.dispatchEvent(new CustomEvent('ingysynth:loop-start', { detail: { startTime } }));
                const pattern = getPattern(state.editSlot);
                const n = patternStepCount(pattern);
                playIndex = pattern.reverse ? n - 1 : 0;
                state.currentStep = playIndex;
                stepDuration = currentStepDuration();
                refreshSnap = true;
            }
            const shown = patternRepeat(getPattern(state.editSlot));
            const pass = next.isCycleStart ? 1 : state.cyclePass + 1;
            queuePatternPass(startTime, pass, shown);
        }
    }

    const snap = refreshSnap
        ? snapshotStepNeighborhood(playIndex, getNumber('stepCount', 8), state.isReverse)
        : scheduled;
    const data = snap.this;
    const prevData = snap.prev;
    const nextData = snap.next;
    const freqThis = (i) => frequencyFromStepData(data, i);
    const freqNext = (i) => frequencyFromStepData(nextData, i);

    const polySeq = seqPolyVoiceMode();
    const meter = state.isPlaying ? normalPassMeter(playIndex, stepDuration, startTime) : null;
    queuePlayStepUi({
        step: playIndex,
        atTime: startTime,
        generation: state.playGeneration,
        on: data.on !== false,
        tune: data.on === false ? null : getStepTotalTuneFromRaw(data.tune),
        fine: data.on === false ? 0 : Math.round(Number(data.fine) || 0),
        cellNotes: data.on === false ? [] : (polySeq ? polySeqPlaybackCellNotes(data) : stepCellNotes(data)),
        chordCount: data.on === false ? 0 : (polySeq ? polySeqPlaybackChordCount(data) : stepChordCount(data)),
        cycleProgress: meter ? meter.progress : null,
        cyclePass: meter ? meter.pass : null,
        cycleRepeat: meter ? meter.repeat : null,
        passStart: meter ? meter.passStart : null,
        passEnd: meter ? meter.passEnd : null,
    });

    if (data.on === false) {
        // Drum-machine model: an OFF step means "no new trigger", not "mute".
        // Self-enveloped drums (and their ratch voices) must keep ringing through
        // empty steps; the next note-on / ratch hit is what resets them.
        // HEAD only released a held shared VCA for stuck-note/slide guards —
        // never tore down oscs or ratch voices here.
        // Poly owns the master VCA at 1 — rest must not gate it.
        if (!polySeq) {
            const drumVoice = !!(
                state.osc4Wavetable
                && state.oscStates?.[OSC4_INDEX]
                && DRUM_ENGINES.has(state.osc4Model)
            );
            const independentRinging = mainIndependentVoicesRinging();
            if (state.acidMode) {
                if (drumVoice && state.envelopeHeld) state.envelopeHeld = false;
                releaseAcidHeldEnvelopes(startTime);
            } else if (state.envelopeHeld && !drumVoice && !independentRinging) {
                // Slide-hold into a rest. Do not cancel — next ON is already on this param.
                scheduleBusRelease(state.envelope.gain, startTime, seqReleaseTau(getNumber('release')));
                state.envelopeHeld = false;
            }
            if (!state.acidMode && state.filterEnvelopeHeld && !independentRinging) {
                scheduleBusRelease(state.filterEnvGain.gain, startTime, seqReleaseTau(getNumber('filterRelease')));
                state.filterEnvelopeHeld = false;
            }
        } else if (lastPolySeqHeld) {
            releasePolySeqHold(startTime);
        }
        // Intentionally do NOT stop activeOscillators or duck independent voices.
        clearLastPolySounding();
        state.lastStepSounded = false;
        return;
    }

    // Slide (TB-303 + compat):
    // - Prefer Sld on step N = glide into N+1 (accent OK on N with Acc+Sld).
    // - Also accept Sld on the destination (older UI habit) so slides still work.
    // - Sld+RATCH (2–4) = gliss-roll: pitch glides this→next during this step.
    const slideFromPrev = !!prevData.slide;
    const slideOnThis = !!data.slide;
    const slideOnNext = nextData.on !== false && !!nextData.slide;
    const ratch = state.acidMode ? 1 : clampRatch(data.ratch);
    const glissRoll = ratch > 1 && slideOnThis;
    const prevWasGliss = slideFromPrev && clampRatch(prevData.ratch) > 1;
    // 303: arriving because previous step had Slide (not a finished gliss-roll)
    const isSlideContinuation = state.lastStepSounded && slideFromPrev && !prevWasGliss;
    // 303: only arriving from prev's Sld skips retrigger / slews pitch.
    const slideThisStep = isSlideContinuation && !glissRoll;
    // MIDI overlap still treats Sld-on-next as inbound dest.
    const nextStepWillSlide = !glissRoll && nextData.on !== false && (slideOnThis || slideOnNext);
    const slideThisStepEnv = slideThisStep;
    const nextStepWillSlideEnv = !glissRoll && nextData.on !== false && slideOnThis;
    const slideThisStepPitch = slideThisStep;
    const slideTime = getSlideTime();
    const accentAmount = getAccentAmount();
    // Accent on Acc+Sld source steps (303). Only blank when arriving via prev's Slide.
    const accentThisStep = !!data.accent && !isSlideContinuation;
    const hits = clampRatch(ratch);
    const subDur = stepDuration / hits;
    const fineCents = Math.round(Number(data.fine) || 0);
    const indepRinging = mainIndependentVoicesRinging();

    if (polySeq) {
        retriggerLfoIfNeeded(startTime);
        playPolySeqStep({
            data,
            nextData,
            startTime,
            stepDuration,
            slideThisStep,
            nextStepWillSlideEnv,
            glissRoll,
            accentThisStep,
            accentAmount,
            ratchHits: hits,
            fineCents,
        });
        return;
    }

    // Send MIDI if enabled (static ratch / gliss: repeated gates at this step's note)
    if (state.sendMidiEnabled && state.selectedMidiOutput) {
        const safeNote = midiNoteFromStepData(data);
        const nextNote = midiNoteFromStepData(nextData);
        const bendRangeEl = document.getElementById('bendRange');
        const bendRange = bendRangeEl ? parseInt(bendRangeEl.value) : 2;
        const gateLen = getGateLength();
        const overlapForSlide = hits === 1 && nextStepWillSlide && nextNote !== safeNote;
        const playGen = state.playGeneration;
        const engineGen = state.seqEngineGeneration;

        for (let k = 0; k < hits; k++) {
            const hitStart = startTime + k * subDur;
            // Full-note ratchets: each MIDI gate lasts a whole step (overlapping)
            const hitDur = hits === 1
                ? stepDuration * (overlapForSlide ? 1.1 : gateLen)
                : subDur * gateLen;
            const noteOnDelay = Math.max(0, (hitStart - state.audioContext.currentTime) * 1000);
            const noteOffDelay = Math.max(0, (hitStart + hitDur - state.audioContext.currentTime) * 1000);
            setTimeout(() => {
                if (!seqMidiStillValid(playGen, engineGen) || !state.selectedMidiOutput) return;
                if (k === 0 && fineCents !== state.lastSentBendCents) {
                    const bend = midiPitchBendValue(fineCents, bendRange);
                    state.selectedMidiOutput.send([0xE0 | (state.selectedMidiChannel - 1), bend & 0x7F, bend >> 7]);
                    state.lastSentBendCents = fineCents;
                }
                state.selectedMidiOutput.send([0x90 | (state.selectedMidiChannel - 1), safeNote, accentThisStep ? 127 : 100]);
            }, noteOnDelay);
            setTimeout(() => {
                if (!seqMidiStillValid(playGen, engineGen) || !state.selectedMidiOutput) return;
                state.selectedMidiOutput.send([0x80 | (state.selectedMidiChannel - 1), safeNote, 0]);
            }, noteOffDelay);
        }
    }

    // Leftover Berlin one-shots (older ratch path) must not mute the main bus.
    if (indepRinging || state.berlinSharedPathArmed) {
        handOffIndependentVoicesToMain(startTime);
    }

    /** Continuous this→next pitch glide over the full outer step (gliss-roll). */
    const scheduleGlissPitch = () => {
        const endTime = startTime + stepDuration;
        const ramp = (osc, fromHz, toHz) => {
            try {
                osc.frequency.cancelScheduledValues(startTime);
                osc.frequency.setValueAtTime(Math.max(0.01, fromHz), startTime);
                osc.frequency.linearRampToValueAtTime(Math.max(0.01, toHz), endTime);
            } catch (_) { /* ignore */ }
        };
        if (state.phaseResetEnabled) {
            state.activeOscillators.forEach((osc) => {
                if (!osc.started) return;
                const i = osc.oscIndex;
                const fromBase = freqThis(i);
                const toBase = freqNext(i);
                ramp(osc, voiceTargetFreq(osc, fromBase), voiceTargetFreq(osc, toBase));
                state.lastStepFreqs[i] = toBase;
            });
        } else {
            state.oscillators.forEach((osc, i) => {
                const fromBase = freqThis(i);
                const toBase = freqNext(i);
                ramp(osc, bentFrequency(fromBase), bentFrequency(toBase));
                state.lastStepFreqs[i] = toBase;
            });
        }
    };

    if (state.phaseResetEnabled) {
        stopDisabledOscStacks(startTime);
        if (glissRoll) {
            // Land on this pitch (respawn unless continuing a non-gliss slide-in), then ramp out
            if (!(slideThisStep && state.activeOscillators.length > 0)) {
                for (let i = 0; i < state.oscStates.length; i++) {
                    if (!state.oscStates[i]) continue;
                    firePhaseResetOscStack(i, freqThis(i), startTime, {
                        oscStart: startTime,
                        gainRampStart: startTime,
                        gainRampEnd: startTime + 0.02,
                    });
                }
            }
            scheduleGlissPitch();
        } else if (slideThisStepPitch) {
            // Slide (303 RC slew): setTargetAtTime = exponential approach from the
            // oscillator's *current* pitch — chained slides keep slewing like the
            // hardware capacitor, and slides land "just a hair short" like a 303.
            // If main oscs were cleared (prior ratch voices), respawn at last pitch first.
            if (state.activeOscillators.length === 0) {
                for (let i = 0; i < state.oscStates.length; i++) {
                    if (!state.oscStates[i]) continue;
                    const fromBase = state.lastStepFreqs[i] ?? freqThis(i);
                    spawnOscStack(i, fromBase, startTime, {
                        oscStart: startTime,
                        gainRampStart: startTime,
                        gainRampEnd: startTime + 0.02,
                    });
                }
            }
            state.activeOscillators.forEach((osc) => {
                const i = osc.oscIndex;
                const baseFreq = freqThis(i);
                const freq = voiceTargetFreq(osc, baseFreq);
                const prevBase = state.lastStepFreqs[i];
                const sameNote = prevBase != null && Math.abs(baseFreq - prevBase) < 1e-4;
                if (!sameNote) {
                    osc.frequency.cancelScheduledValues(startTime);
                    osc.frequency.setTargetAtTime(freq, startTime, slideTime / 3);
                }
                state.lastStepFreqs[i] = baseFreq;
            });
        } else {
        for (let i = 0; i < state.oscStates.length; i++) {
            if (state.oscStates[i]) {
                const baseFreq = freqThis(i);
                firePhaseResetOscStack(i, baseFreq, startTime, {
                    oscStart: startTime,
                    gainRampStart: startTime,
                    gainRampEnd: startTime + 0.02,
                });
            }
        }
        }
    } else if (glissRoll) {
        scheduleGlissPitch();
    } else {
        state.oscillators.forEach((osc, i) => {
            const baseFreq = freqThis(i);
            const freq = bentFrequency(baseFreq);
            if (slideThisStepPitch) {
                // Slide (303 RC slew): exponential approach from current pitch
                const prevBase = state.lastStepFreqs[i];
                const sameNote = state.acidMode && prevBase != null && Math.abs(baseFreq - prevBase) < 1e-4;
                if (!sameNote) {
                    osc.frequency.cancelScheduledValues(startTime);
                    osc.frequency.setTargetAtTime(freq, startTime, slideTime / 3);
                }
            } else {
                osc.frequency.cancelScheduledValues(startTime);
                osc.frequency.setValueAtTime(freq, startTime);
            }
            state.lastStepFreqs[i] = baseFreq;
        });
    }

    if (state.noiseState && getNumber('noiseVol') > 0) {
        if (state.noiseSource) {
            // Apply fade out before stopping
            const noiseGainValue = state.noiseGain.gain.value;
            state.noiseGain.gain.cancelScheduledValues(startTime - 0.005);
            state.noiseGain.gain.setValueAtTime(noiseGainValue, startTime - 0.005);
            state.noiseGain.gain.linearRampToValueAtTime(0, startTime);
            
            // Schedule the stop slightly after the fade completes
            setTimeout(() => {
                state.noiseSource.stop();
            }, 5);
        }
        
        // Create and set up new noise source
        state.noiseSource = state.audioContext.createBufferSource();
        const noiseType = getString('noiseType', 'white');
        state.noiseSource.buffer = state.noiseBuffers[noiseType];
        state.noiseSource.loop = true;
        state.noiseSource.connect(state.noiseGain);
        
        // Start with zero gain and fade in
        const targetNoiseVol = getNumber('noiseVol');
        state.noiseGain.gain.cancelScheduledValues(startTime - 0.003);
        state.noiseGain.gain.setValueAtTime(0, startTime - 0.003);
        state.noiseSource.start(startTime - 0.003);
        state.noiseGain.gain.linearRampToValueAtTime(targetNoiseVol, startTime + 0.005);
    }

    retriggerLfoIfNeeded(startTime);

    const nextIsRest = nextData.on === false;
    // Same oscs / bus as a normal ON. Pulse A/D/R on the ratch grid.
    // Slide dest stays one held gate (hits ignored for envelopes).
    const pulseRatch = hits > 1 && !slideThisStepEnv;
    const envHits = pulseRatch ? hits : 1;
    const envDur = pulseRatch ? subDur : stepDuration;
    for (let k = 0; k < envHits; k++) {
        const tHit = startTime + k * envDur;
        const last = k === envHits - 1;
        scheduleStepEnvelope({
            startTime: tHit,
            stepDuration: envDur,
            slideThisStep: !pulseRatch && slideThisStepEnv,
            nextStepWillSlide: !pulseRatch && nextStepWillSlideEnv,
            accentThisStep,
            accentAmount,
            nextIsRest: last && nextIsRest,
        });
        scheduleStepFilterEnvelope({
            startTime: Math.max(state.audioContext.currentTime, tHit),
            stepDuration: envDur,
            slideThisStep: !pulseRatch && slideThisStepEnv,
            nextStepWillSlide: !pulseRatch && nextStepWillSlideEnv,
            accentThisStep,
            accentAmount,
            nextIsRest: last && nextIsRest,
        });
    }

    state.lastStepSounded = true;
}

// Bulk step changes (bank load, pattern shift, write mode) repaint the readouts
document.addEventListener('ingysynth-kb-steps-sync', () => {
    refreshStepTuneReadouts();
});

document.addEventListener('ingysynth:seq-engine-bump', () => {
    onSeqEngineBump();
});

document.addEventListener('ingysynth:live-note-on', () => {
    if (state.isPlaying || state.isArping || state.keyboardWrite) return;
    stopIdleMarquee();
    setKeyboardStepDigits('Kb', { lit: true, label: 'Keyboard' });
});

document.addEventListener('ingysynth:live-note-off', () => {
    if (state.keyboardWrite) {
        showWriteStepOnVfd();
        return;
    }
    if (!state.isPlaying && !state.isArping) startIdleMarquee();
});

export {
    togglePlay,
    relocateArrangement,
    scheduleNextStep,
    playStep,
    startIdleMarquee,
    startArp,
    stopArp,
    retuneArpTranspose,
};
