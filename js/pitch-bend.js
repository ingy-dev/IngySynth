// Horizontal pitch-bend touch strip on the keyboard performance row.
// Bends sequencer + live keyboard pitch; springs back to center on release.

import { state } from './state.js?v=120';
import { beginMidiLearn } from './midi-learn.js?v=35';
import { midiPitchBendValue } from './tuning.js?v=108';
import { voiceTargetFreq } from './unison.js?v=214';
import { applyPolyPitchBend, hasPolyVoices } from './poly-voice.js?v=202';

const BEND_RAMP = 0.01;

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

export function getBendRangeSemitones() {
    const el = document.getElementById('bendRange');
    const n = el ? parseInt(el.value, 10) : 2;
    return Number.isFinite(n) && n > 0 ? n : 2;
}

export function getPitchBendRatio() {
    return Math.pow(2, (state.pitchBendSemitones || 0) / 12);
}

export function bentFrequency(baseFreq) {
    return Math.max(20, baseFreq * getPitchBendRatio());
}

function sendMidiPitchBend(semitones) {
    if (!state.sendMidiEnabled || !state.selectedMidiOutput) return;
    const range = getBendRangeSemitones();
    const cents = semitones * 100;
    const bend = midiPitchBendValue(cents, range);
    try {
        state.selectedMidiOutput.send([
            0xE0 | (state.selectedMidiChannel - 1),
            bend & 0x7F,
            bend >> 7,
        ]);
        state.lastSentBendCents = cents;
    } catch (_) { /* ignore */ }
}

/** Retune currently sounding oscillators from unbent lastStepFreqs. */
export function applyPitchBend(semitones, { ramp = BEND_RAMP } = {}) {
    state.pitchBendSemitones = semitones;
    if (!state.audioContext) return;

    const now = state.audioContext.currentTime;

    const retune = (osc, i) => {
        const base = state.lastStepFreqs[i];
        if (base == null || !Number.isFinite(base)) return;
        const target = voiceTargetFreq(osc, base);
        try {
            osc.frequency.cancelScheduledValues(now);
            const prev = Math.max(20, osc.frequency.value || target);
            if (ramp > 0 && Math.abs(prev - target) > 0.01) {
                osc.frequency.setValueAtTime(prev, now);
                osc.frequency.exponentialRampToValueAtTime(target, now + ramp);
            } else {
                osc.frequency.setValueAtTime(target, now);
            }
        } catch (_) { /* ignore */ }
    };

    if (hasPolyVoices()) {
        applyPolyPitchBend({ ramp });
    } else if (state.phaseResetEnabled) {
        state.activeOscillators.forEach(osc => {
            if (!osc.started) return;
            retune(osc, osc.oscIndex);
        });
    } else {
        state.oscillators.forEach((osc, i) => retune(osc, i));
    }

    sendMidiPitchBend(semitones);
}

function setStripVisual(el, norm) {
    el.style.setProperty('--bend', String(norm));
    el.setAttribute('aria-valuenow', String(Math.round(norm * 100) / 100));
    el.classList.toggle('active', Math.abs(norm) > 0.001);
}

function normFromClientX(el, clientX) {
    const track = el.querySelector('.keyboard-pitch-bend-track') || el;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    // Map full width: left = -1, center = 0, right = +1
    return clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
}

export function initPitchBendStrip() {
    const el = document.getElementById('keyboardPitchBend');
    if (!el) return;

    let dragging = false;
    let activePointerId = null;

    const setFromNorm = (norm, { ramp } = {}) => {
        const range = getBendRangeSemitones();
        const semis = norm * range;
        setStripVisual(el, norm);
        applyPitchBend(semis, { ramp });
        document.dispatchEvent(new CustomEvent('ingysynth:pitch-bend', {
            detail: { semitones: semis, el },
        }));
    };

    const springBack = () => {
        setFromNorm(0, { ramp: 0.04 });
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
        setFromNorm(normFromClientX(el, e.clientX), { ramp: BEND_RAMP });
    });

    el.addEventListener('pointermove', (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        e.stopPropagation();
        setFromNorm(normFromClientX(el, e.clientX), { ramp: BEND_RAMP });
    });

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        springBack();
    };

    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);

    el.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        let norm = parseFloat(el.style.getPropertyValue('--bend')) || 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            norm = clamp(norm + step, -1, 1);
            setFromNorm(norm);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            norm = clamp(norm - step, -1, 1);
            setFromNorm(norm);
        } else if (e.key === 'Home' || e.key === ' ' || e.key === 'Escape') {
            e.preventDefault();
            springBack();
        } else {
            return;
        }
    });

    // If bend range changes while held, rescale current visual → semitones
    document.getElementById('bendRange')?.addEventListener('change', () => {
        if (dragging) {
            const norm = parseFloat(el.style.getPropertyValue('--bend')) || 0;
            setFromNorm(norm);
        }
    });

    setStripVisual(el, 0);
}
