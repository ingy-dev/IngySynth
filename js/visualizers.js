import { state } from './state.js?v=120';
import { semitonesToNoteName, getStepTotalTune, getStepFineCents } from './tuning.js?v=89';
import { ensureNoteVfd, renderNoteVfd } from './vfd-matrix.js?v=6';
import { formatNoteOrChord } from './chord-name.js?v=12';
import { getLiveStep, stepCellNotes } from './pattern-bank.js?v=31';
import { isPolyChordMemoryOn, getPolyChordIntervals } from './chord-memory.js?v=34';
import { registerAdsrMappingResolver, beginMidiLearn } from './midi-learn.js?v=16';
import { getNumber, set } from './params.js?v=24';
import { getParam } from './param-catalog.js?v=4';
import { acidEnvelopeDisplay, acidDecayKnobFromSec } from './acid-env.js?v=57';

const NOTE_VFD_HOSTS = ['kbPatternNoteVisualizer', 'kbXyNoteVisualizer'];
const NOTE_VFD_IDLE_TEXT = 'Note';

function noteVfdHostIsVisible(host) {
    if (!host) return false;
    // Skip paint for VFDs inside a collapsed / hidden collapsible panel
    const panel = host.closest('.collapsible-panel');
    if (panel && (panel.hidden || panel.classList.contains('hidden'))) return false;
    const fieldset = host.closest('.collapsible-fieldset');
    if (fieldset?.classList.contains('collapsed')) return false;
    if (host.closest('.kb-tab-hidden')) return false;
    return true;
}

function noteVfdHosts() {
    return NOTE_VFD_HOSTS
        .map((id) => document.getElementById(id))
        .filter(noteVfdHostIsVisible);
}

