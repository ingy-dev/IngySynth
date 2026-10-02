import * as THREE from './vendor/three.module.js';
import { noHit } from './vr-label.js?v=2';

const GREEN = 0x2aff6a;
const MAX_DIST = 6;
const IDLE_DIST = 0.45;
const BEAM_R = 0.00038;
const CURSOR_R = 0.0019;
const _ray = new THREE.Raycaster();
const _n = new THREE.Vector3();
const _look = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _hits = [];

const UI_KINDS = new Set([
    'note', 'octUp', 'octDown', 'startStop', 'mode', 'pitch', 'lfo',
    'stepsScreen', 'knob', 'button', 'xy', 'select', 'selectItem', 'hex',
    'grab',
]);

function skipCursor(obj) {
    let p = obj;
    while (p) {
        if (p.userData?.xrRig || p.userData?.skipCursor) return true;
        p = p.parent;
    }
    return false;
}

function worldNormal(hit, rayDir, out) {
    if (hit.face?.normal) out.copy(hit.face.normal);
    else if (hit.normal) out.copy(hit.normal);
    else out.copy(rayDir).negate();
    if (out.dot(rayDir) > 0) out.negate();
    if (out.lengthSq() < 1e-8) out.copy(rayDir).negate();
    return out.normalize();
}

function setControllerRay(controller) {
    _mat.identity().extractRotation(controller.matrixWorld);
    _origin.setFromMatrixPosition(controller.matrixWorld);
    _dir.set(0, 0, -1).applyMatrix4(_mat);
    _ray.set(_origin, _dir);
    _ray.far = MAX_DIST;
    _ray.near = 0.01;
}

function firstHit(controller, root) {
    setControllerRay(controller);
    _hits.length = 0;
    _ray.intersectObject(root, true, _hits);
    for (let i = 0; i < _hits.length; i++) {
        const hit = _hits[i];
        if (skipCursor(hit.object)) continue;
        if (hit.distance < 0.012) continue;
        return hit;
    }
    return null;
}

/**
 * Quest-style laser: beam stops at the first surface and a disc sits on it.
 * Interaction picking stays on `interactives`; this is visual only.
 */
export function createPointer(controller, scene) {
    const beamMat = new THREE.MeshBasicMaterial({
        color: GREEN,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        toneMapped: false,
    });
    const beamGeo = new THREE.CylinderGeometry(BEAM_R, BEAM_R * 0.28, 1, 8);
    beamGeo.translate(0, -0.5, 0);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.rotation.x = Math.PI / 2;
    beam.raycast = noHit;
    beam.userData.skipCursor = true;
    beam.frustumCulled = false;
    controller.add(beam);

    const cursorMat = new THREE.MeshBasicMaterial({
        color: GREEN,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
    });
    const cursor = new THREE.Mesh(new THREE.CircleGeometry(CURSOR_R, 28), cursorMat);
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(CURSOR_R, CURSOR_R * 1.28, 24),
        new THREE.MeshBasicMaterial({
            color: 0x1a1a18,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            toneMapped: false,
            side: THREE.DoubleSide,
        }),
    );
    ring.raycast = noHit;
    cursor.add(ring);
    cursor.raycast = noHit;
    cursor.userData.skipCursor = true;
    cursor.renderOrder = 30;
    cursor.visible = false;
    scene.add(cursor);

    let live = false;
    controller.addEventListener('connected', (event) => {
        const mode = event.data?.targetRayMode;
        const isHand = !!event.data?.hand;
        live = !isHand && (mode === 'tracked-pointer' || mode === 'screen');
        if (!live) hide();
    });
    controller.addEventListener('disconnected', () => {
        live = false;
        beam.visible = false;
        cursor.visible = false;
    });

    function hide() {
        beam.visible = false;
        cursor.visible = false;
    }

    function update(root) {
        if (!live || controller.userData.hidePointer) {
            hide();
            return;
        }
        const hit = firstHit(controller, root);
        beam.visible = true;
        if (!hit) {
            beam.scale.set(1, IDLE_DIST, 1);
            beamMat.color.setHex(GREEN);
            beamMat.opacity = 0.35;
            cursor.visible = false;
            return;
        }
        const ui = UI_KINDS.has(hit.object.userData?.kind);
        beam.scale.set(1, Math.max(0.02, hit.distance), 1);
        beamMat.color.setHex(GREEN);
        beamMat.opacity = ui ? 0.95 : 0.82;
        worldNormal(hit, _dir, _n);
        cursor.visible = true;
        cursor.position.copy(hit.point).addScaledVector(_n, 0.0018);
        _look.copy(hit.point).add(_n);
        cursor.lookAt(_look);
        cursor.scale.setScalar(1);
        cursorMat.color.setHex(GREEN);
    }

    return { beam, cursor, update, hide };
}
