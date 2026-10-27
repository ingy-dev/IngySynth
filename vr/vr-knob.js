import * as THREE from './vendor/three.module.js';
import { getNumber, getString, subscribe } from '../js/params.js?v=19';
import { getParam } from '../js/param-catalog.js?v=4';
import { makeLabel, noHit } from './vr-label.js?v=2';

const ANGLE_MIN = -135 * Math.PI / 180;
const ANGLE_SPAN = 270 * Math.PI / 180;
const Y_UP = new THREE.Vector3(0, 1, 0);
const _dragQ = new THREE.Quaternion();

export const KNOB_TRAVEL = 0.10;

const pointerMat = new THREE.MeshStandardMaterial({
    color: 0xf6f3ec,
    emissive: 0x8a8878,
    emissiveIntensity: 0.55,
    roughness: 0.32,
    metalness: 0.06,
});
const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2c2c2a,
    roughness: 0.48,
    metalness: 0.16,
});

function clamp01(n) {
    return Math.max(0, Math.min(1, n));
}

export function valueToNorm(spec, value, map) {
    if (!spec) return 0;
    if (spec.type === 'select' && spec.options?.length) {
        const idx = spec.options.indexOf(String(value));
        if (idx < 0) return 0;
        return spec.options.length <= 1 ? 0 : idx / (spec.options.length - 1);
    }
    const min = spec.min;
    const max = spec.max;
    if (![min, max].every(Number.isFinite) || max === min) return 0;
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    if (map === 'log') {
        const lo = Math.max(1e-6, min);
        const hi = Math.max(lo * 1.01, max);
        const x = Math.max(lo, Math.min(hi, v));
        return Math.log(x / lo) / Math.log(hi / lo);
    }
    return clamp01((v - min) / (max - min));
}

export function normToValue(spec, norm, map) {
    const n = clamp01(norm);
    if (!spec) return n;
    if (spec.type === 'select' && spec.options?.length) {
        const i = Math.round(n * (spec.options.length - 1));
        return spec.options[Math.max(0, Math.min(spec.options.length - 1, i))];
    }
    const min = spec.min;
    const max = spec.max;
    if (![min, max].every(Number.isFinite)) return n;
    let v;
    if (map === 'log') {
        const lo = Math.max(1e-6, min);
        const hi = Math.max(lo * 1.01, max);
        v = lo * (hi / lo) ** n;
    } else {
        v = min + n * (max - min);
    }
    if (Number.isFinite(spec.step) && spec.step > 0) {
        v = Math.round(v / spec.step) * spec.step;
        const decimals = spec.step < 1 ? Math.ceil(-Math.log10(spec.step)) : 0;
        if (decimals > 0) v = Number(v.toFixed(decimals));
    }
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    return v;
}

export function currentNormForKey(key, map) {
    const spec = getParam(key);
    if (!spec) return 0;
    if (spec.type === 'select') return valueToNorm(spec, getString(key, spec.default), map);
    return valueToNorm(spec, getNumber(key, spec.default), map);
}

function trimNum(n, decimals) {
    const s = Number(n).toFixed(decimals);
    return s.replace(/\.?0+$/, '') || '0';
}

function signed(n, decimals) {
    const mag = decimals > 0 ? trimNum(Math.abs(n), decimals) : String(Math.round(Math.abs(n)));
    if (n > 0) return `+${mag}`;
    if (n < 0) return `-${mag}`;
    return decimals > 0 ? trimNum(0, decimals) : '0';
}

/** Pitch, rate, tempo, and other counted params — not 0–100 amounts. */
function usesNativeReadout(key) {
    return key === 'tempo'
        || key === 'division'
        || key === 'stepCount'
        || key === 'lfoSpeed'
        || key === 'unisonDetune'
        || key === 'masterTune'
        || key === 'octaveSwitch'
        || key === 'semitoneSwitch'
        || /^osc-tune-/.test(key)
        || /PitchMod$/.test(key);
}

function formatNativeKnobValue(key, value, spec) {
    if (spec?.type === 'select') {
        const s = String(value ?? spec.default ?? '');
        if (key === 'division' || key === 'delayTime') return `1/${s}`;
        return s;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value ?? '');
    if (key === 'tempo') return `${Math.round(n)} BPM`;
    if (key === 'lfoSpeed') return `${trimNum(n, 2)} Hz`;
    if (key === 'unisonDetune') return `${Math.round(n)}¢`;
    if (key === 'stepCount') return String(Math.round(n));
    if (key === 'masterTune' || /^osc-tune-/.test(key) || /PitchMod$/.test(key)) {
        return `${signed(n, Number(spec?.step) < 1 ? 1 : 0)} st`;
    }
    if (key === 'octaveSwitch' || key === 'semitoneSwitch') return signed(n, 0);
    return String(n);
}

