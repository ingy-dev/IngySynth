import * as THREE from './vendor/three.module.js';
import {
    currentNormForKey,
    currentKnobValue,
    formatKnobValue,
    knobCaption,
    normToValue,
    KNOB_TRAVEL,
} from './vr-knob.js?v=13';
import { getParam } from '../js/param-catalog.js?v=6';
import { createKnobReadout } from './knob-readout.js?v=3';
import { FINGER_TIPS } from './wire-hand.js?v=1';
import {
    closeSelect,
    hasOpenSelect,
    handleSelectItem,
    openSelectTrigger,
    toggleSelect,
} from './vr-select.js?v=2';
import { createHoverBox } from './hover-box.js?v=3';

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const rotMatrix = new THREE.Matrix4();
const plane = new THREE.Plane();
const planeHit = new THREE.Vector3();
const worldPos = new THREE.Vector3();
const worldQuat = new THREE.Quaternion();
const planeN = new THREE.Vector3();
const localPt = new THREE.Vector3();
const dragAxis = new THREE.Vector3();
const ctrlPos = new THREE.Vector3();
const tipPos = new THREE.Vector3();
const keyLocal = new THREE.Vector3();
const screenUv = { u: 0, v: 0 };

const POKE_PAD = 0.012;
const STICKY_DIST = 0.09;
const PINCH_KNOB_PAD = 0.038;
const POKE_PRIORITY = {
    selectItem: 12,
    button: 9,
    select: 9,
    xy: 8,
    startStop: 7,
    mode: 7,
    octUp: 6,
    octDown: 6,
    pitch: 5,
    lfo: 5,
    stepsScreen: 4,
    note: 3,
};
const STICKY_KINDS = new Set(['xy', 'pitch', 'lfo', 'stepsScreen']);

const DRAG_KINDS = new Set(['pitch', 'lfo']);
const KNOWN = new Set([
    'note', 'octUp', 'octDown', 'startStop', 'mode', 'pitch', 'lfo',
    'stepsScreen', 'knob', 'button', 'xy', 'select', 'selectItem', 'hex',
    'grab',
]);
const PINCH_GRAB_PAD = 0.055;

function pickFromRay(targets) {
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    let hit = null;
    for (let i = 0; i < hits.length; i++) {
        const obj = hits[i].object;
        if (!obj.userData?.kind || !obj.visible) continue;
        hit = hits[i];
        break;
    }
    if (!hit) return null;
    for (let i = 0; i < hits.length && i < 8; i++) {
        const obj = hits[i].object;
        if (!obj.visible) continue;
        if (obj.userData?.kind === 'note' && obj.userData.isBlack
            && hits[i].distance - hit.distance < 0.045) {
            hit = hits[i];
            break;
        }
    }
    return { object: hit.object, point: hit.point };
}

function uvOnScreen(mesh, worldPoint) {
    localPt.copy(worldPoint);
    mesh.worldToLocal(localPt);
    const w = mesh.geometry.parameters.width;
    const h = mesh.geometry.parameters.height;
    screenUv.u = THREE.MathUtils.clamp(localPt.x / w + 0.5, 0, 1);
    screenUv.v = THREE.MathUtils.clamp(0.5 - localPt.y / h, 0, 1);
    return screenUv;
}

function pointOnScreen(mesh) {
    mesh.getWorldPosition(worldPos);
    mesh.getWorldQuaternion(worldQuat);
    planeN.set(0, 0, 1).applyQuaternion(worldQuat);
    plane.setFromNormalAndCoplanarPoint(planeN, worldPos);
    if (!raycaster.ray.intersectPlane(plane, planeHit)) return null;
    return planeHit;
}

function setControllerRay(controller) {
    rotMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(rotMatrix);
}

function pickFromController(controller, targets) {
    setControllerRay(controller);
    return pickFromRay(targets);
}

function pickFromPointer(camera, event, canvas, targets) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return pickFromRay(targets);
}

function pointOnControl(mesh) {
    mesh.getWorldPosition(worldPos);
    mesh.getWorldQuaternion(worldQuat);
    planeN.set(0, 1, 0).applyQuaternion(worldQuat);
    plane.setFromNormalAndCoplanarPoint(planeN, worldPos);
    if (!raycaster.ray.intersectPlane(plane, planeHit)) return null;
    return planeHit;
}

