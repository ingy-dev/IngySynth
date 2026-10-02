import * as THREE from './vendor/three.module.js';
import { paintOscilloscopeCanvas } from '../js/visualizers.js?v=121';
import { state } from '../js/state.js?v=116';
import { noHit } from './vr-label.js?v=2';

/** CSS clip-path polygon(21% 0, 79% 0, 100% 50%, 79% 100%, 21% 100%, 0% 50%). */
export const HEX_UV = [
    [0.21, 0],
    [0.79, 0],
    [1, 0.5],
    [0.79, 1],
    [0.21, 1],
    [0, 0.5],
];

function hexPoints(w, h) {
    return HEX_UV.map(([u, v]) => new THREE.Vector2((u - 0.5) * w, (0.5 - v) * h));
}

function pointInHex(lx, ly, w, h) {
    const pts = hexPoints(w, h);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x;
        const yi = pts[i].y;
        const xj = pts[j].x;
        const yj = pts[j].y;
        const hit = ((yi > ly) !== (yj > ly))
            && (lx < (xj - xi) * (ly - yi) / ((yj - yi) || 1e-9) + xi);
        if (hit) inside = !inside;
    }
    return inside;
}

function hexShape(w, h) {
    const pts = hexPoints(w, h);
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) / w + 0.5, uv.getY(i) / h + 0.5);
    }
    uv.needsUpdate = true;
    return geo;
}

const _local = new THREE.Vector3();

export function installHexRaycast(mesh, w, h) {
    mesh.raycast = function hexRaycast(raycaster, intersects) {
        const before = intersects.length;
        THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
        for (let i = intersects.length - 1; i >= before; i--) {
            const hit = intersects[i];
            this.worldToLocal(_local.copy(hit.point));
            if (!pointInHex(_local.x, _local.y, w, h)) intersects.splice(i, 1);
        }
    };
}

function canvasTex(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    canvas._ingyScopeCtx = ctx;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return { canvas, ctx, tex };
}

function rasterizeSvg(url, drawW, drawH, { mips = false } = {}) {
    return fetch(url).then((res) => {
        if (!res.ok) throw new Error('svg fetch ' + url);
        return res.text();
    }).then((svg) => {
        if (!/\swidth=/.test(svg)) {
            svg = svg.replace(/<svg\b/, `<svg width="${drawW}" height="${drawH}"`);
        }
        const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
        const obj = URL.createObjectURL(blob);
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = drawW;
                canvas.height = drawH;
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, drawW, drawH);
                ctx.drawImage(img, 0, 0, drawW, drawH);
                const tex = new THREE.CanvasTexture(canvas);
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.magFilter = THREE.LinearFilter;
                if (mips) {
                    tex.generateMipmaps = true;
                    tex.minFilter = THREE.LinearMipmapLinearFilter;
                    tex.anisotropy = 16;
                } else {
                    tex.generateMipmaps = false;
                    tex.minFilter = THREE.LinearFilter;
                }
                tex.needsUpdate = true;
                URL.revokeObjectURL(obj);
                resolve(tex);
            };
            img.onerror = () => {
                URL.revokeObjectURL(obj);
                reject(new Error('svg image ' + url));
            };
            img.src = obj;
        });
    });
}

function loadTex(url, { srgb = true, wrap = false } = {}) {
    return new Promise((resolve, reject) => {
        const loader = new THREE.TextureLoader();
        loader.load(
            url,
            (tex) => {
                tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                tex.generateMipmaps = false;
                if (wrap) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
                tex.needsUpdate = true;
                resolve(tex);
            },
            undefined,
            reject,
        );
    });
}

function logoFlicker(now) {
    const t = now / 1000;
    let o = 1;
    const lf = t % 3;
    if (lf > 0.05 && lf < 0.11) o = lf < 0.07 ? 0.9 : lf < 0.09 ? 1.05 : 0.95;
    const lf2 = t % 3;
    if (lf2 > 1.2 && lf2 < 1.32) o *= lf2 < 1.26 ? 0.9 : 1;
    const glow = t % 4;
    if (glow > 0.05 && glow < 0.1) o *= 0.85;
    else if (glow > 0.5 && glow < 0.56) o *= 0.9;
    else if (glow > 3.4 && glow < 3.5) o *= 0.7;
    const pg = t % 15;
    if (pg > 14.25 && pg < 14.41) o *= 0.2 + 0.6 * Math.random();
    else if (pg > 14.71 && pg < 14.82) o *= 0.3 + 0.5 * Math.random();
    return Math.max(0.15, Math.min(1.15, o));
}

