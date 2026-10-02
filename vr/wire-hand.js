import * as THREE from './vendor/three.module.js';
import { noHit } from './vr-label.js?v=2';

const GREEN = 0x2aff6a;

export const HAND_JOINTS = [
    'wrist',
    'thumb-metacarpal',
    'thumb-phalanx-proximal',
    'thumb-phalanx-distal',
    'thumb-tip',
    'index-finger-metacarpal',
    'index-finger-phalanx-proximal',
    'index-finger-phalanx-intermediate',
    'index-finger-phalanx-distal',
    'index-finger-tip',
    'middle-finger-metacarpal',
    'middle-finger-phalanx-proximal',
    'middle-finger-phalanx-intermediate',
    'middle-finger-phalanx-distal',
    'middle-finger-tip',
    'ring-finger-metacarpal',
    'ring-finger-phalanx-proximal',
    'ring-finger-phalanx-intermediate',
    'ring-finger-phalanx-distal',
    'ring-finger-tip',
    'pinky-finger-metacarpal',
    'pinky-finger-phalanx-proximal',
    'pinky-finger-phalanx-intermediate',
    'pinky-finger-phalanx-distal',
    'pinky-finger-tip',
];

const BONES = [
    ['wrist', 'thumb-metacarpal'],
    ['thumb-metacarpal', 'thumb-phalanx-proximal'],
    ['thumb-phalanx-proximal', 'thumb-phalanx-distal'],
    ['thumb-phalanx-distal', 'thumb-tip'],
    ['wrist', 'index-finger-metacarpal'],
    ['index-finger-metacarpal', 'index-finger-phalanx-proximal'],
    ['index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate'],
    ['index-finger-phalanx-intermediate', 'index-finger-phalanx-distal'],
    ['index-finger-phalanx-distal', 'index-finger-tip'],
    ['wrist', 'middle-finger-metacarpal'],
    ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal'],
    ['middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate'],
    ['middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal'],
    ['middle-finger-phalanx-distal', 'middle-finger-tip'],
    ['wrist', 'ring-finger-metacarpal'],
    ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal'],
    ['ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate'],
    ['ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal'],
    ['ring-finger-phalanx-distal', 'ring-finger-tip'],
    ['wrist', 'pinky-finger-metacarpal'],
    ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal'],
    ['pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate'],
    ['pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal'],
    ['pinky-finger-phalanx-distal', 'pinky-finger-tip'],
    ['index-finger-metacarpal', 'middle-finger-metacarpal'],
    ['middle-finger-metacarpal', 'ring-finger-metacarpal'],
    ['ring-finger-metacarpal', 'pinky-finger-metacarpal'],
];

export const FINGER_TIPS = [
    'thumb-tip',
    'index-finger-tip',
    'middle-finger-tip',
    'ring-finger-tip',
    'pinky-finger-tip',
];

const lineMat = new THREE.LineBasicMaterial({
    color: GREEN,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    toneMapped: false,
});
const cageGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

function ensureCage(joint) {
    if (joint.userData.wireCage) return joint.userData.wireCage;
    const cage = new THREE.LineSegments(cageGeo, lineMat);
    cage.raycast = noHit;
    cage.userData.skipCursor = true;
    cage.frustumCulled = false;
    joint.add(cage);
    joint.userData.wireCage = cage;
    return cage;
}

/**
 * CRT-green wire cages on joints plus bone lines. Empty grid, no fill.
 */
export function attachWireHand(hand) {
    const viz = new THREE.Group();
    viz.userData.xrRig = true;
    viz.userData.skipCursor = true;
    hand.add(viz);

    const bonePos = new Float32Array(BONES.length * 6);
    const boneGeo = new THREE.BufferGeometry();
    boneGeo.setAttribute('position', new THREE.BufferAttribute(bonePos, 3));
    const bones = new THREE.LineSegments(boneGeo, lineMat);
    bones.raycast = noHit;
    bones.userData.skipCursor = true;
    bones.frustumCulled = false;
    viz.add(bones);

    function update() {
        if (!hand.visible) {
            viz.visible = false;
            return;
        }
        viz.visible = true;
        const joints = hand.joints;
        for (const name of HAND_JOINTS) {
            const joint = joints[name];
            if (!joint) continue;
            if (!joint.visible) {
                if (joint.userData.wireCage) joint.userData.wireCage.visible = false;
                continue;
            }
            const cage = ensureCage(joint);
            cage.visible = true;
            const r = Math.max(0.0045, joint.jointRadius || 0.007);
            cage.scale.setScalar(name.endsWith('-tip') ? r * 2.6 : r * 2.1);
        }
        let i = 0;
        for (const [from, to] of BONES) {
            const ja = joints[from];
            const jb = joints[to];
            if (ja?.visible && jb?.visible) {
                ja.getWorldPosition(_a);
                jb.getWorldPosition(_b);
                viz.worldToLocal(_a);
                viz.worldToLocal(_b);
                bonePos[i] = _a.x;
                bonePos[i + 1] = _a.y;
                bonePos[i + 2] = _a.z;
                bonePos[i + 3] = _b.x;
                bonePos[i + 4] = _b.y;
                bonePos[i + 5] = _b.z;
            } else {
                bonePos[i] = bonePos[i + 1] = bonePos[i + 2] = 0;
                bonePos[i + 3] = bonePos[i + 4] = bonePos[i + 5] = 0;
            }
            i += 6;
        }
        boneGeo.attributes.position.needsUpdate = true;
        boneGeo.computeBoundingSphere();
    }

    return { viz, update };
}
