import { state } from './state.js?v=107';
import { refreshParamStatusIndicators } from './param-status.js?v=4';
import {
    heldNoteDown,
    heldNoteUp,
    pressKey,
    releaseKey,
    KEYBOARD_SEMI_MIN,
    KEYBOARD_SEMI_MAX,
} from './keyboard.js?v=158';
import { needsHeldNoteSet } from './held-notes.js?v=5';

/** MIDI note number → cell semitone while held (for Chord arp / Chord Mem). */
const midiHeldNotes = new Map();
/** Mono write / live: which MIDI note numbers are currently held. */
const midiPlayNotes = new Set();

function midiNoteToCellSemitone(note) {
    return note - (state.midiBaseNote || 60);
}

function handleMidiHeldNote(note, isNoteOn) {
    if (state.midiMappingMode || state.isPlaying || !needsHeldNoteSet()) return false;
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

/** Write mode only: MIDI notes → keyboard press/release (program steps). */
function handleMidiPlayOrWrite(note, isNoteOn) {
    if (state.midiMappingMode || state.isPlaying || !state.keyboardWrite) return false;
    if (needsHeldNoteSet()) return false;
    const semi = midiNoteToCellSemitone(note);
    if (semi < KEYBOARD_SEMI_MIN || semi > KEYBOARD_SEMI_MAX) return false;

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

function onMIDIMessage(message) {
    if (state.selectedMidiInput !== 'all' && message.target.id !== state.selectedMidiInput) {
        return;
    }
    const [status, data1, data2] = message.data;
    const channel = status & 0x0F;
    const type = status & 0xF0;
    if (state.midiMappingMode && state.currentMappingControl) {
        if (type === 0xB0) {
            // Define the cc variable
            const cc = data1;
            
            // Create a more specific controlId that includes the element type
            let controlId = state.currentMappingControl.id;
            
            // For step controls, create a more specific ID format
            if (state.currentMappingControl.dataset && state.currentMappingControl.dataset.step !== undefined) {
                const stepNum = state.currentMappingControl.dataset.step;
                if (state.currentMappingControl.tagName === 'INPUT' && state.currentMappingControl.type === 'range') {
                    controlId = state.currentMappingControl.classList.contains('step-fine')
                        ? `step-fine-${stepNum}`
                        : `step-slider-${stepNum}`;
                } else if (state.currentMappingControl.tagName === 'BUTTON') {
                    controlId = state.currentMappingControl.classList.contains('step-slide')
                        ? `step-slide-${stepNum}`
                        : state.currentMappingControl.classList.contains('step-accent')
                            ? `step-accent-${stepNum}`
                            : `step-toggle-${stepNum}`;
                }
            } else if (state.currentMappingControl.dataset && state.currentMappingControl.dataset.osc !== undefined) {
                const oscNum = state.currentMappingControl.dataset.osc;
                // Create specific IDs for different oscillator controls
                if (state.currentMappingControl.classList.contains('osc-tune')) {
                    controlId = `osc-tune-${oscNum}`;
                } else if (state.currentMappingControl.classList.contains('osc-vol')) {
                    controlId = `osc-vol-${oscNum}`;
                } else if (state.currentMappingControl.classList.contains('osc-toggle')) {
                    controlId = `osc-toggle-${oscNum}`;
                } else if (state.currentMappingControl.classList.contains('osc-type')) {
                    controlId = `osc-type-${oscNum}`;
                } else {
                    controlId = `osc-${oscNum}`;
                }
            }
            
            state.midiMappings[controlId] = { 
                type: "cc", 
                cc: cc, 
                channel: channel,
                element: state.currentMappingControl // Store reference to the actual element
            };
            state.lastMIDIValues[`cc-${cc}-${channel}`] = data2;
            state.currentMappingControl.classList.remove('midi-highlight');
            
            // Store a reference to the mapped control element
            const mappedControl = state.currentMappingControl;
            state.currentMappingControl = null;
            
            // Add mapped class and remove it after 2 seconds
            mappedControl.classList.add('midi-mapped');
            setTimeout(() => {
                mappedControl.classList.remove('midi-mapped');
            }, 2000);
            refreshParamStatusIndicators(controlId);

            console.log(`Mapped CC ${cc} on channel ${channel} to ${controlId}`);
        } else if (type === 0x90 && data2 > 0) {
            const note = data1;
            let controlId = state.currentMappingControl.id;
            
            // For step controls, create a more specific ID format
            if (state.currentMappingControl.dataset && state.currentMappingControl.dataset.step !== undefined) {
                const stepNum = state.currentMappingControl.dataset.step;
                if (state.currentMappingControl.tagName === 'BUTTON') {
                    controlId = state.currentMappingControl.classList.contains('step-slide')
                        ? `step-slide-${stepNum}`
                        : state.currentMappingControl.classList.contains('step-accent')
                            ? `step-accent-${stepNum}`
                            : `step-toggle-${stepNum}`;
                }
            }
            
            state.midiMappings[controlId] = { 
                type: "note", 
                note: note, 
                channel: channel,
                element: state.currentMappingControl // Store reference to the actual element
            };
            state.currentMappingControl.classList.remove('midi-highlight');
            
            // Store a reference to the mapped control element
            const mappedControl = state.currentMappingControl;
            state.currentMappingControl = null;
            
            // Add mapped class and remove it after 2 seconds
            mappedControl.classList.add('midi-mapped');
            setTimeout(() => {
                mappedControl.classList.remove('midi-mapped');
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
                // Try using the stored element reference first
                let control = mapping.element;
                
                // If the stored element is not available, try to find it by ID
                if (!control) {
                    // Handle step controls with their special ID format
                    if (controlId.startsWith('step-slider-')) {
                        const stepNum = controlId.split('-')[2];
                        control = document.querySelector(`.step-tune[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('step-fine-')) {
                        const stepNum = controlId.split('-')[2];
                        control = document.querySelector(`.step-fine[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('step-slide-')) {
                        const stepNum = controlId.split('-')[2];
                        control = document.querySelector(`.step-slide[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('step-accent-')) {
                        const stepNum = controlId.split('-')[2];
                        control = document.querySelector(`.step-accent[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('step-toggle-')) {
                        const stepNum = controlId.split('-')[2];
                        control = document.querySelector(`.step-toggle[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('osc-tune-')) {
                        const oscNum = controlId.split('-')[2];
                        control = document.querySelector(`.osc-tune[data-osc="${oscNum}"]`);
                    } else if (controlId.startsWith('osc-vol-')) {
                        const oscNum = controlId.split('-')[2];
                        control = document.querySelector(`.osc-vol[data-osc="${oscNum}"]`);
                    } else if (controlId.startsWith('osc-toggle-')) {
                        const oscNum = controlId.split('-')[2];
                        control = document.querySelector(`.osc-toggle[data-osc="${oscNum}"]`);
                    } else if (controlId.startsWith('osc-type-')) {
                        const oscNum = controlId.split('-')[2];
                        control = document.querySelector(`.osc-type[data-osc="${oscNum}"]`);
                    } else if (controlId.startsWith('osc-')) {
                        const oscNum = controlId.split('-')[1];
                        control = document.querySelector(`[data-osc="${oscNum}"]`);
                    } else {
                        control = document.getElementById(controlId);
                    }
                }
                
                if (control) {
                    if (control.tagName === 'INPUT' && control.type === 'range') {
                        const min = parseFloat(control.min) || 0;
                        const max = parseFloat(control.max) || 127;
                        const scaledValue = min + (value / 127) * (max - min);
                        control.value = scaledValue;
                        control.dispatchEvent(new Event('input'));
                        
                        // Update display value if it's a step slider
                        if (control.classList.contains('step-tune') || control.classList.contains('step-fine')) {
                            const valueDisplay = control.nextElementSibling;
                            if (valueDisplay) {
                                valueDisplay.textContent = Math.round(scaledValue);
                            }
                        }
                    }
                }
            }
        });
    } else if (type === 0x90 || type === 0x80) {
        const note = data1;
        const velocity = data2;
        const isNoteOn = type === 0x90 && velocity > 0;

        // Chord arp / Chord Mem learn: play notes into the held-note set
        if (handleMidiHeldNote(note, isNoteOn)) {
            // Still allow mapped note→button clicks below when mapping is off
        } else if (handleMidiPlayOrWrite(note, isNoteOn)) {
            // Write mode + mono live play from MIDI keyboard
        }

        Object.entries(state.midiMappings).forEach(([controlId, mapping]) => {
            if (mapping.type === "note" && mapping.note === note && mapping.channel === channel) {
                // Try using the stored element reference first
                let button = mapping.element;
                
                // If the stored element is not available, try to find it by ID
                if (!button) {
                    // Handle step toggle buttons with their special ID format
                    if (controlId.startsWith('step-toggle-')) {
                        const stepNum = controlId.split('-')[2];
                        button = document.querySelector(`.step-toggle[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('step-slide-')) {
                        const stepNum = controlId.split('-')[2];
                        button = document.querySelector(`.step-slide[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('step-accent-')) {
                        const stepNum = controlId.split('-')[2];
                        button = document.querySelector(`.step-accent[data-step="${stepNum}"]`);
                    } else if (controlId.startsWith('osc-toggle-')) {
                        const oscNum = controlId.split('-')[2];
                        button = document.querySelector(`.osc-toggle[data-osc="${oscNum}"]`);
                    } else {
                        button = document.getElementById(controlId);
                    }
                }
                
                if (button && isNoteOn) {
                    button.click();
                }
            }
        });
    }
}

function setupMappingListeners(enable) {
    const mappableControls = [
        ...document.querySelectorAll('input[type="range"]'),
        ...document.querySelectorAll('button.pushable:not(#midiMapping)')
    ];
    mappableControls.forEach(control => {
        if (enable) {
            control.addEventListener('click', onControlClick);
        } else {
            control.removeEventListener('click', onControlClick);
        }
    });
}

function onControlClick(event) {
    if (!state.midiMappingMode) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.currentMappingControl) {
        state.currentMappingControl.classList.remove('midi-highlight');
    }
    state.currentMappingControl = this;
    this.classList.add('midi-highlight');
    
    // Create a more specific controlId for logging
    let controlId = this.id;
    if (this.dataset && this.dataset.step !== undefined) {
        if (this.tagName === 'INPUT' && this.type === 'range') {
            controlId = this.classList.contains('step-fine')
                ? `step-fine-${this.dataset.step}`
                : `step-slider-${this.dataset.step}`;
        } else if (this.tagName === 'BUTTON') {
            controlId = this.classList.contains('step-slide')
                ? `step-slide-${this.dataset.step}`
                : this.classList.contains('step-accent')
                    ? `step-accent-${this.dataset.step}`
                    : `step-toggle-${this.dataset.step}`;
        }
    } else if (this.dataset && this.dataset.osc !== undefined) {
        const oscNum = this.dataset.osc;
        // Create specific IDs for different oscillator controls
        if (this.classList.contains('osc-tune')) {
            controlId = `osc-tune-${oscNum}`;
        } else if (this.classList.contains('osc-vol')) {
            controlId = `osc-vol-${oscNum}`;
        } else if (this.classList.contains('osc-toggle')) {
            controlId = `osc-toggle-${oscNum}`;
        } else if (this.classList.contains('osc-type')) {
            controlId = `osc-type-${oscNum}`;
        } else {
            controlId = `osc-${oscNum}`;
        }
    }
    
    console.log(`Ready to map MIDI control to ${controlId}`);
}

document.addEventListener('ingysynth:sequencer-start', () => {
    midiHeldNotes.clear();
});

export { onMIDISuccess, onMIDIFailure, onMIDIMessage, setupMappingListeners, populateMidiOutputDropdown };
