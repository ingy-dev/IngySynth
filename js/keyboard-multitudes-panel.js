// Multitudes panel — MI chrome + mirror wiring + 6-voice Plaits poly entry.

import { state } from './state.js?v=120';
import { bindKnob, refreshKnobDial } from './knobs.js?v=189';
import { ensurePlaitsWorklet } from './osc-source.js?v=157';
import { forceAcidOffForPoly } from './keyboard-acid-strip.js?v=46';
import {
    forcePolyAllOff,
    ensureMultitudesPolyReady,
    syncMultitudesPolyLocks,
    bumpSeqEngine,
    forceDrumFiltOffForPoly,
} from './poly-voice.js?v=200';
import { syncChordMemUI } from './chord-memory.js?v=52';
import { getParam } from './param-catalog.js?v=12';
import { getNumber, getOscVol, getString, set, subscribe, toggle, wireSelect, wireToggle } from './params.js?v=44';

/** Stacked Multitudes chords run hot at mono osc levels — match Ingy-6 poly default. */
// Same knob law as Main Stage (four oscillators at 0.25 sum to 1). The mode's
// level against Main Stage comes from POLY_MODE_TRIM_DB in poly-voice.js.
const MULTITUDES_DEFAULT_OSC_VOL = 0.25;
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
    const polyBtn = document.getElementById('keyboardPolyToggle');
    const multBtn = document.getElementById('keyboardMultitudesToggle');
    if (polyBtn) home.appendChild(polyBtn);
    if (multBtn) home.appendChild(multBtn);
    home.hidden = false;
}

