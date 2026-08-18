import { state } from './state.js?v=114';
import { getNumber, getString, getOscType, getOscVol } from './params.js?v=13';
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
} from './tuning.js?v=79';
import { updateNoteVisualizer, clearNoteVisualizer, hideLogoOverlay, showLogoOverlay } from './visualizers.js?v=100';
import { updateFilterCutoffRange, getFilterEnvAmount, getFilterCutoffRange } from './filter-cutoff.js?v=82';
import { forceNoteOff } from './voice.js?v=129';
import { getLfoRateHz } from './lfo-rate.js?v=16';
import { bentFrequency } from './pitch-bend.js?v=91';
import { applyVfdChar, VFD_BRAND_SCROLL } from './vfd-charset.js?v=73';
import { spawnOscStack, firePhaseResetOscStack, stopDisabledOscStacks, voiceTargetFreq, getUnisonVoices, getUnisonSpread, unisonCents, readOscPanValue } from './unison.js?v=166';
import { createOscSource, softStartVoiceGain, wtAttackSecForFilter, wtFilterClickRisk, hasDarkOscActive, fadeStopOsc, DRUM_ENGINES, isTriggeredEngine, OSC4_INDEX } from './osc-source.js?v=98';
import { notifyAutomationLoopAnchor } from './automation.js?v=42';
import { buildOrderList, getChordArpSourceNotes, expandArpNotesByRange } from './held-notes.js?v=8';
import {
    scheduleAcidAmpEnvelope,
    scheduleAcidFilterEnvelope,
    clearAccentSweep,
    acidVegDecaySec,
} from './acid-env.js?v=14';
import {
    isBerlinOn,
    berlinActiveRows,
    ensurePlayheads,
    resetBerlinPlayheads,
    advancePlayhead,
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
} from './berlin.js?v=44';
import { getPattern, snapshotStepNeighborhood } from './pattern-bank.js?v=12';
import {
    clampRatch,
    nextRatch,
    readRatchFromButton,
    syncRatchButton,
} from './step-ratch.js?v=1';

function ensureStepParamBus() {
    let bus = document.getElementById('stepParamBus');
    if (!bus) {
        bus = document.createElement('div');
        bus.id = 'stepParamBus';
        bus.hidden = true;
        bus.setAttribute('aria-hidden', 'true');
        const host = document.getElementById('synthContainer') || document.body;
        host.appendChild(bus);
    }
    return bus;
}

// Canonical step inputs for knobs / MIDI / write. Not `#steps` (CP7: that stays empty).
// Classic play reads `pattern.steps[]`, snapshotted at schedule time.
const stepsDiv = ensureStepParamBus();
// Guard against duplicate ES module instances (?v= skew) appending a second bank of steps.
if (stepsDiv && !globalThis.__ingySynthStepsBuilt) {
    globalThis.__ingySynthStepsBuilt = true;
    for (let i = 0; i < 32; i++) {
        const stepDiv = document.createElement('fieldset');
        stepDiv.className = 'sequencer-step';
        stepDiv.dataset.step = i;
        stepDiv.innerHTML = `
        <legend>Step ${i + 1}</legend>
        <input type="range" class="step-tune" data-step="${i}" min="-39" max="48" value="0">
        <span class="step-value">0</span>
        <input type="range" class="step-fine" data-step="${i}" min="-100" max="100" value="0">
        <span class="step-fine-value">0&cent;</span>
        <div class="step-buttons">
            <div class="step-buttons-row">
                <button class="pushable step-accent off" data-step="${i}">
                    <span class="front">Accent</span>
                </button>
                <button class="pushable step-slide off" data-step="${i}">
                    <span class="front">Slide</span>
                </button>
            </div>
            <div class="step-buttons-row">
                <button class="pushable step-ratch off" data-step="${i}" data-ratch="1" aria-pressed="false">
                    <span class="front">Ratch</span>
                </button>
            </div>
            <div class="step-buttons-row">
                <button class="pushable step-toggle" data-step="${i}">
                    <span class="front">On</span>
                </button>
            </div>
        </div>
    `;
        stepsDiv.appendChild(stepDiv);
    }
}

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

