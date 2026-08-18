import { state } from './state.js?v=114';
import { semitonesToNoteName, getStepTotalTune, getStepFineCents } from './tuning.js?v=79';
import { ensureNoteVfd, renderNoteVfd } from './vfd-matrix.js?v=2';
import { registerAdsrMappingResolver, beginMidiLearn } from './midi-learn.js?v=6';
import { getNumber, set } from './params.js?v=13';
import { getParam } from './param-catalog.js?v=1';

const NOTE_VFD_HOSTS = ['noteVisualizer', 'kbPatternNoteVisualizer', 'kbXyNoteVisualizer'];
const NOTE_VFD_IDLE_TEXT = 'Note';

function noteVfdHostIsVisible(host) {
    if (!host) return false;
    // Skip paint for VFDs inside a collapsed / hidden collapsible panel
    const panel = host.closest('.collapsible-panel');
    if (panel && (panel.hidden || panel.classList.contains('hidden'))) return false;
    const fieldset = host.closest('.collapsible-fieldset');
    if (fieldset?.classList.contains('collapsed')) return false;
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

function ensureOscilloscopeTexture() {
    if (window.oscilloscopeTexture) return;
    window.oscilloscopeTexture = new Image();
    window.oscilloscopeTexture.src = './assets/oscilloscope-glass.jpg';
    window.oscilloscopeTexture.onerror = function () {
        console.log('Failed to load oscilloscope texture');
        window.oscilloscopeTextureError = true;
    };
    window.oscilloscopeTexture.onload = function () {
        console.log('Oscilloscope texture loaded');
    };
}

function paintOscilloscopeCanvas(canvas, dataArray) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    if (window.oscilloscopeTexture && window.oscilloscopeTexture.complete && !window.oscilloscopeTextureError) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.drawImage(window.oscilloscopeTexture, 0, 0, width, height);
        ctx.globalAlpha = 1.0;
        ctx.restore();
    }

    ctx.save();
    ctx.shadowColor = '#00ff00';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.4)';
    ctx.beginPath();

    const sliceWidth = width / state.analyser.frequencyBinCount;
    let x = 0;

    for (let i = 0; i < state.analyser.frequencyBinCount; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * height / 2;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        x += sliceWidth;
    }

    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.restore();

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#00ff00';
    ctx.beginPath();

    x = 0;
    for (let i = 0; i < state.analyser.frequencyBinCount; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * height / 2;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
        x += sliceWidth;
    }

    ctx.lineTo(width, height / 2);
    ctx.stroke();
}

function drawOscilloscope() {
    if (!state.analyser) return;
    const mainCanvas = document.getElementById('oscilloscope');
    const kbCanvas = document.getElementById('kbOscilloscope');
    if (!mainCanvas && !kbCanvas) return;

    const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
    ensureOscilloscopeTexture();

    function draw() {
        requestAnimationFrame(draw);
        state.analyser.getByteTimeDomainData(dataArray);
        paintOscilloscopeCanvas(mainCanvas, dataArray);
        paintOscilloscopeCanvas(kbCanvas, dataArray);
    }

    draw();
}


const ADSR_PAD_X = 5;
const ADSR_SUSTAIN_TIME = 0.5;
const ADSR_HIT_RADIUS = 14;
/** Floor so AD segments stay visible when knobs are at 0. */
const ADSR_SEG_FLOOR = 0.02;

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