function initNoteVfds() {
    NOTE_VFD_HOSTS.forEach((id) => {
        const host = document.getElementById(id);
        if (!host) return;
        ensureNoteVfd(host);
        renderNoteVfd(host, NOTE_VFD_IDLE_TEXT);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNoteVfds, { once: true });
} else {
    initNoteVfds();
}

function getScopeCtx(canvas) {
    if (canvas._ingyScopeCtx) return canvas._ingyScopeCtx;
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
        || canvas.getContext('2d');
    canvas._ingyScopeCtx = ctx;
    return ctx;
}

function paintOscilloscopeCanvas(canvas, dataArray) {
    if (!canvas) return;
    const ctx = getScopeCtx(canvas);
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    const bins = dataArray.length;
    const steps = Math.min(bins, Math.max(64, width));
    const stride = bins / steps;

    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    let x = 0;
    const sliceWidth = width / steps;
    for (let s = 0; s < steps; s++) {
        const i = Math.min(bins - 1, (s * stride) | 0);
        const v = dataArray[i] / 128.0;
        const y = v * height / 2;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#00ff00';
    ctx.stroke();
}

function drawOscilloscope() {
    const p0 = (window.__ingyProf ||= {});
    p0.scopeGlow = false;
    if (new URLSearchParams(location.search).get('scope') === '0') {
        p0.scopeVisible = false;
        p0.scopeMs = 0;
        return;
    }
    if (!state.analyser) return;
    const canvas = document.getElementById('kbOscilloscope');
    if (!canvas) return;

    const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
    let scopeVisible = true;
    try {
        const io = new IntersectionObserver((entries) => {
            scopeVisible = entries.some((e) => e.isIntersecting);
            const p = (window.__ingyProf ||= {});
            p.scopeVisible = scopeVisible;
        }, { threshold: 0.02 });
        io.observe(canvas);
    } catch (_) {
        scopeVisible = true;
    }

    function draw() {
        requestAnimationFrame(draw);
        const p = (window.__ingyProf ||= {});
        p.scopeRafN = (p.scopeRafN || 0) + 1;
        p.scopeVisible = scopeVisible;
        p.scopeGlow = false;
        if (!scopeVisible) {
            p.scopeMs = 0;
            return;
        }
        const t0 = performance.now();
        state.analyser.getByteTimeDomainData(dataArray);
        paintOscilloscopeCanvas(canvas, dataArray);
        const ms = performance.now() - t0;
        p.scopeMs = ms;
        if (ms > (p.scopeMax || 0)) p.scopeMax = ms;
        p.scopePaintN = (p.scopePaintN || 0) + 1;
    }

    draw();
}


const ADSR_PAD_X = 5;
const ADSR_SUSTAIN_TIME = 0.5;
const ADSR_HIT_RADIUS = 14;
/** Floor so AD segments stay visible when knobs are at 0. */
const ADSR_SEG_FLOOR = 0.02;
/** Acid attack is ~3–4 ms; this is a vertical tick, not a time-scaled ramp. */
const ADSR_ACID_ATTACK_PX = 3;

const AMP_ADSR_IDS = {
    attackId: 'attack',
    decayId: 'decay',
    sustainId: 'sustain',
    releaseId: 'release',
};
const FILTER_ADSR_IDS = {
    attackId: 'filterAttack',
    decayId: 'filterDecay',
    sustainId: 'filterSustain',
    releaseId: 'filterRelease',
};

function readAdsrParams(ids) {
    return {
        attack: getNumber(ids.attackId, 0),
        decay: getNumber(ids.decayId, 0),
        sustain: getNumber(ids.sustainId, 0),
        release: getNumber(ids.releaseId, 0),
        attackId: ids.attackId,
        decayId: ids.decayId,
        sustainId: ids.sustainId,
        releaseId: ids.releaseId,
    };
}

function adsrKeyMax(key, fallback) {
    const spec = getParam(key);
    return Number.isFinite(spec?.max) ? spec.max : fallback;
}

function setAdsrValue(key, value) {
    if (!key) return;
    set(key, value);
}

function acidKindFromParams(params) {
    return (params.attackId === 'filterAttack' || params.decayId === 'filterDecay')
        ? 'filter'
        : 'amp';
}

function adsrInnerWidth(width) {
    return Math.max(1, width - ADSR_PAD_X * 2);
}

/** Shared ADSR (or Acid AD) polyline geometry (canvas pixel space). */
function getAdsrLayout(width, height, params, invert = false) {
    const acid = !!state.acidMode;
    const maxHeight = height - 10;
    const yAt = (level) => invert
        ? 10 + level * (maxHeight - 10)
        : maxHeight - level * (maxHeight - 10);
    const levelAt = (y) => {
        const t = (y - 10) / Math.max(1e-6, maxHeight - 10);
        const level = invert ? t : 1 - t;
        return Math.max(0, Math.min(1, level));
    };
    const y0 = yAt(0);
    const yPeak = yAt(1);
    const x0 = ADSR_PAD_X;

    if (acid) {
        const shape = acidEnvelopeDisplay(acidKindFromParams(params));
        const inner = adsrInnerWidth(width);
        // Real acid attack is ~3–4 ms. Draw a 3px tick so it stays vertical at every Decay.
        const decayMax = Math.max(1e-6, shape.window - shape.attack);
        const attackWidth = ADSR_ACID_ATTACK_PX;
        const decayWidth = (shape.decay / decayMax) * (inner - attackWidth);
        const xA = x0 + attackWidth;
        const xD = Math.min(x0 + inner, xA + decayWidth);
        const xEnd = x0 + inner;
        const path = [
            { x: x0, y: y0 },
            { x: xA, y: yPeak },
            { x: xD, y: y0 },
        ];
        if (xEnd > xD + 1) path.push({ x: xEnd, y: y0 });
        return {
            acid: true,
            totalDuration: shape.window,
            attackWidth,
            decayWidth,
            sustainWidth: 0,
            releaseWidth: 0,
            maxHeight,
            yAt,
            levelAt,
            y0,
            yPeak,
            ySustain: y0,
            points: {
                decay: { x: xD, y: y0, key: 'decay' },
            },
            path,
            labels: [
                { text: 'A', x: x0 + attackWidth / 2 },
                { text: 'D', x: xA + decayWidth / 2 },
            ],
        };
    }

    const attack = Math.max(ADSR_SEG_FLOOR, params.attack);
    const decay = Math.max(ADSR_SEG_FLOOR, params.decay);
    const sustain = params.sustain;
    const release = Math.max(0, params.release);
    const sustainTime = ADSR_SUSTAIN_TIME;

    const totalDuration = attack + decay + sustainTime + release;
    const attackWidth = (attack / totalDuration) * width;
    const decayWidth = (decay / totalDuration) * width;
    const sustainWidth = (sustainTime / totalDuration) * width;
    const releaseWidth = (release / totalDuration) * width;
    const ySustain = yAt(sustain);
    const xA = ADSR_PAD_X + attackWidth;
    const xD = ADSR_PAD_X + attackWidth + decayWidth;
    const xS = ADSR_PAD_X + attackWidth + decayWidth + sustainWidth;
    const xR = ADSR_PAD_X + attackWidth + decayWidth + sustainWidth + releaseWidth;

    return {
        acid: false,
        totalDuration,
        attackWidth,
        decayWidth,
        sustainWidth,
        releaseWidth,
        maxHeight,
        yAt,
        levelAt,
        y0,
        yPeak,
        ySustain,
        points: {
            attack: { x: xA, y: yPeak, key: 'attack' },
            decay: { x: xD, y: ySustain, key: 'decay' },
            sustain: { x: xS, y: ySustain, key: 'sustain' },
        },
        path: [
            { x: x0, y: y0 },
            { x: xA, y: yPeak },
            { x: xD, y: ySustain },
            { x: xS, y: ySustain },
            { x: xR, y: y0 },
        ],
        labels: [
            { text: 'A', x: ADSR_PAD_X + attackWidth / 2 },
            { text: 'D', x: ADSR_PAD_X + attackWidth + decayWidth / 2 },
            { text: 'S', x: ADSR_PAD_X + attackWidth + decayWidth + sustainWidth / 2 },
            { text: 'R', x: ADSR_PAD_X + attackWidth + decayWidth + sustainWidth + releaseWidth / 2 },
        ],
    };
}

function strokeAdsrPath(ctx, path) {
    if (!path?.length) return;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) {
        ctx.lineTo(path[i].x, path[i].y);
    }
    ctx.stroke();
}

function paintADSRVisualizer(options = {}) {
    const {
        canvasId = 'kbAdsrVisualizer',
        attackId = 'attack',
        decayId = 'decay',
        sustainId = 'sustain',
        releaseId = 'release',
        lineColor = '#66ff66',
        invert = false,
    } = options;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const params = readAdsrParams({ attackId, decayId, sustainId, releaseId });
    
    // Create the ADSR texture image if it doesn't exist
    if (!window.adsrTexture) {
        window.adsrTexture = new Image();
        window.adsrTexture.src = './assets/oscilloscope-glass.jpg'; // Update to relative web path
        window.adsrTexture.onerror = function() {
            console.log('Failed to load ADSR texture');
            window.adsrTextureError = true;
        };
        window.adsrTexture.onload = function() {
            console.log('ADSR texture loaded');
            drawADSRVisualizer();
            drawFilterADSRVisualizer();
        };
    }
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    
    // Draw the texture image with 25% opacity if it's loaded
    if (window.adsrTexture && window.adsrTexture.complete && !window.adsrTextureError) {
        ctx.save();
        ctx.globalAlpha = 0.25; // 25% opacity
        ctx.drawImage(window.adsrTexture, 0, 0, width, height);
        ctx.globalAlpha = 1.0; // Reset opacity
        ctx.restore();
    }

    const layout = getAdsrLayout(width, height, params, invert);
    const { maxHeight, path, labels } = layout;

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    strokeAdsrPath(ctx, path);
    
    ctx.fillStyle = '#ffffff';
    ctx.font = '8px Michroma';
    labels.forEach(({ text, x }) => {
        ctx.fillText(text, x, maxHeight - 10);
    });
}

function adsrCanvasPoint(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / Math.max(1, rect.width);
    const sy = canvas.height / Math.max(1, rect.height);
    return {
        x: (e.clientX - rect.left) * sx,
        y: (e.clientY - rect.top) * sy,
    };
}

function hitAdsrKey(canvas, e, ids, invert) {
    const params = readAdsrParams(ids);
    const pt = adsrCanvasPoint(canvas, e);
    const layout = getAdsrLayout(canvas.width, canvas.height, params, !!invert);
    let best = null;
    let bestDist = ADSR_HIT_RADIUS;
    Object.values(layout.points).forEach((p) => {
        const d = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (d <= bestDist) {
            bestDist = d;
            best = p.key;
        }
    });
    return { params, key: best, pt };
}

function idsForAdsrCanvas(canvas) {
    if (!canvas) return null;
    if (canvas.id === 'kbAdsrVisualizer') return AMP_ADSR_IDS;
    if (canvas.id === 'kbFilterAdsrVisualizer') return FILTER_ADSR_IDS;
    return null;
}

function resolveAdsrMapping(canvas, e) {
    const ids = idsForAdsrCanvas(canvas);
    if (!ids) return null;
    const invert = canvas.id === 'kbFilterAdsrVisualizer'
        ? !!state.filterEnvInvert
        : false;
    const { params, key } = hitAdsrKey(canvas, e, ids, invert);
    if (!params || !key) return { unmappable: true, host: canvas };
    const catalogKey = ids[`${key}Id`];
    if (!catalogKey) return { unmappable: true, host: canvas };
    return { key: catalogKey, canonical: document.getElementById(catalogKey) || null, host: canvas };
}

/** Invisible hit-targets on envelope corners — appearance unchanged. */
function bindAdsrCanvasDrag(canvasId, ids, { getInvert = () => false } = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || canvas.dataset.adsrDragBound === '1') return;
    canvas.dataset.adsrDragBound = '1';
    canvas.style.touchAction = 'none';

    let dragKey = null;
    let pointerId = null;

    const hitTest = (pt) => {
        const params = readAdsrParams(ids);
        const layout = getAdsrLayout(canvas.width, canvas.height, params, !!getInvert());
        let best = null;
        let bestDist = ADSR_HIT_RADIUS;
        Object.values(layout.points).forEach((p) => {
            const d = Math.hypot(pt.x - p.x, pt.y - p.y);
            if (d <= bestDist) {
                bestDist = d;
                best = p.key;
            }
        });
        return best;
    };

    const applyDrag = (pt) => {
        const params = readAdsrParams(ids);
        if (!dragKey) return;
        const width = canvas.width;
        const x = Math.max(ADSR_PAD_X + 1, Math.min(ADSR_PAD_X + width - 1, pt.x));
        const u = (x - ADSR_PAD_X) / width;

        if (state.acidMode) {
            // Acid attack is fixed; only Decay is live. Map x along the stable time window.
            if (dragKey !== 'decay') return;
            const kind = acidKindFromParams(params);
            const shape = acidEnvelopeDisplay(kind);
            const inner = adsrInnerWidth(width);
            const attackWidth = ADSR_ACID_ATTACK_PX;
            const decaySpan = Math.max(1, inner - attackWidth);
            const t = (x - ADSR_PAD_X - attackWidth) / decaySpan;
            const decaySec = t * Math.max(1e-6, shape.window - shape.attack);
            setAdsrValue(ids.decayId, acidDecayKnobFromSec(kind, decaySec));
            return;
        } else if (dragKey === 'attack') {
            const rest = params.decay + ADSR_SUSTAIN_TIME + params.release;
            const denom = 1 - u;
            const nextA = denom > 1e-4 ? (u * rest) / denom : adsrKeyMax(ids.attackId, 2);
            setAdsrValue(ids.attackId, nextA);
        } else if (dragKey === 'decay') {
            // Keep attack fixed; solve A+D from normalized x, then D = sum - A.
            const rest = ADSR_SUSTAIN_TIME + params.release;
            const denom = 1 - u;
            const sumAD = denom > 1e-4 ? (u * rest) / denom : params.attack + adsrKeyMax(ids.decayId, 2);
            setAdsrValue(ids.decayId, Math.max(0, sumAD - params.attack));
            const layout = getAdsrLayout(width, canvas.height, params, !!getInvert());
            setAdsrValue(ids.sustainId, layout.levelAt(pt.y));
        } else if (dragKey === 'sustain') {
            // Horizontal: release (left = longer release). Vertical: sustain level.
            const fixed = params.attack + params.decay + ADSR_SUSTAIN_TIME;
            const denom = Math.max(1e-4, u);
            const nextR = Math.max(0, fixed * (1 / denom - 1));
            setAdsrValue(ids.releaseId, nextR);
            const layout = getAdsrLayout(width, canvas.height, params, !!getInvert());
            setAdsrValue(ids.sustainId, layout.levelAt(pt.y));
        }
    };

    const setCursor = (mode) => {
        canvas.classList.toggle('adsr-cursor-grab', mode === 'grab');
        canvas.classList.toggle('adsr-cursor-grabbing', mode === 'grabbing');
    };

    canvas.addEventListener('pointerdown', (e) => {
        if (e.button != null && e.button !== 0) return;
        if (state.midiMappingMode) {
            const { params, key } = hitAdsrKey(canvas, e, ids, !!getInvert());
            const catalogKey = key && params ? ids[`${key}Id`] : null;
            beginMidiLearn(e, catalogKey, canvas);
            return;
        }
        const key = hitTest(adsrCanvasPoint(canvas, e));
        if (!key) return;
        e.preventDefault();
        dragKey = key;
        pointerId = e.pointerId;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        setCursor('grabbing');
        applyDrag(adsrCanvasPoint(canvas, e));
    });

    canvas.addEventListener('pointermove', (e) => {
        if (dragKey && pointerId === e.pointerId) {
            e.preventDefault();
            applyDrag(adsrCanvasPoint(canvas, e));
            return;
        }
        setCursor(hitTest(adsrCanvasPoint(canvas, e)) ? 'grab' : '');
    });

    const endDrag = (e) => {
        if (pointerId !== null && e.pointerId !== pointerId) return;
        dragKey = null;
        pointerId = null;
        setCursor(hitTest(adsrCanvasPoint(canvas, e)) ? 'grab' : '');
    };

    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('lostpointercapture', endDrag);
}

