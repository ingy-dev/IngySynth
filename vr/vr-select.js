import * as THREE from './vendor/three.module.js';
import { makeLabel, noHit } from './vr-label.js?v=2';

const ITEM_H = 0.016;
const ITEM_W = 0.13;
const MAX_VISIBLE = 9;

let open = null;
const itemMat = new THREE.MeshStandardMaterial({
    color: 0x2a2a28,
    roughness: 0.55,
    metalness: 0.08,
});
const itemOnMat = new THREE.MeshStandardMaterial({
    color: 0x3e4a32,
    roughness: 0.5,
    metalness: 0.08,
});

function flatten(items) {
    return (items || []).map((it) => (
        typeof it === 'string'
            ? { id: it, label: it }
            : { id: String(it.id), label: it.label || String(it.id), children: it.children }
    ));
}

function removeFrom(interactives, mesh) {
    const i = interactives.indexOf(mesh);
    if (i >= 0) interactives.splice(i, 1);
}

export function hasOpenSelect() {
    return !!open;
}

export function openSelectTrigger() {
    return open?.trigger || null;
}

export function closeSelect(interactives) {
    if (!open) return;
    for (const m of open.hits) {
        removeFrom(interactives, m);
        m.parent?.remove(m);
    }
    open.root.parent?.remove(open.root);
    open = null;
}

function paintItem(mesh, text, on) {
    mesh.material = (on ? itemOnMat : itemMat).clone();
    if (mesh.userData.label) mesh.userData.label.userData.setText(text);
}

function rebuild(interactives) {
    if (!open) return;
    for (const m of open.hits) {
        removeFrom(interactives, m);
        m.parent?.remove(m);
    }
    open.hits.length = 0;

    const { root, stack, value } = open;
    const level = stack[stack.length - 1];
    const rows = [];
    if (stack.length > 1) rows.push({ id: '__back', label: '‹ Back', back: true });
    rows.push(...level);

    const max = MAX_VISIBLE;
    const maxScroll = Math.max(0, rows.length - max);
    open.scroll = Math.max(0, Math.min(maxScroll, open.scroll || 0));
    const slice = rows.slice(open.scroll, open.scroll + max);

    if (open.scroll > 0) {
        slice.unshift({ id: '__up', label: '▲', nav: -1 });
    }
    if (open.scroll + max < rows.length) {
        slice.push({ id: '__down', label: '▼', nav: 1 });
    }

    slice.forEach((row, i) => {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(ITEM_W, ITEM_H * 0.92, 0.004),
            (String(row.id) === String(value) ? itemOnMat : itemMat).clone(),
        );
        mesh.position.set(0, -i * ITEM_H, 0);
        const label = makeLabel(row.label, ITEM_W * 0.92, ITEM_H * 0.72, {
            size: 22,
            pxW: 320,
            pxH: 48,
            color: '#e8e8e0',
        });
        label.position.z = 0.0024;
        mesh.add(label);
        mesh.userData = {
            kind: 'selectItem',
            itemId: row.id,
            back: !!row.back,
            nav: row.nav || 0,
            children: row.children,
            label,
            restColor: 0x2a2a28,
            restY: mesh.position.y,
        };
        root.add(mesh);
        open.hits.push(mesh);
        interactives.push(mesh);
        paintItem(mesh, row.label, String(row.id) === String(value) && !row.back && !row.nav);
    });
}

/**
 * One world-space list. `items` may be nested `{ id, label, children }`.
 * `mount` is the panel face (local +Z outward). Popover sits in front of the trigger.
 */
export function toggleSelect(trigger, interactives, mount, {
    items,
    getValue,
    setValue,
} = {}) {
    if (open && open.trigger === trigger) {
        closeSelect(interactives);
        return;
    }
    closeSelect(interactives);

    const root = new THREE.Group();
    const local = mount.worldToLocal(trigger.getWorldPosition(new THREE.Vector3()));
    root.position.set(local.x, local.y + ITEM_H * 0.2, local.z + 0.018);
    mount.add(root);

    open = {
        trigger,
        root,
        hits: [],
        stack: [flatten(items)],
        value: getValue ? getValue() : '',
        getValue,
        setValue,
        items: flatten(items),
        scroll: 0,
    };
    rebuild(interactives);
}

export function handleSelectItem(mesh, interactives) {
    if (!open || !mesh) return;
    const ud = mesh.userData;
    if (ud.nav) {
        open.scroll += ud.nav * (MAX_VISIBLE - 2);
        rebuild(interactives);
        return;
    }
    if (ud.back) {
        if (open.stack.length > 1) open.stack.pop();
        open.scroll = 0;
        rebuild(interactives);
        return;
    }
    if (ud.children && ud.children.length) {
        open.stack.push(flatten(ud.children));
        open.scroll = 0;
        rebuild(interactives);
        return;
    }
    open.setValue?.(ud.itemId);
    closeSelect(interactives);
}

export function createSelectTrigger(parent, {
    x, y, z,
    w = 0.072,
    h = 0.016,
    d = 0.006,
    label = '',
    items = [],
    getValue,
    setValue,
    voiceBay = false,
} = {}) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: 0x323230, roughness: 0.55, metalness: 0.1 }),
    );
    mesh.position.set(x, y, z);
    const caption = makeLabel(label, w * 0.94, h * 0.78, { size: 22, pxW: 280, pxH: 48 });
    caption.position.z = d / 2 + 0.0006;
    mesh.add(caption);
    mesh.userData = {
        kind: 'select',
        restColor: 0x323230,
        restY: mesh.position.y,
        voiceBay,
        items,
        getValue,
        setValue,
        caption,
        mount: parent,
    };
    const sync = () => {
        const v = getValue?.();
        const all = flatten(items);
        const found = (function find(list) {
            for (const it of list) {
                if (it.id === v) return it;
                if (it.children) {
                    const hit = find(it.children);
                    if (hit) return hit;
                }
            }
            return null;
        }(all));
        caption.userData.setText(found?.label || label);
    };
    mesh.userData.sync = sync;
    sync();
    parent.add(mesh);
    return mesh;
}