/** Shared ADSR (or Acid AD) polyline geometry (canvas pixel space). */
function getAdsrLayout(width, height, params, invert = false) {
    const acid = !!state.acidMode;
    const attack = Math.max(ADSR_SEG_FLOOR, params.attack);
    const decay = Math.max(ADSR_SEG_FLOOR, params.decay);
    const sustain = acid ? 0 : params.sustain;
    const release = acid ? 0 : Math.max(0, params.release);
    const sustainTime = acid ? 0 : ADSR_SUSTAIN_TIME;

    const totalDuration = acid
        ? attack + decay
        : attack + decay + sustainTime + release;
    const attackWidth = (attack / totalDuration) * width;
    const decayWidth = (decay / totalDuration) * width;
    const sustainWidth = acid ? 0 : (sustainTime / totalDuration) * width;
    const releaseWidth = acid ? 0 : (release / totalDuration) * width;
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
    const ySustain = yAt(sustain);
    const x0 = ADSR_PAD_X;
    const xA = ADSR_PAD_X + attackWidth;
    const xD = ADSR_PAD_X + attackWidth + decayWidth;
    const xS = ADSR_PAD_X + attackWidth + decayWidth + sustainWidth;
    const xR = ADSR_PAD_X + attackWidth + decayWidth + sustainWidth + releaseWidth;

    if (acid) {
        return {
            acid: true,
            totalDuration,
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
                attack: { x: xA, y: yPeak, key: 'attack' },
                decay: { x: xD, y: y0, key: 'decay' },
            },
            path: [
                { x: x0, y: y0 },
                { x: xA, y: yPeak },
                { x: xD, y: y0 },
            ],
            labels: [
                { text: 'A', x: ADSR_PAD_X + attackWidth / 2 },
                { text: 'D', x: ADSR_PAD_X + attackWidth + decayWidth / 2 },
            ],
        };
    }

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
        canvasId = 'adsrVisualizer',
        attackId = 'attack',
        decayId = 'decay',
        sustainId = 'sustain',
        releaseId = 'release',
        glowColor = '#00ff00',
        lineColor = '#66ff66',
        glowAlpha = 0.2,
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
    
    // First pass - draw the glow effect with reduced intensity
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 5;
    ctx.lineWidth = 3;
    const glowR = parseInt(glowColor.slice(1, 3), 16);
    const glowG = parseInt(glowColor.slice(3, 5), 16);
    const glowB = parseInt(glowColor.slice(5, 7), 16);
    ctx.strokeStyle = `rgba(${glowR}, ${glowG}, ${glowB}, ${glowAlpha})`;
    strokeAdsrPath(ctx, path);
    ctx.restore();
    
    // Second pass - draw the crisp ADSR / AD line
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
    if (canvas.id === 'adsrVisualizer' || canvas.id === 'kbAdsrVisualizer') return AMP_ADSR_IDS;
    if (canvas.id === 'filterAdsrVisualizer' || canvas.id === 'kbFilterAdsrVisualizer') {
        return FILTER_ADSR_IDS;
    }
    return null;
}

function resolveAdsrMapping(canvas, e) {
    const ids = idsForAdsrCanvas(canvas);
    if (!ids) return null;
    const invert = canvas.id === 'filterAdsrVisualizer' || canvas.id === 'kbFilterAdsrVisualizer'
        ? !!state.filterEnvInvert
        : false;
    const { params, key } = hitAdsrKey(canvas, e, ids, invert);
    if (!params || !key) return { unmappable: true, host: canvas };
    const catalogKey = ids[`${key}Id`];
    if (!catalogKey) return { unmappable: true, host: canvas };
    return { key: catalogKey, canonical: document.getElementById(catalogKey) || null, host: canvas };
}

/** Invisible hit-targets on envelope corners — appearance unchanged. */
function bindAdsrCanvasDrag(canvasId, ids, { getInvert = () => false, isFilter = false } = {}) {
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
            // AD only: A and D share the full width
            if (dragKey === 'attack') {
                const rest = Math.max(ADSR_SEG_FLOOR, params.decay);
                const denom = 1 - u;
                const nextA = denom > 1e-4 ? (u * rest) / denom : adsrKeyMax(ids.attackId, 2);
                setAdsrValue(ids.attackId, nextA);
            } else if (dragKey === 'decay') {
                // Decay corner at u = A/(A+D); keep A fixed → D = A/u - A
                const nextD = u > 1e-4
                    ? Math.max(0, params.attack * (1 / u - 1))
                    : adsrKeyMax(ids.decayId, 2);
                setAdsrValue(ids.decayId, nextD);
            }
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

        if (isFilter) drawFilterADSRVisualizer();
        else drawADSRVisualizer();
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
    bindAdsrCanvasDrag('adsrVisualizer', AMP_ADSR_IDS, { isFilter: false });
    bindAdsrCanvasDrag('kbAdsrVisualizer', AMP_ADSR_IDS, { isFilter: false });
    bindAdsrCanvasDrag('filterAdsrVisualizer', FILTER_ADSR_IDS, {
        getInvert: filterInvert,
        isFilter: true,
    });
    bindAdsrCanvasDrag('kbFilterAdsrVisualizer', FILTER_ADSR_IDS, {
        getInvert: filterInvert,
        isFilter: true,
    });
    registerAdsrMappingResolver(resolveAdsrMapping);
}

function drawADSRVisualizer(options = {}) {
    paintADSRVisualizer(options);
    const canvasId = options.canvasId ?? 'adsrVisualizer';
    if (canvasId === 'adsrVisualizer') {
        paintADSRVisualizer({ ...options, canvasId: 'kbAdsrVisualizer' });
    }
}


function drawFilterADSRVisualizer() {
    const options = {
        canvasId: 'filterAdsrVisualizer',
        attackId: 'filterAttack',
        decayId: 'filterDecay',
        sustainId: 'filterSustain',
        releaseId: 'filterRelease',
        glowColor: '#00ffff',
        lineColor: '#66ffff',
        invert: !!state.filterEnvInvert,
    };
    paintADSRVisualizer(options);
    paintADSRVisualizer({ ...options, canvasId: 'kbFilterAdsrVisualizer' });
}

