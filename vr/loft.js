import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

export const DESK_TOP_Y = 0.807;
export const DESK_WIDTH = 1.6;
export const DESK_DEPTH = 0.8;
export const DESK_FRONT_Z = -0.3;
export const KEYBOARD_Z = DESK_FRONT_Z - 0.10;

const ROOM = {
    minX: -3.35,
    maxX: 3.35,
    minZ: -3.05,
    maxZ: 1.55,
    height: 3.18,
};

const WIN = {
    hw: 1.18,
    sill: 0.02,
    springY: 2.38,
    rise: 0.58,
};
const WALL_T = 0.12;
const MUNTIN = 0x111111;

function box(w, h, d, mat) {
    const geo = new THREE.BoxGeometry(w, h, d);
    prepareSurfaceGeo(geo);
    return new THREE.Mesh(geo, mat);
}

function prepareSurfaceGeo(geo) {
    const uv = geo.attributes.uv;
    if (uv && !geo.attributes.uv2) geo.setAttribute('uv2', uv.clone());
    if (geo.index && geo.attributes.normal && uv) {
        try { geo.computeTangents(); } catch (_) { /* */ }
    }
}

let plasterMaps = null;
let plasterMapsLoading = null;

function loadPlasterMaps() {
    if (plasterMaps) return Promise.resolve(plasterMaps);
    if (plasterMapsLoading) return plasterMapsLoading;
    const loader = new THREE.TextureLoader();
    const load = (file, colorSpace) => new Promise((resolve, reject) => {
        const url = new URL(`./textures/plaster/${file}`, import.meta.url);
        url.searchParams.set('v', '1');
        loader.load(url.href, (tex) => {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = colorSpace;
            tex.anisotropy = 4;
            resolve(tex);
        }, undefined, reject);
    });
    plasterMapsLoading = Promise.all([
        load('color.jpg', THREE.SRGBColorSpace),
        load('roughness.jpg', THREE.NoColorSpace),
        load('metallic.jpg', THREE.NoColorSpace),
        load('ao.jpg', THREE.NoColorSpace),
        load('normal.png', THREE.NoColorSpace),
    ]).then(([map, roughnessMap, metalnessMap, aoMap, normalMap]) => {
        plasterMaps = { map, roughnessMap, metalnessMap, aoMap, normalMap };
        return plasterMaps;
    });
    return plasterMapsLoading;
}

function plasterMaterial(spanU, spanV) {
    const mat = new THREE.MeshStandardMaterial({
        color: 0xf3f1ec,
        roughness: 1,
        metalness: 1,
        aoMapIntensity: 0.85,
        normalScale: new THREE.Vector2(0.7, 0.7),
    });
    loadPlasterMaps()
        .then((maps) => {
            const tile = 0.32;
            const repeat = new THREE.Vector2(Math.max(1, spanU / tile), Math.max(1, spanV / tile));
            for (const key of ['map', 'roughnessMap', 'metalnessMap', 'aoMap', 'normalMap']) {
                const tex = maps[key].clone();
                tex.repeat.copy(repeat);
                mat[key] = tex;
            }
            mat.needsUpdate = true;
        })
        .catch((err) => {
            console.warn('Plaster maps failed', err);
        });
    return mat;
}

function floorMaterial(floorW, floorD) {
    const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.04,
    });
    const url = new URL('./textures/floor.jpg', import.meta.url);
    url.searchParams.set('v', '1');
    const loader = new THREE.TextureLoader();
    loader.load(
        url.href,
        (tex) => {
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.center.set(0.5, 0.5);
            tex.rotation = Math.PI / 2;
            tex.repeat.set(floorD / 2.2, floorW / 2.2);
            mat.map = tex;
            mat.needsUpdate = true;
        },
        undefined,
        (err) => {
            console.warn('Floor texture failed', err);
            mat.color.set(0xc8c8c4);
        },
    );
    return mat;
}

function windowHole() {
    const s = new THREE.Shape();
    const { hw, sill, springY, rise } = WIN;
    // Clockwise hole (wall shape is CCW) so ExtrudeGeometry punches through.
    s.moveTo(-hw, sill);
    s.lineTo(-hw, springY);
    s.quadraticCurveTo(0, springY + rise, hw, springY);
    s.lineTo(hw, sill);
    s.closePath();
    return s;
}

