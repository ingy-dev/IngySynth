import { state } from './state.js?v=107';
import { semitonesToFrequency } from './tuning.js?v=74';
import { updateFilterCutoffRange, getFilterEnvAmount } from './filter-cutoff.js?v=78';
import { updateNoteVisualizer, clearNoteVisualizer, hideLogoOverlay, showLogoOverlay } from './visualizers.js?v=92';
import { bentFrequency } from './pitch-bend.js?v=76';
import { spawnOscStack, voiceTargetFreq, getUnisonVoices } from './unison.js?v=145';
import { fadeStopOsc, wtAttackSecForFilter, hasDarkOscActive } from './osc-source.js?v=66';
import {
    triggerAcidLiveAmp,
    triggerAcidLiveFilter,
    releaseAcidLiveEnvelopes,
    acidVegDecaySec,
} from './acid-env.js?v=8';

const RETUNE_RAMP = 0.012; // short glide — avoids zipper clicks on legato
/** Above this amp level, a new noteOn reuses the voice instead of hard restarting. */
const LEGATO_GAIN_FLOOR = 0.02;

function scaleAdsrTime(seconds) {
    return Math.max(0.002, seconds);
}

function ampEnvelopeLevel() {
    return Math.max(0, state.envelope?.gain?.value ?? 0);
}

function hasLivePhaseResetOscs() {
    return !!state.phaseResetEnabled && state.activeOscillators.some(osc => osc.started);
}

/**
 * Long release keeps phase-reset oscs alive after noteOff. Legato would only
 * retune them — so Unison On/Off or voice-count changes never take effect until
 * the release timeout. Require the live stack to match the current unison config.
 */
function liveStackMatchesUnisonConfig() {
    if (!state.phaseResetEnabled) return true;
    const expected = getUnisonVoices();
    const counts = new Map();
    for (const osc of state.activeOscillators) {
        if (!osc.started) continue;
        const i = osc.oscIndex;
        counts.set(i, (counts.get(i) || 0) + 1);
    }
    let any = false;
    for (let i = 0; i < state.oscStates.length; i++) {
        if (!state.oscStates[i]) continue;
        any = true;
        if ((counts.get(i) || 0) !== expected) return false;
    }
    return any;
}

function shouldLegatoRetrigger() {
    if (!(ampEnvelopeLevel() > LEGATO_GAIN_FLOOR || hasLivePhaseResetOscs())) return false;
    // Release tail still ringing with the wrong stack size → hard respawn
    if (state.phaseResetEnabled && !liveStackMatchesUnisonConfig()) return false;
    return true;
}

function stopLiveOscillators(now) {
    if (state.phaseResetEnabled) {
        state.activeOscillators.forEach((osc) => fadeStopOsc(osc, now + 0.03, { fadeSec: 0.03 }));
        state.activeOscillators = [];
    }
}

function spawnLiveOscillators(semitones, now, { legato = false } = {}) {
    if (!state.phaseResetEnabled) {
        if (legato) {
            setLiveFrequencies(semitones, now, RETUNE_RAMP);
            return;
        }
        state.oscillators.forEach((osc, i) => {
            const baseFreq = semitonesToFrequency(semitones, i);
            const freq = bentFrequency(baseFreq);
            osc.frequency.cancelScheduledValues(now);
            osc.frequency.setValueAtTime(freq, now);
            state.lastStepFreqs[i] = baseFreq;
        });
        return;
    }

    // Fast re-press while prior oscs still alive: retune instead of stop+spawn (clicks)
    if (legato && hasLivePhaseResetOscs()) {
        setLiveFrequencies(semitones, now, RETUNE_RAMP);
        return;
    }

    stopLiveOscillators(now);

    for (let i = 0; i < state.oscStates.length; i++) {
        if (!state.oscStates[i]) continue;
        const baseFreq = semitonesToFrequency(semitones, i);
        spawnOscStack(i, baseFreq, now, {
            oscStart: now,
            gainRampStart: now,
            gainRampEnd: now + 0.005,
        });
    }
}