function stripValue(mesh, worldPoint) {
    localPt.copy(worldPoint);
    mesh.worldToLocal(localPt);
    const half = mesh.userData.half || mesh.userData.halfW || 0.05;
    const axis = mesh.userData.axis || 'x';
    const v = axis === 'z' ? localPt.z : localPt.x;
    const kind = mesh.userData.kind;
    if (kind === 'pitch') {
        return THREE.MathUtils.clamp(-v / half, -1, 1);
    }
    if (kind === 'lfo') {
        return THREE.MathUtils.clamp(0.5 - v / (half * 2), 0, 1);
    }
    return THREE.MathUtils.clamp(0.5 - v / (half * 2), 0, 1);
}

const _pokeBox = new THREE.Box3();

function fingerHits(mesh, worldPoint, pad = POKE_PAD) {
    const geo = mesh.geometry;
    if (!geo) return false;
    if (!geo.boundingBox) geo.computeBoundingBox();
    _pokeBox.copy(geo.boundingBox).expandByScalar(pad);
    mesh.worldToLocal(keyLocal.copy(worldPoint));
    return _pokeBox.containsPoint(keyLocal);
}

function pokePriority(mesh) {
    const kind = mesh.userData?.kind;
    if (kind === 'note' && mesh.userData.isBlack) return 11;
    return POKE_PRIORITY[kind] || 0;
}

function pokeTarget(targets, worldPoint) {
    let best = null;
    let bestPri = -1;
    let bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
        const mesh = targets[i];
        const kind = mesh.userData?.kind;
        if (!kind || !KNOWN.has(kind) || kind === 'hex' || kind === 'knob' || kind === 'grab') continue;
        if (!mesh.visible) continue;
        if (!fingerHits(mesh, worldPoint)) continue;
        const pri = pokePriority(mesh);
        mesh.getWorldPosition(worldPos);
        const d = worldPos.distanceToSquared(worldPoint);
        if (pri > bestPri || (pri === bestPri && d < bestDist)) {
            best = mesh;
            bestPri = pri;
            bestDist = d;
        }
    }
    return best;
}

function stillSticky(mesh, worldPoint) {
    mesh.getWorldPosition(worldPos);
    return worldPos.distanceTo(worldPoint) < STICKY_DIST;
}

function nearestKnob(targets, worldPoint) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
        const mesh = targets[i];
        if (mesh.userData?.kind !== 'knob') continue;
        if (!fingerHits(mesh, worldPoint, PINCH_KNOB_PAD)) continue;
        mesh.getWorldPosition(worldPos);
        const d = worldPos.distanceToSquared(worldPoint);
        if (d < bestDist) {
            best = mesh;
            bestDist = d;
        }
    }
    return best;
}

function nearestGrab(targets, worldPoint) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
        const mesh = targets[i];
        if (mesh.userData?.kind !== 'grab') continue;
        if (!mesh.visible) continue;
        if (!fingerHits(mesh, worldPoint, PINCH_GRAB_PAD)) continue;
        mesh.getWorldPosition(worldPos);
        const d = worldPos.distanceToSquared(worldPoint);
        if (d < bestDist) {
            best = mesh;
            bestDist = d;
        }
    }
    return best;
}

function emitDrag(kind, value, hooks) {
    if (kind === 'pitch') hooks.onPitch?.(value);
    else if (kind === 'lfo') hooks.onLfo?.(value);
}

function controllerWorld(controller, out) {
    return out.setFromMatrixPosition(controller.matrixWorld);
}

function applyKnobNorm(mesh, norm, onKnob) {
    const key = mesh.userData.key;
    const spec = getParam(key);
    if (!spec || !onKnob) return;
    const value = normToValue(spec, norm, mesh.userData.map);
    onKnob(key, value);
    return value;
}

function readoutCopy(mesh, value) {
    const key = mesh.userData.key;
    const v = value !== undefined ? value : currentKnobValue(key);
    return {
        caption: knobCaption(mesh),
        text: formatKnobValue(key, v, mesh.userData.map),
    };
}