function initAdsrCanvasDragging() {
    const filterInvert = () => !!state.filterEnvInvert;
    bindAdsrCanvasDrag('kbAdsrVisualizer', AMP_ADSR_IDS);
    bindAdsrCanvasDrag('kbFilterAdsrVisualizer', FILTER_ADSR_IDS, {
        getInvert: filterInvert,
    });
    registerAdsrMappingResolver(resolveAdsrMapping);
}

function drawADSRVisualizer(options = {}) {
    paintADSRVisualizer({ ...options, canvasId: 'kbAdsrVisualizer' });
}


function drawFilterADSRVisualizer() {
    paintADSRVisualizer({
        canvasId: 'kbFilterAdsrVisualizer',
        attackId: 'filterAttack',
        decayId: 'filterDecay',
        sustainId: 'filterSustain',
        releaseId: 'filterRelease',
        glowColor: '#00ffff',
        lineColor: '#66ffff',
        invert: !!state.filterEnvInvert,
    });
}

function bootAdsrVisualizers() {
    drawADSRVisualizer();
    drawFilterADSRVisualizer();
    initAdsrCanvasDragging();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAdsrVisualizers, { once: true });
} else {
    bootAdsrVisualizers();
}

function paintNoteVfd(text, { preview = false } = {}) {
    const previewOn = preview || !!window.noteVisualizerPreviewActive;
    noteVfdHosts().forEach((host) => renderNoteVfd(host, text, { preview: previewOn }));
}

