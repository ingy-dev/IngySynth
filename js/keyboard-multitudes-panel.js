// Multitudes panel — MI chrome + mirror wiring + 6-voice Plaits poly entry.

import { state } from './state.js?v=113';
import { bindKnob, refreshKnobDial } from './knobs.js?v=113';
import { ensurePlaitsWorklet } from './osc-source.js?v=86';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=11';
import {
    forcePolyAllOff,
    ensureMultitudesPolyReady,
    syncMultitudesPolyLocks,
} from './poly-voice.js?v=60';
import { clearPolyChordMemory } from './chord-memory.js?v=15';
import { getString, set, subscribe, toggle, wireSelect, wireToggle } from './params.js?v=5';

/** Stacked Multitudes chords run hot at mono osc levels — match Ingy-6 poly default. */
const MULTITUDES_DEFAULT_OSC_VOL = 0.1;
const MULTITUDES_DEFAULT_OSC2_WAVE = 'sine';
const MULTITUDES_DEFAULT_OSC2_TUNE = -12;

/** @type {{
 *   osc0Vol: number,
 *   osc1Vol: number,
 *   osc2Wave: string,
 *   osc2Tune: number,
 * } | null } */
let multitudesOscSnapshot = null;

function placeHomeButtons() {
    const home = document.getElementById('keyboardPolyToggleHome');
    if (!home) return;
    const chordBtn = document.getElementById('keyboardChordMemToggle');
    const polyBtn = document.getElementById('keyboardPolyToggle');
    const multBtn = document.getElementById('keyboardMultitudesToggle');
    if (chordBtn) home.appendChild(chordBtn);
    if (polyBtn) home.appendChild(polyBtn);
    if (multBtn) home.appendChild(multBtn);
    home.hidden = false;
}

function setToggleUi(btn, on) {
    if (!btn) return;
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function cloneSelectOptions(fromId, toId) {
    const src = document.getElementById(fromId);
    const dst = document.getElementById(toId);
    if (!src || !dst) return;
    dst.innerHTML = src.innerHTML;
    dst.value = src.value;
}

function wireSelectMirror(miId, key) {
    const mi = document.getElementById(miId);
    if (!mi) return;
    cloneSelectOptions(key, miId);
    wireSelect(mi, key);
}

function wirePushToggle(miId, key) {
    const mi = document.getElementById(miId);
    if (!mi) return;
    wireToggle(mi, key, { syncLabel: false });
}

function oscTuneInput(index) {
    return document.querySelector(`.osc-tune[data-osc="${index}"]`);
}
function oscVolInput(index) {
    return document.querySelector(`.osc-vol[data-osc="${index}"]`);
}
function oscTypeSelect(index) {
    return document.querySelector(`.osc-type[data-osc="${index}"]`);
}
function oscToggleBtn(index) {
    return document.querySelector(`.osc-toggle[data-osc="${index}"]`);
}

function readOscVol(index) {
    const n = parseFloat(oscVolInput(index)?.value);
    return Number.isFinite(n) ? n : MULTITUDES_DEFAULT_OSC_VOL;
}

function setOscVolUi(index, value) {
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    const main = oscVolInput(index);
    if (main) {
        main.value = String(clamped);
        const display = main.nextElementSibling;
        if (display?.classList?.contains('osc-vol-value')) {
            display.textContent = clamped.toFixed(2);
        } else if (display) {
            display.textContent = clamped.toFixed(2);
        }
        try {
            main.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) { /* ignore */ }
    }
    const kbVal = document.getElementById(`kbOsc${index + 1}VolValue`);
    if (kbVal) kbVal.textContent = clamped.toFixed(2);
    const miDial = document.getElementById(index === 0 ? 'miOsc1VolKnob' : 'miOsc2VolKnob');
    if (miDial && main) refreshKnobDial(miDial, main);
}

function readOscTune(index) {
    const n = parseInt(oscTuneInput(index)?.value, 10);
    return Number.isFinite(n) ? n : 0;
}

function setOscTuneUi(index, semis) {
    const el = oscTuneInput(index);
    if (!el) return;
    const clamped = Math.max(-12, Math.min(12, Math.round(semis)));
    if (state.oscTunes) state.oscTunes[index] = clamped;
    if (parseInt(el.value, 10) === clamped) {
        const miDial = document.getElementById(index === 0 ? 'miOsc1TuneKnob' : 'miOsc2TuneKnob');
        if (miDial) refreshKnobDial(miDial, el);
        return;
    }
    el.value = String(clamped);
    const display = el.nextElementSibling;
    if (display?.classList?.contains('osc-tune-value')) {
        display.textContent = String(clamped);
    }
    try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) { /* ignore */ }
    const kbVal = document.getElementById(`kbOsc${index + 1}TuneValue`);
    if (kbVal) kbVal.textContent = String(clamped);
    const miDial = document.getElementById(index === 0 ? 'miOsc1TuneKnob' : 'miOsc2TuneKnob');
    if (miDial) refreshKnobDial(miDial, el);
}

