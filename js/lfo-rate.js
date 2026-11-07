// Ableton-style LFO rate: free-running Hz or tempo-synced beat divisions.
// params.lfoSpeed / lfoSyncDivision are source of truth; applyLfoRate() is
// the single writer to state.lfo.frequency. state.lfoSync stays the mode flag.

import { state } from './state.js?v=120';
import { getNumber, getString, set, subscribe, toggle } from './params.js?v=44';
import { getParam } from './param-catalog.js?v=10';
import { ensureDisplayStep, resetInputToDefault } from './knobs.js?v=186';
import { beginMidiLearn } from './midi-learn.js?v=35';

/** Optional hook so applyLfoRate can refresh smoothing without a circular import. */
let onRateApplied = null;
export function onLfoRateApplied(fn) {
    onRateApplied = typeof fn === 'function' ? fn : null;
}

/** Oscillators still sounding or queued (lookahead retrigger keeps more than one). */
const liveLfoOscs = new Set();
let lastLfoRetrigWhen = -1;

export function registerLfoOsc(osc) {
    if (!osc) return;
    liveLfoOscs.add(osc);
    const drop = () => { liveLfoOscs.delete(osc); };
    try { osc.addEventListener('ended', drop); } catch (_) { /* ignore */ }
}

export function forEachLiveLfoOsc(fn) {
    const list = liveLfoOscs.size ? [...liveLfoOscs] : (state.lfo ? [state.lfo] : []);
    for (const osc of list) {
        try { fn(osc); } catch (_) { /* ignore */ }
    }
}

function connectLfoOsc(lfo) {
    if (state.lfoSmooth) lfo.connect(state.lfoSmooth);
    else if (state.lfoMasterGain) lfo.connect(state.lfoMasterGain);
    else {
        if (state.lfoGainCutoff) lfo.connect(state.lfoGainCutoff);
        if (state.lfoGainResonance) lfo.connect(state.lfoGainResonance);
        if (state.lfoGainHighpass) lfo.connect(state.lfoGainHighpass);
        if (state.lfoGainOsc1Pitch) lfo.connect(state.lfoGainOsc1Pitch);
        if (state.lfoGainOsc2Pitch) lfo.connect(state.lfoGainOsc2Pitch);
        if (state.lfoGainOsc3Pitch) lfo.connect(state.lfoGainOsc3Pitch);
        if (state.lfoGainOsc4Pitch) lfo.connect(state.lfoGainOsc4Pitch);
        if (state.lfoGainRingFreq) lfo.connect(state.lfoGainRingFreq);
    }
}

/** Whole-note = 4 beats. Triplet = 2/3 of the straight note. */
export const LFO_SYNC_DIVISIONS = [
    { label: '8/1', beats: 32 },
    { label: '4/1', beats: 16 },
    { label: '2/1', beats: 8 },
    { label: '1/1', beats: 4 },
    { label: '1/2', beats: 2 },
    { label: '1/2T', beats: 4 / 3 },
    { label: '1/4', beats: 1 },
    { label: '1/4T', beats: 2 / 3 },
    { label: '1/8', beats: 0.5 },
    { label: '1/8T', beats: 1 / 3 },
    { label: '1/16', beats: 0.25 },
    { label: '1/16T', beats: 1 / 6 },
    { label: '1/32', beats: 0.125 },
];

export const LFO_SYNC_DEFAULT_INDEX = LFO_SYNC_DIVISIONS.findIndex((d) => d.label === '1/4');

const ANGLE_MIN = -135;
const ANGLE_MAX = 135;
const DRAG_PIXELS = 120;
const STEPPED_DRAG_PIXELS = 90;

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

export function getTempoBpm() {
    const n = getNumber('tempo', 120);
    return Number.isFinite(n) && n > 0 ? n : 120;
}

export function syncBeatsToHz(tempo, beats) {
    const b = Math.max(0.001, Number(beats) || 1);
    const t = Math.max(1, Number(tempo) || 120);
    return t / (60 * b);
}

export function getSyncDivisionIndex() {
    const raw = getNumber('lfoSyncDivision', state.lfoSyncDivisionIndex);
    const idx = Number.isFinite(raw) ? raw : LFO_SYNC_DEFAULT_INDEX;
    return clamp(idx, 0, LFO_SYNC_DIVISIONS.length - 1);
}

export function getSyncDivision() {
    return LFO_SYNC_DIVISIONS[getSyncDivisionIndex()];
}

/** Effective LFO frequency in Hz (respects Sync / Hz mode). */
export function getLfoRateHz() {
    if (state.lfoSync) {
        const div = getSyncDivision();
        return Math.max(0.01, syncBeatsToHz(getTempoBpm(), div.beats));
    }
    const hz = getNumber('lfoSpeed', 1);
    return Math.max(0.01, Number.isFinite(hz) ? hz : 1);
}

