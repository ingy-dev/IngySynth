// captureProject / applyDoc and #p= boot (spec/ingy). Library UI is W2.

import { state } from './state.js?v=120';
import { get, getNumber, getString, set } from './params.js?v=24';
import { isCatalogKey, isStepKey } from './param-catalog.js?v=4';
import { PARAMS, BAREMETAL_PARAMS } from './ingy/js/params-data.js';
import { decodeLink, normalize, parse, serialize, sectionsFor } from './ingy/js/ingy-codec.js';
import {
    BANK_COUNT,
    SONG_SLOT,
    clampDrumPatch,
    ensureBerlinDrumKit,
    flushDomToPattern,
    loadSongSlot,
    requestSlot,
    selectBerlinSlot,
    selectSlot,
    setDrumSlot,
    snapshotDrumSlot,
    snapshotSynthSlot,
    writeDrumSlot,
    writeSynthSlot,
} from './pattern-bank.js?v=31';
import { snapshotBankAutomation, applyBankAutomation } from './automation.js?v=81';
import { applyAcidOscLock, syncAcidStripUi } from './keyboard-acid-strip.js?v=28';
import { setPolyMode } from './poly-voice.js?v=172';
import { setMultitudesMode } from './keyboard-multitudes-panel.js?v=67';
import { applyBerlinDrumKitToLive, setSpeechUserBankActive } from './osc-source.js?v=135';
import { setBerlinMode } from './berlin.js?v=102';
import { applyChordMemoryIntervals } from './chord-memory.js?v=28';
const ALL_PARAMS = { ...PARAMS, ...BAREMETAL_PARAMS };
const TOP_DOC_KEYS = new Set([
    'format', 'version', 'kind', 'name', 'by',
    'voice', 'pattern', 'session', 'mix', 'arrangement',
]);

/** Unknown top-level keys kept for the next save (W2 library). */
let carriedDocExtras = {};
let carriedName = '';
let carriedBy = '';

function round4(v) {
    return Math.round(v * 1e4) / 1e4;
}

function keysForSection(section) {
    return Object.keys(ALL_PARAMS).filter((k) => ALL_PARAMS[k].section === section);
}

function readCatalogParam(key) {
    const spec = ALL_PARAMS[key];
    if (!spec || isStepKey(key)) return undefined;
    if (spec.type === 'button') return !!get(key);
    if (spec.type === 'range') return getNumber(key, spec.default);
    return getString(key, spec.default);
}

function captureParamsSection(section) {
    const out = {};
    for (const key of keysForSection(section)) {
        out[key] = readCatalogParam(key);
    }
    return out;
}

function applyParamsSection(params, section) {
    if (!params || typeof params !== 'object') return;
    for (const key of keysForSection(section)) {
        if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
        if (!isCatalogKey(key)) continue;
        set(key, params[key]);
    }
    for (const key of Object.keys(params)) {
        if (keysForSection(section).includes(key)) continue;
        if (!isCatalogKey(key)) continue;
        set(key, params[key]);
    }
}

function captureVoiceFlags() {
    ensureBerlinDrumKit();
    const kit = state.berlinDrum.map((p, i) => {
        const c = clampDrumPatch(p, i);
        const patch = {
            engine: c.engine,
            model: c.model,
            tune: c.tune,
            harmonics: c.harmonics,
            morphX: c.morphX,
            morphY: c.morphY,
            alt: c.alt,
            trigPatched: c.trigPatched,
            vol: c.vol,
            pan: c.pan,
        };
        if (c.model === 'open_hat' && c.choke === false) patch.choke = false;
        return patch;
    });
    return {
        acid: !!state.acidMode,
        ingy6: !!state.keyboardPoly,
        ingy6Unison: !!state.keyboardPolyUnison,
        ingy6VcaGate: !!state.polyVcaGate,
        multitudes: !!state.keyboardMultitudes,
        osc1Digital: !!state.osc4Wavetable,
        osc1Alt: !!state.osc4Alt,
        osc1TrigPatched: !!state.osc4TrigPatched,
        speechUserBank: !!state.osc4SpeechUserBank,
        filterEnvInvert: !!state.filterEnvInvert,
        lfoAmount: Number(state.lfoAmount) || 0,
        drumKit: kit,
    };
}

