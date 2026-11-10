// Sidechain TIME: free ms or tempo-synced beat divisions (LFO RATE pattern, shorter list).

import { state } from './state.js?v=120';
import { DRUM_LANE_COUNT } from './pattern-bank.js?v=50';
import { get, getNumber, set, subscribe, toggle } from './params.js?v=44';
import { getParam } from './param-catalog.js?v=13';
import { ensureDisplayStep, resetInputToDefault } from './knobs.js?v=191';
import { beginMidiLearn } from './midi-learn.js?v=35';

export const SC_SYNC_DIVISIONS = [
    { label: '1/4', beats: 1 },
    { label: '1/4T', beats: 2 / 3 },
    { label: '1/8', beats: 0.5 },
    { label: '1/8T', beats: 1 / 3 },
    { label: '1/16', beats: 0.25 },
    { label: '1/16T', beats: 1 / 6 },
    { label: '1/32', beats: 0.125 },
];

export const SC_SYNC_DEFAULT_INDEX = 2; // 1/8
export const SC_ATTACK_SEC = 0.008;

const ANGLE_MIN = -135;
const ANGLE_MAX = 135;
const DRAG_PIXELS = 120;
const STEPPED_DRAG_PIXELS = 90;

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

export function parseScSource(raw) {
    const s = String(raw ?? get('scSource') ?? 'd4').toLowerCase();
    const m = s.match(/^([do])([1-4])$/);
    const kick = DRUM_LANE_COUNT - 1;
    if (!m) return { kind: 'drum', index: kick, id: 'd4' };
    const kind = m[1] === 'o' ? 'osc' : 'drum';
    const n = parseInt(m[2], 10);
    const index = kind === 'drum' ? clamp(n - 1, 0, kick) : clamp(n - 1, 0, 3);
    return { kind, index, id: `${m[1]}${index + 1}` };
}

export function getScSyncIndex() {
    const raw = getNumber('scTimeSyncDivision', SC_SYNC_DEFAULT_INDEX);
    const idx = Number.isFinite(raw) ? raw : SC_SYNC_DEFAULT_INDEX;
    return clamp(Math.round(idx), 0, SC_SYNC_DIVISIONS.length - 1);
}

export function getSidechainReleaseSec() {
    if (get('scTimeSyncToggle')) {
        const div = SC_SYNC_DIVISIONS[getScSyncIndex()] || SC_SYNC_DIVISIONS[SC_SYNC_DEFAULT_INDEX];
        const tempo = getNumber('tempo', 120);
        const bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : 120;
        return Math.max(0.02, (div.beats * 60) / bpm);
    }
    const ms = getNumber('scTimeMs', 150);
    return Math.max(0.05, Math.min(0.4, (Number.isFinite(ms) ? ms : 150) / 1000));
}

export function formatScTimeReadout() {
    if (get('scTimeSyncToggle')) {
        return (SC_SYNC_DIVISIONS[getScSyncIndex()] || SC_SYNC_DIVISIONS[SC_SYNC_DEFAULT_INDEX]).label;
    }
    const ms = Math.round(getNumber('scTimeMs', 150));
    return `${ms} ms`;
}

export function updateScTimeReadout() {
    const span = document.getElementById('kbScTimeValue');
    if (span) span.textContent = formatScTimeReadout();
    const btn = document.getElementById('kbScTimeSync');
    if (btn) {
        const sync = !!get('scTimeSyncToggle');
        btn.textContent = sync ? 'Sync' : 'ms';
        btn.classList.toggle('off', !sync);
        btn.setAttribute('aria-pressed', sync ? 'true' : 'false');
    }
}

/**
 * Hold the scheduled value at t0. Do not pin param.value — that is "now",
 * and lookahead ducks then jump (crossover click into distortion).
 * setTarget after hold continues from the real level (Acid VEG path).
 */
function holdParam(param, t0) {
    if (!param) return;
    try {
        if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t0);
        else param.cancelScheduledValues(t0);
    } catch (_) { /* ignore */ }
}

export function scheduleSidechainDuck(atTime) {
    if (!get('scToggle')) return;
    const ducker = state.scDucker;
    const ctx = state.audioContext;
    if (!ducker || !ctx) return;
    const t0 = Math.max(ctx.currentTime, Number(atTime) || ctx.currentTime);
    const depth = clamp(getNumber('scDepth', 0.6), 0, 1);
    const floor = clamp(1 - depth, 0, 1);
    const release = getSidechainReleaseSec();
    const param = ducker.gain;
    const attack = Math.max(0.002, SC_ATTACK_SEC);
    const attackTau = Math.max(0.0008, attack / 3);
    const releaseTau = Math.max(0.008, release / 3);
    try {
        holdParam(param, t0);
        param.setTargetAtTime(floor, t0, attackTau);
        const t1 = t0 + attack;
        holdParam(param, t1);
        param.setTargetAtTime(1, t1, releaseTau);
    } catch (_) { /* ignore */ }
}

export function resetSidechainDucker(atTime) {
    const ducker = state.scDucker;
    const ctx = state.audioContext;
    if (!ducker) return;
    const t0 = atTime ?? ctx?.currentTime ?? 0;
    const param = ducker.gain;
    try {
        holdParam(param, t0);
        param.setTargetAtTime(1, t0, 0.012);
    } catch (_) {
        try { param.value = 1; } catch (__) { /* ignore */ }
    }
}

function msRange() {
    const spec = getParam('scTimeMs');
    return {
        min: Number.isFinite(spec?.min) ? spec.min : 50,
        max: Number.isFinite(spec?.max) ? spec.max : 400,
        step: Number.isFinite(spec?.step) && spec.step > 0 ? spec.step : 1,
    };
}

