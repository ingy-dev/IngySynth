// Reference codec for .ingy documents (spec/ingy/SPEC.md). Pure JS: no DOM, no app state.
// Runs in browsers (Safari 16.4+) and Node 20+. The web app copies this folder to js/ingy/;
// the C++ codec (core/format) is a port and must agree on every file in spec/ingy/examples.
//
//   parse(text)               -> { ok, error, warnings, doc }
//   migrate(raw, warnings)    -> raw document at the current version
//   normalize(raw, warnings)  -> canonical document (defaults filled, values clamped, unknown keys kept)
//   serialize(doc, { pretty })-> JSON text, keys sorted in every object
//   makeDefault(kind)         -> fully defaulted document
//   encodeLink(doc, baseUrl)  -> Promise<{ url, payload, length, tooLong }>
//   decodeLink(urlOrPayload)  -> Promise<{ ok, error, warnings, doc }>
//
// Warnings are "code:path" strings (SPEC.md "Warnings"), e.g. "clamped:voice.params.cutoff".

import { PARAMS, BAREMETAL_PARAMS, FLAGS } from './params-data.js';

export const FORMAT = 'ingysynth';
export const VERSION = 1;
export const KINDS = ['project', 'patch', 'pattern'];

export const LIMITS = Object.freeze({
    maxDecodedBytes: 1024 * 1024,
    maxFileBytes: 16 * 1024 * 1024,
    maxLinkChars: 2000,
    maxNameChars: 64,
    maxByChars: 64,
    maxKeyChars: 64,
    maxStringChars: 256,
    maxAutomationLanes: 128,
    maxMidiMaps: 256,
});

const STEP_SLOTS = 32;
const SLOT_COUNT = 8;
const DRUM_LANES = 4;
const BERLIN_LANES = 8;
const OSC_LANES = 4;
const AUTOMATION_RESOLUTION = 128;
const RATCH_MAX = 4;
const REPEAT_MAX = 8;
const CHORD_MAX_EXTRAS = 5;
// Steps per bar. Triplets: 3 = 1/2T, 6 = 1/4T, 12 = 1/8T, 24 = 1/16T, 48 = 1/32T.
const DIVISIONS = [2, 3, 4, 6, 8, 12, 16, 24, 48];
const OSC_DESTINATIONS = ['osc1Pitch', 'osc2Pitch', 'osc3Pitch', 'osc4Pitch'];
const MOD_DESTINATIONS = ['cutoff', 'resonance', 'highpass', 'off'];   // M1-M4 defaults
const MOD_DESTINATION_OPTIONS = [...MOD_DESTINATIONS, 'noise'];        // noise: Bare Metal only
const FACTORY_DRUM_ONS = [[7], [2, 4, 6, 8], [3, 7], [1, 3, 5, 7]];
const AUTOMATION_BANK_RE = /^[nb][0-7]$/;

const ALL_PARAMS = { ...PARAMS, ...BAREMETAL_PARAMS };

// ---------------------------------------------------------------- helpers

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const zero = (n) => (n === 0 ? 0 : n); // -0 -> 0

/** Copy keys of `src` that are not in `known` (unknown keys are kept verbatim). */
function unknownKeys(src, known) {
    const out = {};
    if (!isObject(src)) return out;
    for (const k of Object.keys(src)) {
        if (!known.includes(k)) out[k] = src[k];
    }
    return out;
}

function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
}

function round4(v) {
    return zero(Math.round(v * 1e4) / 1e4);
}

class Ctx {
    constructor(warnings) { this.warnings = warnings; }
    warn(code, path) { this.warnings.push(`${code}:${path}`); }

    /** Number in [min, max]. Missing -> def silently; wrong type / non-finite -> def + warning. */
    num(src, key, path, def, min, max, { int = false } = {}) {
        if (!isObject(src) || !hasOwn(src, key) || src[key] == null) return def;
        let n = toNumber(src[key]);
        if (!Number.isFinite(n)) { this.warn('invalid', path); return def; }
        if (int) n = Math.round(n);
        if (n < min) { this.warn('clamped', path); n = min; }
        if (n > max) { this.warn('clamped', path); n = max; }
        return zero(n);
    }

    bool(src, key, path, def) {
        if (!isObject(src) || !hasOwn(src, key) || src[key] == null) return def;
        if (typeof src[key] === 'boolean') return src[key];
        this.warn('invalid', path);
        return def;
    }