function applyVoiceFlags(flags) {
    if (!flags || typeof flags !== 'object') return;
    const acid = !!flags.acid;
    state.acidMode = acid;
    applyAcidOscLock(acid);
    syncAcidStripUi();

    setPolyMode(!!flags.ingy6);
    state.keyboardPolyUnison = !!flags.ingy6Unison;
    state.polyVcaGate = !!flags.ingy6VcaGate;
    setMultitudesMode(!!flags.multitudes);

    state.osc4Wavetable = !!flags.osc1Digital;
    state.osc4Alt = !!flags.osc1Alt;
    state.osc4TrigPatched = flags.osc1TrigPatched !== false;
    setSpeechUserBankActive(!!flags.speechUserBank);
    state.filterEnvInvert = !!flags.filterEnvInvert;
    state.lfoAmount = Math.max(0, Math.min(1, Number(flags.lfoAmount) || 0));

    if (Array.isArray(flags.drumKit)) {
        ensureBerlinDrumKit();
        flags.drumKit.forEach((src, i) => {
            if (i >= state.berlinDrum.length) return;
            state.berlinDrum[i] = clampDrumPatch(src, i);
            applyBerlinDrumKitToLive(i);
        });
    }
}

function captureAutomationDoc() {
    const out = {};
    for (let i = 0; i < BANK_COUNT; i++) {
        for (const prefix of ['n', 'b']) {
            const key = `${prefix}${i}`;
            const snap = snapshotBankAutomation(key);
            const bank = automationSnapToDoc(snap);
            if (bank) out[key] = bank;
        }
    }
    return out;
}

function automationSnapToDoc(snap) {
    if (!snap?.lanes) return null;
    const lanes = {};
    let any = false;
    for (const [laneKey, lane] of Object.entries(snap.lanes)) {
        if (!lane?.samples) continue;
        const samples = lane.samples.map((v) => (
            typeof v === 'number' && Number.isFinite(v) ? round4(v) : null
        ));
        if (!samples.some((v) => v != null)) continue;
        lanes[laneKey] = { samples };
        any = true;
    }
    const offsets = {};
    if (snap.offsets) {
        for (const [k, v] of Object.entries(snap.offsets)) {
            if (typeof v === 'number' && Number.isFinite(v) && v !== 0) offsets[k] = round4(v);
        }
        if (Object.keys(offsets).length) any = true;
    }
    if (!any) return null;
    return { lanes, offsets };
}

function applyAutomationDoc(automation) {
    if (!automation || typeof automation !== 'object') return;
    for (const key of Object.keys(automation)) {
        if (!/^[nb][0-7]$/.test(key)) continue;
        applyBankAutomation(key, automationDocToSnap(automation[key]));
    }
}

function automationDocToSnap(bank) {
    if (!bank || typeof bank !== 'object') return { lanes: {}, offsets: {} };
    const lanes = {};
    const srcLanes = bank.lanes || {};
    for (const [k, lane] of Object.entries(srcLanes)) {
        if (!Array.isArray(lane?.samples)) continue;
        lanes[k] = { samples: lane.samples.slice() };
    }
    return { lanes, offsets: { ...(bank.offsets || {}) } };
}

function captureSession() {
    const xEl = document.getElementById('xAxisParam');
    const yEl = document.getElementById('yAxisParam');
    const bendEl = document.getElementById('bendRange');
    const xy = {
        x: xEl?.value === 'none' || !xEl?.value ? 'cutoff' : String(xEl.value),
        y: yEl?.value === 'none' || !yEl?.value ? 'resonance' : String(yEl.value),
    };
    const pitchBendRange = bendEl ? parseInt(bendEl.value, 10) : 2;

    const intervals = [];
    for (let i = 0; i < 4; i++) {
        intervals.push(Math.round(Number(state.oscTunes?.[i]) || 0));
    }
    const chordOn = intervals.some((v, i) => i > 0 && v !== 0);

    return {
        params: captureParamsSection('session'),
        xy,
        pitchBendRange: Number.isFinite(pitchBendRange) && pitchBendRange > 0 ? pitchBendRange : 2,
        arp: !!state.keyboardArp,
        arpChord: !!state.keyboardArpChord,
        arpOrder: state.arpOrder || 'up',
        arpRange: state.arpRange | 0 || 1,
        latch: !!state.keyboardLatch,
        transpose: state.keyboardTranspose | 0,
        microtuneLock: !!state.microtuneLock,
        chordMemory: { on: chordOn, intervals: chordOn ? intervals.filter((_, i) => i > 0) : [] },
        midiBaseNote: state.midiBaseNote | 0,
        midiMaps: JSON.parse(JSON.stringify(state.midiMappings || {})),
    };
}