// Note preview shared by the tune and fine sliders
function previewStepNote(step) {
    const totalTune = getStepTotalTune(step);
    const cents = getStepFineCents(step);

    // Preview the note in the visualizer
    updateNoteVisualizer(totalTune, cents);

    // Set a flag to indicate we're in preview mode
    window.noteVisualizerPreviewActive = true;

    // Clear any existing timeout
    if (window.noteVisualizerPreviewTimeout) {
        clearTimeout(window.noteVisualizerPreviewTimeout);
    }

    // Set timeout to clear preview mode after 2 seconds
    window.noteVisualizerPreviewTimeout = setTimeout(() => {
        window.noteVisualizerPreviewActive = false;

        // If playing or arping, show the current playing note
        if (state.isPlaying || state.isArping) {
            updateNoteVisualizer(getStepTotalTune(state.currentStep), getStepFineCents(state.currentStep));
        } else {
            clearNoteVisualizer();
        }
    }, 2000); // 2 seconds delay
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
}) {
    if (state.acidMode) {
        scheduleAcidFilterEnvelope({
            startTime,
            stepDuration,
            slideThisStep,
            nextStepWillSlide,
            accentThisStep,
            accentAmount,
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
    if (!slideThisStep && typeof gainParam.cancelAndHoldAtTime === 'function') {
        try {
            gainParam.cancelAndHoldAtTime(t0);
            heldAtBoundary = true;
        } catch (_) { /* fall through */ }
    }
    if (!heldAtBoundary) gainParam.cancelScheduledValues(t0);

    if (slideThisStep) {
        if (!nextStepWillSlide) {
            const releaseStart = Math.min(
                stepEnd - 0.005,
                Math.max(stepEnd - Math.min(releaseTime, stepDuration - 0.01) - 0.001, stepEnd - releaseTime - 0.001)
            );
            const effectiveRelease = Math.min(releaseTime, Math.max(0.005, stepEnd - releaseStart - 0.001));
            gainParam.setValueAtTime(Math.max(minValue, sustain), releaseStart);
            gainParam.exponentialRampToValueAtTime(minValue, releaseStart + effectiveRelease);
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

    // Soft retrigger from the held boundary value (no stale-.value pinning)
    let attackStart = t0;
    const closeT = Math.max(cutModHot ? 0.008 : 0.004, qFloor * 0.6);
    if (!heldAtBoundary) {
        const cur = Math.max(minValue, Number(gainParam.value) || minValue);
        gainParam.setValueAtTime(cur, t0);
    }
    gainParam.linearRampToValueAtTime(minValue, t0 + closeT);
    attackStart = t0 + closeT;
    gainParam.linearRampToValueAtTime(1, attackStart + safeAttackTime);

    const decayEnd = attackStart + safeAttackTime + safeDecayTime;
    gainParam.linearRampToValueAtTime(sustain, decayEnd);

    if (nextStepWillSlide) {
        state.filterEnvelopeHeld = true;
        return;
    }

    const gateEnd = t0 + gateWindow;
    const releaseStart = Math.min(
        hardEnd - 0.005,
        Math.max(decayEnd + 0.01, gateEnd)
    );
    const effectiveRelease = Math.min(releaseTime, Math.max(0.005, hardEnd - releaseStart - 0.001));

    gainParam.setValueAtTime(Math.max(minValue, sustain), releaseStart);
    gainParam.exponentialRampToValueAtTime(minValue, releaseStart + effectiveRelease);
    state.filterEnvelopeHeld = false;
}

// Schedule the per-step amp envelope. Release is clamped so it always finishes
// before the next step; otherwise a long release keeps pulling gain down through
// the following step's attack (especially noticeable on Safari).
function scheduleStepEnvelope({
    startTime,
    stepDuration,
    slideThisStep,
    nextStepWillSlide,
    accentThisStep,
    accentAmount,
    softRetrigger = false,
    releaseUntil = null,
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
    const useSoftRetrigger = !slideThisStep && (softRetrigger || (darkOsc && clickRisk > 0.25));

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
    if (useSoftRetrigger && typeof state.envelope.gain.cancelAndHoldAtTime === 'function') {
        try {
            state.envelope.gain.cancelAndHoldAtTime(t0);
            heldAtBoundary = true;
        } catch (_) { /* fall through to cancel below */ }
    }
    if (!heldAtBoundary) state.envelope.gain.cancelScheduledValues(t0);

    if (slideThisStep) {
        if (!nextStepWillSlide) {
            const releaseStart = Math.min(
                hardEnd - 0.005,
                Math.max(hardEnd - Math.min(safeReleaseTime, stepDuration - 0.01) - 0.001, hardEnd - safeReleaseTime - 0.001)
            );
            const effectiveRelease = Math.min(safeReleaseTime, Math.max(0.005, hardEnd - releaseStart - 0.001));
            state.envelope.gain.setValueAtTime(Math.max(minValue, sustain), releaseStart);
            state.envelope.gain.exponentialRampToValueAtTime(minValue, releaseStart + effectiveRelease);
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

    let attackStart = t0;
    if (useSoftRetrigger) {
        // Soft re-articulate without hard duck when click-risk is high
        const berlinStyle = darkOsc && clickRisk > 0.25;
        if (!heldAtBoundary) {
            const cur = Math.max(minValue, Number(state.envelope.gain.value) || minValue);
            state.envelope.gain.setValueAtTime(cur, t0);
        }
        if (berlinStyle) {
            // Mid-note re-articulation keeps the quick 12ms ramp, but after a
            // gap the env sits at ~0 and a 12ms 0→1 swing pings a high-Q
            // filter (logs: SOFT envVal≈0 only on gapped patterns). Starting
            // from silence gets the full risk-stretched attack instead.
            const curEnv = Number(state.envelope.gain.value) || 0;
            const rampLen = curEnv < 0.2 ? safeAttackTime : Math.min(0.012, safeAttackTime);
            // From silence, cancelAndHold leaves NO anchor (automation already
            // finished), so the ramp interpolates from the release that ended
            // mid-gap — env swells BEFORE the step and the osc swap at step
            // start is audible through the filter (logs: PROBE rising at dt<0).
            if (curEnv < 0.2) state.envelope.gain.setValueAtTime(Math.max(minValue, curEnv), t0);
            state.envelope.gain.linearRampToValueAtTime(ampPeak, t0 + rampLen);
            attackStart = t0;
        } else {
            const closeT = darkOsc ? Math.max(0.006, 0.004 + clickRisk * 0.01) : 0.004;
            state.envelope.gain.linearRampToValueAtTime(minValue, t0 + closeT);
            attackStart = t0 + closeT;
            state.envelope.gain.linearRampToValueAtTime(ampPeak, attackStart + safeAttackTime);
        }
    } else {
        // Hard retrigger from silence so attack is audible even after a long release
        state.envelope.gain.setValueAtTime(0, t0);
        state.envelope.gain.linearRampToValueAtTime(ampPeak, t0 + safeAttackTime);
    }

    const decayEnd = attackStart + safeAttackTime + safeDecayTime;
    state.envelope.gain.linearRampToValueAtTime(Math.max(minValue, ampSustain), decayEnd);

    if (nextStepWillSlide) {
        state.envelopeHeld = true;
        return safeAttackTime;
    }

    const gateEnd = t0 + gateWindow;
    const darkGateEnd = releaseFloor > 0
        ? Math.min(gateEnd, hardEnd - releaseFloor - 0.002)
        : gateEnd;
    const releaseStart = Math.min(
        hardEnd - 0.005,
        Math.max(decayEnd + 0.01, darkGateEnd)
    );
    const effectiveRelease = Math.min(safeReleaseTime, Math.max(0.005, hardEnd - releaseStart - 0.001));

    state.envelope.gain.setValueAtTime(Math.max(minValue, ampSustain), releaseStart);
    state.envelope.gain.exponentialRampToValueAtTime(minValue, releaseStart + effectiveRelease);
    state.envelopeHeld = false;
    return safeAttackTime;
}

/** Keep the shared VCA shut so independent ratch voices own the amp path. */
function silenceMainEnvelope(atTime) {
    if (!state.envelope) return;
    const t = Math.max(state.audioContext.currentTime, atTime);
    // Drum models may still have the shared VCA open after empty steps
    // (off = no trigger, not mute). Soft-close before ratch private voices take over.
    const drumHold = !!(
        state.osc4Wavetable
        && state.oscStates?.[OSC4_INDEX]
        && DRUM_ENGINES.has(state.osc4Model)
    );
    const cur = Math.max(0.00001, Number(state.envelope.gain.value) || 0.00001);
    state.envelope.gain.cancelScheduledValues(t);
    if (drumHold && cur > 0.001) {
        state.envelope.gain.setValueAtTime(cur, t);
        state.envelope.gain.exponentialRampToValueAtTime(0.00001, t + 0.1);
    } else {
        state.envelope.gain.setValueAtTime(0, t);
    }
    state.envelopeHeld = false;
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

function ratchFilterSnapshot(accentThisStep, accentAmount) {
    const cutoff = Math.max(40, getNumber('cutoff', 1000));
    const q = Math.max(0.0001, getNumber('resonance', 1));
    const highPass = Math.max(20, getNumber('highPass', 20));
    const hpQ = state.highPassFilter?.Q?.value ?? 0.7;
    // Mild accent bump so Acc still reads on independent voices
    const boost = accentThisStep ? 1 + 0.35 * accentAmount : 1;
    return {
        cutoff: Math.min(12000, cutoff * boost),
        q: Math.min(20, q * (accentThisStep ? 1 + 0.15 * accentAmount : 1)),
        highPass: Math.min(2000, highPass),
        hpQ: Math.max(0.0001, Number(hpQ) || 0.7),
    };
}

/**
 * Self-contained ratch voice: own oscs + per-step noise + LP/HP snapshot + amp → distortion.
 * Lives until its envelope ends — next step cannot retune/stop it.
 *
 * @param {object} opts
 * @param {(oscIndex: number) => number} opts.freqForOsc  base Hz at hit start
 * @param {(oscIndex: number) => number} [opts.nextFreqForOsc]  gliss target Hz
 */
function spawnRatchVoice({
    startTime,
    stepDuration,
    accentThisStep,
    accentAmount,
    peakScale,
    glissRoll = false,
    freqForOsc,
    nextFreqForOsc = null,
}) {
    const ctx = state.audioContext;
    if (!ctx || !state.distortion || typeof freqForOsc !== 'function') return;

    const mix = ctx.createGain();
    mix.gain.value = 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    const snap = ratchFilterSnapshot(accentThisStep, accentAmount);
    filter.frequency.value = snap.cutoff;
    filter.Q.value = snap.q;
    highPass.frequency.value = snap.highPass;
    highPass.Q.value = snap.hpQ;
    const amp = ctx.createGain();
    amp.gain.value = 0;

    // Match main chain order: LP → HP → amp (VCA) → distortion
    mix.connect(filter);
    filter.connect(highPass);
    highPass.connect(amp);
    amp.connect(state.distortion);

    const oscs = [];
    const oscCount = state.oscStates?.length || 0;
    for (let i = 0; i < oscCount; i++) {
        if (!state.oscStates[i]) continue;
        const wave = getOscType(i);
        const vol = getOscVol(i);
        if (!(vol > 0.0001)) continue;

        const fromHz = Math.max(20, bentFrequency(freqForOsc(i)));
        const osc = createOscSource(ctx, {
            oscIndex: i,
            wave,
            frequency: fromHz,
        });
        osc.frequency.setValueAtTime(fromHz, Math.max(ctx.currentTime, startTime));
        if (glissRoll && typeof nextFreqForOsc === 'function') {
            const toHz = Math.max(20, bentFrequency(nextFreqForOsc(i)));
            try {
                osc.frequency.linearRampToValueAtTime(toHz, startTime + stepDuration);
            } catch (_) { /* ignore */ }
        }

        const g = ctx.createGain();
        g.gain.value = 0;
        // Private panner — overlapping ratches can't share state.oscPanners
        const panNode = ctx.createStereoPanner();
        panNode.pan.value = readOscPanValue(i);
        osc.connect(g);
        g.connect(panNode);
        panNode.connect(mix);
        const tHit = Math.max(ctx.currentTime, startTime);
        const oscStart = osc.isWavetable
            ? tHit
            : Math.max(ctx.currentTime, startTime - 0.002);
        softStartVoiceGain(g.gain, vol, Math.max(tHit, oscStart), {
            wavetable: !!osc.isWavetable,
            triggered: !!osc.isTriggered,
        });
        osc.start(oscStart);
        oscs.push({ osc, gain: g });
    }

    // Per-step noise: same treatment as a normal step hit, gated by this voice's amp
    let noiseSource = null;
    let noiseGain = null;
    const noiseVol = state.noiseState
        ? getNumber('noiseVol', 0)
        : 0;
    if (noiseVol > 0.0001 && state.noiseBuffers) {
        const noiseType = getString('noiseType', 'white');
        const buf = state.noiseBuffers[noiseType] || state.noiseBuffers.white;
        if (buf) {
            noiseSource = ctx.createBufferSource();
            noiseSource.buffer = buf;
            noiseSource.loop = true;
            noiseGain = ctx.createGain();
            noiseGain.gain.value = noiseVol;
            noiseSource.connect(noiseGain);
            noiseGain.connect(mix);
            const nStart = Math.max(ctx.currentTime, startTime - 0.002);
            try { noiseSource.start(nStart); } catch (_) { /* ignore */ }
        }
    }

    if (oscs.length === 0 && !noiseSource) {
        try { mix.disconnect(); } catch (_) { /* ignore */ }
        try { filter.disconnect(); } catch (_) { /* ignore */ }
        try { highPass.disconnect(); } catch (_) { /* ignore */ }
        try { amp.disconnect(); } catch (_) { /* ignore */ }
        return;
    }

    const doneAt = scheduleFullNoteOnGain(amp.gain, {
        startTime,
        stepDuration,
        accentThisStep,
        accentAmount,
        peakScale,
        holdForDrum: true,
    });

    const voice = { oscs, noiseSource, noiseGain, mix, filter, highPass, amp };
    if (!Array.isArray(state.ratchVoices)) state.ratchVoices = [];
    state.ratchVoices.push(voice);

    const generation = state.playGeneration;
    const delay = Math.max(0, (doneAt - ctx.currentTime) * 1000) + 40;
    setTimeout(() => {
        if (generation !== state.playGeneration) return;
        disposeRatchVoice(voice);
    }, delay);
}

function disposeRatchVoice(voice) {
    if (!voice) return;
    const t = state.audioContext?.currentTime ?? 0;
    const ampVal = Number(voice.amp?.gain?.value) || 0;
    const ampSilent = ampVal < 0.002;
    voice.oscs?.forEach(({ osc, gain }) => {
        try {
            if (gain) {
                gain.gain.cancelScheduledValues(t);
                // If the voice amp already rang out, don't hard-zero the osc
                // gain into a live filter — that was the off-step click.
                if (!ampSilent) {
                    gain.gain.setValueAtTime(Math.max(0.00001, Number(gain.gain.value) || 0.00001), t);
                    gain.gain.exponentialRampToValueAtTime(0.00001, t + 0.02);
                } else {
                    gain.gain.setValueAtTime(0, t);
                }
            }
            if (osc?.isTriggered) {
                osc.stop(t + 0.01, { hard: true, silent: true, fadeSec: ampSilent ? 0.02 : 0.05 });
            } else {
                osc.stop(t + 0.01);
            }
            if (ampSilent) {
                osc.disconnect();
                gain?.disconnect();
            } else {
                setTimeout(() => {
                    try { osc.disconnect(); } catch (_) { /* ignore */ }
                    try { gain?.disconnect(); } catch (_) { /* ignore */ }
                }, 40);
            }
        } catch (_) { /* ignore */ }
    });
    if (voice.noiseSource) {
        try {
            voice.noiseGain?.gain.cancelScheduledValues(t);
            voice.noiseGain?.gain.setValueAtTime(0, t);
            voice.noiseSource.stop(t + 0.01);
            voice.noiseSource.disconnect();
            voice.noiseGain?.disconnect();
        } catch (_) { /* ignore */ }
    }
    try { voice.amp?.disconnect(); } catch (_) { /* ignore */ }
    try { voice.highPass?.disconnect(); } catch (_) { /* ignore */ }
    try { voice.filter?.disconnect(); } catch (_) { /* ignore */ }
    try { voice.mix?.disconnect(); } catch (_) { /* ignore */ }
    if (Array.isArray(state.ratchVoices)) {
        state.ratchVoices = state.ratchVoices.filter((v) => v !== voice);
    }
}

/** Fade and drop any lingering independent ratch voices (stop / mode change). */
function releaseRatchVoices(now) {
    const list = state.ratchVoices;
    if (!Array.isArray(list) || list.length === 0) {
        state.ratchVoices = [];
        return;
    }
    const t = now ?? state.audioContext?.currentTime ?? 0;
    list.forEach((voice) => {
        try {
            voice.amp?.gain.cancelScheduledValues(t);
            voice.amp?.gain.setValueAtTime(Math.max(0.00001, voice.amp.gain.value || 0.00001), t);
            voice.amp?.gain.exponentialRampToValueAtTime(0.00001, t + 0.05);
        } catch (_) { /* ignore */ }
        setTimeout(() => disposeRatchVoice(voice), 70);
    });
    state.ratchVoices = [];
}

/**
 * Fire N independent full-note voices on the ratchet grid.
 * Each voice has its own oscs + amp and outlives the next sequencer step.
 */
function scheduleParallelRatchHits({
    startTime,
    stepDuration,
    hits,
    accentThisStep,
    accentAmount,
    glissRoll = false,
    freqForOsc,
    nextFreqForOsc = null,
}) {
    silenceMainEnvelope(startTime);
    silenceMainPhaseResetOscs(startTime);
    const peakScale = 1 / Math.sqrt(hits);
    const subDur = stepDuration / hits;

    // Remember pitch for a possible slide into the following main-path step
    if (typeof freqForOsc === 'function' && state.oscStates) {
        for (let i = 0; i < state.oscStates.length; i++) {
            if (!state.oscStates[i]) continue;
            const endFreq = glissRoll && typeof nextFreqForOsc === 'function'
                ? nextFreqForOsc(i)
                : freqForOsc(i);
            state.lastStepFreqs[i] = endFreq;
        }
    }

    for (let k = 0; k < hits; k++) {
        spawnRatchVoice({
            startTime: startTime + k * subDur,
            stepDuration,
            accentThisStep,
            accentAmount,
            peakScale,
            glissRoll,
            freqForOsc,
            nextFreqForOsc,
        });
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
    releaseRatchVoices(now);
    releaseBerlinOscVoices(now);

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
    return !document.getElementById('scaleToggle')?.classList.contains('off');
}

function setKeyboardStepDigits(pair, { lit = true, label = '', brand = false, cyan = false } = {}) {
    const el = document.getElementById('kbStepDisplay');
    if (!el) return;
    const text = String(pair).padEnd(2, ' ').slice(0, 2);
    el.dataset.value = text;
    if (label) el.setAttribute('aria-label', label);
    const digits = el.querySelectorAll('.sixteen-seg');
    applyVfdChar(digits[0], text[0], { brand });
    applyVfdChar(digits[1], text[1], { brand });
    el.classList.toggle('lit', lit);
    // Cyan = Write / Arp / Scale prompts & write cursor; green = playback & brand
    el.classList.toggle('vfd-cyan', !!cyan);
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

function updateKeyboardStepDisplay(stepIndex) {
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
    setKeyboardStepDigits(text, { lit: true, label: `Step ${text}`, cyan: false });
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
    setKeyboardStepDigits(text, { lit: true, label: `Steps ${text}` });
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

function togglePlay() {
    if (!state.audioContext) return;

    // Safari (and other browsers) can suspend the context after idle time;
    // resume on every Start/Stop click so scheduled audio actually renders.
    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
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
        forceNoteOff();
        document.dispatchEvent(new CustomEvent('ingysynth:sequencer-start'));

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
        // Every Berlin row restarts from its own beginning on the same downbeat
        if (isBerlinOn()) {
            resetBerlinPlayheads(state.nextStepTime);
            notifyAutomationLoopAnchor(state.nextStepTime);
        }
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
        state.playGeneration += 1;
        clearStopCleanup();

        // Show logo again when stopping, but with a delay
        showLogoOverlay(1500);
        
        stopActiveVoices(state.audioContext.currentTime);
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
        clearBerlinStepActive();
        // Idle note matrix: "Note" (cyan knob preview can override while stopped)
        window.noteVisualizerPreviewActive = false;
        if (window.noteVisualizerPreviewTimeout) {
            clearTimeout(window.noteVisualizerPreviewTimeout);
            window.noteVisualizerPreviewTimeout = null;
        }
        clearNoteVisualizer();
    }
}

function scheduleNextStep() {
    if (!state.isPlaying || !state.audioContext) return;

    if (isBerlinOn()) {
        scheduleBerlinSteps();
        setTimeout(scheduleNextStep, 25);
        return;
    }

    const tempo = getNumber('tempo');
    const division = getNumber('division');
    const bps = 60 / tempo;
    const stepDuration = bps * (4 / division);
    
    // Look ahead by 100ms to ensure smooth scheduling
    const lookAheadTime = 0.1; // 100ms
    
    // Schedule notes in the next scheduling window
    while (state.nextStepTime < state.audioContext.currentTime + lookAheadTime) {
        // Schedule this step
        playStep(
            state.currentStep,
            state.nextStepTime,
            stepDuration,
            snapshotStepNeighborhood(state.currentStep, getNumber('stepCount', 8), state.isReverse),
        );

        // Re-read: an armed bank switch can swap pattern length mid-window
        const stepCount = getNumber('stepCount', 8);

        // Advance to next step
        if (state.isReverse) {
            state.currentStep = (state.currentStep - 1 + stepCount) % stepCount;
        } else {
            state.currentStep = (state.currentStep + 1) % stepCount;
        }
        
        // Calculate time for next step
        state.nextStepTime += stepDuration;
    }

    // Use setTimeout with lookahead for better timing stability
    const timeUntilNextSchedule = 25; // ms
    setTimeout(scheduleNextStep, timeUntilNextSchedule);
}

// --- Berlin Dream-960: one clock, eight independent lanes ---------------------

const BERLIN_LOOKAHEAD = 0.1;

/** Highlights land at audio time, not schedule time. */
function scheduleBerlinHighlight(row, step, atTime, syncKeyboard) {
    const generation = state.playGeneration;
    const delay = Math.max(0, (atTime - state.audioContext.currentTime) * 1000);
    setTimeout(() => {
        if (!state.berlinMode || !state.isPlaying || generation !== state.playGeneration) return;
        setBerlinStepActive(row, step);
        if (syncKeyboard) updateKeyboardStepDisplay(step);
    }, delay);
}

function disposeBerlinOscVoice(voice) {
    if (!voice) return;
    const t = state.audioContext?.currentTime ?? 0;
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

function disarmBerlinSharedAmpPath(atTime) {
    if (!state.berlinSharedPathArmed) return;
    const ctx = state.audioContext;
    const t = Math.max(ctx?.currentTime ?? 0, atTime ?? 0);
    state.berlinSharedPathArmed = false;

    state.oscGains?.forEach((g, i) => {
        const vol = getOscVol(i);
        const on = !!state.oscStates?.[i];
        try {
            g.gain.cancelScheduledValues(t);
            g.gain.setValueAtTime(on && Number.isFinite(vol) ? vol : 0, t);
        } catch (_) { /* ignore */ }
    });
    if (state.noiseGain) {
        const nv = state.noiseState
            ? (getNumber('noiseVol', 0))
            : 0;
        try {
            state.noiseGain.gain.cancelScheduledValues(t);
            state.noiseGain.gain.setValueAtTime(nv, t);
        } catch (_) { /* ignore */ }
    }
    if (state.envelope) {
        try {
            state.envelope.gain.cancelScheduledValues(t);
            state.envelope.gain.setValueAtTime(0, t);
            state.envelopeHeld = false;
        } catch (_) { /* ignore */ }
    }
}

/** Fade and drop Berlin per-osc voices (optionally one osc index only). */
function releaseBerlinOscVoices(now, oscIndex = null) {
    const list = state.berlinOscVoices;
    if (!Array.isArray(list) || list.length === 0) {
        state.berlinOscVoices = [];
        if (oscIndex === null) disarmBerlinSharedAmpPath(now);
        return;
    }
    const t = now ?? state.audioContext?.currentTime ?? 0;
    const victims = oscIndex === null
        ? [...list]
        : list.filter((v) => v.oscIndex === oscIndex);
    victims.forEach((voice) => {
        try {
            voice.amp?.gain.cancelScheduledValues(t);
            voice.amp?.gain.setValueAtTime(Math.max(0.00001, voice.amp.gain.value || 0.00001), t);
            voice.amp?.gain.exponentialRampToValueAtTime(0.00001, t + 0.05);
        } catch (_) { /* ignore */ }
        setTimeout(() => disposeBerlinOscVoice(voice), 70);
    });
    if (oscIndex === null) {
        state.berlinOscVoices = [];
        disarmBerlinSharedAmpPath(t);
    } else {
        state.berlinOscVoices = list.filter((v) => v.oscIndex !== oscIndex);
        if (state.berlinOscVoices.length === 0) disarmBerlinSharedAmpPath(t);
    }
}

/**
 * Independent Berlin osc voice: unison stack → amp → shared ring/filter/HP → open envelope → dist.
 * Lane Gate sets note length; global Gate is ignored. Mod-lane CV hits the shared filter.
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
    const ctx = state.audioContext;
    const dest = state.ringModInput || state.filterInputPad || state.filter;
    if (!ctx || !dest) return;
    if (!state.oscStates?.[oscIndex]) return;

    const wave = getOscType(oscIndex);
    const vol = getOscVol(oscIndex);
    if (!(vol > 0.0001)) return;

    armBerlinSharedAmpPath(startTime);
    silenceMainPhaseResetOscs(startTime);

    const mix = ctx.createGain();
    mix.gain.value = 1;
    const amp = ctx.createGain();
    amp.gain.value = 0;

    mix.connect(amp);
    // Per-OSC pan (digital + analog). Shared panner sums concurrent lane voices.
    const panner = state.oscPanners?.[oscIndex];
    amp.connect(panner || dest);

    const n = getUnisonVoices();
    const spread = getUnisonSpread();
    const voiceVol = vol / n;
    const t0 = Math.max(ctx.currentTime, startTime);
    const slideFromBase = (slideIn && state.lastStepFreqs?.[oscIndex] > 0)
        ? state.lastStepFreqs[oscIndex]
        : null;
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
        });
        const targetHz = voiceTargetFreq({ unisonCents: cents }, fromHz);
        if (slideFromBase != null) {
            const slideFrom = voiceTargetFreq({ unisonCents: cents }, slideFromBase);
            osc.frequency.setValueAtTime(slideFrom, t0);
            try {
                osc.frequency.setTargetAtTime(targetHz, t0, Math.max(0.01, slideTime) / 3);
            } catch (_) {
                osc.frequency.setValueAtTime(targetHz, t0);
            }
        } else {
            osc.frequency.setValueAtTime(targetHz, t0);
        }
        if (glissRoll && toHz != null) {
            try {
                const endHz = voiceTargetFreq({ unisonCents: cents }, toHz);
                osc.frequency.cancelScheduledValues(t0);
                osc.frequency.setValueAtTime(targetHz, t0);
                osc.frequency.linearRampToValueAtTime(endHz, startTime + stepDuration);
            } catch (_) { /* ignore */ }
        }

        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(mix);
        // Align WT with amp envelope — early start + full voiceVol clicked into high-Q filter
        const oscStart = osc.isWavetable
            ? t0
            : Math.max(ctx.currentTime, startTime - 0.002);
        softStartVoiceGain(g.gain, voiceVol, Math.max(t0, oscStart), {
            wavetable: !!osc.isWavetable,
            triggered: !!osc.isTriggered,
        });
        osc.start(oscStart);
        if (lfoGain) {
            try { lfoGain.connect(osc.detune); } catch (_) { /* ignore */ }
        }
        oscs.push({ osc, gain: g, unisonCents: cents });
    }

    // Keep shared panner in sync for this lane (live pan while Berlin runs)
    if (panner) {
        try {
            panner.pan.setValueAtTime(readOscPanValue(oscIndex), t0);
        } catch (_) { /* ignore */ }
    }


    const doneAt = scheduleFullNoteOnGain(amp.gain, {
        startTime,
        stepDuration,
        accentThisStep,
        accentAmount,
        peakScale,
        gateLen,
    });

    const voice = {
        oscIndex,
        oscs,
        mix,
        amp,
    };
    if (!Array.isArray(state.berlinOscVoices)) state.berlinOscVoices = [];
    state.berlinOscVoices.push(voice);

    const generation = state.playGeneration;
    const delay = Math.max(0, (doneAt - ctx.currentTime) * 1000) + 40;
    setTimeout(() => {
        if (generation !== state.playGeneration) return;
        disposeBerlinOscVoice(voice);
        if (!state.berlinOscVoices?.length) disarmBerlinSharedAmpPath(ctx.currentTime);
    }, delay);
}

/** Fire one osc lane: independent amp voice(s) for that oscillator only. */
function triggerBerlinOscLane(row, pattern, startTime, stepDuration, data, playhead, nextPitch) {
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
    const peakScale = 1 / Math.sqrt(hits);
    const subDur = stepDuration / hits;

    armBerlinSharedAmpPath(startTime);
    silenceMainPhaseResetOscs(startTime);

    const slideTime = getSlideTime();
    for (let k = 0; k < hits; k++) {
        spawnBerlinOscVoice({
            oscIndex,
            startTime: startTime + k * subDur,
            stepDuration,
            gateLen,
            accentThisStep,
            accentAmount,
            peakScale,
            glissRoll,
            slideIn: hits === 1 && slideIn,
            slideTime,
            fromHz,
            toHz: glissRoll ? toHz : null,
        });
    }
    // Update after spawn so slide-in can read the previous step's pitch
    state.lastStepFreqs[oscIndex] = glissRoll ? toHz : fromHz;

    // Shared filter env on every On (same as normal playStep). Env-On closes
    // the cutoff floor — without this, non-accent Berlin notes stay silent.
    const slideOut = !!data.slide && !glissRoll;
    const adjustedStartTime = Math.max(state.audioContext.currentTime, startTime);
    scheduleStepFilterEnvelope({
        startTime: adjustedStartTime,
        stepDuration,
        slideThisStep: slideIn,
        nextStepWillSlide: slideOut,
        accentThisStep,
        accentAmount,
        gateLen,
    });
}

function berlinNextStepIndex(pattern, step) {
    const n = Math.max(1, Math.round(pattern?.stepCount) || 8);
    return pattern.reverse ? (step - 1 + n) % n : (step + 1) % n;
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
        // Rest: do not spawn; prior independent voices ring out on their own Gate
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

function scheduleBerlinSteps() {
    const ctx = state.audioContext;
    const tempo = getNumber('tempo', 120);
    ensurePlayheads();

    // Automation follows the longest active row, time-wise
    const loopSeconds = masterLoopSeconds(tempo);
    if (loopSeconds > 0.01) {
        if (state.berlinLoopAnchor < ctx.currentTime - loopSeconds * 64) {
            state.berlinLoopAnchor = ctx.currentTime;
        }
        let guard = 0;
        while (state.berlinLoopAnchor + loopSeconds < ctx.currentTime + BERLIN_LOOKAHEAD && guard++ < 64) {
            state.berlinLoopAnchor += loopSeconds;
            notifyAutomationLoopAnchor(state.berlinLoopAnchor);
            document.dispatchEvent(new CustomEvent('ingysynth:loop-start', {
                detail: { startTime: state.berlinLoopAnchor },
            }));
        }
    }

    const kbRow = keyboardHighlightRow();
    berlinActiveRows().forEach((row) => {
        const pattern = getPattern(row);
        const playhead = state.berlinPlayheads[row];
        const stepDuration = rowStepDuration(pattern, tempo);
        if (!(stepDuration > 0)) return;

        // A backgrounded tab can leave a playhead far behind — rejoin the clock
        if (playhead.nextStepTime < ctx.currentTime - 1) {
            playhead.nextStepTime = ctx.currentTime;
        }

        let guard = 0;
        while (playhead.nextStepTime < ctx.currentTime + BERLIN_LOOKAHEAD && guard++ < 64) {
            // Mute / Solo silence skips CV/pitch only — playhead keeps phase
            if (isRowSounding(row)) {
                fireBerlinRow(row, pattern, playhead, playhead.nextStepTime, stepDuration, row === kbRow);
            } else {
                scheduleBerlinHighlight(row, playhead.currentStep, playhead.nextStepTime, false);
            }
            advancePlayhead(row);
            playhead.nextStepTime += stepDuration;
        }
    });
}

// Osc lane muted / solo-silenced — release that osc's independent voices
document.addEventListener('ingysynth:berlin-osc-muted', (e) => {
    if (!state.berlinMode || !state.audioContext) return;
    const oscIndex = e.detail?.oscIndex;
    if (oscIndex === null || oscIndex === undefined) return;
    releaseBerlinOscVoices(state.audioContext.currentTime, oscIndex | 0);
});

document.addEventListener('ingysynth:berlin-mode', (e) => {
    if (e.detail?.on) {
        silenceMainPhaseResetOscs(state.audioContext?.currentTime ?? 0);
        // Shared path arms on first osc-lane hit so mod CV can reach the filter
        clearStepsPreviewTimer();
        showBerlinBdOnVfd();
    } else {
        releaseBerlinOscVoices(state.audioContext?.currentTime ?? 0);
        disarmBerlinSharedAmpPath(state.audioContext?.currentTime ?? 0);
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

    document.querySelectorAll('.sequencer-step').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.keyboard-step').forEach(el => el.classList.remove('active'));
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

    document.querySelectorAll('.sequencer-step').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.keyboard-step').forEach(el => el.classList.remove('active'));

    const sounding = cellSemitone + getGlobalTune();
    if (!window.noteVisualizerPreviewActive) {
        updateNoteVisualizer(sounding);
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

    document.querySelectorAll('.sequencer-step').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.keyboard-step').forEach(el => el.classList.remove('active'));

    const sounding = cellSemitone + getGlobalTune();
    if (!window.noteVisualizerPreviewActive) {
        updateNoteVisualizer(sounding);
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

    if (state.lfoState && state.lfoRetriggerState && state.lfo.started) {
        state.lfo.stop();
        state.lfo = state.audioContext.createOscillator();
        state.lfo.type = getString('lfoWaveform', 'sine');
        state.lfo.frequency.value = getLfoRateHz();
        if (state.lfoSmooth) {
            state.lfo.connect(state.lfoSmooth);
        } else if (state.lfoMasterGain) {
            state.lfo.connect(state.lfoMasterGain);
        } else {
            state.lfo.connect(state.lfoGainCutoff);
            state.lfo.connect(state.lfoGainResonance);
            state.lfo.connect(state.lfoGainHighpass);
            state.lfo.connect(state.lfoGainOsc1Pitch);
            state.lfo.connect(state.lfoGainOsc2Pitch);
            state.lfo.connect(state.lfoGainOsc3Pitch);
            if (state.lfoGainOsc4Pitch) state.lfo.connect(state.lfoGainOsc4Pitch);
        }
        state.lfo.start(startTime);
        state.lfo.started = true;
    }

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

function playStep(step, startTime, stepDuration, scheduled) {
    if (!state.isPlaying && !state.isArping) return;

    const snap = scheduled || snapshotStepNeighborhood(step, getNumber('stepCount', 8), state.isReverse);
    const data = snap.this;
    const prevData = snap.prev;
    const nextData = snap.next;
    const freqThis = (i) => frequencyFromStepData(data, i);
    const freqNext = (i) => frequencyFromStepData(nextData, i);

    // Anchor automation loop phase at the start of each pattern cycle
    const stepsN = getNumber('stepCount', 8);
    const isLoopStart = state.isReverse ? step === stepsN - 1 : step === 0;
    if (state.isPlaying && isLoopStart) {
        notifyAutomationLoopAnchor(startTime);
        // Bank switches land here so P1–P8 stays in time
        document.dispatchEvent(new CustomEvent('ingysynth:loop-start', { detail: { startTime } }));
    }

    updateKeyboardStepDisplay(step);

    document.querySelectorAll('.sequencer-step').forEach(stepEl => stepEl.classList.remove('active'));
    document.querySelectorAll('.keyboard-step').forEach(el => el.classList.remove('active'));

    if (data.on === false) {
        // Drum-machine model: an OFF step means "no new trigger", not "mute".
        // Self-enveloped drums (and their ratch voices) must keep ringing through
        // empty steps; the next note-on / ratch hit is what resets them.
        // HEAD only released a held shared VCA for stuck-note/slide guards —
        // never tore down oscs or ratch voices here.
        const drumVoice = !!(
            state.osc4Wavetable
            && state.oscStates?.[OSC4_INDEX]
            && DRUM_ENGINES.has(state.osc4Model)
        );
        if (state.envelopeHeld) {
            if (drumVoice) {
                // Keep shared VCA open so the kick/snare/hat can finish its
                // internal decay across empty steps. Clear the held flag so we
                // don't treat this as a stuck slide note.
                state.envelopeHeld = false;
            } else {
                const release = getNumber('release');
                const releaseTime = Math.max(0.005, release * 0.3);
                const t = Math.max(state.audioContext.currentTime, startTime);
                state.envelope.gain.cancelScheduledValues(t);
                state.envelope.gain.setValueAtTime(state.envelope.gain.value || 0.00001, t);
                state.envelope.gain.exponentialRampToValueAtTime(0.00001, t + releaseTime);
                state.envelopeHeld = false;
            }
        }
        if (state.filterEnvelopeHeld) {
            const filterRelease = getNumber('filterRelease');
            const filterReleaseTime = Math.max(0.005, filterRelease * 0.3);
            const t = Math.max(state.audioContext.currentTime, startTime);
            state.filterEnvGain.gain.cancelScheduledValues(t);
            state.filterEnvGain.gain.setValueAtTime(state.filterEnvGain.gain.value || 0.00001, t);
            state.filterEnvGain.gain.exponentialRampToValueAtTime(0.00001, t + filterReleaseTime);
            state.filterEnvelopeHeld = false;
        }
        // Intentionally do NOT stop activeOscillators or duck ratchVoices.
        state.lastStepSounded = false;
        return;
    }

    const currentStepElement = document.querySelector(`.sequencer-step[data-step="${step}"]`);
    currentStepElement?.classList.add('active');
    const kbStep = document.querySelector(`.keyboard-step[data-step="${step}"]`);
    if (kbStep) kbStep.classList.add('active');

    // Slide (TB-303 + compat):
    // - Prefer Sld on step N = glide into N+1 (accent OK on N with Acc+Sld).
    // - Also accept Sld on the destination (older UI habit) so slides still work.
    // - Sld+RATCH (2–8) = gliss-roll: pitch glides this→next during this step.
    const slideFromPrev = !!prevData.slide;
    const slideOnThis = !!data.slide;
    const slideOnNext = nextData.on !== false && !!nextData.slide;
    const ratch = state.acidMode ? 1 : clampRatch(data.ratch);
    const glissRoll = ratch > 1 && slideOnThis;
    const prevWasGliss = slideFromPrev && clampRatch(prevData.ratch) > 1;
    // 303: arriving because previous step had Slide (not a finished gliss-roll)
    const isSlideContinuation = state.lastStepSounded && slideFromPrev && !prevWasGliss;
    // Compat: Sld only on destination (older habit) still pitch-glides — not gliss-roll source
    const isDestSlideCompat = state.lastStepSounded && slideOnThis && !slideFromPrev && !glissRoll;
    // Pitch ramp (both continuation + dest-compat); gliss-roll uses outbound ramp instead
    const slideThisStep = (isSlideContinuation || isDestSlideCompat) && !glissRoll;
    // MIDI / pitch overlap: source Slide or next marked as slide dest (gliss already arrives)
    const nextStepWillSlide = !glissRoll && nextData.on !== false && (slideOnThis || slideOnNext);
    // ACID envs: only true continuation skips retrigger; only source Slide holds into next
    const slideThisStepEnv = state.acidMode ? isSlideContinuation && !glissRoll : slideThisStep;
    const nextStepWillSlideEnv = state.acidMode
        ? (!glissRoll && nextData.on !== false && slideOnThis)
        : nextStepWillSlide;
    const slideTime = getSlideTime();
    const accentAmount = getAccentAmount();
    // Accent on Acc+Sld source steps (303). Only blank when arriving via prev's Slide.
    const accentThisStep = !!data.accent && !isSlideContinuation;
    const hits = clampRatch(ratch);
    const subDur = stepDuration / hits;

    // Get note information for the visualizer
    const totalTune = getStepTotalTuneFromRaw(data.tune);
    const fineCents = Math.round(Number(data.fine) || 0);

    // Only update the visualizer if we're not in preview mode
    if (!window.noteVisualizerPreviewActive) {
        // Update note visualizer
        updateNoteVisualizer(totalTune, fineCents);
    }

    // Send MIDI if enabled (static ratch / gliss: repeated gates at this step's note)
    if (state.sendMidiEnabled && state.selectedMidiOutput) {
        const safeNote = midiNoteFromStepData(data);
        const nextNote = midiNoteFromStepData(nextData);
        const bendRangeEl = document.getElementById('bendRange');
        const bendRange = bendRangeEl ? parseInt(bendRangeEl.value) : 2;
        const gateLen = getGateLength();
        const overlapForSlide = hits === 1 && nextStepWillSlide && nextNote !== safeNote;

        for (let k = 0; k < hits; k++) {
            const hitStart = startTime + k * subDur;
            // Full-note ratchets: each MIDI gate lasts a whole step (overlapping)
            const hitDur = hits === 1
                ? stepDuration * (overlapForSlide ? 1.1 : gateLen)
                : stepDuration * gateLen;
            const noteOnDelay = Math.max(0, (hitStart - state.audioContext.currentTime) * 1000);
            const noteOffDelay = Math.max(0, (hitStart + hitDur - state.audioContext.currentTime) * 1000);
            setTimeout(() => {
                if (k === 0 && fineCents !== state.lastSentBendCents) {
                    const bend = midiPitchBendValue(fineCents, bendRange);
                    state.selectedMidiOutput.send([0xE0 | (state.selectedMidiChannel - 1), bend & 0x7F, bend >> 7]);
                    state.lastSentBendCents = fineCents;
                }
                state.selectedMidiOutput.send([0x90 | (state.selectedMidiChannel - 1), safeNote, accentThisStep ? 127 : 100]);
            }, noteOnDelay);
            setTimeout(() => {
                state.selectedMidiOutput.send([0x80 | (state.selectedMidiChannel - 1), safeNote, 0]);
            }, noteOffDelay);
        }
    }

    // Independent ratch voices: own oscs + amp — skip main pitch/env path entirely
    if (hits > 1) {
        scheduleParallelRatchHits({
            startTime,
            stepDuration,
            hits,
            accentThisStep,
            accentAmount,
            glissRoll,
            freqForOsc: freqThis,
            nextFreqForOsc: glissRoll ? freqNext : null,
        });
        state.lastStepSounded = true;
        return;
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
        } else if (slideThisStep) {
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
                osc.frequency.cancelScheduledValues(startTime);
                osc.frequency.setTargetAtTime(freq, startTime, slideTime / 3);
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
            if (slideThisStep) {
                // Slide (303 RC slew): exponential approach from current pitch
                osc.frequency.cancelScheduledValues(startTime);
                osc.frequency.setTargetAtTime(freq, startTime, slideTime / 3);
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

    if (state.lfoState && state.lfoRetriggerState && state.lfo.started) {
        state.lfo.stop();
        state.lfo = state.audioContext.createOscillator();
        state.lfo.type = getString('lfoWaveform', 'sine');
        state.lfo.frequency.value = getLfoRateHz();
        // Reconnect into the smoothed LFO chain (smooth → master → depth gains)
        if (state.lfoSmooth) {
            state.lfo.connect(state.lfoSmooth);
        } else if (state.lfoMasterGain) {
            state.lfo.connect(state.lfoMasterGain);
        } else {
            state.lfo.connect(state.lfoGainCutoff);
            state.lfo.connect(state.lfoGainResonance);
            state.lfo.connect(state.lfoGainHighpass);
            state.lfo.connect(state.lfoGainOsc1Pitch);
            state.lfo.connect(state.lfoGainOsc2Pitch);
            state.lfo.connect(state.lfoGainOsc3Pitch);
            if (state.lfoGainOsc4Pitch) state.lfo.connect(state.lfoGainOsc4Pitch);
        }
        state.lfo.start(startTime);
        state.lfo.started = true;
    }

    const adjustedStartTime = Math.max(state.audioContext.currentTime, startTime);
    scheduleStepEnvelope({
        startTime,
        stepDuration,
        slideThisStep: slideThisStepEnv,
        nextStepWillSlide: nextStepWillSlideEnv,
        accentThisStep,
        accentAmount,
    });
    scheduleStepFilterEnvelope({
        startTime: adjustedStartTime,
        stepDuration,
        slideThisStep: slideThisStepEnv,
        nextStepWillSlide: nextStepWillSlideEnv,
        accentThisStep,
        accentAmount,
    });


    state.lastStepSounded = true;
}

// Bulk step changes (bank load, pattern shift, write mode) repaint the readouts
document.addEventListener('ingysynth-kb-steps-sync', () => {
    refreshStepTuneReadouts();
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
    scheduleNextStep,
    playStep,
    startIdleMarquee,
    startArp,
    stopArp,
    retuneArpTranspose,
};
