import * as THREE from './vendor/three.module.js';
import {
    createHeartPanel,
    PANEL_W,
} from './synth-panel.js?v=10';
import { createKnob } from './vr-knob.js?v=7';
import { createButton } from './vr-button.js?v=2';
import { noHit } from './vr-label.js?v=2';

export const CHASSIS_W = PANEL_W;
const DECK_D = 0.215;
const DECK_H = 0.050;
const LEFT_BAY = 0.072;
const RIGHT_MARGIN = 0.016;
const FRONT_LIP = 0.012;

const WHITE_W = 0.018;
const WHITE_GAP = 0.0008;
const WHITE_L = 0.108;
const WHITE_H = 0.011;
const BLACK_W = 0.011;
const BLACK_L = 0.066;
const BLACK_H = 0.017;
const PRESS_DIP = 0.0036;
const KEY_GREEN = 0x2aff6a;
const KEY_HOVER_WHITE = 0x1a2f1a;
const KEY_HOVER_BLACK = 0x0c1c0c;
const KEY_PRESS_BODY = 0x0e2c12;

const SPAN = 36;
const WHITE_COUNT = 22;
const DEFAULT_START = -12;
const OCTAVE_MIN = -2;
const OCTAVE_MAX = 2;

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const BLACK_X_FRAC = { 1: 0.64, 3: 0.78, 6: 0.58, 8: 0.70, 10: 0.84 };

const CHASSIS_COLOR = 0x4e4e4a;
const NATURAL_COLOR = 0x161616;
const ACCIDENTAL_COLOR = 0x0a0a0a;
const PRESS_COLOR = 0x3a3a3a;
const OCT_COLOR = 0x3a3a38;
const OCT_DIM = 0x2a2a28;
const DECK_DRAG = new THREE.Vector3(0, 0, -1);

function isBlackDegree(degree) {
    const pc = ((degree % 12) + 12) % 12;
    return BLACK_PCS.has(pc);
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('logo image failed: ' + src));
        img.src = src;
    });
}

async function svgLogoTexture(url, { recolor = false, fill = '#e6e6e2' } = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('logo fetch ' + res.status);
    let svg = await res.text();
    if (recolor) {
        svg = svg.replace(/fill:\s*#[0-9a-fA-F]{3,8}/gi, `fill:${fill}`);
        svg = svg.replace(/fill="#[0-9a-fA-F]{3,8}"/gi, `fill="${fill}"`);
    }
    const vb = svg.match(/viewBox=["']([^"']+)["']/);
    let vw = 256;
    let vh = 128;
    if (vb) {
        const p = vb[1].trim().split(/[\s,]+/).map(Number);
        if (p[2] > 0) vw = p[2];
        if (p[3] > 0) vh = p[3];
    }
    if (!/\swidth=/.test(svg)) {
        svg = svg.replace(/<svg\b/, `<svg width="${vw}" height="${vh}"`);
    }
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const obj = URL.createObjectURL(blob);
    try {
        const img = await loadImage(obj);
        const aspect = vw / Math.max(0.001, vh);
        const maxW = 512;
        const maxH = 256;
        let dw;
        let dh;
        if (aspect >= maxW / maxH) {
            dw = maxW;
            dh = Math.max(48, Math.round(maxW / aspect));
        } else {
            dh = maxH;
            dw = Math.max(48, Math.round(maxH * aspect));
        }
        const padX = 28;
        const padY = 36;
        const canvas = document.createElement('canvas');
        canvas.width = dw + padX * 2;
        canvas.height = dh + padY * 2;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, padX, padY, dw, dh);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 16;
        tex.needsUpdate = true;
        return tex;
    } finally {
        URL.revokeObjectURL(obj);
    }
}

function applyModeLogo(mesh, on) {
    const logo = mesh.userData.logo;
    if (!logo) return;
    logo.material.color.setHex(on ? mesh.userData.lampOn : 0xb4b4ae);
}

function whiteIndexBefore(degree) {
    let n = 0;
    for (let d = 0; d < degree; d++) {
        if (!isBlackDegree(d)) n++;
    }
    return n;
}