    oneOf(src, key, path, def, options) {
        if (!isObject(src) || !hasOwn(src, key) || src[key] == null) return def;
        const v = src[key];
        const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
        if (typeof s === 'string' && options.includes(s)) return s;
        this.warn('invalid', path);
        return def;
    }

    str(src, key, path, def, maxChars = LIMITS.maxStringChars) {
        if (!isObject(src) || !hasOwn(src, key) || src[key] == null) return def;
        if (typeof src[key] !== 'string') { this.warn('invalid', path); return def; }
        const chars = Array.from(src[key]);
        if (chars.length > maxChars) { this.warn('truncated', path); return chars.slice(0, maxChars).join(''); }
        return src[key];
    }

    obj(src, key, path) {
        if (!isObject(src) || !hasOwn(src, key) || src[key] == null) return undefined;
        if (isObject(src[key])) return src[key];
        this.warn('invalid', path);
        return undefined;
    }

    arr(src, key, path) {
        if (!isObject(src) || !hasOwn(src, key) || src[key] == null) return undefined;
        if (Array.isArray(src[key])) return src[key];
        this.warn('invalid', path);
        return undefined;
    }
}

// Control characters, and bidi overrides/isolates that can reorder displayed text.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** name / by: untrusted text from links. Strip unsafe characters, trim, cap length. */
export function sanitizeLabel(value, maxChars) {
    if (typeof value !== 'string') return '';
    const clean = value.replace(UNSAFE_CHARS, '').trim();
    return Array.from(clean).slice(0, maxChars).join('');
}

// ---------------------------------------------------------------- steps and patterns

/** Same rules as pattern-bank.js clampChord. */
export function clampChord(src) {
    if (!Array.isArray(src)) return [];
    const seen = new Set();
    const out = [];
    for (const n of src) {
        const iv = Math.round(toNumber(n));
        if (!Number.isFinite(iv) || iv === 0 || seen.has(iv)) continue;
        seen.add(iv);
        out.push(iv);
    }
    out.sort((a, b) => a - b);
    return out.slice(0, CHORD_MAX_EXTRAS);
}

const STEP_KEYS = ['tune', 'fine', 'on', 'accent', 'slide', 'ratch', 'chord'];

function defaultStep(on) {
    return { tune: 0, fine: 0, on, accent: false, slide: false, ratch: 1, chord: [] };
}

/** Missing fields take the value of `fallback`, the default step for this position. */
function normalizeStep(c, src, path, fallback) {
    if (src == null) return fallback;
    if (!isObject(src)) { c.warn('invalid', path); return fallback; }
    const chord = c.arr(src, 'chord', `${path}.chord`);
    const step = {
        ...unknownKeys(src, STEP_KEYS),
        tune: c.num(src, 'tune', `${path}.tune`, fallback.tune, -39, 48, { int: true }),
        fine: c.num(src, 'fine', `${path}.fine`, fallback.fine, -100, 100, { int: true }),
        on: c.bool(src, 'on', `${path}.on`, fallback.on),
        accent: c.bool(src, 'accent', `${path}.accent`, fallback.accent),
        slide: c.bool(src, 'slide', `${path}.slide`, fallback.slide),
        ratch: c.num(src, 'ratch', `${path}.ratch`, fallback.ratch, 1, RATCH_MAX, { int: true }),
        chord: chord ? clampChord(chord) : fallback.chord,
    };
    if (chord && JSON.stringify(step.chord) !== JSON.stringify(chord)) c.warn('clamped', `${path}.chord`);
    return step;
}

/** `factory(i)` gives the default step i when the source has none. */
function normalizeSteps(c, src, path, factory) {
    const list = c.arr(src, 'steps', path) || [];
    if (list.length > STEP_SLOTS) c.warn('truncated', path);
    return Array.from({ length: STEP_SLOTS }, (_, i) => normalizeStep(c, list[i], `${path}.${i}`, factory(i)));
}

const CLOCK_KEYS = ['steps', 'stepCount', 'division', 'reverse', 'enabled', 'gate'];