function updateNoteVisualizer(totalTune, cents = 0) {
    paintNoteVfd(semitonesToNoteName(totalTune, cents), {
        preview: !!window.noteVisualizerPreviewActive,
    });
}

/** Sounding pitches for a step (chord memory expanded when armed). */
function soundingNotesForStep(step) {
    const data = getLiveStep(step);
    const soundingRoot = getStepTotalTune(step);
    let cells;
    if (isPolyChordMemoryOn()) {
        const ivs = getPolyChordIntervals();
        const root = Math.round(Number(data?.tune) || 0);
        cells = ivs.length ? ivs.map((iv) => root + iv) : [root];
    } else {
        cells = stepCellNotes(data);
    }
    if (!cells.length) return [soundingRoot];
    const root = cells[0];
    return cells.map((n) => n - root + soundingRoot);
}

function restoreNoteVisualizerAfterPreview() {
    window.noteVisualizerPreviewActive = false;
    if (state.isPlaying || state.isArping) {
        const step = state.currentStep;
        const cents = getStepFineCents(step);
        const notes = soundingNotesForStep(step);
        if (notes.length > 1) updateChordVisualizer(notes, { cents, preview: false });
        else updateNoteVisualizer(getStepTotalTune(step), cents);
    } else {
        clearNoteVisualizer();
    }
}

