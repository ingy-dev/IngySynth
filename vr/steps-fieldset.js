import { state } from '../js/state.js?v=116';
import { get, getNumber, set, toggle, click } from '../js/params.js?v=15';
import { getLiveStep, getPattern, patternStepCount } from '../js/pattern-bank.js?v=16';
import { getQuantizedStepTune, getStepFineCents, getStepTotalTune } from '../js/tuning.js?v=80';
import { clampManualTune, stepTuneBounds } from '../js/step-tune-range.js?v=24';
import { formatRatchLabel } from '../js/step-ratch.js?v=1';
import { previewNoteVisualizer, soundingNotesForStep } from '../js/visualizers.js?v=121';

const ANGLE_MIN = -135 * Math.PI / 180;
const ANGLE_SPAN = 270 * Math.PI / 180;
const FONT = 'Michroma, ui-monospace, monospace';

const hits = [];
let soundingStep = -1;
let soundingAt = 0;
let drag = null;
let dirty = true;

export function setSoundingStep(step) {
    const next = Number.isFinite(step) ? (step | 0) : -1;
    if (soundingStep !== next) {
        soundingStep = next;
        soundingAt = state.audioContext?.currentTime ?? (performance.now() / 1000);
    }
    dirty = true;
}

export function getSoundingStep() {
    return soundingStep;
}

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function stepCountNow() {
    try {
        const fromPat = patternStepCount(getPattern(state.editSlot));
        const fromParam = Math.round(getNumber('stepCount', fromPat));
        return clamp(fromParam || fromPat || 8, 1, 32);
    } catch (_) {
        return clamp(Math.round(getNumber('stepCount', 8)) || 8, 1, 32);
    }
}

function writeStepCount(n) {
    const next = clamp(Math.round(n) || 8, 1, 32);
    set('stepCount', next);
    try {
        const pat = getPattern(state.editSlot);
        if (pat) pat.stepCount = next;
    } catch (_) { /* */ }
    dirty = true;
}

function previewStep(i) {
    try {
        previewNoteVisualizer(
            getStepTotalTune(i),
            getStepFineCents(i),
            soundingNotesForStep(i),
        );
    } catch (_) { /* */ }
}

function addHit(kind, x, y, w, h, extra = {}) {
    hits.push({ kind, x, y, w, h, ...extra });
}

