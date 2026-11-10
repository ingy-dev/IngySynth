// Standard MIDI File reader for MIDI import. Pure: no DOM, no app imports.
// Turns a .mid (format 0 or 1) into arrange notes-clip notes at 960 PPQ, the same shape
// song-record.js writes: { startTick, durTick, semi, fine, velocity, legato }.
//
// Timing is musical: file ticks are rescaled to 960 PPQ and the file's tempo map is not
// applied, the way a DAW places a MIDI clip at the project tempo. Note 60 is semi 0 (C4).
// Channel 10 (GM drums) is left out unless the file has nothing else.

const PPQ = 960;
const BAR_TICKS = 3840;
const DRUM_CHANNEL = 9;
export const MIDI_IMPORT_MAX_NOTES = 20000;

export function isMidiFileName(name) {
    return /\.(mid|midi|smf)$/i.test(String(name || ''));
}

class Reader {
    constructor(bytes) {
        this.b = bytes;
        this.p = 0;
    }
    left() { return this.b.length - this.p; }
    u8() {
        if (this.p >= this.b.length) throw new Error('the file ends early');
        return this.b[this.p++];
    }
    u16() { return (this.u8() << 8) | this.u8(); }
    u32() { return ((this.u8() << 24) >>> 0) + (this.u8() << 16) + (this.u8() << 8) + this.u8(); }
    str(n) {
        let s = '';
        for (let i = 0; i < n; i += 1) s += String.fromCharCode(this.u8());
        return s;
    }
    varLen() {
        let v = 0;
        for (let i = 0; i < 4; i += 1) {
            const c = this.u8();
            v = (v << 7) | (c & 0x7f);
            if (!(c & 0x80)) return v;
        }
        throw new Error('bad length in the file');
    }
    skip(n) {
        if (n > this.left()) throw new Error('the file ends early');
        this.p += n;
    }
}

function textOf(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0/g, '').trim();
    } catch {
        return '';
    }
}

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ notes: object[], lengthTick: number, name: string, tempo: number|null,
 *             droppedDrums: number, truncated: boolean }}
 * Throws an Error with a short user-facing message when the file can't be read.
 */
export function parseMidiFile(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const r = new Reader(bytes);
    // Some files (RIFF RMID) wrap the SMF; find the header.
    let start = 0;
    for (; start + 4 <= bytes.length && start < 64; start += 1) {
        if (bytes[start] === 0x4d && bytes[start + 1] === 0x54 && bytes[start + 2] === 0x68 && bytes[start + 3] === 0x64) break;
    }
    if (start + 4 > bytes.length || start >= 64) throw new Error('not a MIDI file');
    r.p = start + 4;
    const headerLen = r.u32();
    if (headerLen < 6) throw new Error('not a MIDI file');
    const format = r.u16();
    const trackCount = r.u16();
    const division = r.u16();
    r.skip(headerLen - 6);
    if (format > 2) throw new Error('unknown MIDI file format');
    if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
    const filePpq = division || 96;
    const scale = PPQ / filePpq;

    const melodic = [];
    const drums = [];
    let name = '';
    let tempo = null;
    let endTick = 0;
    // Format 2 tracks are separate patterns played one after another.
    let trackOffset = 0;

    for (let t = 0; t < trackCount && r.left() >= 8; t += 1) {
        const id = r.str(4);
        const len = r.u32();
        const end = Math.min(bytes.length, r.p + len);
        if (id !== 'MTrk') {
            r.p = end;
            continue;
        }
        const open = new Map();   // channel*128+note -> [{ tick, vel }]
        let tick = 0;
        let status = 0;
        const close = (key, at) => {
            const stack = open.get(key);
            if (!stack || !stack.length) return;
            const on = stack.shift();
            const ch = key >> 7;
            const note = {
                startTick: Math.round((trackOffset + on.tick) * scale),
                durTick: Math.max(1, Math.round((at - on.tick) * scale)),
                semi: (key & 0x7f) - 60,
                fine: 0,
                velocity: Math.max(1, on.vel) / 127,
                legato: false,
            };
            (ch === DRUM_CHANNEL ? drums : melodic).push(note);
        };
        while (r.p < end) {
            tick += r.varLen();
            let b = r.u8();
            if (b === 0xff) {
                const type = r.u8();
                const n = r.varLen();
                const body = bytes.subarray(r.p, r.p + n);
                r.skip(n);
                if (type === 0x03 && !name) name = textOf(body);
                else if (type === 0x51 && n === 3 && tempo == null) {
                    const us = (body[0] << 16) | (body[1] << 8) | body[2];
                    if (us > 0) tempo = 60000000 / us;
                } else if (type === 0x2f) break;
                continue;
            }
            if (b === 0xf0 || b === 0xf7) {
                r.skip(r.varLen());
                continue;
            }
            let d1;
            if (b & 0x80) {
                status = b;
                d1 = r.u8();
            } else {
                if (!status) throw new Error('the file is damaged');
                d1 = b;
                b = status;
            }
            const kind = status & 0xf0;
            const ch = status & 0x0f;
            if (kind === 0xc0 || kind === 0xd0) continue;   // one data byte
            const d2 = r.u8();
            if (kind === 0x90 && d2 > 0) {
                const key = (ch << 7) | (d1 & 0x7f);
                if (!open.has(key)) open.set(key, []);
                open.get(key).push({ tick, vel: d2 });
            } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
                close((ch << 7) | (d1 & 0x7f), tick);
            }
        }
        // Notes still held when the track ends stop there.
        for (const key of [...open.keys()]) {
            while (open.get(key)?.length) close(key, tick);
        }
        endTick = Math.max(endTick, Math.round((trackOffset + tick) * scale));
        if (format === 2) trackOffset += tick;
        r.p = end;
    }

    const useDrums = melodic.length === 0;
    let notes = useDrums ? drums : melodic;
    const droppedDrums = useDrums ? 0 : drums.length;
    notes.sort((a, b) => a.startTick - b.startTick || a.semi - b.semi);
    const truncated = notes.length > MIDI_IMPORT_MAX_NOTES;
    if (truncated) notes = notes.slice(0, MIDI_IMPORT_MAX_NOTES);
    let lastEnd = 0;
    for (const n of notes) lastEnd = Math.max(lastEnd, n.startTick + n.durTick);
    // Whole bars, and at least the file's own end-of-track when it sits a little later.
    const reach = Math.max(lastEnd, Math.min(endTick, lastEnd + BAR_TICKS * 4));
    const lengthTick = Math.max(BAR_TICKS, Math.ceil(reach / BAR_TICKS) * BAR_TICKS);
    return { notes, lengthTick, name, tempo, droppedDrums, truncated };
}
