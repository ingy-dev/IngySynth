import * as THREE from './vendor/three.module.js';
import { getNumber, getString, set, subscribe } from '../js/params.js?v=15';
import { SCALE_BANKS } from '../js/tuning.js?v=80';
import { makeLabel, noHit, whenFonts } from './vr-label.js?v=2';
import { createKnob } from './vr-knob.js?v=7';
import { createButton } from './vr-button.js?v=2';
import { createSelectTrigger, closeSelect } from './vr-select.js?v=2';
import { createXyPad } from './vr-xy.js?v=2';
import { createHexScope } from './hex-scope.js?v=6';

export const PANEL_W = 0.60;
export const PANEL_H = 0.335;
export const PANEL_T = 0.015;
/** 0 = standing straight up, face toward the player. */
export const PANEL_FROM_VERT = 0;

const WAVES = ['sawtooth', 'square', 'sine', 'triangle'];
const WAVE_LBL = ['SAW', 'SQR', 'SIN', 'TRI'];
const Y_UP = new THREE.Vector3(0, 1, 0);

const chassisMat = new THREE.MeshStandardMaterial({
    color: 0x4e4e4a,
    roughness: 0.78,
    metalness: 0.08,
});
const plateMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a38,
    roughness: 0.7,
    metalness: 0.06,
});
const dimMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a28,
    roughness: 0.75,
    metalness: 0.05,
    transparent: true,
    opacity: 0.55,
});

function scaleItems() {
    return SCALE_BANKS.map((bank) => ({
        id: `__bank:${bank.name}`,
        label: bank.name.replace(/^Bank \d+:\s*/, ''),
        children: bank.scales.map((s) => ({ id: s.id, label: s.name })),
    }));
}

function semitoneItems() {
    return ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
        .map((n) => ({ id: n, label: n }));
}

function noiseItems() {
    return ['white', 'pink', 'brown'].map((id) => ({ id, label: id }));
}

function fieldTitle(parent, text, x, y, w = 0.12) {
    const m = makeLabel(text, w, 0.011, { size: 28, pxW: 320, pxH: 48, color: '#c8c8c0' });
    m.position.set(x, y, 0.001);
    parent.add(m);
    return m;
}

function fieldPlate(parent, x, y, w, h) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), plateMat.clone());
    m.position.set(x, y, -0.0004);
    parent.add(m);
    return m;
}

function paintAdsr(canvas, ids, invert) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const a = Math.max(0.02, getNumber(ids[0], 0.1));
    const d = Math.max(0.02, getNumber(ids[1], 0.3));
    const s = Math.max(0, Math.min(1, getNumber(ids[2], 0.5)));
    const r = Math.max(0.02, getNumber(ids[3], 0.5));
    const susT = 0.5;
    const total = a + d + susT + r;
    const y0 = invert ? 8 : h - 8;
    const yPeak = invert ? h - 8 : 8;
    const yS = invert ? 8 + (1 - s) * (h - 16) : (h - 8) - s * (h - 16);
    const xA = 6 + (a / total) * (w - 12);
    const xD = xA + (d / total) * (w - 12);
    const xS = xD + (susT / total) * (w - 12);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = invert ? '#66ffff' : '#66ff66';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(6, y0);
    ctx.lineTo(xA, yPeak);
    ctx.lineTo(xD, yS);
    ctx.lineTo(xS, yS);
    ctx.lineTo(w - 6, y0);
    ctx.stroke();
}

function makeAdsrView(parent, x, y, w, h, ids, invertGet) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    );
    mesh.position.set(x, y, 0.001);
    mesh.raycast = noHit;
    parent.add(mesh);
    const draw = () => {
        paintAdsr(canvas, ids, !!invertGet?.());
        tex.needsUpdate = true;
    };
    ids.forEach((k) => subscribe(k, draw));
    whenFonts(draw);
    draw();
    mesh.userData.redraw = draw;
    return mesh;
}

function pushHit(list, mesh) {
    if (mesh && list) list.push(mesh);
}

function oscRow(face, hits, index, y, voiceBay) {
    const x0 = -0.255;
    const on = createButton(face, {
        x: x0, y, z: 0.004, w: 0.024, h: 0.012, d: 0.006,
        label: `O${index + 1}`, key: `osc-toggle-${index}`, voiceBay,
    });
    pushHit(hits, on);
    WAVES.forEach((wave, i) => {
        const btn = createButton(face, {
            x: x0 + 0.032 + i * 0.024, y, z: 0.004,
            w: 0.022, h: 0.012, d: 0.006,
            label: WAVE_LBL[i], key: `osc-type-${index}`, radioValue: wave, voiceBay,
        });
        pushHit(hits, btn);
    });
    pushHit(hits, createKnob(face, {
        x: 0.02, y, z: 0.006, key: `osc-tune-${index}`, label: 'TUNE',
        size: 0.016, voiceBay, dragLocal: Y_UP,
    }));
    pushHit(hits, createKnob(face, {
        x: 0.055, y, z: 0.006, key: `osc-vol-${index}`, label: 'VOL',
        size: 0.016, voiceBay, dragLocal: Y_UP,
    }));
}