export function createHexScope(parent, { x, y, z, w = 0.152, h = 0.064 } = {}) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);

    const { canvas, ctx, tex } = canvasTex(400, 170);
    const geo = hexShape(w, h);

    const screen = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
            map: tex,
            color: 0xffffff,
            toneMapped: false,
        }),
    );
    screen.userData = { kind: 'hex', hexW: w, hexH: h };
    installHexRaycast(screen, w, h);
    group.add(screen);

    const plate = new THREE.Mesh(
        geo.clone(),
        new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    plate.position.z = 0.0004;
    plate.raycast = noHit;
    group.add(plate);

    // Match the hex's top/bottom flats (the horizontal sides), not the bounding box.
    const logoW = w * (HEX_UV[1][0] - HEX_UV[0][0]);
    const logoH = logoW * (102.88 / 240);
    const logo = new THREE.Mesh(
        new THREE.PlaneGeometry(logoW, logoH),
        new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    logo.position.z = 0.0006;
    logo.raycast = noHit;
    group.add(logo);

    const glass = new THREE.Mesh(
        geo.clone(),
        new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.25,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    glass.position.z = 0.0009;
    glass.raycast = noHit;
    group.add(glass);

    const border = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    border.position.z = 0.0013;
    border.raycast = noHit;
    group.add(border);

    const glassUrl = new URL('../assets/oscilloscope-glass.jpg', import.meta.url).href;
    const borderUrl = new URL('../internal-oscilloscope-border.svg', import.meta.url).href;
    const logoUrl = new URL('../IngySynth-logo-oscilloscope.svg', import.meta.url).href;

    loadTex(glassUrl).then((map) => {
        glass.material.map = map;
        glass.material.needsUpdate = true;
    }).catch(() => { /* keep clear glass tint */ });

    rasterizeSvg(borderUrl, 406, 171).then((map) => {
        border.material.map = map;
        border.material.opacity = 0.85;
        border.material.needsUpdate = true;
    }).catch(() => { /* keep hidden until map exists */ });

    rasterizeSvg(logoUrl, 480, 206, { mips: true }).then((map) => {
        logo.material.map = map;
        logo.material.needsUpdate = true;
    }).catch(() => { /* logo optional */ });

    let logoShown = true;
    let idleSince = 0;
    const fade = { value: 1 };

    return {
        group,
        screen,
        canvas,
        ctx,
        tex,
        logo,
        paint(wave) {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            if (wave && wave.length) {
                paintOscilloscopeCanvas(canvas, wave);
            } else {
                ctx.strokeStyle = '#00ff00';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, canvas.height / 2);
                ctx.lineTo(canvas.width, canvas.height / 2);
                ctx.stroke();
            }
            tex.needsUpdate = true;
        },
        tickLogo(now, idle) {
            if (!idle) {
                idleSince = 0;
                logoShown = false;
            } else if (!logoShown) {
                if (!idleSince) idleSince = now;
                if (now - idleSince >= 1500) logoShown = true;
            }
            const target = logoShown ? 1 : 0;
            fade.value += (target - fade.value) * (logoShown ? 0.08 : 0.22);
            const flicker = logoShown ? logoFlicker(now) : 1;
            const o = Math.max(0, Math.min(1, fade.value * flicker));
            plate.material.opacity = fade.value;
            logo.material.opacity = o;
            plate.visible = fade.value > 0.02;
            logo.visible = fade.value > 0.02;
        },
    };
}

export function attachHexPaint(onFrame, hex, analyserFrom) {
    let wave = null;
    onFrame(() => {
        try {
            const analyser = analyserFrom();
            if (analyser) {
                const n = analyser.fftSize || 2048;
                if (!wave || wave.length !== n) wave = new Uint8Array(n);
                analyser.getByteTimeDomainData(wave);
                hex.paint(wave);
            } else {
                hex.paint(null);
            }
            const idle = !state.isPlaying && !state.isArping && !state.keyboardVoiceActive;
            hex.tickLogo(performance.now(), idle);
        } catch (_) { /* keep XR loop alive */ }
    });
}
