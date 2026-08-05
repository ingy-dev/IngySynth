import { state, OSC_COUNT } from './state.js?v=104';
import {
    makeDistortionCurve,
    makeBitcrushCurve,
    renderReverbImpulse,
    applyReverbSize,
} from './audio-engine.js?v=117';
import { refreshFilterInputDrive, applyFilterResonance } from './filter-drive.js?v=4';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=78';
import { clearAccentSweep } from './acid-env.js?v=6';
import { togglePlay, refreshStepTuneReadouts, previewStepsOnVfd } from './sequencer.js?v=159';
import { updateNoteVisualizer, drawOscilloscope, drawADSRVisualizer, drawFilterADSRVisualizer } from './visualizers.js?v=90';
import { calculateSemitoneShift, getQuantizedStepTune, SCALE_BANKS } from './tuning.js?v=74';
import { onMIDISuccess, onMIDIFailure, setupMappingListeners, populateMidiOutputDropdown } from './midi.js?v=79';
import { applyScaleState } from './keyboard.js?v=152';
import { updateKeyboardStepVisibility } from './keyboard-steps.js?v=92';
import { syncUnisonControlsEnabled } from './unison.js?v=76';
import { formatRangeValue, ensureDisplayStep } from './knobs.js?v=96';
import { setLfoEnabled, getLfoAmount, getLfoAmountAudio, applyLfoMasterGain, updateLfoSmoothing, updateLfoCutoffSafety, updateLfoHighpassSafety } from './lfo-strip.js?v=15';
import { initLfoRateControls, applyLfoRate } from './lfo-rate.js?v=7';
import { syncAcidStripUi, applyAcidOscLock } from './keyboard-acid-strip.js?v=6';
import { setPolyMode, applyPolyOscPan } from './poly-voice.js?v=27';

function syncAcidModeUi() {
    syncAcidStripUi();
}

export function setAcidMode(next) {
    const on = !!next;
    if (state.acidMode === on) {
        syncAcidModeUi();
        return;
    }
    // Acid ↔ Poly ↔ Berlin mutex: hand the voice back before Acid locks OSCs
    if (on && state.keyboardPoly) {
        setPolyMode(false);
    }
    if (on) {
        document.dispatchEvent(new CustomEvent('ingysynth:exit-berlin'));
    }
    state.acidMode = on;
    syncAcidModeUi();
    applyAcidOscLock(on);
    drawADSRVisualizer();
    drawFilterADSRVisualizer();

    // ACID needs Env Mod depth — turn Filter Env on when enabling
    if (on && !state.filterEnvState) {
        const filterBtn = document.getElementById('filterEnvToggle');
        filterBtn?.click();
        // Pre-audio: click may have no listener yet — force state/UI
        if (!state.filterEnvState) {
            state.filterEnvState = true;
            const front = filterBtn?.querySelector('.front');
            if (front) front.textContent = 'On';
            filterBtn?.classList.remove('off');
            document.getElementById('filterEnvControls')?.classList.remove('hidden');
            document.getElementById('kbFilterEnvToggle')?.classList.remove('off');
            const kbFront = document.getElementById('kbFilterEnvToggle');
            if (kbFront) {
                kbFront.textContent = 'On';
                kbFront.setAttribute('aria-pressed', 'true');
            }
        }
    }

    // ACID strip Dist knob — enable distortion (amount stays at default 0 until turned up)
    if (on && !state.distortionEnabled) {
        const distBtn = document.getElementById('distortionToggle');
        distBtn?.click();
        if (!state.distortionEnabled) {
            state.distortionEnabled = true;
            const front = distBtn?.querySelector('.front');
            if (front) front.textContent = 'On';
            distBtn?.classList.remove('off');
            distBtn?.setAttribute('aria-pressed', 'true');
            const input = document.getElementById('distortion');
            if (input) input.disabled = false;
            const kbDist = document.getElementById('kbDistortionToggle');
            if (kbDist) {
                kbDist.textContent = 'On';
                kbDist.classList.remove('off');
                kbDist.setAttribute('aria-pressed', 'true');
            }
        }
    }

    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    if (!on) {
        clearAccentSweep(now);
    } else {
        const actualCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
        updateFilterCutoffRange(actualCutoff, now);
        updateLfoCutoffSafety();
    }
}

// Strip + main toggles work before first audio gesture.
// Guard: mismatched ?v= imports used to load this module twice → double-toggle (panel flashes off).
if (!globalThis.__ingysynthAcidToggleWired) {
    globalThis.__ingysynthAcidToggleWired = true;
    document.getElementById('acidModeToggle')?.addEventListener('click', () => {
        setAcidMode(!state.acidMode);
    });
    document.getElementById('kbAcidStripToggle')?.addEventListener('click', () => {
        setAcidMode(!state.acidMode);
    });
}
syncAcidModeUi();

