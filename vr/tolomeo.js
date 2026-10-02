import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import {
    DESK_TOP_Y,
    DESK_WIDTH,
    DESK_DEPTH,
    DESK_FRONT_Z,
    KEYBOARD_Z,
} from './loft.js?v=22';
import { noHit } from './vr-label.js?v=2';

const INSET = 0.13;
const CCD_ITERS = 12;

/**
 * Packed-model pivots (meters, origin at base disc centre), printed by
 * vr/tools/pack-furniture.py::pack_tolomeo.
 */
const STEM_X = -0.086;
const SHOULDER_P = new THREE.Vector3(-0.0915, 0.0965, 0);
const ELBOW_P = new THREE.Vector3(-0.0626, 0.5755, 0);
const WRIST_P = new THREE.Vector3(0.381, 0.58, 0);

/** Shade cone: centroid and unit axis pointing from rim to apex. */
const SHADE_C = new THREE.Vector3(0.5474, 0.5999, 0);
const SHADE_AXIS = new THREE.Vector3(-0.4204, 0.9073, 0);
const SHADE_RIM_PROJ = -0.0595;
/** Bulb sits on the cone axis, most of it inside the rim. */
const BULB_PROJ = -0.04;
const BULB_R = 0.026;
const BULB_P = SHADE_C.clone().addScaledVector(SHADE_AXIS, BULB_PROJ);

/** Balance cables: anchor on one segment, other end on the next. */
const BASE_CABLE_A = new THREE.Vector3(-0.1272, 0.1402, 0); // stem lever
const BASE_CABLE_B = new THREE.Vector3(-0.1039, 0.5347, 0); // elbow bracket
const HEAD_CABLE_A = new THREE.Vector3(-0.0835, 0.6109, 0); // elbow bracket
const HEAD_CABLE_B = new THREE.Vector3(0.3776, 0.5868, 0); // head pin
const CABLE_R = 0.0007;

const UP = new THREE.Vector3(0, 1, 0);
const _t = new THREE.Vector3();
const _e = new THREE.Vector3();
const _toE = new THREE.Vector3();
const _toT = new THREE.Vector3();
const _ik = new THREE.Vector3();
const _stem = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _dir = new THREE.Vector3();

const alu = new THREE.MeshStandardMaterial({
    color: 0xd8dadd,
    metalness: 0.34,
    roughness: 0.4,
    side: THREE.FrontSide,
});
const shadeMat = alu.clone();
shadeMat.side = THREE.DoubleSide;
shadeMat.polygonOffset = true;
shadeMat.polygonOffsetFactor = 2;
shadeMat.polygonOffsetUnits = 2;
const dark = new THREE.MeshStandardMaterial({
    color: 0x151517,
    metalness: 0.2,
    roughness: 0.55,
});
const cableMat = new THREE.MeshStandardMaterial({
    color: 0x303032,
    metalness: 0.6,
    roughness: 0.45,
});
const bulbMat = new THREE.MeshBasicMaterial({
    color: 0xfff4dc,
    toneMapped: false,
});
const proxyMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    color: 0x000000,
});

function named(root, name) {
    let found = null;
    root.traverse((o) => {
        if (o.name === name) found = o;
    });
    return found;
}

function deskClamp(x, z) {
    const minX = -DESK_WIDTH / 2 + INSET;
    const maxX = DESK_WIDTH / 2 - INSET;
    const minZ = DESK_FRONT_Z - DESK_DEPTH + INSET;
    const maxZ = DESK_FRONT_Z - INSET;
    return {
        x: THREE.MathUtils.clamp(x, minX, maxX),
        z: THREE.MathUtils.clamp(z, minZ, maxZ),
    };
}

function yawToward(fromX, fromZ, toX, toZ) {
    return Math.atan2(-(toZ - fromZ), toX - fromX);
}

function ccdZ(joint, effector, target, min, max) {
    joint.updateWorldMatrix(true, true);
    effector.updateWorldMatrix(true, false);
    effector.getWorldPosition(_e);
    joint.worldToLocal(_toE.copy(_e));
    joint.worldToLocal(_toT.copy(target));
    const a = Math.atan2(_toE.y, _toE.x);
    const b = Math.atan2(_toT.y, _toT.x);
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    joint.rotation.z = THREE.MathUtils.clamp(joint.rotation.z + d, min, max);
}

function faceTarget(yaw, target) {
    yaw.parent.updateWorldMatrix(true, false);
    yaw.parent.worldToLocal(_t.copy(target));
    const dx = _t.x - yaw.position.x;
    const dz = _t.z - yaw.position.z;
    if (dx * dx + dz * dz < 1e-8) return;
    yaw.rotation.y = Math.atan2(-dz, dx);
}

function styleMesh(mesh, mat) {
    if (!mesh) return;
    mesh.material = mat;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.raycast = noHit;
}