/**
 * Restart the shared LFO at `startTime` (audio clock).
 * Stop/start are scheduled at that time so sequencer lookahead cannot
 * cancel a reset that has not sounded yet.
 */
export function retriggerLfoIfNeeded(startTime) {
    const ctx = state.audioContext;
    if (!ctx || !state.lfoState || !state.lfoRetriggerState) return false;
    if (!state.lfo && liveLfoOscs.size === 0) return false;
    const now = ctx.currentTime;
    if (startTime == null) return false;
    const when = Math.max(now, Number(startTime) || now);
    if (lastLfoRetrigWhen >= 0 && Math.abs(when - lastLfoRetrigWhen) < 1e-6) return false;

    lastLfoRetrigWhen = when;
    const prev = state.lfo;
    if (prev) {
        try { prev.stop(when); } catch (_) { /* already stopped */ }
    }
    const lfo = ctx.createOscillator();
    try { lfo.type = getString('lfoWaveform', 'sine'); } catch (_) { lfo.type = 'sine'; }
    lfo.frequency.value = getLfoRateHz();
    connectLfoOsc(lfo);
    try {
        lfo.start(when);
        lfo.started = true;
        registerLfoOsc(lfo);
        state.lfo = lfo;
        return true;
    } catch (_) {
        return false;
    }
}

export function formatLfoRateReadout() {
    if (state.lfoSync) {
        return getSyncDivision().label;
    }
    const hz = getNumber('lfoSpeed', 1);
    const n = Number.isFinite(hz) ? hz : 1;
    return `${n} Hz`;
}

export function updateLfoRateReadout() {
    const readout = formatLfoRateReadout();
    const span = document.getElementById('lfoSpeedValue');
    if (span) span.textContent = readout;

    const kbSpan = document.getElementById('kbLfoRateValue');
    if (kbSpan) kbSpan.textContent = readout;

    const syncSpan = document.getElementById('lfoSyncDivisionValue');
    if (syncSpan) syncSpan.textContent = getSyncDivision().label;

    const hzWrap = document.getElementById('lfoSpeedControl');
    const syncWrap = document.getElementById('lfoSyncDivisionControl');
    if (hzWrap) {
        hzWrap.classList.toggle('hidden', !!state.lfoSync);
        hzWrap.hidden = !!state.lfoSync;
    }
    if (syncWrap) {
        syncWrap.classList.toggle('hidden', !state.lfoSync);
        syncWrap.hidden = !state.lfoSync;
    }

    const rateLabel = document.getElementById('lfoRateLabel');
    if (rateLabel) rateLabel.textContent = state.lfoSync ? 'Rate (Sync)' : 'Rate (Hz)';

    const mainBtn = document.getElementById('lfoSyncToggle');
    if (mainBtn) {
        const front = mainBtn.querySelector('.front');
        if (front) front.textContent = state.lfoSync ? 'Sync' : 'Hz';
        mainBtn.classList.toggle('off', !state.lfoSync);
        mainBtn.setAttribute('aria-pressed', state.lfoSync ? 'true' : 'false');
    }

    document.dispatchEvent(new CustomEvent('ingysynth:lfo-rate', {
        detail: {
            sync: !!state.lfoSync,
            hz: getLfoRateHz(),
            label: formatLfoRateReadout(),
            divisionIndex: getSyncDivisionIndex(),
        },
    }));
}

/**
 * Single writer for state.lfo.frequency.
 * @param {{ ramp?: number }} [opts]
 */
export function applyLfoRate({ ramp = 0.03 } = {}) {
    updateLfoRateReadout();
    if (!state.audioContext) return;

    const freq = getLfoRateHz();
    const now = state.audioContext.currentTime;
    const write = (osc) => {
        if (!osc) return;
        const param = osc.frequency;
        const from = Math.max(0.01, param.value || freq);
        param.cancelScheduledValues(now);
        param.setValueAtTime(from, now);
        if (ramp > 0 && Math.abs(from - freq) > 0.0001) {
            try {
                param.exponentialRampToValueAtTime(freq, now + ramp);
            } catch (_) {
                param.linearRampToValueAtTime(freq, now + ramp);
            }
        } else {
            param.setValueAtTime(freq, now);
        }
    };
    forEachLiveLfoOsc(write);
    if (onRateApplied) onRateApplied();
}

export function setLfoSyncMode(on, { ramp = 0.03 } = {}) {
    state.lfoSync = !!on;
    // Keep division index in state + DOM in sync
    const divEl = document.getElementById('lfoSyncDivision');
    if (divEl) {
        const idx = getSyncDivisionIndex();
        state.lfoSyncDivisionIndex = idx;
        if (String(divEl.value) !== String(idx)) divEl.value = String(idx);
    }
    applyLfoRate({ ramp });
}