function setKnobAngle(dial, norm) {
    const angle = ANGLE_MIN + clamp(norm, 0, 1) * (ANGLE_MAX - ANGLE_MIN);
    dial.style.setProperty('--knob-angle', `${angle}deg`);
}

function msValueToNorm(value) {
    const { min, max } = msRange();
    if (!(max > min)) return 0;
    const v = Number.isFinite(value) ? value : getNumber('scTimeMs', 150);
    return clamp((v - min) / (max - min), 0, 1);
}

function msNormToValue(norm) {
    const { min, max, step } = msRange();
    const raw = min + clamp(norm, 0, 1) * (max - min);
    const stepped = Math.round(raw / step) * step;
    return clamp(stepped, min, max);
}

function syncDialVisual(dial) {
    if (!dial) return;
    if (get('scTimeSyncToggle')) {
        const idx = getScSyncIndex();
        const n = SC_SYNC_DIVISIONS.length;
        const norm = n <= 1 ? 0 : idx / (n - 1);
        setKnobAngle(dial, norm);
        dial.setAttribute('aria-valuemin', '0');
        dial.setAttribute('aria-valuemax', String(n - 1));
        dial.setAttribute('aria-valuenow', String(idx));
        dial.setAttribute('aria-valuetext', SC_SYNC_DIVISIONS[idx].label);
    } else {
        const { min, max } = msRange();
        const v = getNumber('scTimeMs', 150);
        setKnobAngle(dial, msValueToNorm(v));
        dial.setAttribute('aria-valuemin', String(min));
        dial.setAttribute('aria-valuemax', String(max));
        dial.setAttribute('aria-valuenow', String(v));
        dial.setAttribute('aria-valuetext', formatScTimeReadout());
    }
    updateScTimeReadout();
}

export function initScTimeKnob() {
    const dial = document.getElementById('kbScTimeKnob');
    if (!dial) return;
    const msInput = document.getElementById('scTimeMs');
    const syncInput = document.getElementById('scTimeSyncDivision');
    if (msInput) ensureDisplayStep(msInput);
    if (syncInput) ensureDisplayStep(syncInput);
    syncDialVisual(dial);

    let dragging = false;
    let startY = 0;
    let startNorm = 0;
    let startIndex = 0;
    let activePointerId = null;

    const writeMs = (norm) => {
        set('scTimeMs', msNormToValue(norm));
        updateScTimeReadout();
    };
    const writeSync = (index) => {
        const idx = clamp(Math.round(index), 0, SC_SYNC_DIVISIONS.length - 1);
        set('scTimeSyncDivision', idx);
        updateScTimeReadout();
        syncDialVisual(dial);
    };

    dial.addEventListener('pointerdown', (e) => {
        const rateId = get('scTimeSyncToggle') ? 'scTimeSyncDivision' : 'scTimeMs';
        if (beginMidiLearn(e, rateId, dial.closest('.synth-knob') || dial)) return;
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        activePointerId = e.pointerId;
        startY = e.clientY;
        if (get('scTimeSyncToggle')) startIndex = getScSyncIndex();
        else startNorm = msValueToNorm(getNumber('scTimeMs', 150));
        dial.classList.add('active');
        try { dial.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });

    dial.addEventListener('pointermove', (e) => {
        if (!dragging || (activePointerId !== null && e.pointerId !== activePointerId)) return;
        e.preventDefault();
        const deltaY = startY - e.clientY;
        if (get('scTimeSyncToggle')) {
            const n = SC_SYNC_DIVISIONS.length;
            const perStep = STEPPED_DRAG_PIXELS / Math.max(1, n - 1);
            writeSync(startIndex + deltaY / perStep);
        } else {
            const norm = clamp(startNorm + deltaY / DRAG_PIXELS, 0, 1);
            setKnobAngle(dial, norm);
            writeMs(norm);
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

    subscribe('scTimeMs', () => { if (!dragging) syncDialVisual(dial); });
    subscribe('scTimeSyncDivision', () => { if (!dragging) syncDialVisual(dial); });
    subscribe('scTimeSyncToggle', () => syncDialVisual(dial));

    dial.addEventListener('keydown', (e) => {
        if (get('scTimeSyncToggle')) {
            let idx = getScSyncIndex();
            if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); writeSync(idx + 1); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); writeSync(idx - 1); }
            else if (e.key === 'Home') { e.preventDefault(); writeSync(0); }
            else if (e.key === 'End') { e.preventDefault(); writeSync(SC_SYNC_DIVISIONS.length - 1); }
            return;
        }
        const stepNorm = e.shiftKey ? 0.05 : 0.01;
        let norm = msValueToNorm(getNumber('scTimeMs', 150));
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); norm = clamp(norm + stepNorm, 0, 1); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); norm = clamp(norm - stepNorm, 0, 1); }
        else if (e.key === 'Home') { e.preventDefault(); norm = 0; }
        else if (e.key === 'End') { e.preventDefault(); norm = 1; }
        else return;
        setKnobAngle(dial, norm);
        writeMs(norm);
    });

    dial.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (get('scTimeSyncToggle')) writeSync(SC_SYNC_DEFAULT_INDEX);
        else if (msInput) {
            resetInputToDefault(msInput);
            syncDialVisual(dial);
        } else {
            set('scTimeMs', getParam('scTimeMs')?.default ?? 150);
            syncDialVisual(dial);
        }
    });

    const syncBtn = document.getElementById('kbScTimeSync');
    if (syncBtn) {
        syncBtn.addEventListener('click', () => toggle('scTimeSyncToggle'));
    }
    updateScTimeReadout();
}