/**
 * Paint a chord (or single note) from a semitone list. Lowest = root.
 * @param {number[]} notes
 * @param {{ cents?: number, preview?: boolean }} [opts]
 */
function updateChordVisualizer(notes, { cents = 0, preview = false } = {}) {
    const text = formatNoteOrChord(notes, cents);
    if (!text) {
        if (!preview && !window.noteVisualizerPreviewActive) clearNoteVisualizer();
        return;
    }
    paintNoteVfd(text, { preview });
}

/** Cyan root-note preview while a step knob / µtune is being edited. */
function previewNoteVisualizer(totalTune, cents = 0, notes = null) {
    window.noteVisualizerPreviewActive = true;
    if (window.noteVisualizerPreviewTimeout) {
        clearTimeout(window.noteVisualizerPreviewTimeout);
    }
    const list = Array.isArray(notes) ? notes : null;
    if (list && list.length > 1) updateChordVisualizer(list, { cents, preview: true });
    else updateNoteVisualizer(totalTune, cents);
    window.noteVisualizerPreviewTimeout = setTimeout(() => {
        restoreNoteVisualizerAfterPreview();
    }, 2000);
}

function previewChordVisualizer(notes, cents = 0) {
    const list = Array.isArray(notes) ? notes : [];
    if (list.length <= 1) {
        previewNoteVisualizer(list[0] ?? 0, cents);
        return;
    }
    previewNoteVisualizer(list[0], cents, list);
}

