import * as THREE from './vendor/three.module.js';

const FONT = 'Michroma, ui-sans-serif, sans-serif';

export function noHit() {}

export function whenFonts(fn) {
    if (document.fonts?.ready) document.fonts.ready.then(fn).catch(() => fn());
    else fn();
}

/** Trilinear mips so distant Michroma stamps do not sparkle as the headset moves. */
export function filterLabelTex(tex) {
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 16;
    tex.needsUpdate = true;
    return tex;
}

export function stampText(text, {
    w = 256,
    h = 64,
    size = 28,
    color = '#e6e6e0',
    align = 'center',
    baseline = 'middle',
    fill = null,
} = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const draw = () => {
        ctx.clearRect(0, 0, w, h);
        if (fill) {
            ctx.fillStyle = fill;
            ctx.fillRect(0, 0, w, h);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1.1, size * 0.05);
        ctx.font = `${size}px ${FONT}`;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        const x = align === 'left' ? 8 : align === 'right' ? w - 8 : w / 2;
        const y = baseline === 'top' ? 8 : h / 2;
        const str = String(text ?? '');
        ctx.strokeText(str, x, y);
        ctx.fillText(str, x, y);
    };
    draw();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    filterLabelTex(tex);
    whenFonts(() => {
        draw();
        tex.needsUpdate = true;
    });
    return { canvas, ctx, tex, redraw: (next) => {
        text = next;
        draw();
        tex.needsUpdate = true;
    } };
}

export function makeLabel(text, worldW, worldH, opts = {}) {
    const stamp = stampText(text, {
        w: opts.pxW || 256,
        h: opts.pxH || 64,
        size: opts.size || 30,
        color: opts.color || '#e6e6e0',
        align: opts.align || 'center',
        fill: opts.fill || null,
    });
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(worldW, worldH),
        new THREE.MeshBasicMaterial({
            map: stamp.tex,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
        }),
    );
    mesh.raycast = noHit;
    mesh.userData.stamp = stamp;
    mesh.userData.setText = (next) => stamp.redraw(next);
    return mesh;
}