export function wireControls() {
    // Capture native steps before automation can set step="any"
    document.querySelectorAll('input[type="range"]').forEach(ensureDisplayStep);

    const startStopButton = document.getElementById('startStop');
    startStopButton.addEventListener('click', togglePlay);
    
    // Set up mobile start/stop button with the same functionality
    const mobileStartStopButton = document.getElementById('mobileStartStop');
    mobileStartStopButton.addEventListener('click', togglePlay);

    const kbStartStopButton = document.getElementById('kbStartStop');
    if (kbStartStopButton) kbStartStopButton.addEventListener('click', togglePlay);

    function syncReverseButtons() {
        const reverseButton = document.getElementById('reverse');
        const reverseFront = reverseButton?.querySelector('.front');
        if (reverseFront) {
            reverseFront.textContent = `Reverse: ${state.isReverse ? 'On' : 'Off'}`;
        }
        const kbRev = document.getElementById('kbRev');
        if (kbRev) {
            kbRev.classList.toggle('off', !state.isReverse);
            kbRev.classList.toggle('on', state.isReverse);
            kbRev.setAttribute('aria-pressed', state.isReverse ? 'true' : 'false');
        }
    }

    function toggleReverse() {
        state.isReverse = !state.isReverse;
        syncReverseButtons();
        if (state.isPlaying || state.isArping) {
            state.currentStep = state.isReverse
                ? parseInt(document.getElementById('stepCount').value) - 1
                : 0;
        }
    }

    document.addEventListener('keydown', function (event) {
        if (event.code !== 'Space') return;
        // Computer-keyboard capture handler owns Space when the keyboard is visible.
        if (state.keyboardVisible) return;
        event.preventDefault();
        togglePlay();
    });

    document.querySelectorAll('.osc-toggle').forEach(toggle => {
        toggle.addEventListener('click', function () {
            if (this.id === 'lfoToggle') {
                // Soft-gate via shared master (On × strip amount)
                setLfoEnabled(!state.lfoState);
            } else if (this.id === 'lfoRetrigger') {
                state.lfoRetriggerState = !state.lfoRetriggerState;
                const front = this.querySelector('.front');
                front.textContent = `Retrigger: ${state.lfoRetriggerState ? 'On' : 'Off'}`;
                if (state.lfoRetriggerState) {
                    this.classList.remove('off');
                } else {
                    this.classList.add('off');
                }
            } else {
                // Only real OSC On/Off buttons have data-osc. Shared class `osc-toggle`
                // is also used by Unison / Phase Reset / FX / etc. — skip those here.
                const oscIndex = parseInt(this.dataset.osc, 10);
                if (!Number.isFinite(oscIndex) || !state.oscGains?.[oscIndex]) return;
                state.oscStates[oscIndex] = !state.oscStates[oscIndex];
                const front = this.querySelector('.front');
                front.textContent = state.oscStates[oscIndex] ? 'On' : 'Off';
                if (front.textContent === 'Off') {
                    this.classList.add('off');
                } else {
                    this.classList.remove('off');
                }
                const volEl = document.querySelector(`.osc-vol[data-osc="${oscIndex}"]`);
                const volume = state.oscStates[oscIndex] && volEl ? parseFloat(volEl.value) : 0;
                state.oscGains[oscIndex].gain.setValueAtTime(volume, state.audioContext.currentTime);
                refreshFilterInputDrive();
            }
        });
    });

    document.querySelectorAll('.osc-vol').forEach(slider => {
        ensureDisplayStep(slider);
        slider.addEventListener('input', function () {
            const oscIndex = parseInt(this.dataset.osc);
            this.nextElementSibling.textContent = formatRangeValue(this);
            if (state.oscStates[oscIndex]) {
                state.oscGains[oscIndex].gain.setValueAtTime(this.value, state.audioContext.currentTime);
            }
            refreshFilterInputDrive();
        });
    });

    function formatOscPan(n) {
        const v = Math.round((Number(n) || 0) * 50);
        if (v === 0) return 'C';
        return v < 0 ? `L${Math.abs(v)}` : `R${v}`;
    }

    document.querySelectorAll('.osc-pan').forEach(slider => {
        ensureDisplayStep(slider);
        const valueEl = slider.nextElementSibling?.classList?.contains('osc-pan-value')
            ? slider.nextElementSibling
            : null;
        if (valueEl) valueEl.textContent = formatOscPan(slider.value);
        slider.addEventListener('input', function () {
            const oscIndex = parseInt(this.dataset.osc, 10);
            if (valueEl) valueEl.textContent = formatOscPan(this.value);
            if (!state.audioContext || !Number.isFinite(oscIndex)) return;
            const pan = Math.max(-1, Math.min(1, parseFloat(this.value) || 0));
            const now = state.audioContext.currentTime;
            if (state.oscPanners?.[oscIndex]) {
                state.oscPanners[oscIndex].pan.setValueAtTime(pan, now);
            }
            applyPolyOscPan(oscIndex, pan);
        });
    });

    document.querySelectorAll('.osc-tune').forEach(tune => {
        ensureDisplayStep(tune);
        tune.addEventListener('input', function () {
            const oscIndex = parseInt(this.dataset.osc);
            this.nextElementSibling.textContent = formatRangeValue(this);
            state.oscTunes[oscIndex] = parseInt(this.value);
            refreshFilterInputDrive();
        });
    });

    document.getElementById('noiseToggle').addEventListener('click', function () {
        state.noiseState = !state.noiseState;
        const front = this.querySelector('.front');
        front.textContent = state.noiseState ? 'On' : 'Off';
        if (front.textContent === 'Off') {
            this.classList.add('off');
        } else {
            this.classList.remove('off');
        }
        const volume = state.noiseState ? parseFloat(document.getElementById('noiseVol').value) : 0;
        // Cancel any noise ramps already scheduled by the sequencer lookahead,
        // otherwise they re-raise the gain right after this set.
        state.noiseGain.gain.cancelScheduledValues(state.audioContext.currentTime);
        state.noiseGain.gain.setValueAtTime(volume, state.audioContext.currentTime);
        refreshFilterInputDrive();
    });

    document.getElementById('noiseVol').addEventListener('input', function () {
        ensureDisplayStep(this);
        this.nextElementSibling.textContent = formatRangeValue(this);
        if (state.noiseState) {
            // Cancel pending lookahead ramps so the slider value sticks
            state.noiseGain.gain.cancelScheduledValues(state.audioContext.currentTime);
            state.noiseGain.gain.setValueAtTime(this.value, state.audioContext.currentTime);
        }
        refreshFilterInputDrive();
    });

    document.getElementById('filterEnvToggle').addEventListener('click', function () {
        state.filterEnvState = !state.filterEnvState;
        const front = this.querySelector('.front');
        front.textContent = state.filterEnvState ? 'On' : 'Off';
        this.classList.toggle('off', !state.filterEnvState);

        document.getElementById('filterEnvControls').classList.toggle('hidden', !state.filterEnvState);

        if (!state.audioContext) return;
        const now = state.audioContext.currentTime;
        const actualCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
        updateFilterCutoffRange(actualCutoff, now);
        updateLfoCutoffSafety();

        if (!state.filterEnvState && state.filterEnvGain) {
            state.filterEnvGain.gain.cancelScheduledValues(now);
            state.filterEnvGain.gain.setValueAtTime(0, now);
            state.filterEnvelopeHeld = false;
        }
    });

    document.getElementById('filterEnvAmount')?.addEventListener('input', function () {
        updateDisplay(this, 'filterEnvAmountValue');
        if (!state.audioContext) return;
        const actualCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
        updateFilterCutoffRange(actualCutoff, state.audioContext.currentTime);
        updateLfoCutoffSafety();
    });

    document.getElementById('masterTune').addEventListener('input', function () {
        updateDisplay(this, 'masterTuneValue');
    });

    document.getElementById('octaveSwitch').addEventListener('input', function () {
        updateDisplay(this, 'octaveSwitchValue');
    });

    document.getElementById('semitoneSwitch').addEventListener('input', function () {
        updateDisplay(this, 'semitoneSwitchValue');
    });

    document.getElementById('semitoneAmount').addEventListener('change', function() {
        // Only update if we're playing and not in preview mode
        if ((state.isPlaying || state.isArping) && !window.noteVisualizerPreviewActive) {
            const currentStepTune = getQuantizedStepTune(state.currentStep);
            const masterTune = parseInt(document.getElementById('masterTune').value);
            const octaveSwitch = parseInt(document.getElementById('octaveSwitch').value) * 12;
            const semitoneShift = calculateSemitoneShift();
            updateNoteVisualizer(currentStepTune + masterTune + octaveSwitch + semitoneShift);
        }
    });

    document.getElementById('stepCount').addEventListener('input', function () {
        updateDisplay(this, 'stepCountValue');
        updateStepVisibility(parseInt(this.value));
        previewStepsOnVfd(this.value);
    });

    // Bank slot loads set state.isReverse directly and ask for a UI catch-up
    document.addEventListener('ingysynth:reverse-sync', syncReverseButtons);

    document.getElementById('reverse').addEventListener('click', toggleReverse);
    const kbRevButton = document.getElementById('kbRev');
    if (kbRevButton) kbRevButton.addEventListener('click', toggleReverse);
    syncReverseButtons();

    document.getElementById('distortion').addEventListener('input', function () {
        updateDisplay(this, 'distortionValue');
        if (!state.audioContext || !state.distortion || !state.distortionEnabled) return;
        state.distortion.curve = makeDistortionCurve(parseFloat(this.value));
    });

    document.getElementById('ringMod').addEventListener('input', function () {
        updateDisplay(this, 'ringModValue');
        if (!state.audioContext || !state.ringModDryGain || !state.ringModWetGain || !state.ringModEnabled) return;
        const value = parseFloat(this.value);
        // Crossfade between dry and wet signals
        state.ringModDryGain.gain.setValueAtTime(1 - value, state.audioContext.currentTime);
        state.ringModWetGain.gain.setValueAtTime(value, state.audioContext.currentTime);
    });

    function applyRingModEnabled(on) {
        if (state.keyboardPoly && on) return; // Poly locks ring mod off
        state.ringModEnabled = !!on;
        if (!state.audioContext || !state.ringModDryGain || !state.ringModWetGain) return;
        if (state.ringModEnabled) {
            const el = document.getElementById('ringMod');
            const value = el ? parseFloat(el.value) : 0;
            state.ringModDryGain.gain.setValueAtTime(1 - value, state.audioContext.currentTime);
            state.ringModWetGain.gain.setValueAtTime(value, state.audioContext.currentTime);
        } else {
            state.ringModDryGain.gain.setValueAtTime(1, state.audioContext.currentTime);
            state.ringModWetGain.gain.setValueAtTime(0, state.audioContext.currentTime);
        }
    }

    function applyDistortionEnabled(on) {
        state.distortionEnabled = !!on;
        if (!state.audioContext || !state.distortion) return;
        if (state.distortionEnabled) {
            const el = document.getElementById('distortion');
            const amount = el ? parseFloat(el.value) : 0;
            state.distortion.curve = makeDistortionCurve(Number.isFinite(amount) ? amount : 0);
        } else {
            state.distortion.curve = makeDistortionCurve(0);
        }
    }

    document.getElementById('bitDepth').addEventListener('input', function () {
        updateDisplay(this, 'bitDepthValue');
        if (!state.audioContext || !state.bitcrusher || !state.bitcrusherEnabled) return;
        state.bitcrusher.curve = makeBitcrushCurve(parseFloat(this.value));
    });

    function applyBitcrusherEnabled(on) {
        state.bitcrusherEnabled = !!on;
        if (!state.audioContext || !state.bitcrusher) return;
        if (state.bitcrusherEnabled) {
            const el = document.getElementById('bitDepth');
            const bits = el ? parseFloat(el.value) : 16;
            state.bitcrusher.curve = makeBitcrushCurve(Number.isFinite(bits) ? bits : 16);
        } else {
            state.bitcrusher.curve = makeBitcrushCurve(16);
        }
    }

    function wireEffectToggle(toggleId, inputId, getEnabled, setEnabled) {
        const toggle = document.getElementById(toggleId);
        if (!toggle) return;
        toggle.addEventListener('click', function () {
            setEnabled(!getEnabled());
            const front = this.querySelector('.front');
            if (front) front.textContent = getEnabled() ? 'On' : 'Off';
            this.classList.toggle('off', !getEnabled());
            this.setAttribute('aria-pressed', getEnabled() ? 'true' : 'false');
            const input = document.getElementById(inputId);
            if (input) input.disabled = !getEnabled();
        });
        setEnabled(false);
        toggle.classList.add('off');
        const front = toggle.querySelector('.front');
        if (front) front.textContent = 'Off';
        toggle.setAttribute('aria-pressed', 'false');
        const input = document.getElementById(inputId);
        if (input) input.disabled = true;
    }

    wireEffectToggle('ringModToggle', 'ringMod', () => state.ringModEnabled, applyRingModEnabled);
    wireEffectToggle('distortionToggle', 'distortion', () => state.distortionEnabled, applyDistortionEnabled);
    wireEffectToggle('bitcrusherToggle', 'bitDepth', () => state.bitcrusherEnabled, applyBitcrusherEnabled);
    // Acid Mode may have been enabled before audio init — keep Dist on
    if (state.acidMode && !state.distortionEnabled) {
        document.getElementById('distortionToggle')?.click();
    }

    document.getElementById('delayAmount').addEventListener('input', function () {
        updateDisplay(this, 'delayAmountValue');
        if (!state.audioContext || !state.delayGain || !state.delayEnabled) return;
        state.delayGain.gain.setValueAtTime(this.value, state.audioContext.currentTime);
    });

    function applyDelayEnabled(on) {
        state.delayEnabled = !!on;
        if (!state.audioContext || !state.delayGain) return;
        if (state.delayEnabled) {
            const el = document.getElementById('delayAmount');
            const value = el ? parseFloat(el.value) : 0;
            state.delayGain.gain.setValueAtTime(Number.isFinite(value) ? value : 0, state.audioContext.currentTime);
        } else {
            state.delayGain.gain.setValueAtTime(0, state.audioContext.currentTime);
        }
    }

    const delayToggle = document.getElementById('delayToggle');
    if (delayToggle) {
        delayToggle.addEventListener('click', function () {
            applyDelayEnabled(!state.delayEnabled);
            const front = this.querySelector('.front');
            if (front) front.textContent = state.delayEnabled ? 'On' : 'Off';
            this.classList.toggle('off', !state.delayEnabled);
            this.setAttribute('aria-pressed', state.delayEnabled ? 'true' : 'false');
            const amount = document.getElementById('delayAmount');
            const time = document.getElementById('delayTime');
            if (amount) amount.disabled = !state.delayEnabled;
            if (time) time.disabled = !state.delayEnabled;
        });
        applyDelayEnabled(false);
        delayToggle.classList.add('off');
        const front = delayToggle.querySelector('.front');
        if (front) front.textContent = 'Off';
        delayToggle.setAttribute('aria-pressed', 'false');
        const amount = document.getElementById('delayAmount');
        const time = document.getElementById('delayTime');
        if (amount) amount.disabled = true;
        if (time) time.disabled = true;
    }

    document.getElementById('compThreshold').addEventListener('input', function () {
        updateDisplay(this, 'compThresholdValue');
        if (!state.audioContext || !state.compressor || !state.compressorEnabled) return;
        state.compressor.threshold.setValueAtTime(this.value, state.audioContext.currentTime);
    });

    function applyReverbAmount(amount) {
        if (!state.audioContext || !state.reverbDryGain || !state.reverbWetGain || !state.reverbErGain) return;
        const a = Math.max(0, Math.min(1, Number(amount) || 0));
        const t = state.audioContext.currentTime;
        const erMix = Number.isFinite(state.reverbErMix) ? state.reverbErMix : 0.2;
        const tailMix = Number.isFinite(state.reverbTailMix) ? state.reverbTailMix : 0.8;
        state.reverbDryGain.gain.setValueAtTime(1 - a * 0.5, t);
        state.reverbErGain.gain.setValueAtTime(a * erMix, t);
        state.reverbWetGain.gain.setValueAtTime(a * tailMix, t);
    }

    function syncReverbAmountFromUi() {
        const el = document.getElementById('reverbAmount');
        const value = el ? parseFloat(el.value) : 0;
        applyReverbAmount(Number.isFinite(value) ? value : 0);
    }

    /** Shared master → (optional reverb) → postFx → (optional compressor) → analyser */
    function routePostFx() {
        if (!state.audioContext || !state.masterGain || !state.postFxGain || !state.analyser) return;

        // Edge disconnect only — leave predelay/multitap/convolver chain intact.
        try { state.masterGain.disconnect(); } catch (_) { /* ignore */ }
        try { state.reverbDryGain?.disconnect(); } catch (_) { /* ignore */ }
        try { state.reverbWetGain?.disconnect(); } catch (_) { /* ignore */ }
        try { state.reverbErGain?.disconnect(); } catch (_) { /* ignore */ }
        try { state.postFxGain.disconnect(); } catch (_) { /* ignore */ }
        try { state.compressor?.disconnect(); } catch (_) { /* ignore */ }

        if (
            state.reverbEnabled &&
            state.reverbInput &&
            state.reverbDryGain &&
            state.reverbWetGain &&
            state.reverbErGain
        ) {
            state.masterGain.connect(state.reverbDryGain);
            state.masterGain.connect(state.reverbInput);
            state.reverbDryGain.connect(state.postFxGain);
            state.reverbWetGain.connect(state.postFxGain);
            state.reverbErGain.connect(state.postFxGain);
        } else {
            state.masterGain.connect(state.postFxGain);
        }

        if (state.compressorEnabled && state.compressor) {
            const thresholdEl = document.getElementById('compThreshold');
            const threshold = thresholdEl ? parseFloat(thresholdEl.value) : -24;
            state.compressor.threshold.setValueAtTime(
                Number.isFinite(threshold) ? threshold : -24,
                state.audioContext.currentTime
            );
            state.postFxGain.connect(state.compressor);
            state.compressor.connect(state.analyser);
        } else {
            state.postFxGain.connect(state.analyser);
        }
    }

    function setCompressorEnabled(on) {
        state.compressorEnabled = !!on;
        routePostFx();
    }

    function applyReverbEnabled(on) {
        state.reverbEnabled = !!on;
        if (state.reverbEnabled) {
            syncReverbAmountFromUi();
        } else {
            applyReverbAmount(0);
        }
        routePostFx();
    }

    function scheduleReverbIrRebuild() {
        const decayEl = document.getElementById('reverbDecay');
        const dampEl = document.getElementById('reverbDamp');
        const decay = decayEl ? parseFloat(decayEl.value) : 1.8;
        const damp = dampEl ? parseFloat(dampEl.value) : 0.35;
        renderReverbImpulse(
            Number.isFinite(decay) ? decay : 1.8,
            Number.isFinite(damp) ? damp : 0.35
        );
    }

    let reverbIrDebounce = null;
    const reverbSize = document.getElementById('reverbSize');
    if (reverbSize) {
        reverbSize.addEventListener('input', function () {
            updateDisplay(this, 'reverbSizeValue');
            if (!state.audioContext) return;
            applyReverbSize(this.value);
            if (state.reverbEnabled) syncReverbAmountFromUi();
        });
    }

    const reverbDecay = document.getElementById('reverbDecay');
    if (reverbDecay) {
        reverbDecay.addEventListener('input', function () {
            updateDisplay(this, 'reverbDecayValue');
            if (!state.audioContext) return;
            clearTimeout(reverbIrDebounce);
            reverbIrDebounce = setTimeout(scheduleReverbIrRebuild, 120);
        });
    }

    const reverbDamp = document.getElementById('reverbDamp');
    if (reverbDamp) {
        reverbDamp.addEventListener('input', function () {
            updateDisplay(this, 'reverbDampValue');
            if (!state.audioContext) return;
            clearTimeout(reverbIrDebounce);
            reverbIrDebounce = setTimeout(scheduleReverbIrRebuild, 120);
        });
    }

    const reverbAmount = document.getElementById('reverbAmount');
    if (reverbAmount) {
        reverbAmount.addEventListener('input', function () {
            updateDisplay(this, 'reverbAmountValue');
            if (!state.audioContext || !state.reverbEnabled) return;
            applyReverbAmount(this.value);
        });
    }

    const reverbControlIds = ['reverbAmount', 'reverbSize', 'reverbDecay', 'reverbDamp'];

    const reverbToggle = document.getElementById('reverbToggle');
    if (reverbToggle) {
        reverbToggle.addEventListener('click', function () {
            applyReverbEnabled(!state.reverbEnabled);
            const front = this.querySelector('.front');
            if (front) front.textContent = state.reverbEnabled ? 'On' : 'Off';
            this.classList.toggle('off', !state.reverbEnabled);
            this.setAttribute('aria-pressed', state.reverbEnabled ? 'true' : 'false');
            reverbControlIds.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.disabled = !state.reverbEnabled;
            });
        });
        applyReverbEnabled(false);
        reverbToggle.classList.add('off');
        const front = reverbToggle.querySelector('.front');
        if (front) front.textContent = 'Off';
        reverbToggle.setAttribute('aria-pressed', 'false');
        reverbControlIds.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.disabled = true;
        });
    }

    const compToggle = document.getElementById('compToggle');
    if (compToggle) {
        compToggle.addEventListener('click', function () {
            setCompressorEnabled(!state.compressorEnabled);
            const front = this.querySelector('.front');
            if (front) front.textContent = state.compressorEnabled ? 'On' : 'Off';
            this.classList.toggle('off', !state.compressorEnabled);
            this.setAttribute('aria-pressed', state.compressorEnabled ? 'true' : 'false');
            const threshold = document.getElementById('compThreshold');
            if (threshold) threshold.disabled = !state.compressorEnabled;
        });
        // Default On to match existing chain
        state.compressorEnabled = true;
        compToggle.classList.remove('off');
        const front = compToggle.querySelector('.front');
        if (front) front.textContent = 'On';
        const threshold = document.getElementById('compThreshold');
        if (threshold) threshold.disabled = false;
    }

    document.querySelectorAll('.step-toggle').forEach(toggle => {
        toggle.addEventListener('click', function () {
            const front = this.querySelector('.front');
            front.textContent = front.textContent === 'On' ? 'Off' : 'On';
            if (front.textContent === 'Off') {
                this.classList.add('off');
            } else {
                this.classList.remove('off');
            }
        });
    });

    document.querySelectorAll('.osc-type').forEach(type => {
        type.addEventListener('change', function () {
            if (!state.audioContext) return;
            const oscIndex = parseInt(this.dataset.osc, 10);
            const wave = this.value;

            // Persistent oscillators (phase-reset off)
            if (state.oscillators[oscIndex]) {
                state.oscillators[oscIndex].type = wave;
            }

            // Live / phase-reset voices currently sounding
            state.activeOscillators.forEach(osc => {
                if (osc.oscIndex === oscIndex) {
                    try { osc.type = wave; } catch (_) {}
                }
            });
        });
    });

    document.getElementById('lfoWaveform').addEventListener('change', function () {
        if (!state.lfo || !state.audioContext) return;
        const now = state.audioContext.currentTime;
        // Brief duck while swapping waveform to avoid a discontinuity click
        if (state.lfoMasterGain) {
            const g = state.lfoMasterGain.gain;
            const target = state.lfoState ? getLfoAmountAudio() : 0;
            g.cancelScheduledValues(now);
            g.setValueAtTime(g.value, now);
            g.linearRampToValueAtTime(0, now + 0.01);
            state.lfo.type = this.value;
            updateLfoSmoothing();
            g.setValueAtTime(0, now + 0.012);
            g.linearRampToValueAtTime(target, now + 0.08);
        } else {
            state.lfo.type = this.value;
            updateLfoSmoothing();
        }
    });

    initLfoRateControls();

    function rampLfoDepth(gainNode, value, rampTime = 0.04) {
        if (!gainNode || !state.audioContext) return;
        const now = state.audioContext.currentTime;
        const param = gainNode.gain;
        // Deep cutoff swings need a slower depth fade to avoid zipper
        let t = rampTime;
        if (gainNode === state.lfoGainCutoff && Math.abs(value) > 800) {
            t = Math.max(t, 0.08);
        }
        if (gainNode === state.lfoGainResonance && Math.abs(value) > 12) {
            t = Math.max(t, 0.06);
        }
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(value, now + t);
    }

    /** Biquad Q needs more throw than the UI ±20 suggests to read as “resonance wobble”. */
    const RES_LFO_DEPTH_SCALE = 1.85;
    function resonanceLfoAudioDepth(uiValue) {
        return (parseFloat(uiValue) || 0) * RES_LFO_DEPTH_SCALE;
    }

    document.getElementById('cutoffMod').addEventListener('input', function () {
        updateDisplay(this, 'cutoffModValue');
        rampLfoDepth(state.lfoGainCutoff, parseFloat(this.value));
        updateLfoCutoffSafety();
        if (state.audioContext) {
            const actualCutoff = Math.max(40, parseFloat(document.getElementById('cutoff').value));
            updateFilterCutoffRange(actualCutoff, state.audioContext.currentTime, 0.06);
        }
    });

    document.getElementById('resonanceMod').addEventListener('input', function () {
        updateDisplay(this, 'resonanceModValue');
        rampLfoDepth(state.lfoGainResonance, resonanceLfoAudioDepth(this.value));
    });

    document.getElementById('highpassMod').addEventListener('input', function () {
        updateDisplay(this, 'highpassModValue');
        rampLfoDepth(state.lfoGainHighpass, parseFloat(this.value));
        updateLfoHighpassSafety();
    });

    document.getElementById('osc1PitchMod').addEventListener('input', function () {
        updateDisplay(this, 'osc1PitchModValue');
        const modulationDepth = parseFloat(this.value) * 100; // Convert semitones to cents
        rampLfoDepth(state.lfoGainOsc1Pitch, modulationDepth);
    });

    document.getElementById('osc2PitchMod').addEventListener('input', function () {
        updateDisplay(this, 'osc2PitchModValue');
        const modulationDepth = parseFloat(this.value) * 100; // Convert semitones to cents
        rampLfoDepth(state.lfoGainOsc2Pitch, modulationDepth);
    });

    document.getElementById('osc3PitchMod').addEventListener('input', function () {
        updateDisplay(this, 'osc3PitchModValue');
        const modulationDepth = parseFloat(this.value) * 100; // Convert semitones to cents
        rampLfoDepth(state.lfoGainOsc3Pitch, modulationDepth);
    });

    document.getElementById('osc4PitchMod')?.addEventListener('input', function () {
        updateDisplay(this, 'osc4PitchModValue');
        const modulationDepth = parseFloat(this.value) * 100;
        rampLfoDepth(state.lfoGainOsc4Pitch, modulationDepth);
    });

    // Apply current UI depths + master (knobs may have moved before audio started)
    function syncLfoDepthsFromUi() {
        const cutoffEl = document.getElementById('cutoffMod');
        const resEl = document.getElementById('resonanceMod');
        const hpEl = document.getElementById('highpassMod');
        const o1 = document.getElementById('osc1PitchMod');
        const o2 = document.getElementById('osc2PitchMod');
        const o3 = document.getElementById('osc3PitchMod');
        const o4 = document.getElementById('osc4PitchMod');
        if (cutoffEl) rampLfoDepth(state.lfoGainCutoff, parseFloat(cutoffEl.value) || 0, 0);
        if (resEl) rampLfoDepth(state.lfoGainResonance, resonanceLfoAudioDepth(resEl.value), 0);
        if (hpEl) rampLfoDepth(state.lfoGainHighpass, parseFloat(hpEl.value) || 0, 0);
        if (o1) rampLfoDepth(state.lfoGainOsc1Pitch, (parseFloat(o1.value) || 0) * 100, 0);
        if (o2) rampLfoDepth(state.lfoGainOsc2Pitch, (parseFloat(o2.value) || 0) * 100, 0);
        if (o3) rampLfoDepth(state.lfoGainOsc3Pitch, (parseFloat(o3.value) || 0) * 100, 0);
        if (o4) rampLfoDepth(state.lfoGainOsc4Pitch, (parseFloat(o4.value) || 0) * 100, 0);
        applyLfoMasterGain({ ramp: 0 });
    }
    syncLfoDepthsFromUi();

    document.getElementById('noiseToggle').classList.add('off');
    // Keep toggle UI in sync with state (don't clobber if strip already enabled)
    setLfoEnabled(!!state.lfoState, { ramp: 0 });
    document.getElementById('lfoRetrigger').classList.add('off');

    updateStepVisibility(8);
    drawOscilloscope();

    const phaseResetToggle = document.getElementById('phaseResetToggle');

    function setPhaseResetUi(on) {
        if (!phaseResetToggle) return;
        const front = phaseResetToggle.querySelector('.front');
        if (front) front.textContent = on ? 'On' : 'Off';
        phaseResetToggle.classList.toggle('off', !on);
        phaseResetToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function setPhaseResetEnabled(enabled) {
        if (!state.audioContext) return;
        const next = !!enabled;
        if (state.phaseResetEnabled === next) {
            setPhaseResetUi(next);
            return;
        }

        state.phaseResetEnabled = next;
        setPhaseResetUi(next);

        if (!next) {
            state.oscillators.forEach(osc => {
                if (osc.started) {
                    osc.stop();
                }
            });
            state.oscillators = Array(OSC_COUNT).fill().map((_, i) => {
                const osc = state.audioContext.createOscillator();
                osc.type = document.querySelector(`.osc-type[data-osc="${i}"]`)?.value || 'sawtooth';
                osc.frequency.value = 261.63;
                osc.connect(state.oscGains[i]);
                try { state.oscGains[i].disconnect(); } catch (_) { /* ignore */ }
                state.oscGains[i].connect(state.oscPanners[i] || state.ringModInput);
                osc.start();
                osc.started = true;
                return osc;
            });
            // Reconnect LFO pitch → persistent osc detune
            [
                state.lfoGainOsc1Pitch,
                state.lfoGainOsc2Pitch,
                state.lfoGainOsc3Pitch,
                state.lfoGainOsc4Pitch,
            ].forEach((gain, i) => {
                if (!gain || !state.oscillators[i]) return;
                try { gain.disconnect(); } catch (_) { /* ignore */ }
                gain.connect(state.oscillators[i].detune);
            });
        } else {
            state.oscillators.forEach(osc => {
                if (osc.started) {
                    osc.stop();
                    osc.disconnect();
                }
            });
            state.oscillators = Array(OSC_COUNT).fill().map(() => state.audioContext.createOscillator());
            state.activeOscillators.forEach(osc => {
                if (osc.started) {
                    osc.stop();
                    osc.disconnect();
                }
            });
            state.activeOscillators = [];
        }

        syncUnisonControlsEnabled();
    }

    if (phaseResetToggle) {
        phaseResetToggle.addEventListener('click', function () {
            if (!state.audioContext) return;
            setPhaseResetEnabled(!state.phaseResetEnabled);
        });
        setPhaseResetUi(state.phaseResetEnabled);
    }

    const unisonVoices = document.getElementById('unisonVoices');
    const unisonDetune = document.getElementById('unisonDetune');
    const unisonDetuneValue = document.getElementById('unisonDetuneValue');
    const unisonToggle = document.getElementById('unisonToggle');

    function formatUnisonDetune(n) {
        return `${Math.round(n)}¢`;
    }

    function setUnisonEnabled(enabled) {
        const next = !!enabled;
        if (next && !state.phaseResetEnabled) {
            // Unison requires phase reset — turn it on automatically
            setPhaseResetEnabled(true);
        }
        state.unisonEnabled = next;
        if (unisonToggle) {
            const front = unisonToggle.querySelector('.front');
            if (front) front.textContent = next ? 'On' : 'Off';
            unisonToggle.classList.toggle('off', !next);
            unisonToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
        }
    }

    if (unisonToggle) {
        unisonToggle.addEventListener('click', function () {
            if (!state.audioContext || state.keyboardPoly) return;
            setUnisonEnabled(!state.unisonEnabled);
        });
        setUnisonEnabled(false);
    }

    if (unisonVoices) {
        unisonVoices.addEventListener('change', function () {
            const n = parseInt(this.value, 10);
            state.unisonVoices = [3, 5, 7].includes(n) ? n : 3;
        });
        state.unisonVoices = parseInt(unisonVoices.value, 10) || 3;
    }

    if (unisonDetune) {
        unisonDetune.addEventListener('input', function () {
            state.unisonSpread = parseFloat(this.value) || 0;
            if (unisonDetuneValue) unisonDetuneValue.textContent = formatUnisonDetune(state.unisonSpread);
        });
        state.unisonSpread = parseFloat(unisonDetune.value) || 0;
        if (unisonDetuneValue) unisonDetuneValue.textContent = formatUnisonDetune(state.unisonSpread);
    }

    syncUnisonControlsEnabled();

    // Initialize MIDI
    if (navigator.requestMIDIAccess) {
        navigator.requestMIDIAccess({ sysex: false })
            .then(onMIDISuccess, onMIDIFailure);
    } else {
        console.warn("WebMIDI is not supported in this browser.");
    }

    const midiMappingButton = document.getElementById('midiMapping');
    midiMappingButton.addEventListener('click', function() {
        state.midiMappingMode = !state.midiMappingMode;
        const front = this.querySelector('.front');
        front.textContent = `MIDI Mapping: ${state.midiMappingMode ? 'On' : 'Off'}`;
        const deviceSelector = document.getElementById('midiDeviceSelector');
        if (state.midiMappingMode) {
            this.classList.add('active');
            document.body.classList.add('midi-mapping-active');
            deviceSelector.style.display = 'flex';
            setupMappingListeners(true);
            if (state.midiInputs.length === 0) {
                alert('No MIDI inputs detected. Please connect a MIDI controller and refresh the page.');
            }
        } else {
            this.classList.remove('active');
            document.body.classList.remove('midi-mapping-active');
            deviceSelector.style.display = 'none';
            setupMappingListeners(false);
            if (state.currentMappingControl) {
                state.currentMappingControl.classList.remove('midi-highlight');
                state.currentMappingControl = null;
            }
            // Remove any persisting midi-mapped classes when exiting mapping mode
            document.querySelectorAll('.midi-mapped').forEach(el => {
                el.classList.remove('midi-mapped');
            });
        }
    });

    document.getElementById('midiInputSelect').addEventListener('change', function() {
        state.selectedMidiInput = this.value;
        console.log(`Selected MIDI input device: ${this.options[this.selectedIndex].text}`);
    });

    const sendMidiButton = document.getElementById('sendMidi');
    sendMidiButton.addEventListener('click', function() {
        state.sendMidiEnabled = !state.sendMidiEnabled;
        const front = this.querySelector('.front');
        front.textContent = `Send MIDI: ${state.sendMidiEnabled ? 'On' : 'Off'}`;
        const outputSelector = document.getElementById('midiOutputSelector');
        if (state.sendMidiEnabled) {
            this.classList.add('active');
            outputSelector.style.display = 'flex';
            populateMidiOutputDropdown();
            if (state.midiOutputs.length === 0) {
                alert('No MIDI outputs detected. Please connect a MIDI device and refresh the page.');
            }
        } else {
            this.classList.remove('active');
            outputSelector.style.display = 'none';
        }
    });

    document.getElementById('midiOutputSelect').addEventListener('change', function() {
        const outputId = this.value;
        if (outputId === 'none') {
            state.selectedMidiOutput = null;
        } else {
            state.selectedMidiOutput = state.midiOutputs.find(output => output.id === outputId);
            console.log(`Selected MIDI output device: ${this.options[this.selectedIndex].text}`);
        }
    });

    document.getElementById('midiOutputChannel').addEventListener('change', function() {
        state.selectedMidiChannel = parseInt(this.value);
        console.log(`Selected MIDI channel: ${state.selectedMidiChannel}`);
    });

    document.getElementById('midiBaseNote').addEventListener('change', function() {
        state.midiBaseNote = parseInt(this.value);
        console.log(`Selected MIDI base note: ${state.midiBaseNote}`);
    });

    // Only initialize chorus nodes if they don't already exist
    if (!state.chorusDryGain) {
        // Initialize chorus settings
        state.chorusDryGain = state.audioContext.createGain();
        state.chorusWetGain = state.audioContext.createGain();
        state.chorusLeftDelay = state.audioContext.createDelay(0.05);
        state.chorusRightDelay = state.audioContext.createDelay(0.05);
        state.chorusLFO = state.audioContext.createOscillator();
        state.chorusLFOGain = state.audioContext.createGain();
        state.chorusSplitter = state.audioContext.createChannelSplitter(2);
        state.chorusMerger = state.audioContext.createChannelMerger(2);
        
        // Initialize chorus settings
        state.chorusDryGain.gain.value = 1;
        state.chorusWetGain.gain.value = 0; // Start with chorus off by default
        state.chorusLFO.type = 'triangle';
        state.chorusLFOGain.gain.value = 0; // No modulation by default
        
        // Start the chorus LFO
        state.chorusLFO.start();
    }

    // Chorus amount
    document.getElementById('chorusAmount').addEventListener('input', function() {
        updateDisplay(this, 'chorusAmountValue');
        const amount = parseFloat(this.value);
        const chorusIActive = !document.getElementById('chorusI').classList.contains('off');
        const chorusIIActive = !document.getElementById('chorusII').classList.contains('off');
        
        // Only apply chorus if at least one button is active
        if (chorusIActive || chorusIIActive) {
            state.chorusWetGain.gain.setValueAtTime(amount, state.audioContext.currentTime);
            state.chorusDryGain.gain.setValueAtTime(1 - 0.5 * amount, state.audioContext.currentTime);
        } else {
            // Ensure chorus is off if no buttons are active
            state.chorusWetGain.gain.setValueAtTime(0, state.audioContext.currentTime);
            state.chorusDryGain.gain.setValueAtTime(1, state.audioContext.currentTime);
        }
    });

    // Initialize chorus buttons to off state
    document.getElementById('chorusI').classList.add('off');
    document.getElementById('chorusI').querySelector('.front').style.color = '#ff0000';
    document.getElementById('chorusII').classList.add('off'); 
    document.getElementById('chorusII').querySelector('.front').style.color = '#ff0000';
    
    // Chorus I button (moderate chorus)
    document.getElementById('chorusI').addEventListener('click', function() {
        const isActivated = !this.classList.contains('off');
        const chorusIIActive = !document.getElementById('chorusII').classList.contains('off');
        const chorusAmount = parseFloat(document.getElementById('chorusAmount').value);
        
        if (isActivated) {
            // Turn off
            this.classList.add('off');
            this.querySelector('.front').style.color = '#ff0000';
            
            // Reset LFO to slower rate if chorus II is also off
            if (!chorusIIActive) {
                // Both are off - disable chorus completely
                state.chorusLFO.frequency.setValueAtTime(0.1, state.audioContext.currentTime);
                state.chorusLeftDelay.delayTime.setValueAtTime(0.003, state.audioContext.currentTime);
                state.chorusRightDelay.delayTime.setValueAtTime(0.003, state.audioContext.currentTime);
                state.chorusLFOGain.gain.setValueAtTime(0, state.audioContext.currentTime);
                state.chorusWetGain.gain.setValueAtTime(0, state.audioContext.currentTime); // Turn off wet signal
                state.chorusDryGain.gain.setValueAtTime(1, state.audioContext.currentTime); // Full dry signal
            } else {
                // If Chorus II is still on, keep its settings
                state.chorusLFO.frequency.setValueAtTime(1.012, state.audioContext.currentTime);
                state.chorusLeftDelay.delayTime.setValueAtTime(0.0055, state.audioContext.currentTime);
                state.chorusRightDelay.delayTime.setValueAtTime(0.0055, state.audioContext.currentTime);
                state.chorusLFOGain.gain.setValueAtTime(0.0025, state.audioContext.currentTime);
                // Keep wet signal active based on slider value
                state.chorusWetGain.gain.setValueAtTime(chorusAmount, state.audioContext.currentTime);
                state.chorusDryGain.gain.setValueAtTime(1 - 0.5 * chorusAmount, state.audioContext.currentTime);
            }
        } else {
            // Turn on - Juno-106 Chorus I (moderate)
            this.classList.remove('off');
            this.querySelector('.front').style.color = '';
            
            if (chorusIIActive) {
                // Both are on - create combined effect (thicker chorus with more animation)
                state.chorusLFO.frequency.setValueAtTime(0.85, state.audioContext.currentTime); // Between I and II
                state.chorusLeftDelay.delayTime.setValueAtTime(0.006, state.audioContext.currentTime); // Longer delay
                state.chorusRightDelay.delayTime.setValueAtTime(0.0065, state.audioContext.currentTime); // Slightly different for stronger stereo
                state.chorusLFOGain.gain.setValueAtTime(0.003, state.audioContext.currentTime); // Deeper modulation
            } else {
                // Only Chorus I
                state.chorusLFO.frequency.setValueAtTime(0.513, state.audioContext.currentTime);
                state.chorusLeftDelay.delayTime.setValueAtTime(0.0045, state.audioContext.currentTime);
                state.chorusRightDelay.delayTime.setValueAtTime(0.0045, state.audioContext.currentTime);
                state.chorusLFOGain.gain.setValueAtTime(0.0013, state.audioContext.currentTime);
            }
            // Enable wet signal based on slider value
            state.chorusWetGain.gain.setValueAtTime(chorusAmount, state.audioContext.currentTime);
            state.chorusDryGain.gain.setValueAtTime(1 - 0.5 * chorusAmount, state.audioContext.currentTime);
        }
    });
    
    // Chorus II button (stronger chorus)
    document.getElementById('chorusII').addEventListener('click', function() {
        const isActivated = !this.classList.contains('off');
        const chorusIActive = !document.getElementById('chorusI').classList.contains('off');
        const chorusAmount = parseFloat(document.getElementById('chorusAmount').value);
        
        if (isActivated) {
            // Turn off
            this.classList.add('off');
            this.querySelector('.front').style.color = '#ff0000';
            
            // Reset LFO if chorus I is also off
            if (!chorusIActive) {
                // Both are off - disable chorus completely
                state.chorusLFO.frequency.setValueAtTime(0.1, state.audioContext.currentTime);
                state.chorusLeftDelay.delayTime.setValueAtTime(0.003, state.audioContext.currentTime);
                state.chorusRightDelay.delayTime.setValueAtTime(0.003, state.audioContext.currentTime);
                state.chorusLFOGain.gain.setValueAtTime(0, state.audioContext.currentTime);
                state.chorusWetGain.gain.setValueAtTime(0, state.audioContext.currentTime); // Turn off wet signal
                state.chorusDryGain.gain.setValueAtTime(1, state.audioContext.currentTime); // Full dry signal
            } else {
                // If Chorus I is still on, keep its settings
                state.chorusLFO.frequency.setValueAtTime(0.513, state.audioContext.currentTime);
                state.chorusLeftDelay.delayTime.setValueAtTime(0.0045, state.audioContext.currentTime);
                state.chorusRightDelay.delayTime.setValueAtTime(0.0045, state.audioContext.currentTime);
                state.chorusLFOGain.gain.setValueAtTime(0.0013, state.audioContext.currentTime);
                // Keep wet signal active based on slider value
                state.chorusWetGain.gain.setValueAtTime(chorusAmount, state.audioContext.currentTime);
                state.chorusDryGain.gain.setValueAtTime(1 - 0.5 * chorusAmount, state.audioContext.currentTime);
            }
        } else {
            // Turn on - Juno-106 Chorus II (stronger)
            this.classList.remove('off');
            this.querySelector('.front').style.color = '';
            
            if (chorusIActive) {
                // Both are on - create combined effect (thicker chorus with more animation)
                state.chorusLFO.frequency.setValueAtTime(0.85, state.audioContext.currentTime); // Between I and II
                state.chorusLeftDelay.delayTime.setValueAtTime(0.006, state.audioContext.currentTime); // Longer delay
                state.chorusRightDelay.delayTime.setValueAtTime(0.0065, state.audioContext.currentTime); // Slightly different for stronger stereo
                state.chorusLFOGain.gain.setValueAtTime(0.003, state.audioContext.currentTime); // Deeper modulation
            } else {
                // Only Chorus II
                state.chorusLFO.frequency.setValueAtTime(1.012, state.audioContext.currentTime);
                state.chorusLeftDelay.delayTime.setValueAtTime(0.0055, state.audioContext.currentTime);
                state.chorusRightDelay.delayTime.setValueAtTime(0.0055, state.audioContext.currentTime);
                state.chorusLFOGain.gain.setValueAtTime(0.0025, state.audioContext.currentTime);
            }
            // Enable wet signal based on slider value
            state.chorusWetGain.gain.setValueAtTime(chorusAmount, state.audioContext.currentTime);
            state.chorusDryGain.gain.setValueAtTime(1 - 0.5 * chorusAmount, state.audioContext.currentTime);
        }
    });
}