function contains(r, x, y) {
    return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

function hitAt(x, y) {
    for (let i = hits.length - 1; i >= 0; i--) {
        if (contains(hits[i], x, y)) return hits[i];
    }
    return null;
}

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function paintButton(ctx, x, y, w, h, label, on, { muted = false } = {}) {
    roundRect(ctx, x, y, w, h, 3);
    if (on && !muted) {
        ctx.fillStyle = '#00ff00';
        ctx.fill();
        ctx.strokeStyle = '#00ff00';
    } else {
        ctx.fillStyle = muted ? '#0a0a0a' : '#101810';
        ctx.fill();
        ctx.strokeStyle = muted ? '#144414' : '#00aa00';
    }
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = muted ? '#245024' : on ? '#000000' : '#00aa00';
    ctx.font = `${Math.max(8, Math.min(11, h * 0.55))}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
}

function playheadPulse() {
    if (soundingStep < 0) return 0;
    const now = state.audioContext?.currentTime ?? (performance.now() / 1000);
    const tempo = Math.max(20, getNumber('tempo', 120));
    const division = Math.max(1, getNumber('division', 8));
    const stepDur = (60 / tempo) * (4 / division);
    const t = (now - soundingAt) / Math.max(0.04, stepDur);
    return 1 - 0.55 * Math.max(0, Math.min(1, t));
}

function paintKnob(ctx, cx, cy, r, tune, { min, max }, active) {
    const pulse = active ? playheadPulse() : 0;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (active) {
        ctx.save();
        ctx.shadowColor = `rgba(0, 255, 0, ${0.35 + 0.65 * pulse})`;
        ctx.shadowBlur = r * (1.2 + 1.6 * pulse);
        ctx.fillStyle = `rgb(${Math.round(40 * (1 - pulse))}, 255, ${Math.round(40 * (1 - pulse))})`;
        ctx.fill();
        ctx.restore();
        ctx.lineWidth = 2 + pulse;
        ctx.strokeStyle = '#00ff00';
        ctx.stroke();
    } else {
        ctx.fillStyle = '#0d0d0d';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#00aa00';
        ctx.stroke();
    }

    const n = (tune - min) / Math.max(1e-6, max - min);
    const ang = ANGLE_MIN + clamp(n, 0, 1) * ANGLE_SPAN - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * r * 0.72, cy + Math.sin(ang) * r * 0.72);
    ctx.strokeStyle = active ? '#000000' : '#00ff00';
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.lineCap = 'butt';
    ctx.stroke();
}

function paintFine(ctx, x, y, w, h, cents) {
    const midY = y + h * 0.45;
    ctx.strokeStyle = '#00aa00';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, midY);
    ctx.lineTo(x + w, midY);
    ctx.stroke();
    const t = (cents + 100) / 200;
    const tx = x + t * w;
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.moveTo(tx, y + 1);
    ctx.lineTo(tx - 5, y + h - 1);
    ctx.lineTo(tx + 5, y + h - 1);
    ctx.closePath();
    ctx.fill();
}

export function markStepsDirty() {
    dirty = true;
}

export function paintStepsFieldset(ctx, w, h) {
    dirty = false;
    hits.length = 0;
    ctx.fillStyle = '#050805';
    ctx.fillRect(0, 0, w, h);

    const count = stepCountNow();
    const headerH = Math.max(36, Math.round(h * 0.07));
    const pad = Math.max(8, Math.round(w * 0.012));

    ctx.fillStyle = '#00aa00';
    ctx.font = `${Math.max(11, Math.round(headerH * 0.42))}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('STEPS', pad, headerH / 2);

    const btn = Math.round(headerH * 0.62);
    const plusX = w - pad - btn;
    const minusX = plusX - btn - 8 - 36;
    roundRect(ctx, minusX, (headerH - btn) / 2, btn, btn, 3);
    ctx.strokeStyle = '#00aa00';
    ctx.stroke();
    ctx.fillStyle = '#00aa00';
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(btn * 0.55)}px ${FONT}`;
    ctx.fillText('−', minusX + btn / 2, headerH / 2);
    ctx.fillText(String(count).padStart(2, '0'), minusX + btn + 22, headerH / 2);
    roundRect(ctx, plusX, (headerH - btn) / 2, btn, btn, 3);
    ctx.stroke();
    ctx.fillText('+', plusX + btn / 2, headerH / 2);
    addHit('countMinus', minusX, (headerH - btn) / 2, btn, btn);
    addHit('countPlus', plusX, (headerH - btn) / 2, btn, btn);

    const cols = Math.min(count, 8);
    const rows = Math.max(1, Math.ceil(count / cols));
    const gap = Math.max(4, Math.round(w * 0.006));
    const gridY = headerH;
    const gridH = h - gridY - pad;
    const cellW = (w - pad * 2 - gap * (cols - 1)) / cols;
    const cellH = (gridH - gap * (rows - 1)) / rows;
    const playhead = (state.isPlaying || state.isArping) ? soundingStep : -1;
    const acid = !!state.acidMode;

    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = (i / cols) | 0;
        const x = pad + col * (cellW + gap);
        const y = gridY + row * (cellH + gap);
        const live = getLiveStep(i);
        const on = live?.on !== false;
        const acc = !!live?.accent;
        const sld = !!live?.slide;
        const ratch = live?.ratch || 1;
        const tune = Number(live?.tune) || 0;
        const cents = Math.round(Number(live?.fine) || 0);
        const bounds = stepTuneBounds(tune);
        const active = playhead === i;

        ctx.strokeStyle = active ? '#00ff00' : '#00aa00';
        ctx.lineWidth = active ? 2 : 1;
        roundRect(ctx, x, y, cellW, cellH, 4);
        ctx.stroke();
        ctx.fillStyle = active ? 'rgba(0, 255, 0, 0.22)' : 'rgba(0, 0, 0, 0.15)';
        ctx.fill();

        const inner = cellW * 0.1;
        const cx = x + cellW / 2;
        let cy = y + 6;

        ctx.fillStyle = '#00aa00';
        ctx.font = `${Math.max(8, Math.round(cellH * 0.055))}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(String(i + 1).padStart(2, '0'), cx, cy);
        cy += cellH * 0.08;

        const knobR = Math.min(cellW * 0.28, cellH * 0.14);
        const knobY = cy + knobR;
        paintKnob(ctx, cx, knobY, knobR, tune, bounds, active);
        addHit('tune', cx - knobR - 4, knobY - knobR - 4, knobR * 2 + 8, knobR * 2 + 8, { step: i });
        cy = knobY + knobR + 4;

        ctx.fillStyle = '#00ff00';
        ctx.font = `${Math.max(9, Math.round(cellH * 0.06))}px ${FONT}`;
        ctx.textBaseline = 'top';
        ctx.fillText(String(getQuantizedStepTune(i)), cx, cy);
        cy += cellH * 0.075;

        const fineH = Math.max(12, cellH * 0.07);
        const fineW = cellW - inner * 2;
        const fineX = x + inner;
        paintFine(ctx, fineX, cy, fineW, fineH, cents);
        addHit('fine', fineX, cy, fineW, fineH, { step: i });
        cy += fineH + 2;

        ctx.fillStyle = '#00aa00';
        ctx.font = `${Math.max(7, Math.round(cellH * 0.045))}px ${FONT}`;
        ctx.fillText(`${cents > 0 ? '+' : ''}${cents}¢`, cx, cy);
        cy += cellH * 0.06;

        const btnGap = 3;
        const btnW = (cellW - inner * 2 - btnGap) / 2;
        const restH = y + cellH - cy - 6;
        const rowH = Math.max(14, (restH - btnGap * 2) / 3);
        const bx = x + inner;

        paintButton(ctx, bx, cy, btnW, rowH, 'Acc', acc);
        addHit('acc', bx, cy, btnW, rowH, { step: i });
        paintButton(ctx, bx + btnW + btnGap, cy, btnW, rowH, 'Sld', sld);
        addHit('sld', bx + btnW + btnGap, cy, btnW, rowH, { step: i });
        cy += rowH + btnGap;

        const fullW = cellW - inner * 2;
        paintButton(ctx, bx, cy, fullW, rowH, formatRatchLabel(ratch), ratch > 1, { muted: acid });
        addHit('ratch', bx, cy, fullW, rowH, { step: i });
        cy += rowH + btnGap;
        paintButton(ctx, bx, cy, fullW, rowH, on ? 'On' : 'Off', on);
        addHit('on', bx, cy, fullW, rowH, { step: i });
    }
}

