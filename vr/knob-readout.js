import * as THREE from './vendor/three.module.js';
import { filterLabelTex, noHit, whenFonts } from './vr-label.js?v=2';

const FONT = 'Michroma, ui-sans-serif, sans-serif';
const PX_W = 384;
const PX_H = 128;
const WORLD_W = 0.086;
const WORLD_H = WORLD_W * (PX_H / PX_W);
const LINGER_MS = 520;
const CAM_GAP = 0.055;
const LIFT = 0.016;

/**
 * One world-space value bubble for the held knob.
 *
 * Pattern: Ableton / hardware-encoder popup + Meta spatial UI —
 * object-locked (not a HUD), billboarded to the headset, appears on grab,
 * lingers briefly after release. Single canvas so XR does not pay a texture
 * upload every frame.
 */
export function createKnobReadout(scene) {
    const canvas = document.createElement('canvas');
    canvas.width = PX_W;
    canvas.height = PX_H;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    filterLabelTex(tex);

    let caption = '';
    let value = '';

    function paint() {
        const w = PX_W;
        const h = PX_H;
        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(10, 10, w - 20, h - 20, 28);
        else ctx.rect(10, 10, w - 20, h - 20);
        ctx.fillStyle = 'rgba(16, 16, 14, 0.94)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(42, 255, 106, 0.95)';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (caption) {
            ctx.fillStyle = '#8e8e86';
            const cap = String(caption);
            let size = 20;
            ctx.font = `${size}px ${FONT}`;
            while (size > 13 && ctx.measureText(cap).width > w - 48) {
                size -= 1;
                ctx.font = `${size}px ${FONT}`;
            }
            ctx.fillText(cap, w / 2, 40);
        }
        ctx.fillStyle = '#f3f0e6';
        ctx.font = `44px ${FONT}`;
        ctx.fillText(String(value), w / 2, caption ? 82 : 64);
        tex.needsUpdate = true;
    }

    paint();
    whenFonts(paint);

    const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, WORLD_H), mat);
    mesh.raycast = noHit;
    mesh.renderOrder = 24;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);

    const pos = new THREE.Vector3();
    const camPos = new THREE.Vector3();
    const dir = new THREE.Vector3();

    let target = null;
    let held = false;
    let hideAt = 0;
    let opacity = 0;
    let lastMs = performance.now();

    function place(camera) {
        if (!target || !camera) return;
        target.getWorldPosition(pos);
        camera.getWorldPosition(camPos);
        dir.subVectors(camPos, pos);
        const dist = dir.length();
        if (dist > 1e-4) dir.multiplyScalar(1 / dist);
        else dir.set(0, 0, 1);
        pos.addScaledVector(dir, CAM_GAP);
        pos.y += LIFT;
        mesh.position.copy(pos);
        mesh.quaternion.copy(camera.quaternion);
        const s = THREE.MathUtils.clamp(dist / 0.58, 0.82, 1.55);
        mesh.scale.setScalar(s);
    }

    function setText(nextCaption, nextValue) {
        const cap = String(nextCaption || '');
        const val = String(nextValue || '');
        if (cap === caption && val === value) return;
        caption = cap;
        value = val;
        paint();
    }

    return {
        show(knobMesh, nextCaption, nextValue) {
            target = knobMesh;
            held = true;
            hideAt = Infinity;
            setText(nextCaption, nextValue);
        },
        update(nextCaption, nextValue) {
            if (!held && performance.now() >= hideAt) return;
            setText(nextCaption, nextValue);
        },
        release() {
            held = false;
            hideAt = performance.now() + LINGER_MS;
        },
        tick(camera) {
            const now = performance.now();
            const dt = Math.min(0.05, (now - lastMs) / 1000);
            lastMs = now;
            const want = (held || now < hideAt) ? 1 : 0;
            const k = 1 - Math.exp(-dt / 0.07);
            opacity += (want - opacity) * k;
            if (opacity < 0.02 && want === 0) {
                opacity = 0;
                mesh.visible = false;
                if (!held) target = null;
                mat.opacity = 0;
                return;
            }
            mesh.visible = true;
            mat.opacity = opacity;
            place(camera);
        },
    };
}