function updateDisplay(element, valueElementId) {
    ensureDisplayStep(element);
    const el = document.getElementById(valueElementId);
    if (el) el.textContent = formatRangeValue(element);
}

function updateStepVisibility(stepCount) {
    document.querySelectorAll('.sequencer-step').forEach(step => {
        const stepIndex = parseInt(step.dataset.step);
        if (stepIndex < stepCount) {
            step.classList.remove('hidden');
        } else {
            step.classList.add('hidden');
        }
    });
    updateKeyboardStepVisibility(stepCount);
}

document.getElementById('tempo').addEventListener('input', function () {
    updateDisplay(this, 'tempoValue');
    if (state.audioContext) updateDelayTime();
    if (state.lfoSync) applyLfoRate({ ramp: 0.02 });
});

document.getElementById('slideTime').addEventListener('input', function () {
    updateDisplay(this, 'slideTimeValue');
});

document.getElementById('accentAmount').addEventListener('input', function () {
    updateDisplay(this, 'accentAmountValue');
});

document.getElementById('gateLength').addEventListener('input', function () {
    updateDisplay(this, 'gateLengthValue');
});

document.getElementById('cutoff').addEventListener('input', function () {
    if (!state.audioContext) return;
    updateDisplay(this, 'cutoffValue');
    const actualCutoff = Math.max(40, parseFloat(this.value));
    updateFilterCutoffRange(actualCutoff, state.audioContext.currentTime);
    updateLfoCutoffSafety();
    applyFilterResonance(0.03);
});

