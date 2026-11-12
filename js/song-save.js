// Arrangement <-> the `.ingy` `arrangement` section (spec/ingy/SPEC.md). Shared by both apps:
// this file is identical in the web repo (js/song-save.js) and Bare Metal (ui/js/song-save.js).
// Pure: no DOM, no app imports, so neither app's versioned imports get in the way.
//
// The section is the song model as song-model.js keeps it: clips bottom-first per track
// (they may stack), the transpose lane and the loop. Undo history and the playhead are not
// saved. Unknown keys on a clip are kept, so either app round-trips the other's clips.
//
// Version 2 stores each distinct clip pattern once, in `patterns`, and each clip names its
// entry with `pattern` instead of carrying `data`: a song is mostly copies of a few pads, and
// Berlin row clips cut from one pad share its whole 8-lane pattern. Version 1 files (`data`
// on every clip) still load. The song model in memory always has `data` on each clip.

export const ARRANGEMENT_VERSION = 2;

const SYNTH_KINDS = new Set(['n', 'b', 'notes']);
const DRUM_KINDS = new Set(['d']);
const LANE_KINDS = new Set(['b']);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// JSON with keys sorted, so equal patterns match whatever order their keys were built in.
function stableText(value) {
    if (value === null || typeof value !== 'object') {
        const text = JSON.stringify(value);
        return text === undefined ? 'null' : text;
    }
    if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
        .map((k) => `${JSON.stringify(k)}:${stableText(value[k])}`).join(',')}}`;
}

// Moves each clip's `data` into `patterns` (p0, p1, ... in first-use order) and leaves a
// `pattern` key in its place.
function shareClipPatterns(trackLists) {
    const keys = new Map();
    const patterns = {};
    for (const clips of trackLists) {
        for (const clip of clips) {
            if (clip.kind === 'notes' || !clip.data || typeof clip.data !== 'object') continue;
            const text = stableText(clip.data);
            let key = keys.get(text);
            if (!key) {
                key = `p${keys.size}`;
                keys.set(text, key);
                patterns[key] = clip.data;
            }
            delete clip.data;
            clip.pattern = key;
        }
    }
    return patterns;
}

function int(value, fallback, min = -Infinity) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

function emptySong() {
    return {
        synth: { clips: [] },
        drums: { clips: [] },
        lanes: [0, 1, 2, 3].map(() => ({ clips: [] })),
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
            && !(song.lanes || []).some((lane) => (lane?.clips?.length || 0) > 0)
            && (song.transpose?.length || 0) === 0);
}

/** The `arrangement` section for `song`, or null when there is nothing to save. */
export function songToArrangement(song) {
    // Pad Preview clips (song-record.js) are only heard, never saved.
    const kept = (list) => clone((list || []).filter((clip) => !clip?.preview));
    if (song) {
        song = {
            ...song,
            synth: { ...song.synth, clips: kept(song.synth?.clips) },
            drums: { ...song.drums, clips: kept(song.drums?.clips) },
            lanes: (song.lanes || []).map((lane) => ({ ...lane, clips: kept(lane?.clips) })),
        };
    }
    if (songIsEmpty(song)) return null;
    const loop = song.loop || {};
    const out = {
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
    // Berlin oscillator rows O1..O4 (song-model.js). Left out when none hold a clip.
    const lanes = [0, 1, 2, 3].map((row) => ({ clips: clone(song.lanes?.[row]?.clips || []) }));
    if (lanes.some((lane) => lane.clips.length)) out.lanes = lanes;
    out.patterns = shareClipPatterns([out.synth.clips, out.drums.clips, ...lanes.map((lane) => lane.clips)]);
    return out;
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

function cleanClips(list, track, kinds, ids, patterns) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
        if (!raw || typeof raw !== 'object' || !kinds.has(raw.kind)) continue;
        const clip = clone(raw);
        // Version 2: the clip's pattern is in the shared table. Each clip gets its own copy.
        if (typeof clip.pattern === 'string') {
            const shared = patterns?.[clip.pattern];
            if (clip.data == null && shared && typeof shared === 'object') clip.data = clone(shared);
            delete clip.pattern;
        }
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
    const patterns = arrangement.patterns && typeof arrangement.patterns === 'object' ? arrangement.patterns : null;
    song.synth.clips = cleanClips(arrangement.synth?.clips, 'synth', SYNTH_KINDS, ids, patterns);
    song.drums.clips = cleanClips(arrangement.drums?.clips, 'drums', DRUM_KINDS, ids, patterns);
    // An older file has no `lanes`: its Berlin clips sit on the synth track and the arrange
    // view moves them to their rows (song-model.js splitBerlinClips).
    song.lanes = [0, 1, 2, 3].map((row) => ({
        clips: cleanClips(arrangement.lanes?.[row]?.clips, `o${row + 1}`, LANE_KINDS, ids, patterns)
            .map((clip) => ({ ...clip, row })),
    }));
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