function normalizeClock(c, src, path) {
    const division = (() => {
        if (!isObject(src) || src.division === undefined) return 8;
        const n = toNumber(src.division);
        if (DIVISIONS.includes(n)) return n;
        c.warn('invalid', `${path}.division`);
        return 8;
    })();
    return {
        stepCount: c.num(src, 'stepCount', `${path}.stepCount`, 8, 1, STEP_SLOTS, { int: true }),
        division,
        reverse: c.bool(src, 'reverse', `${path}.reverse`, false),
        enabled: c.bool(src, 'enabled', `${path}.enabled`, true),
        gate: c.num(src, 'gate', `${path}.gate`, 0.9, 0.05, 1),
    };
}

const SLOT_KEYS = [...CLOCK_KEYS, 'repeat'];

function normalizeSlot(c, src, path) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    return {
        ...unknownKeys(src, SLOT_KEYS),
        steps: normalizeSteps(c, src, `${path}.steps`, () => defaultStep(true)),
        ...normalizeClock(c, src, path),
        repeat: c.num(src, 'repeat', `${path}.repeat`, 1, 1, REPEAT_MAX, { int: true }),
    };
}

function factoryDrumStep(lane, i) {
    return defaultStep(FACTORY_DRUM_ONS[lane].includes(i + 1));
}

function normalizeDrumLane(c, src, path, lane) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    return {
        ...unknownKeys(src, CLOCK_KEYS),
        // A missing or null step is that lane's factory step (SPEC.md "Defaults").
        steps: normalizeSteps(c, src, `${path}.steps`, (i) => factoryDrumStep(lane, i)),
        ...normalizeClock(c, src, path),
    };
}

function normalizeDrumSlot(c, src, path) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const lanes = c.arr(src, 'lanes', `${path}.lanes`) || [];
    if (lanes.length > DRUM_LANES) c.warn('truncated', `${path}.lanes`);
    return {
        ...unknownKeys(src, ['lanes']),
        lanes: Array.from({ length: DRUM_LANES }, (_, i) => normalizeDrumLane(c, lanes[i], `${path}.lanes.${i}`, i)),
    };
}

const BERLIN_LANE_KEYS = [...CLOCK_KEYS, 'destination', 'amount'];

function normalizeBerlinLane(c, src, path, row) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const osc = row < OSC_LANES;
    let destination;
    let amount;
    if (osc) {
        destination = OSC_DESTINATIONS[row];
        amount = 1;
    } else {
        destination = c.oneOf(src, 'destination', `${path}.destination`, MOD_DESTINATIONS[row - OSC_LANES], MOD_DESTINATION_OPTIONS);
        amount = c.num(src, 'amount', `${path}.amount`, 1, 0, 1);
    }
    return {
        ...unknownKeys(src, BERLIN_LANE_KEYS),
        steps: normalizeSteps(c, src, `${path}.steps`, () => defaultStep(true)),
        ...normalizeClock(c, src, path),
        destination,
        amount,
    };
}

const BERLIN_PATTERN_KEYS = ['lanes', 'oscCount', 'modCount', 'repeat'];

function normalizeBerlinPattern(c, src, path) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const lanes = c.arr(src, 'lanes', `${path}.lanes`) || [];
    if (lanes.length > BERLIN_LANES) c.warn('truncated', `${path}.lanes`);
    return {
        ...unknownKeys(src, BERLIN_PATTERN_KEYS),
        lanes: Array.from({ length: BERLIN_LANES }, (_, r) => normalizeBerlinLane(c, lanes[r], `${path}.lanes.${r}`, r)),
        oscCount: c.num(src, 'oscCount', `${path}.oscCount`, 3, 1, OSC_LANES, { int: true }),
        modCount: c.num(src, 'modCount', `${path}.modCount`, 1, 1, OSC_LANES, { int: true }),
        repeat: c.num(src, 'repeat', `${path}.repeat`, 1, 1, REPEAT_MAX, { int: true }),
    };
}

function fixedList(c, src, key, path, normalizeItem) {
    const list = c.arr(src, key, path) || [];
    if (list.length > SLOT_COUNT) c.warn('truncated', path);
    return Array.from({ length: SLOT_COUNT }, (_, i) => normalizeItem(list[i], `${path}.${i}`));
}

// ---------------------------------------------------------------- automation

const AUTOMATION_BANK_KEYS = ['lanes', 'offsets'];

