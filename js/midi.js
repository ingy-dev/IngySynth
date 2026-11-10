import { state } from './state.js?v=120';
import { refreshParamStatusIndicators } from './param-status.js?v=33';
import {
    heldNoteDown,
    heldNoteUp,
    pressKey,
    releaseKey,
    KEYBOARD_SEMI_MIN,
    KEYBOARD_SEMI_MAX,
} from './keyboard.js?v=276';
import { needsHeldNoteSet } from './held-notes.js?v=13';
import { isPolyWriteMode, polyWriteNoteDown, polyWriteNoteUp } from './pattern-write.js?v=160';
import {
    catalogKeyFromLearn,
    clearMappingHighlight,
    setupMappingPointerCapture,
} from './midi-learn.js?v=35';
import { click, set, toggle } from './params.js?v=44';
import { getParam, isCatalogKey, scaleCcToCatalog } from './param-catalog.js?v=13';

/** MIDI note number → cell semitone while held (for Chord arp / Chord Mem). */
const midiHeldNotes = new Map();
/** Mono write / live: which MIDI note numbers are currently held. */
const midiPlayNotes = new Set();

function midiNoteToCellSemitone(note) {
    return note - (state.midiBaseNote || 60);
}

function handleMidiHeldNote(note, isNoteOn) {
    if (state.midiMappingMode || (state.isPlaying && !state.songLiveKeys) || state.keyboardWrite || !needsHeldNoteSet()) return false;
    const semi = midiNoteToCellSemitone(note);
    if (semi < KEYBOARD_SEMI_MIN || semi > KEYBOARD_SEMI_MAX) return false;
    if (isNoteOn) {
        if (midiHeldNotes.has(note)) return true;
        midiHeldNotes.set(note, semi);
        heldNoteDown(semi);
    } else if (midiHeldNotes.has(note)) {
        const s = midiHeldNotes.get(note);
        midiHeldNotes.delete(note);
        heldNoteUp(s);
    }
    return true;
}

/** Write mode: MIDI notes program steps (poly: last-key-up capture). Allowed during Play. */
function handleMidiPlayOrWrite(note, isNoteOn) {
    if (state.midiMappingMode || !state.keyboardWrite) return false;
    const semi = midiNoteToCellSemitone(note);
    if (semi < KEYBOARD_SEMI_MIN || semi > KEYBOARD_SEMI_MAX) return false;

    if (isPolyWriteMode()) {
        if (isNoteOn) {
            if (midiHeldNotes.has(note)) return true;
            midiHeldNotes.set(note, semi);
            polyWriteNoteDown(semi);
        } else if (midiHeldNotes.has(note)) {
            const s = midiHeldNotes.get(note);
            midiHeldNotes.delete(note);
            polyWriteNoteUp(s);
        }
        return true;
    }

    if (isNoteOn) {
        if (midiPlayNotes.has(note)) return true;
        midiPlayNotes.add(note);
        pressKey(semi);
    } else if (midiPlayNotes.has(note)) {
        midiPlayNotes.delete(note);
        if (midiPlayNotes.size === 0) releaseKey();
        // Don't legato-retune in Write — each note-on already wrote a step
    }
    return true;
}

/** Phase 2: MIDI during Play (not Write) sets keyboard transpose like the piano. */
function handleMidiPlayTranspose(note, isNoteOn) {
    if (state.midiMappingMode || !state.isPlaying || state.keyboardWrite) return false;
    const semi = midiNoteToCellSemitone(note);
    if (semi < KEYBOARD_SEMI_MIN || semi > KEYBOARD_SEMI_MAX) return false;
    if (isNoteOn) {
        if (midiPlayNotes.has(note)) return true;
        midiPlayNotes.add(note);
        pressKey(semi);
    } else if (midiPlayNotes.has(note)) {
        midiPlayNotes.delete(note);
        if (midiPlayNotes.size === 0) releaseKey();
    }
    return true;
}

function onMIDISuccess(access) {
    state.midiAccess = access;
    state.midiInputs = Array.from(state.midiAccess.inputs.values());
    state.midiOutputs = Array.from(state.midiAccess.outputs.values());
    for (const input of state.midiInputs) {
        input.onmidimessage = onMIDIMessage;
        console.log(`MIDI Input: ${input.name}`);
    }
    for (const output of state.midiOutputs) {
        console.log(`MIDI Output: ${output.name}`);
    }
    populateMidiDeviceDropdown();
    state.midiAccess.onstatechange = function(e) {
        console.log(`MIDI connection changed: ${e.port.name} ${e.port.state}`);
        state.midiInputs = Array.from(state.midiAccess.inputs.values());
        state.midiOutputs = Array.from(state.midiAccess.outputs.values());
        for (const input of state.midiInputs) {
            input.onmidimessage = onMIDIMessage;
        }
        populateMidiDeviceDropdown();
    };
}

function onMIDIFailure(error) {
    console.error("Failed to access MIDI devices:", error);
}

function populateMidiDeviceDropdown() {
    const dropdown = document.getElementById('midiInputSelect');
    while (dropdown.options.length > 1) {
        dropdown.remove(1);
    }
    state.midiInputs.forEach((input, index) => {
        const option = document.createElement('option');
        option.value = input.id;
        option.text = input.name || `MIDI Input ${index + 1}`;
        dropdown.appendChild(option);
    });
    if (state.midiInputs.length === 0) {
        const option = document.createElement('option');
        option.value = "none";
        option.text = "No MIDI devices detected";
        option.disabled = true;
        dropdown.appendChild(option);
    }
}