/** Idle note screen (fixed 14-cell matrix, centered "Note"). */
function clearNoteVisualizer() {
    noteVfdHosts().forEach((host) => renderNoteVfd(host, NOTE_VFD_IDLE_TEXT, { preview: false }));
}

/** Catch a previously-skipped host up to the latest note text (e.g. panel expand). */
export function syncNoteVfdFromPeer(hostId, peerId = 'kbPatternNoteVisualizer') {
    const host = document.getElementById(hostId);
    if (!host || !noteVfdHostIsVisible(host)) return;
    const peer = document.getElementById(peerId);
    ensureNoteVfd(host);
    const chars = host.querySelector('.note-vfd-chars');
    if (chars) delete chars.dataset.painted;
    const text = peer?.dataset.text || NOTE_VFD_IDLE_TEXT;
    const preview = !!peer?.classList.contains('note-vfd--preview');
    renderNoteVfd(host, text, { preview });
}


let logoFlickerRunning = false;

function logoOverlay() {
    return document.getElementById('kb-logo-overlay');
}

function startLogoFlicker() {
    const overlay = logoOverlay();
    if (!overlay || logoFlickerRunning) return;
    logoFlickerRunning = true;

    function randomFlicker() {
        if (overlay.classList.contains('hidden')) {
            logoFlickerRunning = false;
            return;
        }

        if (Math.random() > 0.97) {
            const logoSvg = overlay.querySelector('svg');
            if (logoSvg) {
                logoSvg.classList.add('flicker');

                if (Math.random() > 0.7) {
                    const glitchContainer = overlay.querySelector('.glitch');
                    if (glitchContainer) {
                        glitchContainer.style.transform = `translate(${(Math.random() * 4) - 2}px, ${(Math.random() * 4) - 2}px)`;
                    }

                    logoSvg.style.filter = `drop-shadow(0 0 5px #00ff00) drop-shadow(0 0 10px rgba(0, 255, 0, 0.7)) 
                                       drop-shadow(${(Math.random() * 2) - 1}px 0 1px rgba(255,0,0,0.5)) 
                                       drop-shadow(0 ${(Math.random() * 2) - 1}px 1px rgba(0,0,255,0.5))`;

                    setTimeout(() => {
                        if (glitchContainer) glitchContainer.style.transform = '';
                        logoSvg.style.filter = 'drop-shadow(0 0 5px #00ff00) drop-shadow(0 0 10px rgba(0, 255, 0, 0.7))';
                    }, 100);
                }

                setTimeout(() => {
                    logoSvg.classList.remove('flicker');
                }, 150);
            }
        }

        requestAnimationFrame(randomFlicker);
    }

    randomFlicker();
}