export function bindBoard({
    renderer,
    scene,
    camera,
    onFrame,
    interactives,
    setPressed,
    shiftOctave,
    useHeld,
    onPress,
    onRelease,
    onHeldDown,
    onHeldUp,
    onAnySelect,
    onStartStop,
    onMode,
    onPitch,
    onPitchEnd,
    onLfo,
    onKnob,
    onButton,
    keyMeshes = [],
    setKeyHover = () => {},
}) {
    const held = new Map();
    const semiRefs = new Map();
    const hooks = { onPitch, onLfo };
    const controllers = [];
    const hands = [renderer.xr.getHand(0), renderer.xr.getHand(1)];
    const readout = createKnobReadout(scene);
    const hoverXr = [createHoverBox(scene), createHoverBox(scene)];
    const hoverDesk = createHoverBox(scene);
    const canvas = renderer.domElement;
    let deskPointer = null;
    const litNotes = new Set();

    function syncNoteHover(meshes) {
        const next = new Set(meshes);
        for (const mesh of litNotes) {
            if (!next.has(mesh)) setKeyHover(mesh, false);
        }
        for (const mesh of next) setKeyHover(mesh, true);
        litNotes.clear();
        next.forEach((mesh) => litNotes.add(mesh));
    }

    function rememberDesk(event) {
        deskPointer = {
            clientX: event.clientX,
            clientY: event.clientY,
            pointerId: event.pointerId,
        };
    }

    function hoverMesh(id, pick) {
        const heldMesh = held.get(id)?.mesh;
        if (heldMesh?.parent) return heldMesh;
        const mesh = pick?.object;
        const kind = mesh?.userData?.kind;
        if (!kind || !KNOWN.has(kind) || kind === 'hex') return null;
        return mesh;
    }

    function tickHover() {
        const seen = new Set();
        const notes = [];
        function apply(box, mesh) {
            if (mesh?.userData?.kind === 'note') {
                notes.push(mesh);
                box.hide();
                return;
            }
            if (mesh && seen.has(mesh)) {
                box.hide();
                return;
            }
            box.show(mesh);
            if (mesh) seen.add(mesh);
        }
        if (!renderer.xr.isPresenting) {
            hoverXr[0].hide();
            hoverXr[1].hide();
            if (!deskPointer) {
                hoverDesk.hide();
                syncNoteHover([]);
                return;
            }
            const id = `ptr:${deskPointer.pointerId}`;
            const pick = pickFromPointer(camera, deskPointer, canvas, interactives);
            apply(hoverDesk, hoverMesh(id, pick));
            syncNoteHover(notes);
            return;
        }
        hoverDesk.hide();
        for (let i = 0; i < 2; i++) {
            const controller = controllers[i];
            const id = `xr:${i}`;
            if (!controller || controller.userData.isHand || controller.userData.hidePointer) {
                const heldMesh = held.get(id)?.mesh;
                apply(hoverXr[i], heldMesh?.parent ? heldMesh : null);
                continue;
            }
            apply(hoverXr[i], hoverMesh(id, pickFromController(controller, interactives)));
        }
        syncNoteHover(notes);
    }

    function remainingSemis() {
        const out = [];
        for (const h of held.values()) {
            if (h.kind === 'note') out.push(h.semi);
        }
        return out;
    }

    function noteDown(semi) {
        const n = (semiRefs.get(semi) || 0) + 1;
        semiRefs.set(semi, n);
        if (n !== 1) return;
        if (useHeld()) onHeldDown(semi);
        else onPress(semi);
    }

    function noteUp(semi) {
        const n = (semiRefs.get(semi) || 1) - 1;
        if (n > 0) {
            semiRefs.set(semi, n);
            return;
        }
        semiRefs.delete(semi);
        if (useHeld()) {
            onHeldUp(semi);
            return;
        }
        const left = remainingSemis().filter((s) => s !== semi);
        if (left.length) onPress(left[left.length - 1]);
        else onRelease();
    }

    function dismissSelect() {
        if (hasOpenSelect()) closeSelect(interactives);
    }

    function sampleFromId(id) {
        if (id.startsWith('poke:')) {
            const rest = id.slice(5);
            const split = rest.indexOf(':');
            const hand = hands[Number(rest.slice(0, split))];
            const joint = hand?.joints[rest.slice(split + 1)];
            if (joint?.visible) return joint.getWorldPosition(ctrlPos).clone();
            return null;
        }
        if (id.startsWith('xr:')) {
            const c = controllers[Number(id.slice(3))];
            if (c) return controllerWorld(c, ctrlPos).clone();
        }
        return null;
    }

    function knobSample(id, mesh) {
        const fromId = sampleFromId(id);
        if (fromId) return fromId;
        const pt = pointOnControl(mesh);
        return pt ? pt.clone() : null;
    }

    function setPointerHidden(id, hidden) {
        if (!id.startsWith('xr:')) return;
        const c = controllers[Number(id.slice(3))];
        if (c) c.userData.hidePointer = !!hidden;
    }

    function pinchPoint(handIndex, out) {
        const hand = hands[handIndex];
        const index = hand?.joints['index-finger-tip'];
        const thumb = hand?.joints['thumb-tip'];
        if (index?.visible && thumb?.visible) {
            index.getWorldPosition(out);
            thumb.getWorldPosition(worldPos);
            return out.add(worldPos).multiplyScalar(0.5);
        }
        if (index?.visible) return index.getWorldPosition(out);
        const c = controllers[handIndex];
        return c ? controllerWorld(c, out) : null;
    }

    function grabHand(id, fallback, pos, quat) {
        if (id.startsWith('xr:')) {
            const i = Number(id.slice(3));
            const c = controllers[i];
            if (!c) {
                pos.copy(fallback);
                quat.copy(camera.quaternion);
                return;
            }
            if (c.userData.isHand) {
                const pt = pinchPoint(i, tipPos);
                if (pt) pos.copy(pt);
                else pos.copy(fallback);
                quat.identity();
                return;
            }
            c.getWorldPosition(pos);
            c.getWorldQuaternion(quat);
            return;
        }
        pos.copy(fallback);
        quat.copy(camera.quaternion);
    }

    function moveGrabHeld(id, h) {
        if (id.startsWith('xr:')) {
            grabHand(id, tipPos, worldPos, worldQuat);
            h.mesh.userData.onGrabMove?.(worldPos, worldQuat);
            return;
        }
        raycaster.ray.at(h.grabDist, worldPos);
        h.mesh.userData.onGrabMove?.(worldPos, camera.quaternion);
    }

    function pokeId(handIndex, tip) {
        return `poke:${handIndex}:${tip}`;
    }

    function endPokeHand(handIndex) {
        for (const tip of FINGER_TIPS) end(pokeId(handIndex, tip));
    }

    function tickPoke() {
        for (let i = 0; i < 2; i++) {
            const hand = hands[i];
            const controller = controllers[i];
            const isHand = !!controller?.userData?.isHand;
            if (controller) controller.userData.hidePointer = isHand;
            if (!isHand || !hand?.visible) {
                endPokeHand(i);
                continue;
            }
            const joints = hand.joints;
            for (const tip of FINGER_TIPS) {
                const id = pokeId(i, tip);
                const joint = joints[tip];
                if (!joint?.visible) {
                    end(id);
                    continue;
                }
                joint.getWorldPosition(tipPos);
                const current = held.get(id);
                if (current && STICKY_KINDS.has(current.kind) && stillSticky(current.mesh, tipPos)) {
                    glide(id, { object: current.mesh, point: tipPos });
                    continue;
                }
                const next = pokeTarget(interactives, tipPos);
                if (current && current.mesh === next) {
                    glide(id, { object: next, point: tipPos });
                    continue;
                }
                if (current) end(id);
                if (next) {
                    onAnySelect?.();
                    begin(id, { object: next, point: tipPos.clone() });
                }
            }
        }
    }

    function begin(id, pick) {
        if (held.has(id)) return;
        if (!pick) {
            dismissSelect();
            return;
        }
        const mesh = pick.object;
        const kind = mesh.userData.kind;
        if (!kind || !KNOWN.has(kind) || kind === 'hex') {
            dismissSelect();
            return;
        }

        if (kind === 'selectItem') {
            handleSelectItem(mesh, interactives);
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'select') {
            if (hasOpenSelect() && openSelectTrigger() === mesh) {
                closeSelect(interactives);
            } else {
                toggleSelect(mesh, interactives, mesh.userData.mount, {
                    items: mesh.userData.items,
                    getValue: mesh.userData.getValue,
                    setValue: mesh.userData.setValue,
                });
            }
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            return;
        }

        if (hasOpenSelect()) closeSelect(interactives);

        if (kind === 'grab') {
            grabHand(id, pick.point, worldPos, worldQuat);
            mesh.userData.onGrabBegin?.(worldPos, worldQuat);
            held.set(id, {
                kind,
                mesh,
                semi: null,
                grabDist: pick.point.distanceTo(raycaster.ray.origin),
            });
            setPointerHidden(id, true);
            return;
        }
        if (kind === 'octDown' || kind === 'octUp') {
            shiftOctave(kind === 'octUp' ? 1 : -1);
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'startStop') {
            onStartStop?.();
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'mode') {
            onMode?.(mesh.userData.mode);
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'button') {
            onButton?.(mesh.userData);
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'stepsScreen') {
            const uv = uvOnScreen(mesh, pick.point);
            mesh.userData.onStepsDown?.(uv.u, uv.v);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'xy') {
            mesh.userData.dragStart?.();
            const uv = uvOnScreen(mesh, pick.point);
            mesh.userData.applyUv?.(uv.u, uv.v);
            held.set(id, { kind, mesh, semi: null });
            return;
        }
        if (kind === 'knob') {
            const sample = knobSample(id, mesh) || pick.point.clone();
            const startNorm = currentNormForKey(mesh.userData.key, mesh.userData.map);
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null, startNorm, startPt: sample });
            const copy = readoutCopy(mesh);
            readout.show(mesh, copy.caption, copy.text);
            setPointerHidden(id, true);
            return;
        }
        if (DRAG_KINDS.has(kind)) {
            setPressed(mesh, true);
            held.set(id, { kind, mesh, semi: null });
            emitDrag(kind, stripValue(mesh, pick.point), hooks);
            return;
        }
        if (kind !== 'note' || !mesh.visible) return;
        const semi = mesh.userData.semitone;
        held.set(id, { kind, mesh, semi });
        setPressed(mesh, true);
        noteDown(semi);
    }

    function end(id) {
        const h = held.get(id);
        if (!h) return;
        held.delete(id);
        if (h.kind !== 'stepsScreen' && h.kind !== 'xy' && h.kind !== 'grab') setPressed(h.mesh, false);
        if (h.kind === 'note') noteUp(h.semi);
        else if (h.kind === 'pitch') onPitchEnd?.();
        else if (h.kind === 'stepsScreen') h.mesh.userData.onStepsUp?.();
        else if (h.kind === 'xy') h.mesh.userData.dragEnd?.();
        else if (h.kind === 'grab') {
            h.mesh.userData.onGrabEnd?.();
            setPointerHidden(id, false);
        }
        else if (h.kind === 'knob') {
            readout.release();
            setPointerHidden(id, false);
        }
    }

    function glide(id, pick) {
        const h = held.get(id);
        if (!h) return;
        if (h.kind === 'grab') {
            moveGrabHeld(id, h);
            return;
        }
        if (h.kind === 'note') {
            if (!pick || pick.object.userData.kind !== 'note') return;
            if (!pick.object.visible) return;
            if (useHeld()) return;
            const semi = pick.object.userData.semitone;
            if (semi === h.semi) return;
            setPressed(h.mesh, false);
            const old = h.semi;
            h.mesh = pick.object;
            h.semi = semi;
            setPressed(h.mesh, true);
            const oldRefs = semiRefs.get(old) || 1;
            if (oldRefs <= 1) semiRefs.delete(old);
            else semiRefs.set(old, oldRefs - 1);
            const n = (semiRefs.get(semi) || 0) + 1;
            semiRefs.set(semi, n);
            onPress(semi);
            return;
        }
        if (h.kind === 'stepsScreen') {
            const pt = pick?.point || pointOnScreen(h.mesh);
            if (!pt) return;
            const uv = uvOnScreen(h.mesh, pt);
            h.mesh.userData.onStepsMove?.(uv.u, uv.v);
            return;
        }
        if (h.kind === 'xy') {
            const pt = pick?.point || pointOnScreen(h.mesh);
            if (!pt) return;
            const uv = uvOnScreen(h.mesh, pt);
            h.mesh.userData.applyUv?.(uv.u, uv.v);
            return;
        }
        if (h.kind === 'knob') {
            const sample = knobSample(id, h.mesh);
            if (!sample || !h.startPt) return;
            h.mesh.userData.getDragAxis(dragAxis);
            const meters = sample.clone().sub(h.startPt).dot(dragAxis);
            const norm = THREE.MathUtils.clamp(h.startNorm + meters / KNOB_TRAVEL, 0, 1);
            const value = applyKnobNorm(h.mesh, norm, onKnob);
            const copy = readoutCopy(h.mesh, value);
            readout.update(copy.caption, copy.text);
            return;
        }
        if (!DRAG_KINDS.has(h.kind)) return;
        const pt = pick?.point || pointOnControl(h.mesh);
        if (!pt) return;
        emitDrag(h.kind, stripValue(h.mesh, pt), hooks);
    }

    function bindController(index) {
        const controller = renderer.xr.getController(index);
        scene.add(controller);
        const id = `xr:${index}`;
        controller.addEventListener('connected', (event) => {
            controller.userData.isHand = !!event.data?.hand;
            controller.userData.gamepad = event.data?.gamepad || null;
            controller.userData.handedness = event.data?.handedness || '';
        });
        controller.addEventListener('disconnected', () => {
            controller.userData.isHand = false;
            controller.userData.gamepad = null;
            controller.userData.handedness = '';
        });
        controller.addEventListener('selectstart', () => {
            onAnySelect?.();
            if (controller.userData.isHand) {
                const pt = pinchPoint(index, tipPos);
                if (!pt) return;
                const knob = nearestKnob(interactives, pt);
                if (knob) {
                    begin(id, { object: knob, point: pt.clone() });
                    return;
                }
                const grab = nearestGrab(interactives, pt);
                if (grab) begin(id, { object: grab, point: pt.clone() });
                return;
            }
            begin(id, pickFromController(controller, interactives));
        });
        controller.addEventListener('selectend', () => end(id));
        return controller;
    }

    controllers.push(bindController(0), bindController(1));

    /** xr-standard: buttons[4] is A on the right Touch controller. */
    const XR_A = 4;
    let rightADown = false;

    function tickRightA() {
        let right = null;
        for (let i = 0; i < controllers.length; i++) {
            const c = controllers[i];
            if (c.userData.handedness === 'right' && !c.userData.isHand) {
                right = c;
                break;
            }
        }
        const pressed = !!(right?.userData.gamepad?.buttons?.[XR_A]?.pressed);
        if (pressed && !rightADown) {
            onAnySelect?.();
            onStartStop?.();
        }
        rightADown = pressed;
    }

    onFrame(() => {
        readout.tick(camera);
        tickHover();
        if (!renderer.xr.isPresenting) {
            rightADown = false;
            return;
        }
        tickPoke();
        tickRightA();
        for (let i = 0; i < 2; i++) {
            const id = `xr:${i}`;
            if (!held.has(id)) continue;
            glide(id, pickFromController(controllers[i], interactives));
        }
    });

    canvas.addEventListener('pointerdown', (event) => {
        if (renderer.xr.isPresenting) return;
        rememberDesk(event);
        onAnySelect?.();
        const pick = pickFromPointer(camera, event, canvas, interactives);
        begin(`ptr:${event.pointerId}`, pick);
        if (pick) canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
        if (renderer.xr.isPresenting) return;
        rememberDesk(event);
        if (!held.has(`ptr:${event.pointerId}`)) return;
        glide(`ptr:${event.pointerId}`, pickFromPointer(camera, event, canvas, interactives));
    });
    canvas.addEventListener('pointerup', (event) => {
        if (!held.has(`ptr:${event.pointerId}`)) return;
        try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
        end(`ptr:${event.pointerId}`);
    });
    canvas.addEventListener('pointerleave', (event) => {
        if (renderer.xr.isPresenting) return;
        if (held.has(`ptr:${event.pointerId}`)) return;
        deskPointer = null;
    });

    function releaseAll() {
        for (const id of [...held.keys()]) end(id);
        dismissSelect();
        hoverXr[0].hide();
        hoverXr[1].hide();
        hoverDesk.hide();
        syncNoteHover([]);
        rightADown = false;
    }

    return { controllers, releaseAll, dismissSelect };
}