function normalizeAutomationBank(c, src, path) {
    if (src == null) return null;
    if (!isObject(src)) { c.warn('invalid', path); return null; }
    const out = { ...unknownKeys(src, AUTOMATION_BANK_KEYS), lanes: {}, offsets: {} };
    const lanes = c.obj(src, 'lanes', `${path}.lanes`) || {};
    let count = 0;
    // Sorted so the cap keeps the same lanes in every implementation.
    for (const key of Object.keys(lanes).sort()) {
        const lanePath = `${path}.lanes.${key}`;
        if (key.length === 0 || key.length > LIMITS.maxKeyChars) { c.warn('dropped', lanePath); continue; }
        if (count >= LIMITS.maxAutomationLanes) { c.warn('dropped', lanePath); continue; }
        const samples = isObject(lanes[key]) && Array.isArray(lanes[key].samples) ? lanes[key].samples : null;
        if (!samples) { c.warn('invalid', lanePath); continue; }
        // Shorter lists are padded with null (writers trim trailing nulls); longer ones are cut.
        if (samples.length > AUTOMATION_RESOLUTION) c.warn('truncated', `${lanePath}.samples`);
        const fixed = Array.from({ length: AUTOMATION_RESOLUTION }, (_, i) => {
            const v = samples[i];
            return typeof v === 'number' && Number.isFinite(v) ? round4(v) : null;
        });
        if (fixed.every((v) => v === null)) continue;
        out.lanes[key] = { ...unknownKeys(lanes[key], ['samples']), samples: fixed };
        count++;
    }
    const offsets = c.obj(src, 'offsets', `${path}.offsets`) || {};
    for (const key of Object.keys(offsets)) {
        const v = offsets[key];
        if (key.length === 0 || key.length > LIMITS.maxKeyChars || typeof v !== 'number' || !Number.isFinite(v)) {
            c.warn('dropped', `${path}.offsets.${key}`);
            continue;
        }
        if (v !== 0) out.offsets[key] = round4(v);
    }
    const empty = Object.keys(out.lanes).length === 0 && Object.keys(out.offsets).length === 0
        && Object.keys(unknownKeys(src, AUTOMATION_BANK_KEYS)).length === 0;
    return empty ? null : out;
}

function normalizeAutomation(c, src, path) {
    const out = {};
    if (!isObject(src)) return out;
    for (const key of Object.keys(src)) {
        if (!AUTOMATION_BANK_RE.test(key)) { out[key] = src[key]; continue; }
        const bank = normalizeAutomationBank(c, src[key], `${path}.${key}`);
        if (bank) out[key] = bank;
    }
    return out;
}

// ---------------------------------------------------------------- params

/** Every known key (catalog + Bare Metal) whose section is `section`. */
function keysForSection(section) {
    return Object.keys(ALL_PARAMS).filter((k) => ALL_PARAMS[k].section === section);
}

function normalizeParamValue(c, spec, src, key, path) {
    if (spec.type === 'range') return c.num(src, key, path, spec.default, spec.min, spec.max);
    if (spec.type === 'button') return c.bool(src, key, path, spec.default);
    if (spec.options.length === 0) return c.str(src, key, path, spec.default, LIMITS.maxKeyChars);
    return c.oneOf(src, key, path, spec.default, spec.options);
}

function normalizeParams(c, src, section, path) {
    const out = {};
    const input = isObject(src) ? src : {};
    for (const key of Object.keys(input)) {
        const spec = ALL_PARAMS[key];
        if (!spec) { out[key] = input[key]; continue; }      // unknown key: keep verbatim
        if (spec.section !== section) c.warn('misplaced', `${path}.${key}`);
    }
    for (const key of keysForSection(section)) {
        out[key] = normalizeParamValue(c, ALL_PARAMS[key], input, key, `${path}.${key}`);
    }
    return out;
}

// ---------------------------------------------------------------- voice

function normalizeDrumPatch(c, src, path, lane) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const F = FLAGS.drumPatch.fields;
    const laneModel = FLAGS.drumPatch.laneModels[lane];
    const model = c.oneOf(src, 'model', `${path}.model`, laneModel, F.model.options);
    let engine = isObject(src) ? src.engine : undefined;
    if (typeof engine === 'string' && F.engine.aliases[engine]) engine = F.engine.aliases[engine];
    engine = c.oneOf({ engine }, 'engine', `${path}.engine`, F.engine.default, F.engine.options);
    const unit = (k, def = F[k].default) => c.num(src, k, `${path}.${k}`, def, F[k].min, F[k].max);
    return {
        ...unknownKeys(src, Object.keys(F)),
        engine,
        model,
        tune: unit('tune'),
        harmonics: unit('harmonics'),
        morphX: unit('morphX'),
        // Defaults come from the lane, not the chosen model (web clampDrumPatch uses defaultDrumPatch(lane)).
        morphY: unit('morphY', laneModel === 'open_hat' ? F.morphY.defaultOpenHat : F.morphY.default),
        alt: c.bool(src, 'alt', `${path}.alt`, false),
        trigPatched: c.bool(src, 'trigPatched', `${path}.trigPatched`, true),
        choke: model === 'open_hat' ? !(isObject(src) && src.choke === false) : false,
        vol: unit('vol'),
        pan: unit('pan'),
    };
}

