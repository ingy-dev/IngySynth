// Arrangement <-> the `.ingy` `arrangement` section (spec/ingy/SPEC.md). Shared by both apps:
// this file is identical in the web repo (js/song-save.js) and Bare Metal (ui/js/song-save.js).
// Pure: no DOM, no app imports, so neither app's versioned imports get in the way.
//
// The section is the song model as song-model.js keeps it: clips bottom-first per track
// (they may stack), the transpose lane and the loop. Undo history and the playhead are not
// saved. Unknown keys on a clip are kept, so either app round-trips the other's clips.

export const ARRANGEMENT_VERSION = 1;

const SYNTH_KINDS = new Set(['n', 'b', 'notes']);
const DRUM_KINDS = new Set(['d']);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function int(value, fallback, min = -Infinity) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function emptySong() {
    return {
        synth: { clips: [] },
        drums: { clips: [] },
        transpose: [],
        loop: { on: false, startTick: 0, endTick: 0 },
        playheadTick: 0,
    };
}

/** True when the song has nothing worth saving. */
export function songIsEmpty(song) {
    return !song
        || ((song.synth?.clips?.length || 0) === 0
            && (song.drums?.clips?.length || 0) === 0
            && (song.transpose?.length || 0) === 0);
}

/** The `arrangement` section for `song`, or null when there is nothing to save. */
export function songToArrangement(song) {
    if (songIsEmpty(song)) return null;
    const loop = song.loop || {};
    return {
        v: ARRANGEMENT_VERSION,
        synth: { clips: clone(song.synth?.clips || []) },
        drums: { clips: clone(song.drums?.clips || []) },
        transpose: clone(song.transpose || []),
        loop: {
            on: !!loop.on,
            startTick: int(loop.startTick, 0, 0),
            endTick: int(loop.endTick, 0, 0),
        },
    };
}

function cleanNotes(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const n of list) {
        if (!n || typeof n !== 'object') continue;
        const semi = Number(n.semi);
        if (!Number.isFinite(semi)) continue;
        const velocity = Number(n.velocity);
        out.push({
            ...n,
            startTick: int(n.startTick, 0, 0),
            durTick: int(n.durTick, 240, 1),
            semi,
            fine: int(n.fine, 0),
            velocity: Number.isFinite(velocity) ? Math.max(0, Math.min(1, velocity)) : 0.8,
            legato: !!n.legato,
        });
    }
    out.sort((a, b) => a.startTick - b.startTick);
    return out;
}

function cleanClips(list, track, kinds, ids) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        if (!raw || typeof raw !== 'object' || !kinds.has(raw.kind)) continue;
        const clip = clone(raw);
        clip.track = track;
        clip.startTick = int(clip.startTick, 0, 0);
        clip.lengthTick = int(clip.lengthTick, 3840, 1);
        if (clip.startOffset != null) clip.startOffset = int(clip.startOffset, 0);
        if (clip.kind === 'notes') {
            clip.notes = cleanNotes(clip.notes);
        } else {
            clip.source = Math.max(0, Math.min(7, int(clip.source, 0)));
            if (!clip.data || typeof clip.data !== 'object') continue;
        }
        let id = typeof clip.id === 'string' && clip.id ? clip.id : '';
        while (!id || ids.has(id)) id = `clip-${Math.random().toString(36).slice(2, 10)}`;
        ids.add(id);
        clip.id = id;
        out.push(clip);
    }
    return out;
}

/** A song model from an `arrangement` section; an empty song for anything unreadable. */
export function arrangementToSong(arrangement) {
    const song = emptySong();
    if (!arrangement || typeof arrangement !== 'object') return song;
    const ids = new Set();
    song.synth.clips = cleanClips(arrangement.synth?.clips, 'synth', SYNTH_KINDS, ids);
    song.drums.clips = cleanClips(arrangement.drums?.clips, 'drums', DRUM_KINDS, ids);
    if (Array.isArray(arrangement.transpose)) {
        song.transpose = arrangement.transpose
            .filter((e) => e && typeof e === 'object')
            .map((e) => ({ ...e, tick: int(e.tick, 0, 0), semi: int(e.semi, 0) }))
            .sort((a, b) => a.tick - b.tick);
    }
    const loop = arrangement.loop || {};
    song.loop = {
        on: !!loop.on,
        startTick: int(loop.startTick, 0, 0),
        endTick: int(loop.endTick, 0, 0),
    };
    return song;
}