export function stepsNeedPaint() {
    return dirty;
}

export function pointerDownOnSteps(u, v, canvasW, canvasH) {
    const x = u * canvasW;
    const y = v * canvasH;
    const hit = hitAt(x, y);
    if (!hit) {
        drag = null;
        return false;
    }
    if (hit.kind === 'countMinus') {
        writeStepCount(stepCountNow() - 1);
        return true;
    }
    if (hit.kind === 'countPlus') {
        writeStepCount(stepCountNow() + 1);
        return true;
    }
    const i = hit.step;
    if (hit.kind === 'acc') {
        toggle(`step-accent-${i}`);
        dirty = true;
        return true;
    }
    if (hit.kind === 'sld') {
        toggle(`step-slide-${i}`);
        dirty = true;
        return true;
    }
    if (hit.kind === 'on') {
        toggle(`step-toggle-${i}`);
        dirty = true;
        return true;
    }
    if (hit.kind === 'ratch') {
        if (!state.acidMode) click(`step-ratch-${i}`);
        dirty = true;
        return true;
    }
    if (hit.kind === 'tune') {
        drag = { kind: 'tune', step: i, startY: y, startVal: Number(get(`step-slider-${i}`)) || 0 };
        previewStep(i);
        return true;
    }
    if (hit.kind === 'fine') {
        drag = { kind: 'fine', step: i, startX: x, startVal: Number(get(`step-fine-${i}`)) || 0 };
        previewStep(i);
        return true;
    }
    return false;
}

export function pointerMoveOnSteps(u, v, canvasW, canvasH) {
    if (!drag) return false;
    const x = u * canvasW;
    const y = v * canvasH;
    const i = drag.step;
    if (drag.kind === 'tune') {
        const bounds = stepTuneBounds(drag.startVal);
        const range = Math.max(1, bounds.max - bounds.min);
        const next = clampManualTune(drag.startVal - ((y - drag.startY) / 88) * range);
        set(`step-slider-${i}`, next);
        previewStep(i);
        dirty = true;
        return true;
    }
    if (drag.kind === 'fine') {
        const next = clamp(Math.round(drag.startVal + (x - drag.startX) * 1.15), -100, 100);
        set(`step-fine-${i}`, next);
        previewStep(i);
        dirty = true;
        return true;
    }
    return false;
}

export function pointerUpOnSteps() {
    drag = null;
}