function normalizeFlags(c, src, path) {
    const specs = FLAGS.voiceFlags;
    const out = { ...unknownKeys(src, Object.keys(specs)) };
    for (const [key, spec] of Object.entries(specs)) {
        const p = `${path}.${key}`;
        if (spec.type === 'bool') out[key] = c.bool(src, key, p, spec.default);
        else if (spec.type === 'number') out[key] = c.num(src, key, p, spec.default, spec.min, spec.max);
        else if (spec.type === 'drumKit') {
            const kit = c.arr(src, key, p) || [];
            if (kit.length > DRUM_LANES) c.warn('truncated', p);
            out[key] = Array.from({ length: DRUM_LANES }, (_, i) => normalizeDrumPatch(c, kit[i], `${p}.${i}`, i));
        }
    }
    return out;
}

const VOICE_KEYS = ['params', 'flags', 'speechBank', 'fm6Bank'];

function normalizeVoice(c, src, path) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const out = {
        ...unknownKeys(src, VOICE_KEYS),
        params: normalizeParams(c, c.obj(src, 'params', `${path}.params`), 'voice', `${path}.params`),
        flags: normalizeFlags(c, c.obj(src, 'flags', `${path}.flags`), `${path}.flags`),
    };
    const speech = c.obj(src, 'speechBank', `${path}.speechBank`);
    if (speech) out.speechBank = speech;
    const fm6 = c.obj(src, 'fm6Bank', `${path}.fm6Bank`);
    if (fm6) out.fm6Bank = fm6;
    return out;
}

// ---------------------------------------------------------------- pattern

const PATTERN_KEYS = ['params', 'slot', 'slots', 'drumSlot', 'drums', 'berlin', 'automation', 'song'];
const BERLIN_KEYS = ['enabled', 'seeded', 'slot', 'slots'];

function normalizePattern(c, src, path) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const berlinSrc = c.obj(src, 'berlin', `${path}.berlin`);
    const out = {
        ...unknownKeys(src, PATTERN_KEYS),
        params: normalizeParams(c, c.obj(src, 'params', `${path}.params`), 'pattern', `${path}.params`),
        slot: c.num(src, 'slot', `${path}.slot`, 0, 0, SLOT_COUNT - 1, { int: true }),
        slots: fixedList(c, src, 'slots', `${path}.slots`, (s, p) => normalizeSlot(c, s, p)),
        drumSlot: c.num(src, 'drumSlot', `${path}.drumSlot`, 0, 0, SLOT_COUNT - 1, { int: true }),
        drums: fixedList(c, src, 'drums', `${path}.drums`, (s, p) => normalizeDrumSlot(c, s, p)),
        berlin: {
            ...unknownKeys(berlinSrc, BERLIN_KEYS),
            enabled: c.bool(berlinSrc, 'enabled', `${path}.berlin.enabled`, false),
            seeded: c.bool(berlinSrc, 'seeded', `${path}.berlin.seeded`, false),
            slot: c.num(berlinSrc, 'slot', `${path}.berlin.slot`, 0, 0, SLOT_COUNT - 1, { int: true }),
            slots: fixedList(c, berlinSrc, 'slots', `${path}.berlin.slots`, (s, p) => normalizeBerlinPattern(c, s, p)),
        },
        automation: normalizeAutomation(c, c.obj(src, 'automation', `${path}.automation`), `${path}.automation`),
    };
    const song = c.obj(src, 'song', `${path}.song`);
    if (song) out.song = song;
    return out;
}

// ---------------------------------------------------------------- session