export function setLfoSyncDivision(index, { ramp = 0.03 } = {}) {
    const idx = clamp(Math.round(index), 0, LFO_SYNC_DIVISIONS.length - 1);
    state.lfoSyncDivisionIndex = idx;
    const divEl = document.getElementById('lfoSyncDivision');
    if (divEl && String(divEl.value) !== String(idx)) {
        divEl.value = String(idx);
    }
    if (state.lfoSync) applyLfoRate({ ramp });
    else updateLfoRateReadout();
}

function setKnobAngle(dial, norm) {
    const angle = ANGLE_MIN + clamp(norm, 0, 1) * (ANGLE_MAX - ANGLE_MIN);
    dial.style.setProperty('--knob-angle', `${angle}deg`);
}

function hzRange() {
    const spec = getParam('lfoSpeed');
    return {
        min: Number.isFinite(spec?.min) ? spec.min : 0.1,
        max: Number.isFinite(spec?.max) ? spec.max : 20,
        step: Number.isFinite(spec?.step) && spec.step > 0 ? spec.step : 0.1,
    };
}

function hzValueToNorm(value) {
    const { min, max } = hzRange();
    if (!(max > min)) return 0;
    const v = Number.isFinite(value) ? value : getNumber('lfoSpeed', 1);
    return clamp((v - min) / (max - min), 0, 1);
}

function hzNormToValue(norm) {
    const { min, max, step } = hzRange();
    const raw = min + clamp(norm, 0, 1) * (max - min);
    const stepped = Math.round(raw / step) * step;
    return clamp(Number(stepped.toFixed(6)), min, max);
}

function syncDialVisual(dial) {
    if (!dial) return;
    if (state.lfoSync) {
        const idx = getSyncDivisionIndex();
        const n = LFO_SYNC_DIVISIONS.length;
        const norm = n <= 1 ? 0 : idx / (n - 1);
        setKnobAngle(dial, norm);
        dial.setAttribute('aria-valuemin', '0');
        dial.setAttribute('aria-valuemax', String(n - 1));
        dial.setAttribute('aria-valuenow', String(idx));
        dial.setAttribute('aria-valuetext', LFO_SYNC_DIVISIONS[idx].label);
    } else {
        const { min, max } = hzRange();
        const v = getNumber('lfoSpeed', 1);
        const norm = hzValueToNorm(v);
        setKnobAngle(dial, norm);
        dial.setAttribute('aria-valuemin', String(min));
        dial.setAttribute('aria-valuemax', String(max));
        dial.setAttribute('aria-valuenow', String(v));
        dial.setAttribute('aria-valuetext', formatLfoRateReadout());
    }
}

/**
 * Mode-aware RATE dial: continuous Hz or stepped sync divisions.
 * Binds from params + catalog even when #lfoSpeed / #lfoSyncDivision are missing.
 */