export function createPoly800() {
    const board = new THREE.Group();
    board.name = 'poly800';

    const chassisMat = new THREE.MeshStandardMaterial({
        color: CHASSIS_COLOR,
        roughness: 0.78,
        metalness: 0.08,
    });
    const deck = new THREE.Group();
    deck.name = 'keyDeck';
    board.add(deck);

    const chassis = new THREE.Mesh(
        new THREE.BoxGeometry(CHASSIS_W, DECK_H, DECK_D),
        chassisMat,
    );
    deck.add(chassis);

    const naturalGeo = new THREE.BoxGeometry(WHITE_W, WHITE_H, WHITE_L);
    const accidentalGeo = new THREE.BoxGeometry(BLACK_W, BLACK_H, BLACK_L);
    const naturalMat = new THREE.MeshStandardMaterial({
        color: NATURAL_COLOR,
        roughness: 0.48,
        metalness: 0.04,
    });
    const accidentalMat = new THREE.MeshStandardMaterial({
        color: ACCIDENTAL_COLOR,
        roughness: 0.32,
        metalness: 0.06,
    });

    const usedW = WHITE_COUNT * WHITE_W + (WHITE_COUNT - 1) * WHITE_GAP;
    const availW = CHASSIS_W - LEFT_BAY - RIGHT_MARGIN;
    const keybedLeft = -CHASSIS_W / 2 + LEFT_BAY + (availW - usedW) / 2;
    const nearZ = DECK_D / 2 - FRONT_LIP;
    const farZ = nearZ - WHITE_L;

    const interactives = [];
    const voiceBayHits = [];
    const keyMeshes = [];
    let octave = 0;
    let scaleCheck = () => true;

    function startSemi() {
        return DEFAULT_START + octave * 12;
    }

    function xForWhiteIndex(i) {
        return keybedLeft + i * (WHITE_W + WHITE_GAP) + WHITE_W / 2;
    }

    for (let degree = 0; degree <= SPAN; degree++) {
        const black = isBlackDegree(degree);
        const mesh = new THREE.Mesh(
            black ? accidentalGeo : naturalGeo,
            (black ? accidentalMat : naturalMat).clone(),
        );
        const wi = whiteIndexBefore(degree);
        if (black) {
            const pc = ((degree % 12) + 12) % 12;
            const left = keybedLeft + wi * (WHITE_W + WHITE_GAP);
            mesh.position.x = left + WHITE_W * (BLACK_X_FRAC[pc] ?? 0.7);
            mesh.position.y = DECK_H / 2 + BLACK_H / 2;
            mesh.position.z = farZ + BLACK_L / 2;
        } else {
            mesh.position.x = xForWhiteIndex(wi);
            mesh.position.y = DECK_H / 2 + WHITE_H / 2;
            mesh.position.z = nearZ - WHITE_L / 2;
        }
        mesh.userData = {
            kind: 'note',
            degree,
            isBlack: black,
            restY: mesh.position.y,
            restColor: black ? ACCIDENTAL_COLOR : NATURAL_COLOR,
            semitone: startSemi() + degree,
        };
        deck.add(mesh);
        keyMeshes.push(mesh);
        interactives.push(mesh);
    }

    function makeOctButton(kind, x, z) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.028, 0.01, 0.028),
            new THREE.MeshStandardMaterial({ color: OCT_COLOR, roughness: 0.6, metalness: 0.1 }),
        );
        mesh.position.set(x, DECK_H / 2 + 0.006, z);
        mesh.userData = {
            kind,
            restY: mesh.position.y,
            restColor: OCT_COLOR,
        };
        const markMat = new THREE.MeshStandardMaterial({ color: 0xc8c8c4, roughness: 0.45, metalness: 0.05 });
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.003, 0.0026), markMat);
        bar.position.y = 0.006;
        bar.raycast = noHit;
        mesh.add(bar);
        if (kind === 'octUp') {
            const stem = new THREE.Mesh(new THREE.BoxGeometry(0.0026, 0.003, 0.012), markMat);
            stem.position.y = 0.006;
            stem.raycast = noHit;
            mesh.add(stem);
        }
        deck.add(mesh);
        interactives.push(mesh);
        return mesh;
    }

    const bayLeft = -CHASSIS_W / 2;
    const stripZ = nearZ - WHITE_L / 2;
    const transportZ = (farZ + (-DECK_D / 2)) * 0.5;
    const octDown = makeOctButton('octDown', bayLeft + 0.022, transportZ);
    const octUp = makeOctButton('octUp', bayLeft + 0.054, transportZ);

    const deckY = DECK_H / 2 + 0.007;
    const tickMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d0, roughness: 0.4, metalness: 0.08 });
    const rollMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a28,
        roughness: 0.55,
        metalness: 0.12,
        emissive: 0x000000,
    });

    function makeVertStrip(kind, x) {
        const depth = WHITE_L;
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.024, 0.012, depth),
            rollMat.clone(),
        );
        mesh.position.set(x, deckY, stripZ);
        mesh.userData = {
            kind,
            restY: mesh.position.y,
            restColor: 0x2a2a28,
            axis: 'z',
            half: depth / 2,
        };
        const tick = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.004, 0.008), tickMat);
        tick.position.y = 0.007;
        tick.raycast = noHit;
        mesh.add(tick);
        mesh.userData.tick = tick;
        deck.add(mesh);
        interactives.push(mesh);
        return mesh;
    }

    const pitchRoll = makeVertStrip('pitch', bayLeft + 0.018);
    const lfoRoll = makeVertStrip('lfo', bayLeft + 0.048);

    const startBtn = createButton(deck, {
        x: 0.018, y: deckY, z: transportZ,
        w: 0.036, h: 0.022, d: 0.01,
        label: 'START', special: 'startStop', lamp: true, layout: 'deck',
    });
    startBtn.userData.kind = 'startStop';
    interactives.push(startBtn);

    interactives.push(createKnob(deck, {
        x: -0.12, y: deckY + 0.002, z: transportZ,
        key: 'tempo', label: 'TEMPO', size: 0.018, dragLocal: DECK_DRAG, layout: 'deck',
    }));
    const revBtn = createButton(deck, {
        x: -0.082, y: deckY, z: transportZ,
        w: 0.028, h: 0.018, d: 0.01,
        label: 'REV', special: 'reverse', layout: 'deck',
    });
    interactives.push(revBtn);
    interactives.push(createKnob(deck, {
        x: -0.048, y: deckY + 0.002, z: transportZ,
        key: 'division', label: 'DIV', size: 0.018, dragLocal: DECK_DRAG, layout: 'deck',
    }));
    interactives.push(createKnob(deck, {
        x: -0.012, y: deckY + 0.002, z: transportZ,
        key: 'stepCount', label: 'STEPS', size: 0.018, dragLocal: DECK_DRAG, layout: 'deck',
    }));

    const MODE_SPEC = [
        { id: 'acid', on: 0xffcc33, off: 0x3a3010, em: 0xaa8800, svg: '../Acid Mode.svg', recolor: true },
        { id: 'berlin', on: 0x44aaff, off: 0x102030, em: 0x2266aa, svg: '../Berlin-Dream-Lockup.svg', recolor: true },
        { id: 'poly', on: 0xffe8a0, off: 0x3a3828, em: 0x887744, svg: '../SVG/ingy-6-lockup.svg', recolor: false },
        { id: 'multitudes', on: 0xff66cc, off: 0x3a1028, em: 0xaa2266, svg: '../SVG/multitudes-logo-lockup.svg', recolor: true },
    ];
    const modeButtons = [];
    let lastModeFlags = {};
    const modeZ = transportZ;
    const modePitch = 0.048;
    const modeStartX = 0.072;
    MODE_SPEC.forEach((spec, i) => {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.044, 0.011, 0.022),
            new THREE.MeshStandardMaterial({ color: 0x3a3a38, roughness: 0.58, metalness: 0.1 }),
        );
        mesh.position.set(modeStartX + i * modePitch, DECK_H / 2 + 0.007, modeZ);
        mesh.userData = {
            kind: 'mode',
            mode: spec.id,
            restY: mesh.position.y,
            restColor: 0x3a3a38,
        };
        const lamp = new THREE.Mesh(
            new THREE.BoxGeometry(0.036, 0.0024, 0.0032),
            new THREE.MeshStandardMaterial({
                color: spec.off,
                emissive: 0x000000,
                roughness: 0.35,
                metalness: 0.15,
            }),
        );
        lamp.position.set(0, 0.0066, -0.0082);
        lamp.raycast = noHit;
        mesh.add(lamp);
        mesh.userData.lamp = lamp;
        mesh.userData.lampOn = spec.on;
        mesh.userData.lampOff = spec.off;
        mesh.userData.lampEm = spec.em;
        deck.add(mesh);
        interactives.push(mesh);
        modeButtons.push(mesh);

        const logoUrl = new URL(spec.svg, import.meta.url).href;
        svgLogoTexture(logoUrl, { recolor: spec.recolor }).then((tex) => {
            const img = tex.image;
            const aspect = (img && img.width && img.height) ? img.width / img.height : 3;
            const logoW = 0.038;
            const logoH = THREE.MathUtils.clamp(logoW / aspect, 0.0075, 0.016);
            const logo = new THREE.Mesh(
                new THREE.PlaneGeometry(logoW, logoH),
                new THREE.MeshBasicMaterial({
                    map: tex,
                    transparent: true,
                    color: 0xb4b4ae,
                    depthWrite: false,
                }),
            );
            logo.rotation.x = -Math.PI / 2;
            logo.position.set(0, 0.0064, 0.001);
            logo.raycast = noHit;
            mesh.add(logo);
            mesh.userData.logo = logo;
            applyModeLogo(mesh, !!lastModeFlags[spec.id]);
        }).catch((err) => {
            console.warn('Mode logo failed', spec.id, err);
        });
    });

    const heartApi = createHeartPanel({ interactives, voiceBayHits });
    const heart = heartApi.heart;
    heart.position.set(0, DECK_H / 2, -DECK_D / 2 + 0.008);
    heart.rotation.x = 0;
    board.add(heart);

    for (const m of voiceBayHits) {
        if (!interactives.includes(m)) interactives.push(m);
    }

    function setModeLamps(flags) {
        lastModeFlags = flags || {};
        for (const mesh of modeButtons) {
            const on = !!lastModeFlags[mesh.userData.mode];
            const lamp = mesh.userData.lamp;
            lamp.material.color.setHex(on ? mesh.userData.lampOn : mesh.userData.lampOff);
            lamp.material.emissive.setHex(on ? mesh.userData.lampEm : 0x000000);
            lamp.material.emissiveIntensity = on ? 0.9 : 0;
            applyModeLogo(mesh, on);
        }
        const any = !!(flags?.acid || flags?.berlin || flags?.poly || flags?.multitudes);
        heartApi.setVoiceBayLive(!any);
    }

    function setPitchNorm(n) {
        const t = THREE.MathUtils.clamp(n, -1, 1);
        pitchRoll.userData.tick.position.z = -t * (pitchRoll.userData.half - 0.01);
    }
    function setLfoNorm(n) {
        const t = THREE.MathUtils.clamp(n, 0, 1);
        lfoRoll.userData.tick.position.z = (0.5 - t) * (lfoRoll.userData.half * 2 - 0.016);
    }
    function setPlaying(on) {
        startBtn.userData.setOn?.(!!on);
    }
    setPitchNorm(0);
    setLfoNorm(0);
    setPlaying(false);
    setModeLamps({});

    function refreshKeySemitones() {
        const start = startSemi();
        for (const mesh of keyMeshes) {
            mesh.userData.semitone = start + mesh.userData.degree;
        }
        const atMin = octave <= OCTAVE_MIN;
        const atMax = octave >= OCTAVE_MAX;
        octDown.material.color.setHex(atMin ? OCT_DIM : OCT_COLOR);
        octUp.material.color.setHex(atMax ? OCT_DIM : OCT_COLOR);
        octDown.userData.restColor = atMin ? OCT_DIM : OCT_COLOR;
        octUp.userData.restColor = atMax ? OCT_DIM : OCT_COLOR;
        applyScaleFilter(scaleCheck);
    }

    function shiftOctave(delta) {
        const next = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, octave + delta));
        if (next === octave) return false;
        octave = next;
        refreshKeySemitones();
        return true;
    }

    function paintKey(mesh) {
        const mat = mesh.material;
        if (!mat) return;
        const pressed = !!mesh.userData.pressed;
        const hovered = !!mesh.userData.hovered;
        if (mesh.userData.restY != null) {
            mesh.position.y = pressed ? mesh.userData.restY - PRESS_DIP : mesh.userData.restY;
        }
        if (pressed || hovered) {
            mat.color.setHex(pressed
                ? KEY_PRESS_BODY
                : (mesh.userData.isBlack ? KEY_HOVER_BLACK : KEY_HOVER_WHITE));
            if (mat.emissive) {
                mat.emissive.setHex(KEY_GREEN);
                mat.emissiveIntensity = pressed ? 0.95 : 0.42;
            }
            mat.toneMapped = false;
            return;
        }
        mat.color.setHex(mesh.userData.restColor);
        if (mat.emissive) {
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
        }
        mat.toneMapped = true;
    }

    function applyScaleFilter(isInScale) {
        if (typeof isInScale === 'function') scaleCheck = isInScale;
        for (const mesh of keyMeshes) {
            const on = scaleCheck(mesh.userData.semitone);
            mesh.visible = on;
            if (!on) {
                mesh.userData.pressed = false;
                mesh.userData.hovered = false;
                if (mesh.userData.restY != null) mesh.position.y = mesh.userData.restY;
            }
            paintKey(mesh);
        }
    }

    function setKeyHover(mesh, on) {
        if (!mesh || mesh.userData.kind !== 'note' || !mesh.visible) return;
        mesh.userData.hovered = !!on;
        paintKey(mesh);
    }

    function setPressed(mesh, on) {
        if (!mesh) return;
        const kind = mesh.userData.kind;
        if (kind === 'note') {
            if (!mesh.visible) return;
            mesh.userData.pressed = !!on;
            paintKey(mesh);
            return;
        }
        if (kind === 'pitch' || kind === 'lfo' || kind === 'knob' || kind === 'xy') {
            if (mesh.material?.emissive) mesh.material.emissive.setHex(on ? 0x1a1a18 : 0x000000);
            return;
        }
        if (kind === 'select' || kind === 'selectItem' || kind === 'hex') return;
        const dip = 0.0024;
        if (mesh.userData.restY != null && mesh.parent?.name !== 'heartFace') {
            mesh.position.y = on ? mesh.userData.restY - dip : mesh.userData.restY;
        }
        if (kind === 'mode') return;
        if (mesh.material?.color && mesh.userData.restColor != null) {
            mesh.material.color.setHex(on ? PRESS_COLOR : mesh.userData.restColor);
        }
    }

    function meshForSemi(semi) {
        return keyMeshes.find((m) => m.userData.semitone === semi) || null;
    }

    refreshKeySemitones();

    return {
        board,
        interactives,
        keyMeshes,
        hex: heartApi.hex,
        xy: heartApi.xy,
        voiceBay: heartApi.voiceBay,
        setVoiceBayLive: heartApi.setVoiceBayLive,
        syncSpecials: (state, orderLabel) => {
            heartApi.syncSpecials(state, orderLabel);
            revBtn.userData.setOn?.(!!state.isReverse);
        },
        setPressed,
        setKeyHover,
        shiftOctave,
        applyScaleFilter,
        meshForSemi,
        getOctave: () => octave,
        setPitchNorm,
        setLfoNorm,
        setPlaying,
        setModeLamps,
        deckH: DECK_H,
    };
}

export function placeOnDesk(board, { topY, z }) {
    board.position.set(0, topY + DECK_H / 2 + 0.001, z);
    board.rotation.x = 0;
}