function windowWall(plaster) {
    const shape = new THREE.Shape();
    shape.moveTo(ROOM.minX, 0);
    shape.lineTo(ROOM.maxX, 0);
    shape.lineTo(ROOM.maxX, ROOM.height);
    shape.lineTo(ROOM.minX, ROOM.height);
    shape.closePath();
    shape.holes.push(windowHole());
    const geo = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false, curveSegments: 24 });
    prepareSurfaceGeo(geo);
    const mesh = new THREE.Mesh(geo, plaster);
    mesh.position.z = ROOM.minZ - WALL_T;
    return mesh;
}

function addMuntins(parent, mat) {
    const { hw, sill, springY, rise } = WIN;
    const t = 0.028;
    const z = ROOM.minZ + 0.01;
    const frame = 0.042;
    const innerH = springY - sill;
    const cols = 4;
    const rows = 3;

    const outer = new THREE.Group();
    outer.add(box(hw * 2 + frame, frame, t, mat));
    outer.children[0].position.set(0, sill + frame / 2, z);
    const topBar = box(hw * 2 + frame, frame, t, mat);
    topBar.position.set(0, springY, z);
    outer.add(topBar);
    const left = box(frame, innerH + frame, t, mat);
    left.position.set(-hw, sill + innerH / 2, z);
    outer.add(left);
    const right = box(frame, innerH + frame, t, mat);
    right.position.set(hw, sill + innerH / 2, z);
    outer.add(right);

    const bayW = (hw * 2) / cols;
    for (let i = 1; i < cols; i++) {
        const v = box(t, innerH, t, mat);
        v.position.set(-hw + i * bayW, sill + innerH / 2, z);
        outer.add(v);
    }
    const bayH = innerH / rows;
    for (let r = 1; r < rows; r++) {
        const hBar = box(hw * 2, t, t, mat);
        hBar.position.set(0, sill + r * bayH, z);
        outer.add(hBar);
    }

    // Arch outline — top pane is the curve, no inner grid.
    const archPts = [];
    for (let i = 0; i <= 16; i++) {
        const u = i / 16;
        const x = THREE.MathUtils.lerp(-hw, hw, u);
        const y = springY + rise * (1 - (2 * u - 1) ** 2);
        archPts.push(new THREE.Vector3(x, y, z));
    }
    const archGeo = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(archPts),
        16,
        t * 0.42,
        5,
        false,
    );
    outer.add(new THREE.Mesh(archGeo, mat));

    parent.add(outer);
}

function iBeam(height, steel) {
    const g = new THREE.Group();
    const fw = 0.2;
    const d = 0.18;
    const th = 0.014;
    const flZ = d / 2 - th / 2;
    const near = box(fw, height, th, steel);
    near.position.set(0, height / 2, flZ);
    const far = box(fw, height, th, steel);
    far.position.set(0, height / 2, -flZ);
    const web = box(th, height, d - th * 2, steel);
    web.position.set(0, height / 2, 0);
    g.add(near, far, web);
    return g;
}

function beolabFallback(alu, blk) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.05, 1.0, 18), alu);
    body.position.y = 0.06 + 0.5;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.047, 0.26, 18), blk);
    head.position.y = 0.06 + 1.0 + 0.13;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.05, 0.03, 18), blk);
    cap.position.y = 0.06 + 1.0 + 0.26 + 0.015;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.058, 0.04, 18), blk);
    foot.position.y = 0.02;
    g.add(body, head, cap, foot);
    return g;
}

function placeSpeakerPair(scene, proto) {
    const x = WIN.hw + 0.58;
    const z = ROOM.minZ + 0.48;
    const toe = 0.28;
    const left = proto.clone();
    left.name = 'beolabL';
    left.position.set(-x, 0, z);
    left.rotation.y = toe;
    const right = proto.clone();
    right.name = 'beolabR';
    right.position.set(x, 0, z);
    right.rotation.y = -toe;
    scene.add(left, right);
}