function normalizeMidiMaps(c, src, path) {
    const out = {};
    if (!isObject(src)) return out;
    let count = 0;
    for (const key of Object.keys(src).sort()) {
        const m = src[key];
        const p = `${path}.${key}`;
        const valid = isObject(m) && (m.type === 'cc' || m.type === 'note')
            && key.length > 0 && key.length <= LIMITS.maxKeyChars && count < LIMITS.maxMidiMaps;
        if (!valid) { c.warn('dropped', p); continue; }
        const field = m.type === 'cc' ? 'cc' : 'note';
        out[key] = {
            type: m.type,
            [field]: c.num(m, field, `${p}.${field}`, 0, 0, 127, { int: true }),
            channel: c.num(m, 'channel', `${p}.channel`, 0, 0, 15, { int: true }),
        };
        count++;
    }
    return out;
}

const SESSION_KEYS = ['params', ...Object.keys(FLAGS.session)];

function normalizeSession(c, src, path) {
    if (src != null && !isObject(src)) c.warn('invalid', path);
    if (!isObject(src)) src = undefined;
    const S = FLAGS.session;
    const xy = c.obj(src, 'xy', `${path}.xy`);
    const chordMemory = c.obj(src, 'chordMemory', `${path}.chordMemory`);
    const int = (k) => c.num(src, k, `${path}.${k}`, S[k].default, S[k].min, S[k].max, { int: true });
    const out = {
        ...unknownKeys(src, SESSION_KEYS),
        params: normalizeParams(c, c.obj(src, 'params', `${path}.params`), 'session', `${path}.params`),
        xy: {
            ...unknownKeys(xy, ['x', 'y']),
            x: c.str(xy, 'x', `${path}.xy.x`, S.xy.default.x, LIMITS.maxKeyChars),
            y: c.str(xy, 'y', `${path}.xy.y`, S.xy.default.y, LIMITS.maxKeyChars),
        },
        pitchBendRange: int('pitchBendRange'),
        arp: c.bool(src, 'arp', `${path}.arp`, false),
        arpChord: c.bool(src, 'arpChord', `${path}.arpChord`, false),
        arpOrder: c.oneOf(src, 'arpOrder', `${path}.arpOrder`, S.arpOrder.default, S.arpOrder.options),
        arpRange: int('arpRange'),
        latch: c.bool(src, 'latch', `${path}.latch`, false),
        transpose: int('transpose'),
        microtuneLock: c.bool(src, 'microtuneLock', `${path}.microtuneLock`, false),
        chordMemory: {
            ...unknownKeys(chordMemory, ['on', 'intervals']),
            on: c.bool(chordMemory, 'on', `${path}.chordMemory.on`, false),
            intervals: clampChord(c.arr(chordMemory, 'intervals', `${path}.chordMemory.intervals`)),
        },
        midiBaseNote: int('midiBaseNote'),
        midiMaps: normalizeMidiMaps(c, c.obj(src, 'midiMaps', `${path}.midiMaps`), `${path}.midiMaps`),
    };
    const tuning = c.obj(src, 'tuning', `${path}.tuning`);
    if (tuning) out.tuning = tuning;
    return out;
}

// ---------------------------------------------------------------- document

const TOP_KEYS = ['format', 'version', 'kind', 'name', 'by', 'voice', 'pattern', 'session', 'mix', 'arrangement'];

/** Which sections a kind carries. */
export function sectionsFor(kind) {
    return {
        voice: kind === 'project' || kind === 'patch',
        pattern: kind === 'project' || kind === 'pattern',
        session: kind === 'project',
        mix: kind === 'project',
        arrangement: kind === 'project',
    };
}

/** Version upgrades. v1 is current; each future step is (doc, warnings) => doc at version + 1. */
const MIGRATIONS = {};

/** Error codes (SPEC.md "Errors"). The message is the code. */
export const ERRORS = Object.freeze({
    notText: 'not-text',
    tooLarge: 'too-large',
    notJson: 'not-json',
    notObject: 'not-object',
    notIngy: 'not-ingysynth',
    kind: 'unknown-kind',
    version: 'bad-version',
    link: 'bad-link',
});

function docVersion(raw) {
    const v = raw.version === undefined ? VERSION : Math.round(toNumber(raw.version));
    if (!Number.isFinite(v) || v < 1) throw new Error(ERRORS.version);
    return v;
}

export function migrate(raw, warnings = []) {
    let doc = raw;
    let v = docVersion(doc);
    while (v < VERSION) {
        const step = MIGRATIONS[v];
        if (!step) throw new Error(ERRORS.version);
        doc = step(doc, warnings);
        v += 1;
        doc = { ...doc, version: v };
        warnings.push('migrated:version');
    }
    return doc;
}