function triggerLiveAmpEnvelope(now, { fromCurrent = false } = {}) {
    if (state.acidMode) {
        triggerAcidLiveAmp(now, { fromCurrent });
        return;
    }
    const attack = parseFloat(document.getElementById('attack').value);
    const decay = parseFloat(document.getElementById('decay').value);
    const sustain = parseFloat(document.getElementById('sustain').value);
    const darkOsc = hasDarkOscActive();
    const safeAttack = Math.max(
        darkOsc ? Math.max(0.008, wtAttackSecForFilter() * 0.55) : 0,
        scaleAdsrTime(attack)
    );
    const safeDecay = scaleAdsrTime(decay);
    const startLevel = fromCurrent
        ? Math.max(0.00001, ampEnvelopeLevel() || 0.00001)
        : 0;

    state.envelope.gain.cancelScheduledValues(now);
    state.envelope.gain.setValueAtTime(startLevel, now);
    state.envelope.gain.linearRampToValueAtTime(1, now + safeAttack);
    state.envelope.gain.linearRampToValueAtTime(sustain, now + safeAttack + safeDecay);
    state.envelopeHeld = true;
}

function triggerLiveFilterEnvelope(now, { fromCurrent = false } = {}) {
    if (state.acidMode) {
        triggerAcidLiveFilter(now, { fromCurrent });
        return;
    }
    if (!state.filterEnvGain || getFilterEnvAmount() === 0) return;

    const attack = parseFloat(document.getElementById('filterAttack').value);
    const decay = parseFloat(document.getElementById('filterDecay').value);
    const sustain = parseFloat(document.getElementById('filterSustain').value);
    const baseCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
    const cutModHot = state.lfoState
        && Math.abs(parseFloat(document.getElementById('cutoffMod')?.value) || 0) > 80
        && (Number(state.lfoAmount) || 0) > 0.02;
    const safeAttack = Math.max(cutModHot ? 0.01 : 0.002, scaleAdsrTime(attack));
    const safeDecay = scaleAdsrTime(decay);
    const minValue = 0.00001;
    const startLevel = fromCurrent
        ? Math.max(minValue, state.filterEnvGain.gain.value || minValue)
        : minValue;

    updateFilterCutoffRange(baseCutoff, now, 0.01);

    const gainParam = state.filterEnvGain.gain;
    gainParam.cancelScheduledValues(now);
    if (fromCurrent && startLevel > 0.06) {
        const closeT = cutModHot ? 0.008 : 0.004;
        gainParam.setValueAtTime(startLevel, now);
        gainParam.linearRampToValueAtTime(minValue, now + closeT);
        gainParam.linearRampToValueAtTime(1, now + closeT + safeAttack);
        gainParam.linearRampToValueAtTime(sustain, now + closeT + safeAttack + safeDecay);
    } else {
        gainParam.setValueAtTime(minValue, now);
        gainParam.linearRampToValueAtTime(1, now + safeAttack);
        gainParam.linearRampToValueAtTime(sustain, now + safeAttack + safeDecay);
    }
    state.filterEnvelopeHeld = true;
}

function releaseLiveEnvelopes(now) {
    if (state.acidMode) {
        releaseAcidLiveEnvelopes(now);
        if (state.phaseResetEnabled) {
            const generation = state.playGeneration;
            const releaseTime = Math.max(0.2, acidVegDecaySec() * 0.85);
            setTimeout(() => {
                if (state.isPlaying || state.isArping || state.keyboardVoiceActive || generation !== state.playGeneration) return;
                stopLiveOscillators(state.audioContext.currentTime);
            }, (releaseTime + 0.05) * 1000);
        }
        return;
    }
    const release = parseFloat(document.getElementById('release').value);
    const filterRelease = parseFloat(document.getElementById('filterRelease').value);
    const releaseTime = Math.max(0.02, release);
    const filterReleaseTime = Math.max(0.02, filterRelease);
    const minValue = 0.00001;

    state.envelope.gain.cancelScheduledValues(now);
    state.envelope.gain.setValueAtTime(Math.max(minValue, state.envelope.gain.value || minValue), now);
    state.envelope.gain.exponentialRampToValueAtTime(minValue, now + releaseTime);
    state.envelopeHeld = false;

    if (state.filterEnvGain) {
        const baseCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(
            Math.max(minValue, state.filterEnvGain.gain.value || minValue),
            now
        );
        state.filterEnvGain.gain.exponentialRampToValueAtTime(minValue, now + filterReleaseTime);
        updateFilterCutoffRange(baseCutoff, now, filterReleaseTime);
        state.filterEnvelopeHeld = false;
    }

    // Tear down phase-reset oscillators after release so they don't linger
    if (state.phaseResetEnabled) {
        const generation = state.playGeneration;
        setTimeout(() => {
            if (state.isPlaying || state.isArping || state.keyboardVoiceActive || generation !== state.playGeneration) return;
            stopLiveOscillators(state.audioContext.currentTime);
        }, (releaseTime + 0.05) * 1000);
    }
}

