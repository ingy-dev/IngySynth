import * as THREE from './vendor/three.module.js';
import { createSky } from './sky.js?v=10';
import { createLoft } from './loft.js?v=22';

export function createScene(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0xd8dce0, 1);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    // Three defaults this to 1 (max). Seated panel text sits off-axis and sparkles.
    renderer.xr.setFoveation(0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);
    camera.position.set(0, 1.24, 0.18);
    camera.lookAt(0, 0.82, -0.55);

    createSky(scene, renderer);
    createLoft(scene);

    const frameHooks = [];
    function onFrame(fn) {
        frameHooks.push(fn);
    }

    function onResize() {
        if (renderer.xr.isPresenting) return;
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
    window.addEventListener('resize', onResize);

    renderer.setAnimationLoop(() => {
        for (let i = 0; i < frameHooks.length; i++) frameHooks[i]();
        renderer.render(scene, camera);
    });

    return { renderer, scene, camera, onFrame };
}