window.addEventListener('load', function() {
    setTimeout(() => {
        drawADSRVisualizer();
        drawFilterADSRVisualizer();
        initAdsrCanvasDragging();
    }, 500);
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdsrCanvasDragging, { once: true });
} else {
    initAdsrCanvasDragging();
}


document.getElementById('masterTune')?.addEventListener('input', function () {
    if ((state.isPlaying || state.isArping) && !window.noteVisualizerPreviewActive) {
        updateNoteVisualizer(getStepTotalTune(state.currentStep), getStepFineCents(state.currentStep));
    }
});

document.getElementById('octaveSwitch')?.addEventListener('input', function () {
    if ((state.isPlaying || state.isArping) && !window.noteVisualizerPreviewActive) {
        updateNoteVisualizer(getStepTotalTune(state.currentStep), getStepFineCents(state.currentStep));
    }
});

document.getElementById('semitoneSwitch')?.addEventListener('input', function () {
    if ((state.isPlaying || state.isArping) && !window.noteVisualizerPreviewActive) {
        updateNoteVisualizer(getStepTotalTune(state.currentStep), getStepFineCents(state.currentStep));
    }
});

function updateNoteVisualizer(totalTune, cents = 0) {
    const noteName = semitonesToNoteName(totalTune, cents);
    const preview = !!window.noteVisualizerPreviewActive;
    noteVfdHosts().forEach((host) => renderNoteVfd(host, noteName, { preview }));
}

/** Idle note screen (fixed 12-cell matrix, centered "Note"). */
function clearNoteVisualizer() {
    noteVfdHosts().forEach((host) => renderNoteVfd(host, NOTE_VFD_IDLE_TEXT, { preview: false }));
}

/** Catch a previously-skipped host up to the latest note text (e.g. panel expand). */
export function syncNoteVfdFromPeer(hostId, peerId = 'kbPatternNoteVisualizer') {
    const host = document.getElementById(hostId);
    if (!host || !noteVfdHostIsVisible(host)) return;
    const peer = document.getElementById(peerId) || document.getElementById('noteVisualizer');
    ensureNoteVfd(host);
    const chars = host.querySelector('.note-vfd-chars');
    if (chars) delete chars.dataset.painted;
    const text = peer?.dataset.text || NOTE_VFD_IDLE_TEXT;
    const preview = !!peer?.classList.contains('note-vfd--preview');
    renderNoteVfd(host, text, { preview });
}


let logoFlickerRunning = false;

function logoOverlays() {
    return [
        document.getElementById('logo-overlay'),
        document.getElementById('kb-logo-overlay'),
    ].filter(Boolean);
}

function startLogoFlicker() {
    const overlays = logoOverlays();
    if (!overlays.length || logoFlickerRunning) return;
    logoFlickerRunning = true;

    function randomFlicker() {
        const visible = overlays.filter((el) => !el.classList.contains('hidden'));
        if (!visible.length) {
            logoFlickerRunning = false;
            return;
        }

        if (Math.random() > 0.97) {
            visible.forEach((overlay) => {
                const logoSvg = overlay.querySelector('svg');
                if (!logoSvg) return;
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
            });
        }

        requestAnimationFrame(randomFlicker);
    }

    randomFlicker();
}

/** Hide the logo so the oscilloscope waveform is visible. */
function hideLogoOverlay() {
    const overlays = logoOverlays();
    if (!overlays.length) return;
    if (state.logoDisplayTimeout) {
        clearTimeout(state.logoDisplayTimeout);
        state.logoDisplayTimeout = null;
    }
    overlays.forEach((el) => el.classList.add('hidden'));
}

/**
 * Show the logo again after audio goes idle.
 * @param {number} delayMs - delay before revealing (matches sequencer stop fade)
 */
function showLogoOverlay(delayMs = 0) {
    const overlays = logoOverlays();
    if (!overlays.length) return;

    if (state.logoDisplayTimeout) {
        clearTimeout(state.logoDisplayTimeout);
        state.logoDisplayTimeout = null;
    }

    const reveal = () => {
        // Keep scope visible while sequencer or keyboard voice is active
        if (state.isPlaying || state.keyboardVoiceActive) return;
        overlays.forEach((el) => el.classList.remove('hidden'));
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
    logoOverlays().forEach((el) => el.classList.remove('hidden'));
    startLogoFlicker();
});


export { drawOscilloscope, drawADSRVisualizer, drawFilterADSRVisualizer, updateNoteVisualizer, clearNoteVisualizer, hideLogoOverlay, showLogoOverlay };