document.getElementById('resonance').addEventListener('input', function () {
    if (!state.audioContext) return;
    updateDisplay(this, 'resonanceValue');
    applyFilterResonance(0.03);
});

document.getElementById('highPass').addEventListener('input', function () {
    if (!state.audioContext) return;
    updateDisplay(this, 'highPassValue');
    const now = state.audioContext.currentTime;
    const highPassValue = parseFloat(this.value);
    state.highPassFilter.frequency.cancelScheduledValues(now);
    state.highPassFilter.frequency.setValueAtTime(state.highPassFilter.frequency.value, now);
    state.highPassFilter.frequency.exponentialRampToValueAtTime(highPassValue, now + 0.03);
    updateLfoHighpassSafety();
});

['attack', 'decay', 'sustain', 'release'].forEach(param => {
    document.getElementById(param).addEventListener('input', function () {
        updateDisplay(this, `${param}Value`);
        drawADSRVisualizer();
    });
});

['filterAttack', 'filterDecay', 'filterSustain', 'filterRelease'].forEach(param => {
    document.getElementById(param).addEventListener('input', function () {
        updateDisplay(this, `${param}Value`);
        drawFilterADSRVisualizer();
        if (param === 'filterSustain') updateLfoCutoffSafety();
    });
});

document.getElementById('delayTime').addEventListener('change', updateDelayTime);