/** Throws Error(<code>) for documents that cannot be loaded at all; otherwise returns the canonical doc. */
export function normalize(raw, warnings = []) {
    const c = new Ctx(warnings);
    if (!isObject(raw)) throw new Error(ERRORS.notObject);
    if (raw.format !== FORMAT) throw new Error(ERRORS.notIngy);
    if (!KINDS.includes(raw.kind)) throw new Error(ERRORS.kind);
    const version = docVersion(raw);
    if (version > VERSION) c.warn('newer', 'version');

    const kind = raw.kind;
    const has = sectionsFor(kind);
    const name = sanitizeLabel(raw.name, LIMITS.maxNameChars);
    const by = sanitizeLabel(raw.by, LIMITS.maxByChars);
    if (raw.name !== undefined && name !== raw.name) c.warn('sanitized', 'name');
    if (raw.by !== undefined && by !== raw.by) c.warn('sanitized', 'by');

    const doc = { ...unknownKeys(raw, TOP_KEYS), format: FORMAT, version, kind, name, by };
    for (const section of ['voice', 'pattern', 'session', 'mix', 'arrangement']) {
        if (!has[section] && raw[section] !== undefined) c.warn('ignored', section);
    }
    if (has.voice) doc.voice = normalizeVoice(c, raw.voice, 'voice');
    if (has.pattern) doc.pattern = normalizePattern(c, raw.pattern, 'pattern');
    if (has.session) doc.session = normalizeSession(c, raw.session, 'session');
    // SPEC.md "mix": keep the object verbatim (no defaults, no clamps) so unknown keys round-trip.
    // The router applies that schema when it loads the section. Same path as arrangement.
    if (has.mix) { const m = c.obj(raw, 'mix', 'mix'); if (m) doc.mix = m; }
    if (has.arrangement) { const a = c.obj(raw, 'arrangement', 'arrangement'); if (a) doc.arrangement = a; }
    return doc;
}

export function makeDefault(kind = 'project') {
    return normalize({ format: FORMAT, version: VERSION, kind }, []);
}

function utf8Length(text) {
    return new TextEncoder().encode(text).length;
}

/** Parse an already-decoded JSON value (e.g. from a file picker that parsed for you). */
export function parseValue(raw) {
    const warnings = [];
    try {
        if (!isObject(raw)) throw new Error(ERRORS.notObject);
        if (raw.format !== FORMAT) throw new Error(ERRORS.notIngy);
        let doc = raw;
        if (raw.version === undefined) {
            warnings.push('missing:version');
            doc = { ...raw, version: VERSION };
        }
        doc = normalize(migrate(doc, warnings), warnings);
        return { ok: true, error: '', warnings: warnings.sort(), doc };
    } catch (err) {
        return { ok: false, error: String(err?.message || err), warnings: [], doc: null };
    }
}

export function parse(text) {
    if (typeof text !== 'string') return { ok: false, error: ERRORS.notText, warnings: [], doc: null };
    if (utf8Length(text) > LIMITS.maxFileBytes) return { ok: false, error: ERRORS.tooLarge, warnings: [], doc: null };
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, error: ERRORS.notJson, warnings: [], doc: null };
    }
    return parseValue(raw);
}

// ---------------------------------------------------------------- serialize

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!isObject(value)) return typeof value === 'number' ? zero(value) : value;
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
}

/** Structural equality for JSON values (key order ignored). */
export function sameJson(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) {
        return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
    }
    if (isObject(a) && isObject(b)) {
        const ka = Object.keys(a);
        return ka.length === Object.keys(b).length && ka.every((k) => hasOwn(b, k) && sameJson(a[k], b[k]));
    }
    return false;
}

const OMIT = Symbol('omit');
const ALWAYS_WRITTEN = ['format', 'version', 'kind'];

/**
 * Minimal form (SPEC.md "Minimal form"): drop everything equal to its default.
 * Fixed-length lists of records (slots, steps, lanes, drum kit) compare element by element;
 * a default element becomes null and trailing nulls are trimmed. Other arrays are values.
 */
