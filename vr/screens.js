import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { DESK_TOP_Y, DESK_FRONT_Z, DESK_DEPTH } from './loft.js?v=22';
import { state } from '../js/state.js?v=116';
import { getHeldNotes } from '../js/held-notes.js?v=9';
import { formatNoteOrChord } from '../js/chord-name.js?v=3';
import { semitonesToNoteName } from '../js/tuning.js?v=80';
import {
    paintStepsFieldset,
    stepsNeedPaint,
    markStepsDirty,
    setSoundingStep,
    getSoundingStep,
    pointerDownOnSteps,
    pointerMoveOnSteps,
    pointerUpOnSteps,
} from './steps-fieldset.js?v=11';
import {
    MATRIX_5X7,
    padNoteVfdText,
    NOTE_VFD_COLS,
    NOTE_VFD_ROWS,
    NOTE_VFD_DOT_COLS,
} from '../js/vfd-matrix.js?v=6';

const PROFEEL_SCREEN = { w: 0.29, h: 0.1939, x: -0.03, y: 0.2094, z: 0.2075 };

function canvasTex(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#020402';
    ctx.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return { canvas, ctx, tex };
}

function screenMat(map) {
    return new THREE.MeshBasicMaterial({
        map,
        color: 0xffffff,
        toneMapped: false,
    });
}

function makeProfeel({ canvasW, canvasH, yaw = 0, scale = 1 }) {
    const { canvas, ctx, tex } = canvasTex(canvasW, canvasH);
    const g = new THREE.Group();
    const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(PROFEEL_SCREEN.w * scale, PROFEEL_SCREEN.h * scale),
        screenMat(tex),
    );
    screen.position.set(
        PROFEEL_SCREEN.x * scale,
        PROFEEL_SCREEN.y * scale,
        PROFEEL_SCREEN.z * scale,
    );
    g.add(screen);

    const url = new URL('./models/sony-profeel.glb', import.meta.url);
    url.searchParams.set('v', '1');
    const loader = new GLTFLoader();
    loader.load(
        url.href,
        (gltf) => {
            const body = gltf.scene;
            body.scale.setScalar(scale);
            body.traverse((o) => {
                if (!o.isMesh) return;
                o.castShadow = false;
                o.receiveShadow = false;
            });
            g.add(body);
        },
        undefined,
        (err) => {
            console.warn('Sony ProFeel GLB failed', err);
        },
    );

    g.rotation.y = yaw;
    return { group: g, canvas, ctx, tex, screen };
}

function glyphRows(ch) {
    if (Object.prototype.hasOwnProperty.call(MATRIX_5X7, ch)) return MATRIX_5X7[ch];
    const upper = ch.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(MATRIX_5X7, upper)) return MATRIX_5X7[upper];
    return MATRIX_5X7[' '];
}

const liveKeys = new Set();

export function liveDisplayDown(semi) {
    if (Number.isFinite(semi)) liveKeys.add(semi);
}

export function liveDisplayUp(semi) {
    if (semi == null) liveKeys.clear();
    else liveKeys.delete(semi);
}

function liveDisplayNotes() {
    if (liveKeys.size) return [...liveKeys].sort((a, b) => a - b);
    return getHeldNotes();
}

let seqNoteText = 'Note';

function applySeqStepUi(detail) {
    const d = detail || {};
    setSoundingStep(Number.isFinite(d.step) ? d.step : -1);
    if (d.on === false || d.tune == null) return;
    try {
        const notes = Array.isArray(d.cellNotes) ? d.cellNotes : [];
        if (notes.length > 1) {
            const root = notes[0];
            const sounding = notes.map((n) => n - root + d.tune);
            seqNoteText = formatNoteOrChord(sounding, d.fine) || 'Note';
        } else {
            seqNoteText = semitonesToNoteName(d.tune, d.fine);
        }
    } catch (_) { /* */ }
}

function currentNoteText() {
    try {
        if (state.isPlaying || state.isArping) return seqNoteText;
        const held = liveDisplayNotes();
        if (held.length > 1) return formatNoteOrChord(held, 0) || 'Note';
        if (held.length === 1) return semitonesToNoteName(held[0], 0);
    } catch (_) { /* bank or audio not ready */ }
    return 'Note';
}