document.getElementById('volume').addEventListener('input', function () {
    if (!state.audioContext) return;
    updateDisplay(this, 'volumeValue');
    state.masterGain.gain.setValueAtTime(this.value, state.audioContext.currentTime);
});

// (The step-tune readout is updated by the listener in sequencer.js, which is
// scale-quantization aware.)

// --- Scale mode (quantize steps to a selected scale) ---
const scaleSelect = document.getElementById('scaleSelect');
SCALE_BANKS.forEach(bank => {
    const group = document.createElement('optgroup');
    group.label = bank.name;
    bank.scales.forEach(scale => {
        const option = document.createElement('option');
        option.value = scale.id;
        option.textContent = scale.name;
        group.appendChild(option);
    });
    scaleSelect.appendChild(group);
});

document.getElementById('scaleToggle').addEventListener('click', function () {
    const turningOn = this.classList.contains('off');
    applyScaleState(turningOn, document.getElementById('scaleSelect')?.value);
});

scaleSelect.addEventListener('change', function () {
    const enabled = !document.getElementById('scaleToggle')?.classList.contains('off');
    applyScaleState(enabled, this.value);
});

function updateDelayTime() {
    if (!state.audioContext) return;
    const division = parseInt(document.getElementById('delayTime').value);
    const bps = 60 / parseInt(document.getElementById('tempo').value);
    state.delay.delayTime.setValueAtTime(bps * (4 / division), state.audioContext.currentTime);
}