function setOsc2WaveUi(wave) {
    const sel = oscTypeSelect(1);
    const next = wave || MULTITUDES_DEFAULT_OSC2_WAVE;
    if (!sel) return;
    if (sel.value !== next) {
        sel.value = next;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const kb = document.querySelector(`.keyboard-osc-wave[data-osc="1"]`);
    if (kb && kb.value !== next) {
        kb.value = next;
        kb.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncOsc2WaveUi();
}

function applyMultitudesOscDefaults() {
    multitudesOscSnapshot = {
        osc0Vol: readOscVol(0),
        osc1Vol: readOscVol(1),
        osc2Wave: oscTypeSelect(1)?.value || 'sawtooth',
        osc2Tune: readOscTune(1),
    };
    setOscVolUi(0, MULTITUDES_DEFAULT_OSC_VOL);
    setOscVolUi(1, MULTITUDES_DEFAULT_OSC_VOL);
    setOsc2WaveUi(MULTITUDES_DEFAULT_OSC2_WAVE);
    setOscTuneUi(1, MULTITUDES_DEFAULT_OSC2_TUNE);
}

function restoreMultitudesOscDefaults() {
    if (!multitudesOscSnapshot) return;
    setOscVolUi(0, multitudesOscSnapshot.osc0Vol);
    setOscVolUi(1, multitudesOscSnapshot.osc1Vol);
    setOsc2WaveUi(multitudesOscSnapshot.osc2Wave);
    setOscTuneUi(1, multitudesOscSnapshot.osc2Tune);
    multitudesOscSnapshot = null;
}

function syncOsc2WaveUi() {
    const wave = getString('osc-type-1', 'sawtooth');
    document.querySelectorAll('#multitudesPanel .mi-wave-btn').forEach((btn) => {
        const on = btn.dataset.wave === wave;
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function syncOsc2ToggleUi() {
    setToggleUi(document.getElementById('miOsc2Toggle'), !!state.oscStates?.[1]);
}

function forceDigitalOn() {
    document.dispatchEvent(new CustomEvent('ingysynth:digital-on'));
}

export function syncMultitudesPanelUi() {
    const on = !!state.keyboardMultitudes;
    const panel = document.getElementById('multitudesPanel');
    if (panel) panel.hidden = !on;
    document.body.classList.toggle('multitudes-mode', on);

    const btn = document.getElementById('keyboardMultitudesToggle');
    if (btn) {
        btn.classList.toggle('off', !on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute(
            'aria-label',
            on ? 'Multitudes mode on' : 'Multitudes Polyphonic Plaititudes',
        );
    }

    if (state.keyboardPoly) return;

    const home = document.getElementById('keyboardPolyToggleHome');
    const left = document.getElementById('multitudesBrandLeft');
    const toggleSlot = document.getElementById('multitudesToggleSlot');
    const chordBtn = document.getElementById('keyboardChordMemToggle');
    const polyBtn = document.getElementById('keyboardPolyToggle');
    const multBtn = document.getElementById('keyboardMultitudesToggle');

    if (on) {
        if (left) {
            if (chordBtn) left.appendChild(chordBtn);
            if (polyBtn) left.appendChild(polyBtn);
        }
        if (toggleSlot && multBtn) toggleSlot.appendChild(multBtn);
        if (home) home.hidden = true;
    } else {
        placeHomeButtons();
    }
}

/**
 * Enter/leave Multitudes. Forces digital OSC1; arms 6-voice Plaits poly path.
 * @param {boolean} on
 */
export function setMultitudesMode(on) {
    const next = !!on;
    if (state.keyboardMultitudes === next) {
        syncMultitudesPanelUi();
        return;
    }

    if (next) {
        if (state.isPlaying || state.keyboardWrite) {
            syncMultitudesPanelUi();
            return;
        }
        forceAcidOffForPoly();
        document.dispatchEvent(new CustomEvent('ingysynth:exit-berlin'));
        state.keyboardMultitudes = true;
        clearPolyChordMemory();
        forceDigitalOn();
        void ensurePlaitsWorklet(state.audioContext);
        // Default voice: OSC1 + OSC2
        if (state.oscStates) {
            state.oscStates[0] = true;
            state.oscStates[1] = true;
            state.oscStates[2] = false;
            state.oscStates[3] = false;
        }
        const t0 = oscToggleBtn(0);
        const t1 = oscToggleBtn(1);
        if (t0?.classList.contains('off')) t0.click();
        if (t1?.classList.contains('off')) t1.click();
        for (let i = 2; i < 4; i++) {
            const t = oscToggleBtn(i);
            if (t && !t.classList.contains('off')) t.click();
        }
        applyMultitudesOscDefaults();
        ensureMultitudesPolyReady();
        syncMultitudesPolyLocks(true);
        syncOsc2ToggleUi();
        syncOsc2WaveUi();
        syncMultitudesPanelUi();
        return;
    }

    forcePolyAllOff({ silent: true });
    // Clear mode flag before unlock so syncUnisonControlsEnabled re-enables classic Unison UI
    state.keyboardMultitudes = false;
    clearPolyChordMemory();
    syncMultitudesPolyLocks(false);
    restoreMultitudesOscDefaults();
    syncMultitudesPanelUi();
}

export function toggleMultitudesMode() {
    setMultitudesMode(!state.keyboardMultitudes);
}

function wireMultitudesKnobs() {
    const pairs = [
        ['miOsc1TuneKnob', 'osc-tune-0'],
        ['miOsc1VolKnob', 'osc-vol-0'],
        ['miHarmonicsKnob', 'osc4Harmonics'],
        ['miTimbreKnob', 'osc4MorphX'],
        ['miMorphKnob', 'osc4MorphY'],
        ['miOsc2TuneKnob', 'osc-tune-1'],
        ['miOsc2VolKnob', 'osc-vol-1'],
        ['miCutoffKnob', 'cutoff'],
        ['miResonanceKnob', 'resonance'],
        ['miHighPassKnob', 'highPass'],
        ['miFilterEnvAmountKnob', 'filterEnvAmount'],
        ['miFilterAttackKnob', 'filterAttack'],
        ['miFilterDecayKnob', 'filterDecay'],
        ['miFilterSustainKnob', 'filterSustain'],
        ['miFilterReleaseKnob', 'filterRelease'],
        ['miVolumeKnob', 'volume'],
        ['miAttackKnob', 'attack'],
        ['miDecayKnob', 'decay'],
        ['miSustainKnob', 'sustain'],
        ['miReleaseKnob', 'release'],
        ['miDelayAmountKnob', 'delayAmount'],
        ['miReverbSizeKnob', 'reverbSize'],
        ['miReverbDecayKnob', 'reverbDecay'],
        ['miReverbDampKnob', 'reverbDamp'],
        ['miReverbAmountKnob', 'reverbAmount'],
    ];
    pairs.forEach(([dialId, key]) => {
        bindKnob(document.getElementById(dialId), key, null);
    });
}

function wireAnalogControls() {
    document.getElementById('miOsc2Toggle')?.addEventListener('click', () => {
        toggle('osc-toggle-1');
        syncOsc2ToggleUi();
    });
    document.querySelectorAll('#multitudesPanel .mi-wave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            set('osc-type-1', btn.dataset.wave || 'sawtooth');
            syncOsc2WaveUi();
        });
    });
    subscribe('osc-type-1', syncOsc2WaveUi);
    subscribe('osc-toggle-1', syncOsc2ToggleUi);
    syncOsc2ToggleUi();
    syncOsc2WaveUi();
}

export function initMultitudesPanel() {
    wireMultitudesKnobs();
    wireSelectMirror('miOsc4Model', 'osc4Model');
    wireSelectMirror('miOsc4Bank', 'osc4Bank');
    wireSelectMirror('miDelayTime', 'delayTime');
    wirePushToggle('miFilterEnvToggle', 'filterEnvToggle');
    wirePushToggle('miDelayToggle', 'delayToggle');
    wirePushToggle('miReverbToggle', 'reverbToggle');
    wireAnalogControls();
    syncMultitudesPanelUi();
}