function paintNoteVfd(ctx, w, h, text) {
    ctx.fillStyle = '#030801';
    ctx.fillRect(0, 0, w, h);
    const padded = padNoteVfdText(text);
    const marginX = 10;
    const marginY = 18;
    const cellGap = 6;
    const cellW = (w - marginX * 2 - cellGap * (NOTE_VFD_COLS - 1)) / NOTE_VFD_COLS;
    const dotGap = 1.4;
    const dot = Math.min(
        (cellW - dotGap * (NOTE_VFD_DOT_COLS - 1)) / NOTE_VFD_DOT_COLS,
        (h - marginY * 2 - dotGap * (NOTE_VFD_ROWS - 1)) / NOTE_VFD_ROWS,
    );
    const gridH = NOTE_VFD_ROWS * dot + (NOTE_VFD_ROWS - 1) * dotGap;
    const originY = (h - gridH) / 2;

    for (let c = 0; c < NOTE_VFD_COLS; c++) {
        const rows = glyphRows(padded[c] ?? ' ');
        const ox = marginX + c * (cellW + cellGap);
        for (let r = 0; r < NOTE_VFD_ROWS; r++) {
            const mask = rows[r] ?? 0;
            for (let col = 0; col < NOTE_VFD_DOT_COLS; col++) {
                const on = (mask & (0b10000 >> col)) !== 0;
                const x = ox + col * (dot + dotGap);
                const y = originY + r * (dot + dotGap);
                ctx.fillStyle = on ? '#00ff00' : 'rgba(0, 48, 0, 0.45)';
                ctx.beginPath();
                ctx.arc(x + dot / 2, y + dot / 2, Math.max(1.1, dot / 2.15), 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}

export function createDeskMonitors(scene, onFrame, interactives) {
    const steps = makeProfeel({
        canvasW: 1280,
        canvasH: 816,
        yaw: 0.28,
        scale: 1,
    });
    steps.group.position.set(-0.70, DESK_TOP_Y, DESK_FRONT_Z - DESK_DEPTH * 0.36);
    scene.add(steps.group);

    const notes = makeProfeel({
        canvasW: 320,
        canvasH: 128,
        yaw: -0.18,
        scale: 0.48,
    });
    notes.group.position.set(0.62, DESK_TOP_Y, DESK_FRONT_Z - DESK_DEPTH * 0.42);
    scene.add(notes.group);

    const screen = steps.screen;
    screen.userData.kind = 'stepsScreen';
    screen.userData.onStepsDown = (u, v) => pointerDownOnSteps(u, v, steps.canvas.width, steps.canvas.height);
    screen.userData.onStepsMove = (u, v) => pointerMoveOnSteps(u, v, steps.canvas.width, steps.canvas.height);
    screen.userData.onStepsUp = () => pointerUpOnSteps();
    interactives?.push(screen);

    let lastNote = '';
    let lastSteps = '';
    let lastPulsePaint = 0;
    paintNoteVfd(notes.ctx, notes.canvas.width, notes.canvas.height, 'Note');
    notes.tex.needsUpdate = true;
    try {
        paintStepsFieldset(steps.ctx, steps.canvas.width, steps.canvas.height);
        steps.tex.needsUpdate = true;
    } catch (err) {
        console.warn('Steps fieldset paint failed', err);
    }
    document.fonts?.ready?.then(() => markStepsDirty());

    document.addEventListener('ingysynth:seq-step-ui', (e) => {
        applySeqStepUi(e.detail);
        lastSteps = '';
        lastNote = '';
        markStepsDirty();
    });
    document.addEventListener('ingysynth:sequencer-stop', () => {
        setSoundingStep(-1);
        seqNoteText = 'Note';
        lastNote = '';
        lastSteps = '';
        markStepsDirty();
    });
    document.addEventListener('ingysynth:live-note-off', () => {
        if (!state.isPlaying && !state.isArping && !liveKeys.size) lastNote = '';
    });

    onFrame(() => {
        try {
            const playing = state.isPlaying || state.isArping;
            const now = performance.now();
            if (playing && getSoundingStep() >= 0 && now - lastPulsePaint > 33) {
                markStepsDirty();
            }
            const key = [
                state.editSlot,
                getSoundingStep(),
                playing ? 1 : 0,
                state.acidMode ? 1 : 0,
            ].join(':');
            if (key !== lastSteps || stepsNeedPaint()) {
                lastSteps = key;
                lastPulsePaint = now;
                paintStepsFieldset(steps.ctx, steps.canvas.width, steps.canvas.height);
                steps.tex.needsUpdate = true;
            }
        } catch (_) { /* */ }

        try {
            const text = currentNoteText();
            if (text !== lastNote) {
                lastNote = text;
                paintNoteVfd(notes.ctx, notes.canvas.width, notes.canvas.height, text);
                notes.tex.needsUpdate = true;
            }
        } catch (_) { /* */ }
    });

    return { steps, notes };
}