function loadBeolab50(scene, alu, black) {
    const url = new URL('./models/beolab50.glb', import.meta.url);
    url.searchParams.set('v', '1');
    const loader = new GLTFLoader();
    loader.load(
        url.href,
        (gltf) => {
            const proto = gltf.scene;
            proto.traverse((o) => {
                if (o.isMesh) {
                    o.castShadow = false;
                    o.receiveShadow = false;
                }
            });
            placeSpeakerPair(scene, proto);
        },
        undefined,
        (err) => {
            console.warn('Beolab 50 GLB failed, using pencil fallback', err);
            placeSpeakerPair(scene, beolabFallback(alu, black));
        },
    );
}

function loadZigZagChair(scene) {
    const url = new URL('./models/zigzag-chair.glb', import.meta.url);
    url.searchParams.set('v', '1');
    const loader = new GLTFLoader();
    loader.load(
        url.href,
        (gltf) => {
            const chair = gltf.scene;
            chair.name = 'zigzagChair';
            chair.position.set(0, 0, 0.23);
            chair.traverse((o) => {
                if (!o.isMesh) return;
                o.castShadow = false;
                o.receiveShadow = false;
            });
            scene.add(chair);
        },
        undefined,
        (err) => {
            console.warn('Zig-zag chair GLB failed', err);
        },
    );
}

function loadEiermann(parent, steel, deskTop) {
    const url = new URL('./models/eiermann.glb', import.meta.url);
    url.searchParams.set('v', '1');
    const loader = new GLTFLoader();
    loader.load(
        url.href,
        (gltf) => {
            const proto = gltf.scene;
            proto.name = 'eiermann';
            proto.position.set(0, 0, DESK_FRONT_Z - DESK_DEPTH / 2);
            proto.rotation.y = Math.PI;
            proto.traverse((o) => {
                if (o.isMesh) {
                    o.castShadow = false;
                    o.receiveShadow = false;
                }
            });
            parent.add(proto);
        },
        undefined,
        (err) => {
            console.warn('Eiermann GLB failed, using box fallback', err);
            parent.add(eiermannFallback(steel, deskTop));
        },
    );
}

function eiermannFallback(steel, topMat) {
    const g = new THREE.Group();
    const topZ = DESK_FRONT_Z - DESK_DEPTH / 2;
    const top = box(DESK_WIDTH, 0.022, DESK_DEPTH, topMat);
    top.position.set(0, DESK_TOP_Y - 0.011, topZ);
    g.add(top);

    const tube = 0.022;
    const inset = 0.06;
    const halfW = DESK_WIDTH / 2 - inset;
    const frontZ = DESK_FRONT_Z - inset;
    const backZ = DESK_FRONT_Z - DESK_DEPTH + inset;
    const railY = 0.16;

    function post(x, z) {
        const p = box(tube, DESK_TOP_Y - 0.022, tube, steel);
        p.position.set(x, (DESK_TOP_Y - 0.022) / 2, z);
        g.add(p);
    }
    post(-halfW, frontZ);
    post(halfW, frontZ);
    post(-halfW, backZ);
    post(halfW, backZ);

    function rail(w, h, d, x, y, z) {
        const m = box(w, h, d, steel);
        m.position.set(x, y, z);
        g.add(m);
    }
    rail(halfW * 2 + tube, tube, tube, 0, railY, frontZ);
    rail(halfW * 2 + tube, tube, tube, 0, railY, backZ);
    rail(tube, tube, Math.abs(frontZ - backZ), -halfW, railY, (frontZ + backZ) / 2);
    rail(tube, tube, Math.abs(frontZ - backZ), halfW, railY, (frontZ + backZ) / 2);

    // Kreuz on each long side (YZ plane), offset like Eiermann 1.
    function kreuz(x) {
        const spanZ = Math.abs(frontZ - backZ);
        const spanY = DESK_TOP_Y - 0.05;
        const len = Math.hypot(spanZ, spanY);
        const d1 = box(tube * 0.85, tube * 0.85, len, steel);
        d1.position.set(x, spanY / 2 + 0.02, (frontZ + backZ) / 2);
        d1.rotation.x = Math.atan2(spanY, spanZ);
        const d2 = d1.clone();
        d2.rotation.x = -Math.atan2(spanY, spanZ);
        g.add(d1, d2);
    }
    kreuz(-halfW);
    kreuz(halfW);
    return g;
}