function applySession(session) {
    if (!session || typeof session !== 'object') return;
    applyParamsSection(session.params, 'session');

    const xy = session.xy || {};
    const xEl = document.getElementById('xAxisParam');
    const yEl = document.getElementById('yAxisParam');
    if (xEl && xy.x) xEl.value = String(xy.x);
    if (yEl && xy.y) yEl.value = String(xy.y);
    xEl?.dispatchEvent(new Event('change', { bubbles: true }));
    yEl?.dispatchEvent(new Event('change', { bubbles: true }));

    const bendEl = document.getElementById('bendRange');
    if (bendEl && session.pitchBendRange != null) {
        bendEl.value = String(session.pitchBendRange);
        bendEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    state.keyboardArp = !!session.arp;
    state.keyboardArpChord = !!session.arpChord;
    state.arpOrder = session.arpOrder || 'up';
    state.arpRange = session.arpRange | 0 || 1;
    state.keyboardLatch = !!session.latch;
    state.keyboardTranspose = session.transpose | 0;
    state.microtuneLock = !!session.microtuneLock;
    state.midiBaseNote = session.midiBaseNote | 0;
    state.midiMappings = JSON.parse(JSON.stringify(session.midiMaps || {}));

    const cm = session.chordMemory;
    if (cm && Array.isArray(cm.intervals)) {
        const root = [0, ...cm.intervals];
        while (root.length < 4) root.push(0);
        applyChordMemoryIntervals(root.slice(0, 4));
    }
}

function capturePatternSection() {
    flushDomToPattern(state.editSlot);
    const slots = [];
    for (let i = 0; i < BANK_COUNT; i++) {
        slots.push(snapshotSynthSlot('n', i));
    }
    const drums = [];
    for (let i = 0; i < BANK_COUNT; i++) {
        drums.push({ lanes: snapshotDrumSlot(i) });
    }
    const berlinSlots = [];
    for (let i = 0; i < BANK_COUNT; i++) {
        berlinSlots.push(snapshotSynthSlot('b', i));
    }
    return {
        params: captureParamsSection('pattern'),
        slot: state.editSlot | 0,
        slots,
        drumSlot: isSongSlot(state.drumSlot) ? 0 : (state.drumSlot | 0),
        drums,
        berlin: {
            enabled: !!state.berlinMode,
            // pattern-bank.js berlinO1Seeded is module-private (line 613); cannot read faithfully.
            seeded: true,
            slot: state.berlinSlot | 0,
            slots: berlinSlots,
        },
        automation: captureAutomationDoc(),
    };
}

function isSongSlot(slot) {
    return (slot | 0) === SONG_SLOT;
}

function applyPatternSection(pattern, { whilePlaying = false } = {}) {
    if (!pattern || typeof pattern !== 'object') return;
    applyParamsSection(pattern.params, 'pattern');

    for (let i = 0; i < BANK_COUNT; i++) {
        const slotData = pattern.slots?.[i];
        if (slotData) {
            writeSynthSlot('n', i, slotData, pattern.automation?.[`n${i}`]);
        }
    }
    for (let i = 0; i < BANK_COUNT; i++) {
        const drumData = pattern.drums?.[i];
        if (drumData?.lanes) writeDrumSlot(i, drumData.lanes);
    }
    const berlin = pattern.berlin || {};
    if (berlin.enabled !== undefined) setBerlinMode(!!berlin.enabled);
    for (let i = 0; i < BANK_COUNT; i++) {
        const bSlot = berlin.slots?.[i];
        if (bSlot) writeSynthSlot('b', i, bSlot, pattern.automation?.[`b${i}`]);
    }
    applyAutomationDoc(pattern.automation);

    if (pattern.song && typeof pattern.song === 'object') {
        if (pattern.song.normal) loadSongSlot('n', pattern.song.normal);
        if (pattern.song.berlin) loadSongSlot('b', pattern.song.berlin);
        if (pattern.song.drums) loadSongSlot('d', pattern.song.drums);
    }

    const slot = Math.max(0, Math.min(BANK_COUNT - 1, pattern.slot | 0));
    const berlinSlot = Math.max(0, Math.min(BANK_COUNT - 1, (berlin.slot | 0)));
    const drumSlot = Math.max(0, Math.min(BANK_COUNT - 1, pattern.drumSlot | 0));

    if (state.berlinMode) {
        if (whilePlaying) requestSlot(berlinSlot);
        else selectBerlinSlot(berlinSlot, { followDrums: false });
    } else if (whilePlaying) {
        requestSlot(slot);
    } else {
        selectSlot(slot, { flush: false, followDrums: false });
        setDrumSlot(drumSlot);
    }
}

function mergeCarriedExtras(raw) {
    const out = { ...raw };
    for (const k of Object.keys(carriedDocExtras)) {
        if (out[k] === undefined) out[k] = carriedDocExtras[k];
    }
    return out;
}

function stashUnknownTopLevel(doc) {
    const extras = {};
    for (const k of Object.keys(doc)) {
        if (!TOP_DOC_KEYS.has(k)) extras[k] = doc[k];
    }
    carriedDocExtras = extras;
    carriedName = doc.name ?? carriedName;
    carriedBy = doc.by ?? carriedBy;
}

/** Current machine → canonical project document (unsaved edits included). */
export function captureProject() {
    flushDomToPattern(state.editSlot);
    const raw = mergeCarriedExtras({
        format: 'ingysynth',
        version: 1,
        kind: 'project',
        name: carriedName,
        by: carriedBy,
        voice: {
            params: captureParamsSection('voice'),
            flags: captureVoiceFlags(),
        },
        pattern: capturePatternSection(),
        session: captureSession(),
    });
    const warnings = [];
    return normalize(raw, warnings);
}

function stopPlaybackForProjectLoad() {
    if (!state.isPlaying) return;
    const btn = document.getElementById('startStop')
        || document.getElementById('mobileStartStop')
        || document.getElementById('kbStartStop');
    if (btn) btn.click();
    else state.isPlaying = false;
}

function applyVoiceSection(voice) {
    if (!voice) return;
    applyParamsSection(voice.params, 'voice');
    applyVoiceFlags(voice.flags);
    if (voice.speechBank) {
        // LPC frame object is kept on the doc; live bytes are not exported from osc-source (speech-bank.ingy shape).
        carriedDocExtras.speechBankPending = voice.speechBank;
    }
}

/** Load a normalized (or raw) document. `kind` overrides doc.kind when set. */
export function applyDoc(doc, kind) {
    if (!doc || typeof doc !== 'object') return false;
    const warnings = [];
    let canonical;
    try {
        canonical = normalize({ ...doc, kind: kind || doc.kind }, warnings);
    } catch {
        return false;
    }
    stashUnknownTopLevel(canonical);
    const k = canonical.kind;
    const sections = sectionsFor(k);
    const playing = state.isPlaying || state.isArping;

    if (k === 'project') stopPlaybackForProjectLoad();

    if (sections.voice) {
        applyVoiceSection(canonical.voice);
    }

    if (sections.pattern) {
        applyPatternSection(canonical.pattern, { whilePlaying: k === 'pattern' && playing });
    }

    if (sections.session) applySession(canonical.session);

    return true;
}

function plainLinkError(message) {
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.textContent = message;
    el.style.cssText = 'position:fixed;inset:0 auto auto 0;right:0;margin:1rem;padding:1rem;background:#300;color:#fff;z-index:99999;font:sans-serif';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
}

/** Build confirm message with plain text only (name / by). Exported for tests. */
export function linkConfirmMessage(doc) {
    const name = doc?.name ? String(doc.name) : 'Untitled';
    const by = doc?.by ? String(doc.by) : '';
    if (by) return `Load project "${name}" by ${by}?`;
    return `Load project "${name}"?`;
}

async function tryBootFromHash() {
    const hash = typeof location !== 'undefined' ? location.hash : '';
    if (!hash.includes('p=')) return;
    const result = await decodeLink(hash);
    if (!result.ok) {
        const msg = result.error === 'too-large'
            ? 'Link is too large to load.'
            : 'Could not read share link.';
        plainLinkError(msg);
        return;
    }
    const doc = result.doc;
    const ok = typeof window !== 'undefined'
        ? window.confirm(linkConfirmMessage(doc))
        : false;
    if (!ok) return;
    applyDoc(doc, 'project');
    if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', location.pathname + location.search);
    }
}

/** One-shot startup: storage persist + optional #p= load. */
export function initSaveBoot() {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        navigator.storage.persist().catch(() => {});
    }
    tryBootFromHash().catch(() => {
        plainLinkError('Could not read share link.');
    });
}

export function captureRoundTripCheck(doc) {
    const text = serialize(doc);
    const again = parse(text);
    return again.ok && JSON.stringify(again.doc) === JSON.stringify(doc);
}