/** Hide the logo so the oscilloscope waveform is visible. */
function hideLogoOverlay() {
    const overlay = logoOverlay();
    if (!overlay) return;
    if (state.logoDisplayTimeout) {
        clearTimeout(state.logoDisplayTimeout);
        state.logoDisplayTimeout = null;
    }
    overlay.classList.add('hidden');
}

/**
 * Show the logo again after audio goes idle.
 * @param {number} delayMs - delay before revealing (matches sequencer stop fade)
 */
function showLogoOverlay(delayMs = 0) {
    const overlay = logoOverlay();
    if (!overlay) return;

    if (state.logoDisplayTimeout) {
        clearTimeout(state.logoDisplayTimeout);
        state.logoDisplayTimeout = null;
    }

    const reveal = () => {
        // Keep scope visible while sequencer or keyboard voice is active
        if (state.isPlaying || state.keyboardVoiceActive) return;
        overlay.classList.remove('hidden');
        startLogoFlicker();
        state.logoDisplayTimeout = null;
    };

    if (delayMs > 0) {
        state.logoDisplayTimeout = setTimeout(reveal, delayMs);
    } else {
        reveal();
    }
}

// Add script to apply CRT flicker randomly
document.addEventListener('DOMContentLoaded', function() {
    const overlay = logoOverlay();
    if (overlay) overlay.classList.remove('hidden');
    startLogoFlicker();
});


export {
    paintOscilloscopeCanvas,
    drawOscilloscope,
    drawADSRVisualizer,
    drawFilterADSRVisualizer,
    updateNoteVisualizer,
    updateChordVisualizer,
    clearNoteVisualizer,
    previewNoteVisualizer,
    previewChordVisualizer,
    soundingNotesForStep,
    hideLogoOverlay,
    showLogoOverlay,
};
