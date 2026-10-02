import * as THREE from './vendor/three.module.js';

/** Heat dusk — night and evening share this sky (no black night). */
const DUSK = {
    zenith: new THREE.Color(0x6a6d8a),
    horizon: new THREE.Color(0xe8a06a),
    haze: new THREE.Color(0xf0c4a0),
    ground: new THREE.Color(0x8a7060),
    sun: new THREE.Color(0xffc08a),
    hemiSky: new THREE.Color(0xe8b898),
    hemiGround: new THREE.Color(0x7a746c),
    sunIntensity: 0.85,
    hemiIntensity: 0.55,
    exposure: 0.92,
    photo: 0.38,
};

const DAY = {
    zenith: new THREE.Color(0x8ec4e8),
    horizon: new THREE.Color(0xdcebf5),
    haze: new THREE.Color(0xf2f6f8),
    ground: new THREE.Color(0xc8c2b8),
    sun: new THREE.Color(0xfff4e4),
    hemiSky: new THREE.Color(0xe8f0f6),
    hemiGround: new THREE.Color(0x9a9890),
    sunIntensity: 1.35,
    hemiIntensity: 0.7,
    exposure: 1.0,
    photo: 0.94,
};

const DAWN = {
    zenith: new THREE.Color(0x7a8aaa),
    horizon: new THREE.Color(0xf0b090),
    haze: new THREE.Color(0xf8d8c0),
    ground: new THREE.Color(0xa09080),
    sun: new THREE.Color(0xffd0a8),
    hemiSky: new THREE.Color(0xf0c8b0),
    hemiGround: new THREE.Color(0x8a847c),
    sunIntensity: 0.7,
    hemiIntensity: 0.5,
    exposure: 0.9,
    photo: 0.46,
};

function hourDecimal(date) {
    return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}

export function skyPalette(date = new Date()) {
    const h = hourDecimal(date);
    if (h >= 7.5 && h < 17) return DAY;
    if (h >= 5.5 && h < 7.5) return DAWN;
    return DUSK;
}

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
varying vec2 vUv;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vDir = w.xyz;
    vUv = uv;
    gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const SKY_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uGround;
uniform vec3 uSun;
uniform float uRotate;
uniform float uPhoto;
varying vec3 vDir;
varying vec2 vUv;
void main() {
    vec3 d = normalize(vDir);
    vec2 uv = vec2(fract(-vUv.x + uRotate), vUv.y);
    vec3 photo = texture2D(uMap, uv).rgb;
    photo = min(photo, vec3(0.92));
    float lum = dot(photo, vec3(0.2126, 0.7152, 0.0722));
    float h = d.y;
    float up = smoothstep(0.0, 0.72, h);
    float haze = exp(-max(h, 0.0) * 3.4);
    vec3 pal = mix(uHorizon, uZenith, up);
    pal = mix(pal, uHaze, haze * 0.55);
    float cloud = smoothstep(0.50, 0.80, lum) * smoothstep(0.03, 0.20, h);
    vec3 cloudCol = mix(mix(uHaze, uSun, 0.28), photo, 0.4);
    vec3 graded = mix(pal, cloudCol, cloud);
    vec3 col = mix(graded, photo, uPhoto);
    col = mix(uGround, col, smoothstep(-0.16, 0.05, h));
    gl_FragColor = vec4(col, 1.0);
}
`;

function blankMap() {
    const tex = new THREE.DataTexture(new Uint8Array([196, 186, 176, 255]), 1, 1);
    tex.needsUpdate = true;
    return tex;
}

/** Poly Haven “Kloofendal 38d Partly Cloudy (Pure Sky)”, CC0, Greg Zaal. */
function loadSkyMap(onLoad) {
    const url = new URL('./textures/sky/day.jpg', import.meta.url);
    url.searchParams.set('v', '1');
    new THREE.TextureLoader().load(url.href, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        onLoad(tex);
    });
}

export function createSky(scene, renderer) {
    const pal = skyPalette();
    const uniforms = {
        uMap: { value: blankMap() },
        uZenith: { value: pal.zenith.clone() },
        uHorizon: { value: pal.horizon.clone() },
        uHaze: { value: pal.haze.clone() },
        uGround: { value: pal.ground.clone() },
        uSun: { value: pal.sun.clone() },
        uRotate: { value: 0.18 },
        uPhoto: { value: pal.photo },
    };
    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(48, 32, 24),
        new THREE.ShaderMaterial({
            uniforms,
            vertexShader: SKY_VERT,
            fragmentShader: SKY_FRAG,
            side: THREE.BackSide,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    mesh.frustumCulled = false;
    mesh.userData.skipCursor = true;
    mesh.raycast = () => {};
    const yaw0 = uniforms.uRotate.value;
    const revMs = 2 * 60 * 60 * 1000;
    mesh.onBeforeRender = () => {
        uniforms.uRotate.value = yaw0 + performance.now() / revMs;
    };
    scene.add(mesh);
    loadSkyMap((tex) => {
        uniforms.uMap.value.dispose();
        uniforms.uMap.value = tex;
    });

    const hemi = new THREE.HemisphereLight(pal.hemiSky, pal.hemiGround, pal.hemiIntensity);
    scene.add(hemi);

    const sun = new THREE.DirectionalLight(pal.sun, pal.sunIntensity);
    sun.position.set(-1.2, 3.4, -6.5);
    scene.add(sun);

    function apply(date) {
        const p = skyPalette(date);
        uniforms.uZenith.value.copy(p.zenith);
        uniforms.uHorizon.value.copy(p.horizon);
        uniforms.uHaze.value.copy(p.haze);
        uniforms.uGround.value.copy(p.ground);
        uniforms.uSun.value.copy(p.sun);
        uniforms.uPhoto.value = p.photo;
        hemi.color.copy(p.hemiSky);
        hemi.groundColor.copy(p.hemiGround);
        hemi.intensity = p.hemiIntensity;
        sun.color.copy(p.sun);
        sun.intensity = p.sunIntensity;
        if (renderer) renderer.toneMappingExposure = p.exposure;
    }

    apply();
    return { mesh, sun, hemi, apply };
}
