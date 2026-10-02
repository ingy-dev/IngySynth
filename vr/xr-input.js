import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { XRControllerModelFactory } from './vendor/XRControllerModelFactory.js';
import { OculusHandModel } from './vendor/OculusHandModel.js';
import { noHit } from './vr-label.js?v=2';
import { createPointer } from './xr-pointer.js?v=5';

const handMat = new THREE.MeshBasicMaterial({
    color: 0x2aff6a,
    wireframe: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    toneMapped: false,
});

function markRig(obj) {
    obj.userData.xrRig = true;
    obj.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh || child.isLine) {
            child.raycast = noHit;
            child.userData.skipCursor = true;
        }
    });
}

function silenceCast(root) {
    root.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh) {
            child.raycast = noHit;
            child.castShadow = false;
            child.receiveShadow = false;
            child.frustumCulled = false;
            child.userData.skipCursor = true;
        }
    });
}

function styleHandMesh(root) {
    root.traverse((child) => {
        if (!child.isMesh && !child.isSkinnedMesh) return;
        child.material = handMat;
        child.castShadow = false;
        child.receiveShadow = false;
        child.frustumCulled = false;
        child.raycast = noHit;
        child.userData.skipCursor = true;
    });
}

/**
 * Touch controller GLBs on grip space. Hands keep the Quest generic-hand
 * mesh, unlit green wireframe (same shape, no shading).
 */
export function attachXrInput({ renderer, scene, onFrame, controllers }) {
    const gltfLoader = new GLTFLoader();
    const controllerFactory = new XRControllerModelFactory(gltfLoader, silenceCast);
    const hands = [];

    const pointers = controllers.map((controller, i) => {
        markRig(controller);
        const pointer = createPointer(controller, scene);

        const grip = renderer.xr.getControllerGrip(i);
        markRig(grip);
        grip.add(controllerFactory.createControllerModel(grip));
        grip.addEventListener('connected', () => silenceCast(grip));
        scene.add(grip);

        const hand = renderer.xr.getHand(i);
        markRig(hand);
        hand.add(new OculusHandModel(hand, null, styleHandMesh));
        scene.add(hand);
        hands.push(hand);

        return pointer;
    });

    onFrame(() => {
        if (!renderer.xr.isPresenting) {
            for (const p of pointers) p.hide();
            return;
        }
        for (const p of pointers) p.update(scene);
    });

    return { pointers, hands };
}
