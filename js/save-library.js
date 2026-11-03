// Browser library slots in localStorage (caps documented in LIBRARY_CAPS).
import { normalize, parse, serialize } from './ingy/js/ingy-codec.js';

export const LIBRARY_KEY = 'ingysynth.library';
export const SESSION_KEY = 'ingysynth.session';

/** Web caps; Bare Metal library is unlimited. */
export const LIBRARY_CAPS = Object.freeze({
    patch: 8,
    pattern: 16,
    project: 16,
});

const KINDS = ['patch', 'pattern', 'project'];

function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `ingy-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function emptyLibrary() {
    return { patch: [], pattern: [], project: [] };
}

export function readLibrary(storage) {
    try {
        const raw = storage.getItem(LIBRARY_KEY);
        if (!raw) return emptyLibrary();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return emptyLibrary();
        const out = emptyLibrary();
        for (const kind of KINDS) {
            const list = parsed[kind];
            out[kind] = Array.isArray(list) ? list.filter(isEntry).slice() : [];
        }
        return out;
    } catch {
        return emptyLibrary();
    }
}

function isEntry(entry) {
    return entry
        && typeof entry === 'object'
        && typeof entry.id === 'string'
        && KINDS.includes(entry.kind)
        && typeof entry.name === 'string'
        && typeof entry.by === 'string'
        && typeof entry.savedAt === 'number'
        && entry.doc != null;
}

function writeLibrary(storage, lib) {
    storage.setItem(LIBRARY_KEY, JSON.stringify(lib));
}

/** Store codec-normalized doc objects (not raw DOM state). */
export function docForKind(capturedProject, kind) {
    const warnings = [];
    const base = capturedProject && typeof capturedProject === 'object'
        ? { ...capturedProject, kind }
        : { format: 'ingysynth', version: 1, kind };
    return normalize(base, warnings);
}

export function listEntries(storage, kind) {
    const lib = readLibrary(storage);
    return (lib[kind] || []).slice().sort((a, b) => b.savedAt - a.savedAt);
}

export function saveEntry(storage, kind, doc) {
    if (!KINDS.includes(kind)) return { ok: false, error: 'bad-kind' };
    const lib = readLibrary(storage);
    const list = lib[kind];
    if (list.length >= LIBRARY_CAPS[kind]) return { ok: false, error: 'cap' };
    const entry = {
        id: newId(),
        kind,
        name: String(doc.name ?? 'Untitled'),
        by: String(doc.by ?? ''),
        savedAt: Date.now(),
        doc,
    };
    list.push(entry);
    writeLibrary(storage, lib);
    return { ok: true, entry };
}

export function deleteEntry(storage, kind, id) {
    const lib = readLibrary(storage);
    const list = lib[kind];
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return { ok: false, error: 'missing' };
    list.splice(idx, 1);
    writeLibrary(storage, lib);
    return { ok: true };
}

export function renameEntry(storage, kind, id, name, by) {
    const lib = readLibrary(storage);
    const entry = lib[kind].find((e) => e.id === id);
    if (!entry) return { ok: false, error: 'missing' };
    entry.name = String(name ?? entry.name);
    entry.by = String(by ?? entry.by);
    if (entry.doc && typeof entry.doc === 'object') {
        entry.doc.name = entry.name;
        entry.doc.by = entry.by;
    }
    writeLibrary(storage, lib);
    return { ok: true, entry };
}

export function getEntry(storage, kind, id) {
    const lib = readLibrary(storage);
    return lib[kind].find((e) => e.id === id) ?? null;
}

export function writeSession(storage, doc) {
    try {
        storage.setItem(SESSION_KEY, serialize(doc));
    } catch {
        // Quota or private mode — share/file remain the backup path.
    }
}

export function readSession(storage) {
    try {
        const text = storage.getItem(SESSION_KEY);
        if (!text) return null;
        const result = parse(text);
        return result.ok ? result.doc : null;
    } catch {
        return null;
    }
}

export function createMemoryStorage() {
    const map = new Map();
    return {
        getItem(key) { return map.has(key) ? map.get(key) : null; },
        setItem(key, value) { map.set(key, String(value)); },
        removeItem(key) { map.delete(key); },
    };
}