function setToggleUi(btn, on) {
    if (!btn) return;
    btn.classList.toggle('off', !on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

const STAGE_SELECT_SOURCE = {
    osc4Model: 'kbOsc4Model',
    osc4Bank: 'kbOsc4Bank',
    delayTime: 'kbDelayTimeSelect',
};

function fillSelectFromCatalog(dst, catalogKey) {
    const spec = getParam(catalogKey);
    const options = spec?.options;
    if (!options?.length) return;
    const cur = String(getString(catalogKey, spec.default ?? ''));
    dst.innerHTML = options.map((opt) => {
        const value = String(opt);
        const selected = value === cur ? ' selected' : '';
        return `<option value="${value}"${selected}>${value}</option>`;
    }).join('');
    dst.value = cur;
}

function cloneSelectOptions(catalogKey, toId) {
    const dst = document.getElementById(toId);
    if (!dst) return;
    const stageId = STAGE_SELECT_SOURCE[catalogKey];
    const src = (stageId && document.getElementById(stageId))
        || document.getElementById(catalogKey);
    if (src && src.options.length) {
        dst.innerHTML = src.innerHTML;
        dst.value = src.value;
        return;
    }
    fillSelectFromCatalog(dst, catalogKey);
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

function readOscVol(index) {
    return getOscVol(index, MULTITUDES_DEFAULT_OSC_VOL);
}

function setOscVolUi(index, value) {
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    set(`osc-vol-${index}`, clamped);
    const kbVal = document.getElementById(`kbOsc${index + 1}VolValue`);
    if (kbVal) kbVal.textContent = clamped.toFixed(2);
    const miDial = document.getElementById(index === 0 ? 'miOsc1VolKnob' : 'miOsc2VolKnob');
    if (miDial) refreshKnobDial(miDial, `osc-vol-${index}`);
}

function readOscTune(index) {
    return Math.round(getNumber(`osc-tune-${index}`, 0)) || 0;
}

function setOscTuneUi(index, semis) {
    const clamped = Math.max(-12, Math.min(12, Math.round(semis)));
    if (state.oscTunes) state.oscTunes[index] = clamped;
    set(`osc-tune-${index}`, clamped);
    const kbVal = document.getElementById(`kbOsc${index + 1}TuneValue`);
    if (kbVal) kbVal.textContent = String(clamped);
    const miDial = document.getElementById(index === 0 ? 'miOsc1TuneKnob' : 'miOsc2TuneKnob');
    if (miDial) refreshKnobDial(miDial, `osc-tune-${index}`);
}

function setOsc2WaveUi(wave) {
    const next = wave || MULTITUDES_DEFAULT_OSC2_WAVE;
    set('osc-type-1', next);
    syncOsc2WaveUi();
}

function applyMultitudesOscDefaults() {
    multitudesOscSnapshot = {
        osc0Vol: readOscVol(0),
        osc1Vol: readOscVol(1),
        osc2Wave: getString('osc-type-1', 'sawtooth'),
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
        btn.classList.remove('is-locked');
        btn.disabled = false;
        btn.setAttribute('aria-disabled', 'false');
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.setAttribute(
            'aria-label',
            on ? 'Multitudes mode on' : 'Multitudes Polyphonic Plaititudes',
        );
    }

    if (state.keyboardPoly) return;

    const home = document.getElementById('keyboardPolyToggleHome');
    const toggleSlot = document.getElementById('multitudesToggleSlot');
    const polyBtn = document.getElementById('keyboardPolyToggle');
    const multBtn = document.getElementById('keyboardMultitudesToggle');

    if (on) {
        if (toggleSlot) {
            if (polyBtn) toggleSlot.appendChild(polyBtn);
            if (multBtn) toggleSlot.appendChild(multBtn);
        }
        if (home) home.hidden = true;
    } else {
        placeHomeButtons();
    }
}

/**
 * Enter/leave Multitudes. Forces digital OSC1; arms 6-voice Plaits poly path.
 * Parked chord memory stays loaded until reset (shared with Ingy-6).
 * @param {boolean} on
 */
export function setMultitudesMode(on) {
    const next = !!on;
    if (state.keyboardMultitudes === next) {
        syncMultitudesPanelUi();
        return;
    }

    bumpSeqEngine();

    if (next) {
        forceAcidOffForPoly();
        document.dispatchEvent(new CustomEvent('ingysynth:exit-berlin'));
        forceDrumFiltOffForPoly();
        state.keyboardMultitudes = true;
        forceDigitalOn();
        void ensurePlaitsWorklet(state.audioContext);
        // Default voice: OSC1 + OSC2
        if (state.oscStates) {
            state.oscStates[0] = true;
            state.oscStates[1] = true;
            state.oscStates[2] = false;
            state.oscStates[3] = false;
        }
        set('osc-toggle-0', true);
        set('osc-toggle-1', true);
        set('osc-toggle-2', false);
        set('osc-toggle-3', false);
        applyMultitudesOscDefaults();
        ensureMultitudesPolyReady();
        syncMultitudesPolyLocks(true);
        syncOsc2ToggleUi();
        syncOsc2WaveUi();
        syncMultitudesPanelUi();
        syncChordMemUI();
        return;
    }

    forcePolyAllOff({ silent: true });
    // Clear mode flag before unlock so syncUnisonControlsEnabled re-enables classic Unison UI
    state.keyboardMultitudes = false;
    syncMultitudesPolyLocks(false);
    restoreMultitudesOscDefaults();
    syncMultitudesPanelUi();
    syncChordMemUI();
}

export function toggleMultitudesMode() {
    setMultitudesMode(!state.keyboardMultitudes);
}

function wireMultitudesKnobs() {
    const pairs = [
        ['miOsc1TuneKnob', 'osc-tune-0'],
        ['miOsc1VolKnob', 'osc-vol-0'],
        ['miOsc4FrequencyKnob', 'osc4Frequency'],
        ['miHarmonicsKnob', 'osc4Harmonics'],
        ['miTimbreKnob', 'osc4MorphX'],
        ['miMorphKnob', 'osc4MorphY'],
        ['miEnvPitchKnob', 'osc4EnvPitch'],
        ['miEnvTimbreKnob', 'osc4EnvTimbre'],
        ['miEnvMorphKnob', 'osc4EnvMorph'],
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
