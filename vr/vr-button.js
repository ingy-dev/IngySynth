import * as THREE from './vendor/three.module.js';
import { get, getString, subscribe } from '../js/params.js?v=19';
import { makeLabel, noHit } from './vr-label.js?v=2';

const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x3a3a38,
    roughness: 0.58,
    metalness: 0.1,
});

export function createButton(parent, {
    x, y, z,
    w = 0.028,
    h = 0.014,
    d = 0.007,
    label = '',
    key = null,
    special = null,
    radioValue = null,
    voiceBay = false,
    lamp = true,
    layout = 'panel',
} = {}) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        bodyMat.clone(),
    );
    mesh.position.set(x, y, z);
    if (layout === 'deck') mesh.rotation.x = -Math.PI / 2;

    const cap = makeLabel(label, w * 0.92, h * 0.72, {
        size: 20,
        pxW: 256,
        pxH: 48,
        color: '#e4e4dc',
    });
    cap.position.z = d / 2 + 0.0005;
    mesh.add(cap);

    let lampMesh = null;
    if (lamp) {
        lampMesh = new THREE.Mesh(
            new THREE.BoxGeometry(w * 0.86, 0.0022, 0.0022),
            new THREE.MeshStandardMaterial({
                color: 0x2a1818,
                emissive: 0x000000,
                roughness: 0.4,
                metalness: 0.15,
            }),
        );
        lampMesh.position.set(0, h * 0.38, d / 2 + 0.0004);
        lampMesh.raycast = noHit;
        mesh.add(lampMesh);
    }

    function setOn(on) {
        if (!lampMesh) return;
        lampMesh.material.color.setHex(on ? 0xff3a2a : 0x2a1818);
        lampMesh.material.emissive.setHex(on ? 0xaa1208 : 0x000000);
        lampMesh.material.emissiveIntensity = on ? 0.85 : 0;
    }

    mesh.userData = {
        kind: 'button',
        key,
        special,
        radioValue,
        voiceBay,
        restY: mesh.position.y,
        restColor: 0x3a3a38,
        setOn,
        cap,
    };

    if (key && radioValue != null) {
        subscribe(key, (v) => setOn(String(v) === String(radioValue)));
        setOn(String(getString(key, '')) === String(radioValue));
    } else if (key && !special) {
        subscribe(key, (v) => setOn(!!v));
        setOn(!!get(key));
    }

    parent.add(mesh);
    return mesh;
}
