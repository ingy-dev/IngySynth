import * as THREE from './vendor/three.module.js';
import { noHit } from './vr-label.js?v=2';

/** Same CRT green as the wire hands — not the yellow-lime laser. */
const COLOR = 0x2aff6a;
const PAD = 0.0014;
const LIFT = 0.0008;
const DASH = 0.0035;
const GAP = 0.0024;
const STROKE = 0.0007;
const MAX_DASH = 192;

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _axisX = new THREE.Vector3(1, 0, 0);
const _corners = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
];
const _dummy = new THREE.Object3D();
const dashGeo = new THREE.BoxGeometry(1, 1, 1);

function skipKind(kind) {
    return !kind || kind === 'hex' || kind === 'note';
}

function frameOf(mesh) {
    if (mesh.userData?.kind === 'knob' && mesh.parent) return mesh.parent;
    return mesh;
}

function thinnestAxis(size) {
    if (size.x <= size.y && size.x <= size.z) return 0;
    if (size.y <= size.z) return 1;
    return 2;
}

function faceCorners(box, thin, pad, lift, out) {
    const min = box.min;
    const max = box.max;
    const a = (thin + 1) % 3;
    const b = (thin + 2) % 3;
    const front = max.getComponent(thin) + lift;
    const a0 = min.getComponent(a) - pad;
    const a1 = max.getComponent(a) + pad;
    const b0 = min.getComponent(b) - pad;
    const b1 = max.getComponent(b) + pad;
    const set = (v, va, vb) => {
        v.setComponent(thin, front);
        v.setComponent(a, va);
        v.setComponent(b, vb);
    };
    set(out[0], a0, b0);
    set(out[1], a1, b0);
    set(out[2], a1, b1);
    set(out[3], a0, b1);
}

/**
 * Flat dashed rectangle on the facing plane of the hovered control.
 */
export function createHoverBox(scene) {
    const root = new THREE.Group();
    root.userData.skipCursor = true;
    root.userData.xrRig = true;
    root.matrixAutoUpdate = false;
    root.visible = false;
    root.frustumCulled = false;

    const mat = new THREE.MeshBasicMaterial({
        color: COLOR,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
    });
    const inst = new THREE.InstancedMesh(dashGeo, mat, MAX_DASH);
    inst.raycast = noHit;
    inst.userData.skipCursor = true;
    inst.frustumCulled = false;
    inst.renderOrder = 40;
    inst.count = 0;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(inst);
    scene.add(root);

    function emitEdge(p0, p1, stroke, n) {
        _dir.subVectors(p1, p0);
        const len = _dir.length();
        if (len < 1e-6 || n >= MAX_DASH) return n;
        _dir.multiplyScalar(1 / len);
        _dummy.quaternion.setFromUnitVectors(_axisX, _dir);
        let t = 0;
        while (t < len && n < MAX_DASH) {
            const seg = Math.min(DASH, len - t);
            if (seg < DASH * 0.28) break;
            _mid.copy(p0).addScaledVector(_dir, t + seg * 0.5);
            _dummy.position.copy(_mid);
            _dummy.scale.set(seg, stroke, stroke);
            _dummy.updateMatrix();
            inst.setMatrixAt(n, _dummy.matrix);
            n += 1;
            t += DASH + GAP;
        }
        return n;
    }

    function hide() {
        root.visible = false;
        inst.count = 0;
        root.userData.target = null;
    }

    function show(mesh) {
        if (!mesh?.geometry || !mesh.parent || skipKind(mesh.userData?.kind)) {
            hide();
            return;
        }
        const geo = mesh.geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        _box.copy(geo.boundingBox);
        _box.getSize(_size);
        const thin = thinnestAxis(_size);
        faceCorners(_box, thin, PAD, LIFT, _corners);

        const spanA = _corners[0].distanceTo(_corners[1]);
        const spanB = _corners[1].distanceTo(_corners[2]);
        const stroke = Math.min(STROKE, Math.min(spanA, spanB) * 0.1);

        const frame = frameOf(mesh);
        frame.updateWorldMatrix(true, false);
        root.matrix.copy(frame.matrixWorld);
        root.updateMatrixWorld(true);

        let n = 0;
        n = emitEdge(_corners[0], _corners[1], stroke, n);
        n = emitEdge(_corners[1], _corners[2], stroke, n);
        n = emitEdge(_corners[2], _corners[3], stroke, n);
        n = emitEdge(_corners[3], _corners[0], stroke, n);
        inst.count = n;
        inst.instanceMatrix.needsUpdate = true;
        root.visible = n > 0;
        root.userData.target = mesh;
    }

    return { show, hide, root };
}