/**
 * Steep heart panel: Scale | Hex | XY, voiceBay, Arp + Mod.
 * Face local: +X right, +Y up the slant, +Z toward the player.
 */
export function createHeartPanel({ interactives, voiceBayHits }) {
    const heart = new THREE.Group();
    heart.name = 'heartPanel';

    const plate = new THREE.Mesh(
        new THREE.BoxGeometry(PANEL_W, PANEL_H, PANEL_T),
        chassisMat,
    );
    plate.position.set(0, PANEL_H / 2, 0);
    heart.add(plate);

    const face = new THREE.Group();
    face.name = 'heartFace';
    face.position.set(0, 0, PANEL_T / 2 + 0.001);
    heart.add(face);

    const persist = interactives;
    const bayHits = voiceBayHits;

    // --- persistent top band ---
    fieldTitle(face, 'SCALE / TUNE', -0.22, 0.318, 0.14);
    pushHit(persist, createButton(face, {
        x: -0.255, y: 0.300, z: 0.004, w: 0.036, h: 0.014, d: 0.006,
        label: 'SCALE', key: 'scaleToggle',
    }));
    const scaleSel = createSelectTrigger(face, {
        x: -0.195, y: 0.300, z: 0.004, w: 0.078, h: 0.014, d: 0.006,
        label: 'Scale',
        items: scaleItems(),
        getValue: () => getString('scaleSelect', 'ionian'),
        setValue: (id) => set('scaleSelect', id),
    });
    pushHit(persist, scaleSel);
    subscribe('scaleSelect', () => scaleSel.userData.sync?.());

    pushHit(persist, createKnob(face, {
        x: -0.255, y: 0.272, z: 0.006, key: 'masterTune', label: 'TUNE', size: 0.016,
    }));
    pushHit(persist, createKnob(face, {
        x: -0.218, y: 0.272, z: 0.006, key: 'octaveSwitch', label: 'OCT', size: 0.016,
    }));
    pushHit(persist, createKnob(face, {
        x: -0.181, y: 0.272, z: 0.006, key: 'semitoneSwitch', label: 'SEMI', size: 0.016,
    }));
    const amtSel = createSelectTrigger(face, {
        x: -0.215, y: 0.248, z: 0.004, w: 0.072, h: 0.013, d: 0.006,
        label: 'Amount',
        items: semitoneItems(),
        getValue: () => getString('semitoneAmount', '7'),
        setValue: (id) => set('semitoneAmount', id),
    });
    pushHit(persist, amtSel);
    subscribe('semitoneAmount', () => amtSel.userData.sync?.());

    const hex = createHexScope(face, { x: 0, y: 0.278, z: 0.002, w: 0.148, h: 0.062 });
    pushHit(persist, hex.screen);

    const xy = createXyPad(face, { x: 0.215, y: 0.282, z: 0.002, size: 0.07 });
    xy.xTrig.userData.mount = face;
    xy.yTrig.userData.mount = face;
    pushHit(persist, xy.pad);
    pushHit(persist, xy.xTrig);
    pushHit(persist, xy.yTrig);

    // --- voiceBay ---
    const voiceBay = new THREE.Group();
    voiceBay.name = 'voiceBay';
    face.add(voiceBay);

    const bayPlate = new THREE.Mesh(
        new THREE.PlaneGeometry(PANEL_W * 0.96, 0.175),
        plateMat.clone(),
    );
    bayPlate.position.set(0, 0.148, -0.0006);
    face.add(bayPlate);
    const emptyLabel = makeLabel('MODE', 0.12, 0.02, { size: 36, color: '#888880' });
    emptyLabel.position.set(0, 0.148, 0.001);
    emptyLabel.visible = false;
    face.add(emptyLabel);

    fieldPlate(voiceBay, 0, 0.188, PANEL_W * 0.94, 0.092);
    fieldTitle(voiceBay, 'OSC', -0.255, 0.228, 0.08);
    oscRow(voiceBay, bayHits, 0, 0.214, true);
    oscRow(voiceBay, bayHits, 1, 0.196, true);
    oscRow(voiceBay, bayHits, 2, 0.178, true);
    oscRow(voiceBay, bayHits, 3, 0.160, true);

    pushHit(bayHits, createKnob(voiceBay, {
        x: 0.105, y: 0.160, z: 0.006, key: 'osc4Harmonics', label: 'HARM',
        size: 0.015, voiceBay: true,
    }));
    pushHit(bayHits, createKnob(voiceBay, {
        x: 0.138, y: 0.160, z: 0.006, key: 'osc4MorphX', label: 'TMBR',
        size: 0.015, voiceBay: true,
    }));
    pushHit(bayHits, createKnob(voiceBay, {
        x: 0.171, y: 0.160, z: 0.006, key: 'osc4MorphY', label: 'MRPH',
        size: 0.015, voiceBay: true,
    }));

    pushHit(bayHits, createKnob(voiceBay, {
        x: 0.105, y: 0.136, z: 0.006, key: 'noiseVol', label: 'NOIZ',
        size: 0.015, voiceBay: true,
    }));
    const noiseSel = createSelectTrigger(voiceBay, {
        x: 0.155, y: 0.136, z: 0.004, w: 0.048, h: 0.012, d: 0.006,
        label: 'Type', items: noiseItems(), voiceBay: true,
        getValue: () => getString('noiseType', 'white'),
        setValue: (id) => set('noiseType', id),
    });
    pushHit(bayHits, noiseSel);
    subscribe('noiseType', () => noiseSel.userData.sync?.());
    pushHit(bayHits, createButton(voiceBay, {
        x: 0.205, y: 0.136, z: 0.004, w: 0.032, h: 0.012, d: 0.006,
        label: 'NS', key: 'noiseToggle', voiceBay: true,
    }));

    pushHit(bayHits, createButton(voiceBay, {
        x: -0.255, y: 0.136, z: 0.004, w: 0.036, h: 0.012, d: 0.006,
        label: 'UNI', key: 'unisonToggle', voiceBay: true,
    }));
    pushHit(bayHits, createKnob(voiceBay, {
        x: -0.210, y: 0.136, z: 0.006, key: 'unisonDetune', label: 'DET',
        size: 0.015, voiceBay: true,
    }));
    pushHit(bayHits, createButton(voiceBay, {
        x: -0.165, y: 0.136, z: 0.004, w: 0.042, h: 0.012, d: 0.006,
        label: 'PHASE', key: 'phaseResetToggle', voiceBay: true,
    }));

    fieldPlate(voiceBay, -0.08, 0.100, 0.42, 0.048);
    fieldTitle(voiceBay, 'FILTER', -0.255, 0.118, 0.1);
    pushHit(bayHits, createKnob(voiceBay, {
        x: -0.230, y: 0.100, z: 0.006, key: 'cutoff', label: 'CUT',
        size: 0.018, map: 'log', voiceBay: true,
    }));
    pushHit(bayHits, createKnob(voiceBay, {
        x: -0.190, y: 0.100, z: 0.006, key: 'resonance', label: 'RES',
        size: 0.016, voiceBay: true,
    }));
    pushHit(bayHits, createKnob(voiceBay, {
        x: -0.154, y: 0.100, z: 0.006, key: 'highPass', label: 'HP',
        size: 0.016, voiceBay: true,
    }));
    pushHit(bayHits, createKnob(voiceBay, {
        x: -0.118, y: 0.100, z: 0.006, key: 'filterEnvAmount', label: 'AMT',
        size: 0.016, voiceBay: true,
    }));
    pushHit(bayHits, createButton(voiceBay, {
        x: -0.082, y: 0.100, z: 0.004, w: 0.028, h: 0.012, d: 0.006,
        label: 'ENV', key: 'filterEnvToggle', voiceBay: true,
    }));
    const invertBtn = createButton(voiceBay, {
        x: -0.048, y: 0.100, z: 0.004, w: 0.032, h: 0.012, d: 0.006,
        label: 'INV', special: 'invert', voiceBay: true,
    });
    pushHit(bayHits, invertBtn);
    ['filterAttack', 'filterDecay', 'filterSustain', 'filterRelease'].forEach((key, i) => {
        pushHit(bayHits, createKnob(voiceBay, {
            x: 0.00 + i * 0.032, y: 0.100, z: 0.006, key,
            label: ['A', 'D', 'S', 'R'][i], size: 0.014, voiceBay: true,
        }));
    });
    const filterAdsr = makeAdsrView(voiceBay, 0.168, 0.100, 0.072, 0.028, [
        'filterAttack', 'filterDecay', 'filterSustain', 'filterRelease',
    ], () => invertBtn.userData.invertOn);
    filterAdsr.userData.voiceBay = true;

    fieldPlate(voiceBay, 0.12, 0.068, 0.34, 0.032);
    fieldTitle(voiceBay, 'AMP', -0.255, 0.078, 0.08);
    ['attack', 'decay', 'sustain', 'release'].forEach((key, i) => {
        pushHit(bayHits, createKnob(voiceBay, {
            x: -0.220 + i * 0.034, y: 0.062, z: 0.006, key,
            label: ['A', 'D', 'S', 'R'][i], size: 0.015, voiceBay: true,
        }));
    });
    pushHit(bayHits, createKnob(voiceBay, {
        x: -0.084, y: 0.062, z: 0.006, key: 'volume', label: 'VOL',
        size: 0.016, voiceBay: true,
    }));
    makeAdsrView(voiceBay, 0.00, 0.062, 0.08, 0.028, [
        'attack', 'decay', 'sustain', 'release',
    ], () => false);

    // --- Arp + Mod (persistent, bottom of slant) ---
    fieldTitle(face, 'ARP / MOD', -0.22, 0.048, 0.14);
    const arpBtn = createButton(face, {
        x: -0.250, y: 0.030, z: 0.004, w: 0.032, h: 0.014, d: 0.006,
        label: 'ARP', special: 'arp',
    });
    const chordBtn = createButton(face, {
        x: -0.214, y: 0.030, z: 0.004, w: 0.036, h: 0.014, d: 0.006,
        label: 'CHD', special: 'arpChord',
    });
    const orderBtn = createButton(face, {
        x: -0.172, y: 0.030, z: 0.004, w: 0.040, h: 0.014, d: 0.006,
        label: 'UP', special: 'arpOrder',
    });
    pushHit(persist, arpBtn);
    pushHit(persist, chordBtn);
    pushHit(persist, orderBtn);

    WAVES.forEach((wave, i) => {
        pushHit(persist, createButton(face, {
            x: -0.118 + i * 0.024, y: 0.030, z: 0.004,
            w: 0.022, h: 0.013, d: 0.006,
            label: WAVE_LBL[i], key: 'lfoWaveform', radioValue: wave,
        }));
    });
    pushHit(persist, createKnob(face, {
        x: -0.010, y: 0.028, z: 0.006, key: 'lfoSpeed', label: 'RATE', size: 0.016,
    }));
    pushHit(persist, createButton(face, {
        x: 0.028, y: 0.030, z: 0.004, w: 0.032, h: 0.013, d: 0.006,
        label: 'RTRG', key: 'lfoRetrigger',
    }));
    pushHit(persist, createKnob(face, {
        x: 0.068, y: 0.028, z: 0.006, key: 'cutoffMod', label: 'CMOD', size: 0.016,
    }));
    pushHit(persist, createKnob(face, {
        x: 0.102, y: 0.028, z: 0.006, key: 'osc1PitchMod', label: 'O1', size: 0.015,
    }));
    pushHit(persist, createKnob(face, {
        x: 0.134, y: 0.028, z: 0.006, key: 'osc2PitchMod', label: 'O2', size: 0.015,
    }));
    pushHit(persist, createKnob(face, {
        x: 0.166, y: 0.028, z: 0.006, key: 'osc3PitchMod', label: 'O3', size: 0.015,
    }));
    pushHit(persist, createKnob(face, {
        x: 0.198, y: 0.028, z: 0.006, key: 'osc4PitchMod', label: 'O4', size: 0.015,
    }));
    const revBtn = createButton(face, {
        x: 0.240, y: 0.030, z: 0.004, w: 0.032, h: 0.013, d: 0.006,
        label: 'REV', special: 'reverse',
    });
    pushHit(persist, revBtn);

    function setVoiceBayLive(on) {
        closeSelect(interactives);
        voiceBay.visible = !!on;
        bayPlate.material = on ? plateMat : dimMat;
        emptyLabel.visible = !on;
        for (let i = interactives.length - 1; i >= 0; i--) {
            if (interactives[i].userData?.voiceBay) interactives.splice(i, 1);
        }
        if (on) {
            for (const m of voiceBayHits) {
                if (!interactives.includes(m)) interactives.push(m);
            }
        }
    }

    function syncSpecials(state, arpOrderLabel) {
        arpBtn.userData.setOn(!!state.keyboardArp);
        chordBtn.userData.setOn(!!(state.keyboardArp && state.keyboardArpChord));
        revBtn.userData.setOn(!!state.isReverse);
        invertBtn.userData.invertOn = !!state.filterEnvInvert;
        invertBtn.userData.setOn(!!state.filterEnvInvert);
        filterAdsr.userData.redraw?.();
        if (arpOrderLabel) orderBtn.userData.cap?.userData.setText(arpOrderLabel);
        orderBtn.userData.setOn(!!(state.keyboardArp && state.keyboardArpChord));
    }

    setVoiceBayLive(true);

    return {
        heart,
        face,
        hex,
        xy,
        voiceBay,
        setVoiceBayLive,
        syncSpecials,
        invertBtn,
        scaleSel,
    };
}
