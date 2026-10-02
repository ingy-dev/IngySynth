import * as THREE from './vendor/three.module.js';
import { getNumber, set, subscribe } from '../js/params.js?v=15';
import { getParam, xyPadEntries } from '../js/param-catalog.js?v=3';
import { makeLabel, whenFonts } from './vr-label.js?v=2';

function groupedAxisItems() {
    const rows = [{ id: 'none', label: 'None' }];
    const grouped = new Map();
    const order = [];
    xyPadEntries().forEach((p) => {
        const g = p.group || 'Synth';
        if (!grouped.has(g)) {
            grouped.set(g, []);
            order.push(g);
        }
        grouped.get(g).push({ id: p.id, label: p.name });
    });
    order.forEach((g) => {
        rows.push({ id: `__g:${g}`, label: g, children: grouped.get(g) });
    });
    return rows;
}

function keyFromAxis(id) {
    if (!id || id === 'none' || String(id).startsWith('__')) return null;
    return getParam(id) ? id : null;
}

function normalizeFromKey(key) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range') return null;
    const min = spec.min;
    const max = spec.max;
    const value = getNumber(key, spec.default);
    if (![min, max, value].every(Number.isFinite) || max === min) return null;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function mapNormToKey(norm, key) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range') return null;
    return spec.min + Math.max(0, Math.min(1, norm)) * (spec.max - spec.min);
}

function labelFor(id) {
    if (!id || id === 'none') return 'None';
    const spec = getParam(id);
    return spec?.xyName || id;
}

export function createXyPad(parent, {
    x, y, z,
    size = 0.072,
    interactives,
    voiceBay = false,
} = {}) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;

    const pad = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    );
    group.add(pad);

    let xKey = 'cutoff';
    let yKey = 'resonance';
    let currentX = 0.5;
    let currentY = 0.5;
    let dragging = false;
    const trail = [];

    function draw() {
        const w = canvas.width;
        const h = canvas.height;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.22)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 5; i++) {
            ctx.beginPath();
            ctx.moveTo((w * i) / 5, 0);
            ctx.lineTo((w * i) / 5, h);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, (h * i) / 5);
            ctx.lineTo(w, (h * i) / 5);
            ctx.stroke();
        }
        for (let i = 0; i < trail.length; i++) {
            const p = trail[i];
            const a = 0.7 * (i / trail.length);
            const r = 10 * (i / trail.length);
            ctx.beginPath();
            ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(0, 255, 0, ${a})`;
            ctx.fill();
        }
        ctx.fillStyle = '#00ff00';
        ctx.font = '18px Michroma, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(labelFor(xKey), w / 2, h - 14);
        ctx.save();
        ctx.translate(16, h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(labelFor(yKey), 0, 0);
        ctx.restore();
        ctx.beginPath();
        ctx.arc(currentX * w, currentY * h, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#00ff66';
        ctx.fill();
        tex.needsUpdate = true;
    }

    function writeAxes() {
        if (xKey) {
            const mapped = mapNormToKey(currentX, xKey);
            if (mapped != null) set(xKey, mapped);
        }
        if (yKey) {
            const mapped = mapNormToKey(1 - currentY, yKey);
            if (mapped != null) set(yKey, mapped);
        }
    }

    function followKeys() {
        if (dragging) return;
        let moved = false;
        const nx = normalizeFromKey(xKey);
        const ny = normalizeFromKey(yKey);
        if (nx != null) {
            currentX = nx;
            moved = true;
        }
        if (ny != null) {
            currentY = 1 - ny;
            moved = true;
        }
        if (moved) draw();
    }

    let unsubX = null;
    let unsubY = null;
    function bindFollow() {
        if (typeof unsubX === 'function') unsubX();
        if (typeof unsubY === 'function') unsubY();
        unsubX = xKey ? subscribe(xKey, followKeys) : null;
        unsubY = yKey ? subscribe(yKey, followKeys) : null;
    }

    pad.userData = {
        kind: 'xy',
        voiceBay,
        restY: 0,
        restColor: 0x111111,
        applyUv(u, v) {
            currentX = Math.max(0, Math.min(1, u));
            currentY = Math.max(0, Math.min(1, v));
            trail.push({ x: currentX, y: currentY });
            if (trail.length > 15) trail.shift();
            writeAxes();
            draw();
        },
        dragStart() {
            dragging = true;
            trail.length = 0;
        },
        dragEnd() {
            dragging = false;
            setTimeout(() => {
                trail.length = 0;
                draw();
            }, 280);
        },
        setXKey(id) {
            xKey = keyFromAxis(id);
            pad.userData.xKey = xKey;
            bindFollow();
            followKeys();
            draw();
            xTrig.userData.sync?.();
        },
        setYKey(id) {
            yKey = keyFromAxis(id);
            pad.userData.yKey = yKey;
            bindFollow();
            followKeys();
            draw();
            yTrig.userData.sync?.();
        },
        getXKey: () => xKey || 'none',
        getYKey: () => yKey || 'none',
        axisItems: groupedAxisItems(),
    };

    const xTrig = makeAxisSlot(group, -size * 0.28, -size * 0.5 - 0.012, 'X', () => xKey || 'none', (id) => {
        pad.userData.setXKey(id);
    });
    const yTrig = makeAxisSlot(group, size * 0.28, -size * 0.5 - 0.012, 'Y', () => yKey || 'none', (id) => {
        pad.userData.setYKey(id);
    });
    xTrig.userData.voiceBay = voiceBay;
    yTrig.userData.voiceBay = voiceBay;

    const nx = normalizeFromKey(xKey);
    const ny = normalizeFromKey(yKey);
    if (nx != null) currentX = nx;
    if (ny != null) currentY = 1 - ny;
    whenFonts(draw);
    draw();
    bindFollow();

    return { group, pad, xTrig, yTrig, axisItems: groupedAxisItems() };
}

function makeAxisSlot(parent, x, y, axisName, getValue, setValue) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.064, 0.014, 0.005),
        new THREE.MeshStandardMaterial({ color: 0x323230, roughness: 0.55, metalness: 0.1 }),
    );
    mesh.position.set(x, y, 0.003);
    const caption = makeLabel(`${axisName}: ${labelFor(getValue())}`, 0.06, 0.012, {
        size: 18,
        pxW: 256,
        pxH: 40,
    });
    caption.position.z = 0.003;
    mesh.add(caption);
    mesh.userData = {
        kind: 'select',
        restColor: 0x323230,
        restY: mesh.position.y,
        items: groupedAxisItems(),
        getValue: () => getValue() || 'none',
        setValue,
        caption,
        mount: parent.parent || parent,
        sync() {
            caption.userData.setText(`${axisName}: ${labelFor(getValue())}`);
        },
    };
    parent.add(mesh);
    return mesh;
}