function trackLighting(parent, black, deskTarget) {
    const y = ROOM.height - 0.07;
    const z = (DESK_FRONT_Z + DESK_FRONT_Z - DESK_DEPTH) / 2;
    const rail = box(1.9, 0.035, 0.04, black);
    rail.position.set(0, y, z);
    parent.add(rail);

    const xs = [-0.7, -0.23, 0.23, 0.7];
    for (const x of xs) {
        const can = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.034, 0.08, 10), black);
        can.position.set(x, y - 0.06, z);
        can.rotation.x = 0.55;
        parent.add(can);
    }

    const spot = new THREE.SpotLight(0xfff2e0, 3.2, 6.5, 0.55, 0.55, 1.1);
    spot.position.set(0.15, y - 0.08, z);
    spot.target.position.copy(deskTarget);
    parent.add(spot);
    parent.add(spot.target);

    const spot2 = new THREE.SpotLight(0xfff2e0, 1.8, 5.5, 0.45, 0.6, 1.1);
    spot2.position.set(-0.55, y - 0.08, z);
    spot2.target.position.copy(deskTarget);
    parent.add(spot2);
    parent.add(spot2.target);
}

export function createLoft(scene) {
    const floorW = ROOM.maxX - ROOM.minX + 0.4;
    const floorD = ROOM.maxZ - ROOM.minZ + 0.4;
    const sideD = ROOM.maxZ - ROOM.minZ + WALL_T;
    const plaster = plasterMaterial(floorW, ROOM.height);
    const ceilMat = plasterMaterial(floorW, floorD);
    const sideMat = plasterMaterial(sideD, ROOM.height);
    const steel = new THREE.MeshStandardMaterial({
        color: 0x6d7176,
        roughness: 0.42,
        metalness: 0.62,
    });
    const alu = new THREE.MeshStandardMaterial({
        color: 0xc9ccd0,
        roughness: 0.28,
        metalness: 0.78,
    });
    const black = new THREE.MeshStandardMaterial({
        color: MUNTIN,
        roughness: 0.45,
        metalness: 0.2,
    });
    const deskTop = new THREE.MeshStandardMaterial({
        color: 0xb8bcc0,
        roughness: 0.32,
        metalness: 0.72,
    });

    const floorMat = floorMaterial(floorW, floorD);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorW, floorD), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, (ROOM.minZ + ROOM.maxZ) / 2);
    scene.add(floor);

    const ceil = box(floorW, 0.06, floorD, ceilMat);
    ceil.position.set(0, ROOM.height + 0.03, (ROOM.minZ + ROOM.maxZ) / 2);
    scene.add(ceil);

    scene.add(windowWall(plaster));
    addMuntins(scene, black);

    const back = box(floorW, ROOM.height, WALL_T, plaster);
    back.position.set(0, ROOM.height / 2, ROOM.maxZ + WALL_T / 2);
    scene.add(back);

    const sideZ = (ROOM.minZ + ROOM.maxZ) / 2;
    const left = box(WALL_T, ROOM.height, sideD, sideMat);
    left.position.set(ROOM.minX - WALL_T / 2, ROOM.height / 2, sideZ);
    const right = box(WALL_T, ROOM.height, sideD, sideMat);
    right.position.set(ROOM.maxX + WALL_T / 2, ROOM.height / 2, sideZ);
    scene.add(left, right);

    const beamL = iBeam(ROOM.height, steel);
    beamL.position.set(-WIN.hw - 0.16, 0, ROOM.minZ + 0.1);
    const beamR = iBeam(ROOM.height, steel);
    beamR.position.set(WIN.hw + 0.16, 0, ROOM.minZ + 0.1);
    scene.add(beamL, beamR);

    loadBeolab50(scene, alu, black);
    loadZigZagChair(scene);

    const desk = new THREE.Group();
    desk.name = 'desk';
    scene.add(desk);
    loadEiermann(desk, steel, deskTop);

    const deskAim = new THREE.Vector3(0, DESK_TOP_Y, DESK_FRONT_Z - DESK_DEPTH * 0.35);
    trackLighting(scene, black, deskAim);

    return { desk };
}