export function initLfoRateKnob() {
    const dial = document.getElementById('kbLfoRateKnob');
    if (!dial) return;
    const hzInput = document.getElementById('lfoSpeed');
    const syncInput = document.getElementById('lfoSyncDivision');
    if (hzInput) ensureDisplayStep(hzInput);
    if (syncInput) ensureDisplayStep(syncInput);
    syncDialVisual(dial);

    let dragging = false;
    let startY = 0;
    let startNorm = 0;
    let startIndex = 0;
    let activePointerId = null;

    const writeHz = (norm) => {
        const next = hzNormToValue(norm);
        set('lfoSpeed', next);
        if (!state.lfoSync) applyLfoRate({ ramp: 0.02 });
        else updateLfoRateReadout();
    };

    const writeSync = (index) => {
        const idx = clamp(Math.round(index), 0, LFO_SYNC_DIVISIONS.length - 1);
        set('lfoSyncDivision', idx);
        setLfoSyncDivision(idx, { ramp: 0.02 });
    };

    const paintRateKnob = (normOrNull) => {
        if (state.lfoSync) {
            const idx = getSyncDivisionIndex();
            const n = LFO_SYNC_DIVISIONS.length;
            setKnobAngle(dial, n <= 1 ? 0 : idx / (n - 1));
            dial.setAttribute('aria-valuenow', String(idx));
            dial.setAttribute('aria-valuetext', LFO_SYNC_DIVISIONS[idx].label);
        } else {
            const norm = Number.isFinite(normOrNull) ? normOrNull : hzValueToNorm(getNumber('lfoSpeed', 1));
            setKnobAngle(dial, norm);
            const v = getNumber('lfoSpeed', 1);
            dial.setAttribute('aria-valuenow', String(v));
            dial.setAttribute('aria-valuetext', formatLfoRateReadout());
        }
        updateLfoRateReadout();
    };

    dial.addEventListener('pointerdown', (e) => {
        const rateId = state.lfoSync ? 'lfoSyncDivision' : 'lfoSpeed';
        if (beginMidiLearn(e, rateId, dial.closest('.synth-knob') || dial)) return;
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        if (state.lfoSync) {
            startIndex = getSyncDivisionIndex();
        } else {
            startNorm = hzValueToNorm(getNumber('lfoSpeed', 1));
        }
        dial.classList.add('active');
        try {
            dial.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
    });

    dial.addEventListener('pointermove', (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        e.stopPropagation();
        const deltaY = startY - e.clientY;
        if (state.lfoSync) {
            const n = LFO_SYNC_DIVISIONS.length;
            const perStep = STEPPED_DRAG_PIXELS / Math.max(1, n - 1);
            writeSync(startIndex + deltaY / perStep);
            paintRateKnob();
        } else {
            const norm = clamp(startNorm + deltaY / DRAG_PIXELS, 0, 1);
            writeHz(norm);
            paintRateKnob(norm);
        }
    });

    const endDrag = (e) => {
        if (!dragging) return;
        if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
        dragging = false;
        activePointerId = null;
        dial.classList.remove('active');
        syncDialVisual(dial);
    };

    dial.addEventListener('pointerup', endDrag);
    dial.addEventListener('pointercancel', endDrag);
    dial.addEventListener('lostpointercapture', endDrag);

    hzInput?.addEventListener('input', () => {
        if (dragging || state.lfoSync) return;
        syncDialVisual(dial);
    });
    syncInput?.addEventListener('input', () => {
        if (dragging) return;
        syncDialVisual(dial);
    });

    subscribe('lfoSpeed', () => {
        if (dragging) return;
        if (!state.lfoSync) applyLfoRate({ ramp: 0.02 });
        syncDialVisual(dial);
    });
    subscribe('lfoSyncDivision', () => {
        if (dragging) return;
        if (state.lfoSync) applyLfoRate({ ramp: 0.02 });
        syncDialVisual(dial);
    });

    dial.addEventListener('keydown', (e) => {
        if (state.lfoSync) {
            let idx = getSyncDivisionIndex();
            if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
                e.preventDefault();
                writeSync(idx + 1);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
                e.preventDefault();
                writeSync(idx - 1);
            } else if (e.key === 'Home') {
                e.preventDefault();
                writeSync(0);
            } else if (e.key === 'End') {
                e.preventDefault();
                writeSync(LFO_SYNC_DIVISIONS.length - 1);
            } else {
                return;
            }
            paintRateKnob();
            return;
        }
        const stepNorm = e.shiftKey ? 0.05 : 0.01;
        let norm = hzValueToNorm(getNumber('lfoSpeed', 1));
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            norm = clamp(norm + stepNorm, 0, 1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            norm = clamp(norm - stepNorm, 0, 1);
        } else if (e.key === 'Home') {
            e.preventDefault();
            norm = 0;
        } else if (e.key === 'End') {
            e.preventDefault();
            norm = 1;
        } else {
            return;
        }
        setKnobAngle(dial, norm);
        writeHz(norm);
        paintRateKnob(norm);
    });

    // Double-click reset: Hz → catalog default; Sync → 1/4
    dial.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.lfoSync) {
            writeSync(LFO_SYNC_DEFAULT_INDEX);
        } else if (hzInput) {
            resetInputToDefault(hzInput);
            syncDialVisual(dial);
        } else {
            const spec = getParam('lfoSpeed');
            set('lfoSpeed', spec?.default ?? 1);
            applyLfoRate({ ramp: 0.02 });
            syncDialVisual(dial);
        }
    });

    document.addEventListener('ingysynth:lfo-rate', () => {
        if (!dragging) syncDialVisual(dial);
    });
}

/** Wire classic Sync toggle + division slider (call from controls / main). */
let rateControlsWired = false;
export function initLfoRateControls() {
    if (rateControlsWired) {
        updateLfoRateReadout();
        return;
    }
    rateControlsWired = true;

    subscribe('lfoSyncToggle', (on) => setLfoSyncMode(!!on));
    const syncBtn = document.getElementById('lfoSyncToggle');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => toggle('lfoSyncToggle'));
    }

    subscribe('lfoSpeed', () => {
        if (!state.lfoSync) applyLfoRate();
    });
    subscribe('lfoSyncDivision', (v) => {
        setLfoSyncDivision(parseInt(v, 10) || 0);
    });

    updateLfoRateReadout();
}