function setLiveFrequencies(semitones, now, ramp = 0) {
    const apply = (osc, i) => {
        const baseFreq = Math.max(20, semitonesToFrequency(semitones, i));
        const freq = voiceTargetFreq(osc, baseFreq);
        const prevBase = Math.max(20, state.lastStepFreqs[i] ?? baseFreq);
        const prev = voiceTargetFreq(osc, prevBase);
        osc.frequency.cancelScheduledValues(now);
        if (ramp > 0 && Math.abs(prev - freq) > 0.01) {
            osc.frequency.setValueAtTime(prev, now);
            osc.frequency.exponentialRampToValueAtTime(freq, now + ramp);
        } else {
            osc.frequency.setValueAtTime(freq, now);
        }
        state.lastStepFreqs[i] = baseFreq;
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

/** Start a monophonic live note (semitones from C4; caller applies global tune). */
export function noteOn(semitonesFromC) {
    if (!state.audioContext || state.isPlaying) return;

    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }

    const now = state.audioContext.currentTime;
    // Rapid re-press while prior note is still releasing: keep voice, avoid gain→0 click
    const legato = shouldLegatoRetrigger();

    state.keyboardVoiceActive = true;
    state.playGeneration += 1;

    hideLogoOverlay();
    document.dispatchEvent(new CustomEvent('ingysynth:live-note-on'));
    spawnLiveOscillators(semitonesFromC, now, { legato });
    triggerLiveAmpEnvelope(now, { fromCurrent: legato });
    triggerLiveFilterEnvelope(now, { fromCurrent: legato });
    updateNoteVisualizer(semitonesFromC);
}

/**
 * Change pitch of an already-held live note without retriggering envelopes.
 * Used when dragging across keys so each new key doesn't click.
 */
export function retuneNote(semitonesFromC) {
    if (!state.audioContext || state.isPlaying) return;
    if (!state.keyboardVoiceActive) {
        noteOn(semitonesFromC);
        return;
    }

    const now = state.audioContext.currentTime;
    setLiveFrequencies(semitonesFromC, now, RETUNE_RAMP);
    updateNoteVisualizer(semitonesFromC);
}

/** Release the live keyboard voice. */
export function noteOff() {
    if (!state.audioContext || !state.keyboardVoiceActive) return;
    if (state.isPlaying) {
        state.keyboardVoiceActive = false;
        return;
    }

    const now = state.audioContext.currentTime;
    state.keyboardVoiceActive = false;
    releaseLiveEnvelopes(now);
    document.dispatchEvent(new CustomEvent('ingysynth:live-note-off'));

    // Match sequencer stop: keep scope visible through the release tail
    const release = parseFloat(document.getElementById('release')?.value ?? '0.5');
    showLogoOverlay(Math.max(1500, (release + 0.1) * 1000));

    // Back to idle "Note" unless a knob preview is showing
    if (!state.isPlaying && !state.isArping && !window.noteVisualizerPreviewActive) {
        clearNoteVisualizer();
    }
}

/** Force-stop live voice immediately (e.g. when sequencer starts). */
export function forceNoteOff() {
    if (!state.audioContext) return;
    const wasActive = state.keyboardVoiceActive;
    state.keyboardVoiceActive = false;
    if (!wasActive) return;

    const now = state.audioContext.currentTime;
    // Quick mute — sequencer will own the envelope next
    state.envelope.gain.cancelScheduledValues(now);
    state.envelope.gain.setValueAtTime(0, now);
    state.envelopeHeld = false;
    if (state.filterEnvGain) {
        state.filterEnvGain.gain.cancelScheduledValues(now);
        state.filterEnvGain.gain.setValueAtTime(0, now);
        state.filterEnvelopeHeld = false;
    }
    if (state.phaseResetEnabled) {
        stopLiveOscillators(now);
    }

    // Sequencer start hides the logo itself; only restore when idle
    if (!state.isPlaying) {
        showLogoOverlay(0);
    }
}