/** Live readout while a VR knob is held. Amounts are 0–100; counted params keep units. */
export function formatKnobValue(key, value, map) {
    const spec = getParam(key);
    if (usesNativeReadout(key)) return formatNativeKnobValue(key, value, spec);
    return String(Math.round(valueToNorm(spec, value, map) * 100));
}

export function currentKnobValue(key) {
    const spec = getParam(key);
    if (!spec) return null;
    if (spec.type === 'select') return getString(key, spec.default);
    return getNumber(key, spec.default);
}

const GENERIC_NAMES = new Set(['Tune', 'Volume']);

function titleFromKey(key) {
    return String(key || '')
        .replace(/[-_]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Full param name for the grab readout (Cutoff, Resonance), not the panel stamp. */
export function knobCaption(mesh) {
    const key = mesh?.userData?.key;
    const spec = key ? getParam(key) : null;
    const name = spec?.xyName;
    if (name) {
        const group = spec.xyGroup || '';
        if (GENERIC_NAMES.has(name) && group) {
            const osc = group.match(/^Oscillator (\d+)$/);
            if (osc) return `Osc ${osc[1]} ${name}`;
            return `${group} ${name}`;
        }
        return name;
    }
    if (key) return titleFromKey(key);
    return mesh?.userData?.label || '';
}

export function applyKnobAngle(mesh, norm) {
    const dial = mesh.userData.dial;
    if (!dial) return;
    // Clockwise from 7 o'clock (min) through 12 (mid) to 5 o'clock (max).
    dial.rotation.y = -(ANGLE_MIN + clamp01(norm) * ANGLE_SPAN);
}

/**
 * Dial on a face whose local +Z is outward and local +Y is up-the-panel.
 * Collider is the cylinder (non-recursive pick).
 */
export function createKnob(parent, {
    x, y, z,
    key,
    label = '',
    size = 0.018,
    map = 'lin',
    dragLocal = Y_UP,
    voiceBay = false,
    special = null,
    layout = 'panel',
} = {}) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    if (layout !== 'deck') group.rotation.x = Math.PI / 2;

    const r = size * 0.5;
    const halfH = size * 0.36;
    const collider = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 1.1, halfH * 2, 20),
        bodyMat.clone(),
    );
    const pointer = new THREE.Mesh(
        new THREE.BoxGeometry(size * 0.1, size * 0.07, r * 0.92),
        pointerMat,
    );
    pointer.position.set(0, halfH + size * 0.02, -r * 0.28);
    pointer.raycast = noHit;
    collider.add(pointer);
    const capDot = new THREE.Mesh(
        new THREE.CylinderGeometry(size * 0.045, size * 0.045, size * 0.04, 8),
        pointerMat,
    );
    capDot.position.y = halfH + size * 0.015;
    capDot.raycast = noHit;
    collider.add(capDot);
    group.add(collider);

    if (label) {
        const cap = makeLabel(label, size * 1.7, size * 0.42, { size: 26, pxW: 256, pxH: 64 });
        if (layout === 'deck') {
            cap.rotation.x = -Math.PI / 2;
            cap.position.set(0, size * 0.55, size * 0.85);
        } else {
            cap.position.set(0, 0, size * 0.95);
            cap.rotation.x = -Math.PI / 2;
        }
        group.add(cap);
    }

    collider.userData = {
        kind: 'knob',
        key,
        map,
        label,
        special,
        voiceBay,
        restColor: 0x2c2c2a,
        restY: 0,
        dial: collider,
        dragLocal: dragLocal.clone ? dragLocal.clone() : new THREE.Vector3().copy(dragLocal),
        getDragAxis(out) {
            parent.getWorldQuaternion(_dragQ);
            return out.copy(collider.userData.dragLocal).applyQuaternion(_dragQ);
        },
    };

    const unsub = key ? subscribe(key, () => {
        applyKnobAngle(collider, currentNormForKey(key, map));
    }) : null;
    collider.userData.unsub = unsub;
    applyKnobAngle(collider, currentNormForKey(key, map));

    parent.add(group);
    return collider;
}

export function createSteppedKnob(parent, opts) {
    return createKnob(parent, opts);
}
