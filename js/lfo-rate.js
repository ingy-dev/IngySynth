// Ableton-style LFO rate: free-running Hz or tempo-synced beat divisions.
// Classic #lfoSpeed / #lfoSyncDivision are source of truth; applyLfoRate() is
// the single writer to state.lfo.frequency.

import { state } from './state.js?v=107';
import { ensureDisplayStep, formatRangeValue, resetInputToDefault } from './knobs.js?v=100';

/** Optional hook so applyLfoRate can refresh smoothing without a circular import. */
let onRateApplied = null;
export function onLfoRateApplied(fn) {
    onRateApplied = typeof fn === 'function' ? fn : null;
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
    const n = parseFloat(document.getElementById('tempo')?.value);
    return Number.isFinite(n) && n > 0 ? n : 120;
}

export function syncBeatsToHz(tempo, beats) {
    const b = Math.max(0.001, Number(beats) || 1);
    const t = Math.max(1, Number(tempo) || 120);
    return t / (60 * b);
}

export function getSyncDivisionIndex() {
    const el = document.getElementById('lfoSyncDivision');
    const raw = el ? parseInt(el.value, 10) : state.lfoSyncDivisionIndex;
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
    const hz = parseFloat(document.getElementById('lfoSpeed')?.value);
    return Math.max(0.01, Number.isFinite(hz) ? hz : 1);
}

export function formatLfoRateReadout() {
    if (state.lfoSync) {
        return getSyncDivision().label;
    }
    const hz = parseFloat(document.getElementById('lfoSpeed')?.value);
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
    if (!state.lfo || !state.audioContext) return;

    const freq = getLfoRateHz();
    const now = state.audioContext.currentTime;
    const param = state.lfo.frequency;
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

function hzValueToNorm(input) {
    const min = parseFloat(input.min) || 0.1;
    const max = parseFloat(input.max) || 20;
    const v = parseFloat(input.value);
    if (!(max > min)) return 0;
    return clamp(((Number.isFinite(v) ? v : min) - min) / (max - min), 0, 1);
}

function hzNormToValue(input, norm) {
    const min = parseFloat(input.min) || 0.1;
    const max = parseFloat(input.max) || 20;
    const step = parseFloat(input.step) || 0.1;
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
        const input = document.getElementById('lfoSpeed');
        if (!input) return;
        const norm = hzValueToNorm(input);
        setKnobAngle(dial, norm);
        dial.setAttribute('aria-valuemin', input.min);
        dial.setAttribute('aria-valuemax', input.max);
        dial.setAttribute('aria-valuenow', input.value);
        dial.setAttribute('aria-valuetext', formatRangeValue(input));
    }
}

/**
 * Mode-aware RATE dial: continuous Hz or stepped sync divisions.
 */
export function initLfoRateKnob() {
    const dial = document.getElementById('kbLfoRateKnob');
    const hzInput = document.getElementById('lfoSpeed');
    const syncInput = document.getElementById('lfoSyncDivision');
    if (!dial || !hzInput || !syncInput) return;

    ensureDisplayStep(hzInput);
    ensureDisplayStep(syncInput);
    syncDialVisual(dial);

    let dragging = false;
    let startY = 0;
    let startNorm = 0;
    let startIndex = 0;
    let activePointerId = null;

    const writeHz = (norm) => {
        const next = hzNormToValue(hzInput, norm);
        if (parseFloat(hzInput.value) !== next) {
            hzInput.value = String(next);
            hzInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Apply directly — don't wait for wireControls()'s input listener
        if (!state.lfoSync) applyLfoRate({ ramp: 0.02 });
    };

    const writeSync = (index) => {
        const idx = clamp(Math.round(index), 0, LFO_SYNC_DIVISIONS.length - 1);
        if (parseInt(syncInput.value, 10) !== idx) {
            syncInput.value = String(idx);
            syncInput.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            syncDialVisual(dial);
        }
        setLfoSyncDivision(idx, { ramp: 0.02 });
    };

    dial.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        if (state.lfoSync) {
            startIndex = getSyncDivisionIndex();
        } else {
            startNorm = hzValueToNorm(hzInput);
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
        } else {
            const norm = clamp(startNorm + deltaY / DRAG_PIXELS, 0, 1);
            setKnobAngle(dial, norm);
            writeHz(norm);
            dial.setAttribute('aria-valuetext', formatRangeValue(hzInput));
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

    hzInput.addEventListener('input', () => {
        if (dragging || state.lfoSync) return;
        syncDialVisual(dial);
    });
    syncInput.addEventListener('input', () => {
        if (dragging) return;
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
            }
            return;
        }
        const stepNorm = e.shiftKey ? 0.05 : 0.01;
        let norm = hzValueToNorm(hzInput);
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
    });

    // Double-click reset: Hz → default; Sync → 1/4
    dial.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.lfoSync) {
            writeSync(LFO_SYNC_DEFAULT_INDEX);
        } else {
            resetInputToDefault(hzInput);
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

    const syncBtn = document.getElementById('lfoSyncToggle');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            setLfoSyncMode(!state.lfoSync);
        });
    }

    const speed = document.getElementById('lfoSpeed');
    if (speed) {
        speed.addEventListener('input', () => {
            if (state.lfoSync) return;
            applyLfoRate();
        });
    }

    const divEl = document.getElementById('lfoSyncDivision');
    if (divEl) {
        // Ensure default index in DOM
        if (!divEl.value) divEl.value = String(LFO_SYNC_DEFAULT_INDEX);
        state.lfoSyncDivisionIndex = getSyncDivisionIndex();
        divEl.addEventListener('input', () => {
            setLfoSyncDivision(parseInt(divEl.value, 10) || 0);
        });
    }

    updateLfoRateReadout();
}