function minimizeValue(value, def) {
    if (def !== undefined && sameJson(value, def)) return OMIT;
    if (Array.isArray(value)) {
        const recordList = Array.isArray(def) && def.length > 0 && def.length === value.length && def.every(isObject);
        if (!recordList) return value;
        const out = value.map((v, i) => {
            const m = minimizeValue(v, def[i]);
            return m === OMIT ? null : m;
        });
        while (out.length && out[out.length - 1] === null) out.pop();
        return out;
    }
    if (isObject(value)) {
        const out = {};
        for (const k of Object.keys(value)) {
            const m = minimizeValue(value[k], isObject(def) ? def[k] : undefined);
            if (m !== OMIT) out[k] = m;
        }
        return out;
    }
    return value;
}

function trimAutomation(pattern) {
    if (!isObject(pattern?.automation)) return;
    for (const key of Object.keys(pattern.automation)) {
        if (!AUTOMATION_BANK_RE.test(key)) continue;
        const lanes = pattern.automation[key]?.lanes;
        if (!isObject(lanes)) continue;
        for (const lane of Object.values(lanes)) {
            if (!Array.isArray(lane?.samples)) continue;
            const s = lane.samples.slice();
            while (s.length && s[s.length - 1] === null) s.pop();
            lane.samples = s;
        }
    }
}

/** `choke` defaults by model, not lane, so an open-hat patch that is written at all carries it. */
function keepOpenHatChoke(doc, result) {
    const kit = doc.voice?.flags?.drumKit;
    const outKit = result.voice?.flags?.drumKit;
    if (!Array.isArray(kit) || !Array.isArray(outKit)) return;
    outKit.forEach((patch, i) => {
        if (isObject(patch) && kit[i]?.model === 'open_hat') patch.choke = kit[i].choke;
    });
}

const defaultCache = new Map();

/** A normalized document in minimal form. normalize(minimize(doc)) deep-equals doc. */
export function minimize(doc) {
    if (!isObject(doc) || !KINDS.includes(doc.kind)) return doc;
    if (!defaultCache.has(doc.kind)) defaultCache.set(doc.kind, makeDefault(doc.kind));
    const out = minimizeValue(doc, defaultCache.get(doc.kind));
    const result = out === OMIT ? {} : out;
    for (const k of ALWAYS_WRITTEN) result[k] = doc[k];
    trimAutomation(result.pattern);
    keepOpenHatChoke(doc, result);
    return result;
}

/** Minimal form, keys sorted. `full: true` writes every default too (debugging only). */
export function serialize(doc, { pretty = false, full = false } = {}) {
    const value = full || !isObject(doc) || !hasOwn(doc, 'format') ? doc : minimize(doc);
    return JSON.stringify(sortKeys(value), null, pretty ? 2 : undefined);
}

// ---------------------------------------------------------------- links

function bytesToBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(text) {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) throw new Error(ERRORS.link);
    const b64 = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function pipe(bytes, stream, cap) {
    const writer = stream.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (cap && total > cap) {
            await reader.cancel().catch(() => {});
            throw new Error(ERRORS.tooLarge);
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) { out.set(ch, off); off += ch.length; }
    return out;
}

/** The document a link carries: the speech and six-op user banks never go in a link. */
export function linkDocument(doc) {
    if (!doc?.voice?.speechBank && !doc?.voice?.fm6Bank) return doc;
    const { speechBank, fm6Bank, ...voice } = doc.voice;
    return { ...doc, voice };
}

export async function encodeLink(doc, baseUrl = '') {
    const text = serialize(linkDocument(doc));
    const deflated = await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw'));
    const payload = bytesToBase64Url(deflated);
    const base = String(baseUrl).split('#')[0];
    const url = `${base}#p=${payload}`;
    return { url, payload, length: url.length, tooLong: url.length > LIMITS.maxLinkChars };
}

/** Accepts a full URL, "#p=...", "p=..." or the bare payload. */
export function linkPayload(input) {
    const s = String(input ?? '').trim();
    const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s;
    for (const part of hash.split('&')) {
        if (part.startsWith('p=')) return part.slice(2);
    }
    return hash;
}

export async function decodeLink(input) {
    let text;
    try {
        const bytes = base64UrlToBytes(linkPayload(input));
        const inflated = await pipe(bytes, new DecompressionStream('deflate-raw'), LIMITS.maxDecodedBytes);
        text = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
    } catch (err) {
        const code = err?.message === ERRORS.tooLarge ? ERRORS.tooLarge : ERRORS.link;
        return { ok: false, error: code, warnings: [], doc: null };
    }
    return parse(text);
}