function populateMidiOutputDropdown() {
    const dropdown = document.getElementById('midiOutputSelect');
    while (dropdown.options.length > 1) {
        dropdown.remove(1);
    }
    state.midiOutputs.forEach((output, index) => {
        const option = document.createElement('option');
        option.value = output.id;
        option.text = output.name || `MIDI Output ${index + 1}`;
        dropdown.appendChild(option);
    });
    if (state.midiOutputs.length === 0) {
        const option = document.createElement('option');
        option.value = "none";
        option.text = "No MIDI outputs detected";
        option.disabled = true;
        dropdown.appendChild(option);
    }
}

function resolveStoredMappingKey(controlId) {
    if (isCatalogKey(controlId)) return controlId;
    if (controlId.startsWith('ingy6-')) {
        const mapped = {
            attack: 'attack',
            decay: 'decay',
            sustain: 'sustain',
            release: 'release',
            cutoff: 'cutoff',
            resonance: 'resonance',
            filterEnvAmount: 'filterEnvAmount',
            highPass: 'highPass',
            noise: 'noiseVol',
            vcaLevel: 'volume',
        }[controlId.slice(6)];
        if (mapped) return mapped;
    }
    return controlId;
}

function applyMappedCc(controlId, ccValue) {
    const key = resolveStoredMappingKey(controlId);
    const spec = getParam(key);
    if (spec?.type === 'range') {
        const scaled = scaleCcToCatalog(key, ccValue);
        if (scaled != null) set(key, scaled);
    }
}

function applyMappedNote(controlId) {
    const key = resolveStoredMappingKey(controlId);
    const spec = getParam(key);
    if (spec?.type === 'ratch') {
        click(key);
        return;
    }
    if (spec?.type === 'button') {
        toggle(key);
    }
}
function onMIDIMessage(message) {
    if (state.selectedMidiInput !== 'all' && message.target.id !== state.selectedMidiInput) {
        return;
    }
    const [status, data1, data2] = message.data;
    const channel = status & 0x0F;
    const type = status & 0xF0;
    if (state.midiMappingMode && (state.currentMappingKey || state.currentMappingControl)) {
        if (type === 0xB0) {
            const cc = data1;
            const controlId = state.currentMappingKey
                || catalogKeyFromLearn(state.currentMappingControl, state.currentMappingHost);
            const visual = state.currentMappingHost || state.currentMappingControl;

            state.midiMappings[controlId] = {
                type: "cc",
                cc: cc,
                channel: channel,
            };
            state.lastMIDIValues[`cc-${cc}-${channel}`] = data2;
            visual?.classList.remove('midi-highlight');
            const mappedControl = visual;
            state.currentMappingControl = null;
            state.currentMappingHost = null;
            state.currentMappingKey = null;

            mappedControl?.classList.add('midi-mapped');
            setTimeout(() => {
                mappedControl?.classList.remove('midi-mapped');
            }, 2000);
            refreshParamStatusIndicators(controlId);

            console.log(`Mapped CC ${cc} on channel ${channel} to ${controlId}`);
        } else if (type === 0x90 && data2 > 0) {
            const note = data1;
            const controlId = state.currentMappingKey
                || catalogKeyFromLearn(state.currentMappingControl, state.currentMappingHost);
            const visual = state.currentMappingHost || state.currentMappingControl;

            state.midiMappings[controlId] = {
                type: "note",
                note: note,
                channel: channel,
            };
            visual?.classList.remove('midi-highlight');
            const mappedControl = visual;
            state.currentMappingControl = null;
            state.currentMappingHost = null;
            state.currentMappingKey = null;

            mappedControl?.classList.add('midi-mapped');
            setTimeout(() => {
                mappedControl?.classList.remove('midi-mapped');
            }, 2000);
            refreshParamStatusIndicators(controlId);

            console.log(`Mapped Note ${note} on channel ${channel} to ${controlId}`);
        }
    }
    
    // Process MIDI messages for mapped controls
    if (type === 0xB0) {
        const cc = data1;
        const value = data2;
        const midiKey = `cc-${cc}-${channel}`;
        state.lastMIDIValues[midiKey] = value;
        
        Object.entries(state.midiMappings).forEach(([controlId, mapping]) => {
            if (mapping.type === "cc" && mapping.cc === cc && mapping.channel === channel) {
                applyMappedCc(controlId, value);
            }
        });
    } else if (type === 0x90 || type === 0x80) {
        const note = data1;
        const velocity = data2;
        const isNoteOn = type === 0x90 && velocity > 0;
        if (isNoteOn) {
            state.lastVelocity = Math.max(0.05, Math.min(1, velocity / 127));
        }

        // Chord arp / Chord Mem learn: play notes into the held-note set
        if (handleMidiPlayOrWrite(note, isNoteOn)) {
            // Write mode (poly last-key-up or mono 303-advance)
        } else if (handleMidiHeldNote(note, isNoteOn)) {
            // Chord arp / Chord Mem learn / live poly
        } else if (handleMidiPlayTranspose(note, isNoteOn)) {
            // Sequencer play: MIDI keys transpose like the piano
        }

        if (isNoteOn) {
            Object.entries(state.midiMappings).forEach(([controlId, mapping]) => {
                if (mapping.type === "note" && mapping.note === note && mapping.channel === channel) {
                    applyMappedNote(controlId);
                }
            });
        }
    }
}

function setupMappingListeners(enable) {
    setupMappingPointerCapture(!!enable);
}

document.addEventListener('ingysynth:sequencer-start', () => {
    midiHeldNotes.clear();
    midiPlayNotes.clear();
});
document.addEventListener('ingysynth:sequencer-stop', () => {
    midiHeldNotes.clear();
    midiPlayNotes.clear();
});

export { onMIDISuccess, onMIDIFailure, onMIDIMessage, setupMappingListeners, populateMidiOutputDropdown, clearMappingHighlight };