/** Add an anchor point to a joint, given a CAD-space position. */
function anchor(joint, cadPos, pivot) {
    const o = new THREE.Object3D();
    o.position.copy(cadPos).sub(pivot);
    joint.add(o);
    return o;
}

function rigLamp(model, interactives) {
    const disc = named(model, 'disc');
    const stem = named(model, 'stem');
    const stemDark = named(model, 'stem_dark');
    const lower = named(model, 'lower');
    const lowerDark = named(model, 'lower_dark');
    const upper = named(model, 'upper');
    const upperDark = named(model, 'upper_dark');
    const head = named(model, 'head');
    const headDark = named(model, 'head_dark');
    const shade = named(model, 'shade');
    const handle = named(model, 'handle');
    if (!disc || !stem || !lower || !upper || !head || !shade) {
        console.warn('Tolomeo parts missing');
        return null;
    }

    for (const m of [disc, stem, lower, upper, head, handle]) styleMesh(m, alu);
    for (const m of [stemDark, lowerDark, upperDark, headDark]) styleMesh(m, dark);
    styleMesh(shade, shadeMat);
    head.renderOrder = 1;

    const root = new THREE.Group();
    root.name = 'tolomeo';
    root.add(model);

    // Stem spins in the disc socket.
    const yaw = new THREE.Group();
    yaw.name = 'lampYaw';
    yaw.position.set(STEM_X, 0, 0);
    root.add(yaw);
    const yawPivot = new THREE.Vector3(STEM_X, 0, 0);

    // Lower arm hinges on the stem knuckle.
    const shoulder = new THREE.Group();
    shoulder.name = 'lampShoulder';
    shoulder.position.copy(SHOULDER_P).sub(yawPivot);
    shoulder.userData.min = -1.2;
    shoulder.userData.max = 1.2;
    yaw.add(shoulder);

    // Upper arm hinges on the elbow knuckle.
    const elbow = new THREE.Group();
    elbow.name = 'lampElbow';
    elbow.position.copy(ELBOW_P).sub(SHOULDER_P);
    elbow.userData.min = -2.6;
    elbow.userData.max = 1.3;
    shoulder.add(elbow);

    // Head tilts on the pin at the end of the upper arm.
    const wrist = new THREE.Group();
    wrist.name = 'lampWrist';
    wrist.position.copy(WRIST_P).sub(ELBOW_P);
    wrist.userData.min = -1.6;
    wrist.userData.max = 1.6;
    elbow.add(wrist);

    root.updateMatrixWorld(true);
    root.attach(disc);
    yaw.attach(stem);
    if (stemDark) yaw.attach(stemDark);
    shoulder.attach(lower);
    if (lowerDark) shoulder.attach(lowerDark);
    elbow.attach(upper);
    if (upperDark) elbow.attach(upperDark);
    wrist.attach(head);
    if (headDark) wrist.attach(headDark);
    wrist.attach(shade);
    if (handle) wrist.attach(handle);
    root.remove(model);

    // Round knuckle caps on the open (+z) side of each hinge. The CAD only
    // has a disc on -z; these hide the seam where the split bracket halves
    // and tube ends rotate against each other.
    function knuckleCap(joint, radius, zMin, zMax) {
        const cap = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, zMax - zMin, 32),
            dark,
        );
        cap.rotation.x = Math.PI / 2;
        cap.position.set(0, 0, (zMin + zMax) / 2);
        cap.raycast = noHit;
        joint.add(cap);
    }
    knuckleCap(shoulder, 0.012, -0.006, 0.0064);
    knuckleCap(elbow, 0.0145, -0.0048, 0.0054);

    const effector = anchor(wrist, BULB_P, WRIST_P);
    effector.name = 'lampEffector';

    const bulb = new THREE.Mesh(new THREE.SphereGeometry(BULB_R, 24, 16), bulbMat);
    bulb.position.copy(BULB_P).sub(WRIST_P);
    bulb.raycast = noHit;
    bulb.userData.skipCursor = true;
    wrist.add(bulb);

    const spot = new THREE.SpotLight(0xfff1d0, 2.2, 2.6, 0.5, 0.5, 1.1);
    spot.position.copy(bulb.position);
    const spotTarget = new THREE.Object3D();
    spotTarget.position.copy(bulb.position).addScaledVector(SHADE_AXIS, -0.3);
    wrist.add(spot);
    wrist.add(spotTarget);
    spot.target = spotTarget;

    // Balance cables, drawn between anchors on neighbouring segments.
    const cableGeo = new THREE.CylinderGeometry(CABLE_R, CABLE_R, 1, 6, 1, true);
    const cables = [
        {
            a: anchor(yaw, BASE_CABLE_A, yawPivot),
            b: anchor(shoulder, BASE_CABLE_B, SHOULDER_P),
            mesh: new THREE.Mesh(cableGeo, cableMat),
        },
        {
            a: anchor(shoulder, HEAD_CABLE_A, SHOULDER_P),
            b: anchor(wrist, HEAD_CABLE_B, WRIST_P),
            mesh: new THREE.Mesh(cableGeo, cableMat),
        },
    ];
    for (const c of cables) {
        c.mesh.raycast = noHit;
        c.mesh.frustumCulled = false;
        root.add(c.mesh);
    }

    function updateCables() {
        root.updateWorldMatrix(true, true);
        for (const c of cables) {
            c.a.getWorldPosition(_ca);
            c.b.getWorldPosition(_cb);
            root.worldToLocal(_ca);
            root.worldToLocal(_cb);
            const len = _ca.distanceTo(_cb);
            c.mesh.position.copy(_ca).add(_cb).multiplyScalar(0.5);
            c.mesh.scale.set(1, Math.max(len, 1e-4), 1);
            _dir.copy(_cb).sub(_ca).normalize();
            c.mesh.quaternion.setFromUnitVectors(UP, _dir);
        }
    }

    const reach = SHOULDER_P.distanceTo(ELBOW_P) + ELBOW_P.distanceTo(WRIST_P) + 0.18;
    const offset = new THREE.Vector3();
    let part = null;

    const lamp = {
        root,
        refresh: updateCables,
        beginGrab(grabPart, handPos) {
            part = grabPart;
            if (grabPart === 'base') {
                root.getWorldPosition(_t);
                offset.copy(_t).sub(handPos);
                offset.y = 0;
                return;
            }
            effector.getWorldPosition(_t);
            offset.copy(_t).sub(handPos);
        },
        moveGrab(handPos) {
            if (!part) return;
            if (part === 'base') {
                const p = deskClamp(handPos.x + offset.x, handPos.z + offset.z);
                root.position.x = p.x;
                root.position.z = p.z;
                root.position.y = DESK_TOP_Y;
                return;
            }
            _ik.copy(handPos).add(offset);
            yaw.getWorldPosition(_stem);
            _toT.copy(_ik).sub(_stem);
            _toT.y = Math.max(_toT.y, 0.1);
            const len = _toT.length();
            if (len > reach) _toT.multiplyScalar(reach / len);
            _ik.copy(_stem).add(_toT);
            faceTarget(yaw, _ik);
            for (let i = 0; i < CCD_ITERS; i++) {
                ccdZ(wrist, effector, _ik, wrist.userData.min, wrist.userData.max);
                ccdZ(elbow, effector, _ik, elbow.userData.min, elbow.userData.max);
                ccdZ(shoulder, effector, _ik, shoulder.userData.min, shoulder.userData.max);
            }
            updateCables();
        },
        endGrab() {
            part = null;
        },
    };

    function tag(host, grab) {
        host.geometry.computeBoundingBox();
        const box = host.geometry.boundingBox;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const proxy = new THREE.Mesh(
            new THREE.BoxGeometry(
                Math.max(size.x, 0.03),
                Math.max(size.y, 0.03),
                Math.max(size.z, 0.03),
            ),
            proxyMat,
        );
        proxy.position.copy(center);
        proxy.name = `grab-${grab}`;
        proxy.userData.kind = 'grab';
        proxy.userData.grab = grab;
        proxy.userData.onGrabBegin = (pos) => lamp.beginGrab(grab, pos);
        proxy.userData.onGrabMove = (pos) => lamp.moveGrab(pos);
        proxy.userData.onGrabEnd = () => lamp.endGrab();
        host.add(proxy);
        interactives.push(proxy);
    }
    tag(disc, 'base');
    tag(stem, 'base');
    tag(lower, 'arm');
    tag(upper, 'arm');
    tag(head, 'head');
    tag(shade, 'head');

    updateCables();
    return lamp;
}

function placeLamp(lamp, x, z, yaw) {
    const p = deskClamp(x, z);
    lamp.root.position.set(p.x, DESK_TOP_Y, p.z);
    lamp.root.rotation.y = yaw;
    lamp.refresh();
}

export function createTolomeoLamps(scene, interactives) {
    const url = new URL('./models/tolomeo.glb', import.meta.url);
    url.searchParams.set('v', '6');
    const loader = new GLTFLoader();
    return new Promise((resolve) => {
        loader.load(
            url.href,
            (gltf) => {
                const lamp = rigLamp(gltf.scene, interactives);
                if (!lamp) {
                    resolve(null);
                    return;
                }

                const backZ = DESK_FRONT_Z - DESK_DEPTH + INSET;
                const rightX = DESK_WIDTH / 2 - INSET;
                scene.add(lamp.root);
                placeLamp(lamp, rightX, backZ, yawToward(rightX, backZ, 0.06, KEYBOARD_Z));
                lamp.root.name = 'tolomeoR';
                resolve(lamp);
            },
            undefined,
            (err) => {
                console.warn('Tolomeo GLB failed', err);
                resolve(null);
            },
        );
    });
}
