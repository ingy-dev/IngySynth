import { state, OSC_COUNT } from './state.js?v=120';
import { get, getNumber, getOscType, getOscVol, getString, set, subscribe, toggle } from './params.js?v=24';
import { applyStoreToAudio, liveCutoff, setReverbIrRebuilder } from './store-engine.js?v=69';
import {
    makeDistortionCurve,
    makeBitcrushCurve,
    renderReverbImpulse,
    applyReverbSize,
} from './audio-engine.js?v=227';
import { refreshFilterInputDrive, applyFilterResonance } from './filter-drive.js?v=40';
import { updateFilterCutoffRange } from './filter-cutoff.js?v=93';
import { clearAccentSweep } from './acid-env.js?v=57';
import { togglePlay, refreshStepTuneReadouts, previewStepsOnVfd } from './sequencer.js?v=436';
import { updateNoteVisualizer, drawOscilloscope, drawADSRVisualizer, drawFilterADSRVisualizer } from './visualizers.js?v=132';
import { calculateSemitoneShift, getQuantizedStepTune, SCALE_BANKS } from './tuning.js?v=89';
import { onMIDISuccess, onMIDIFailure, setupMappingListeners, populateMidiOutputDropdown, clearMappingHighlight } from './midi.js?v=145';
import { applyScaleState } from './keyboard.js?v=257';
import { updateKeyboardStepVisibility } from './keyboard-steps.js?v=158';
import { syncUnisonControlsEnabled, spawnOscStack } from './unison.js?v=196';
import { formatRangeValue, ensureDisplayStep, chordNameFromHarmonics } from './knobs.js?v=167';
import { setLfoEnabled, getLfoAmount, getLfoAmountAudio, applyLfoMasterGain, updateLfoSmoothing, updateLfoCutoffSafety, updateLfoHighpassSafety } from './lfo-strip.js?v=52';
import { initLfoRateControls, applyLfoRate } from './lfo-rate.js?v=49';
import { syncAcidStripUi, applyAcidOscLock } from './keyboard-acid-strip.js?v=28';
import { setPolyMode, applyPolyOscPan, forEachPolyWavetableOsc, bumpSeqEngine } from './poly-voice.js?v=172';
import { setMultitudesMode } from './keyboard-multitudes-panel.js?v=67';
import {
    ensurePlaitsWorklet,
    createOscSource,
    applyOsc4MorphToLive,
    applyOsc4AltModeToLive,
    applyLiveOscVolume,
    fadeStopOsc,
    OSC4_INDEX,
    applyFm6BankToLive,
    readFm6PatchName,
    fm6PresetFromHarmonics,
} from './osc-source.js?v=135';
import { initSpeechRecUi, syncSpeechRecUi, setSpeechUserBankUiHook } from './speech-rec.js?v=31';

function syncAcidModeUi() {
    syncAcidStripUi();
}

/** Wired in wireControls — forces OSC1 digital engine on/off (Acid needs analog). */
let applyDigitalEngine = async (want) => {
    state.osc4Wavetable = !!want;
};

export function setAcidMode(next) {
    const on = !!next;
    if (state.acidMode === on) {
        syncAcidModeUi();
        return;
    }
    // Acid ↔ Poly ↔ Multitudes ↔ Berlin mutex: hand the voice back before Acid locks OSCs
    if (on && state.keyboardPoly) {
        setPolyMode(false);
    }
    if (on && state.keyboardMultitudes) {
        setMultitudesMode(false);
    }
    if (on) {
        document.dispatchEvent(new CustomEvent('ingysynth:exit-berlin'));
        // Acid needs analog saw/square on OSC1 — drop digital engine
        void applyDigitalEngine(false);
    }
    bumpSeqEngine();
    state.acidMode = on;
    syncAcidModeUi();
    applyAcidOscLock(on);
    drawADSRVisualizer();
    drawFilterADSRVisualizer();

    // ACID needs Env Mod depth — turn Filter Env on when enabling
    if (on) set('filterEnvToggle', true);

    // ACID strip Dist knob — enable distortion (amount stays at default 0 until turned up).
    // Must stay after applyAcidOscLock so the pre-Acid toggle is snapshotted first;
    // exit turns it off again unless it was already on.
    if (on) set('distortionToggle', true);

    // Acid default GATE is full-length (slider still live after this)
    if (on) set('gateLength', 100);

    if (!state.audioContext) return;
    const now = state.audioContext.currentTime;
    if (!on) {
        clearAccentSweep(now);
    } else {
        const actualCutoff = liveCutoff();
        updateFilterCutoffRange(actualCutoff, now);
        updateLfoCutoffSafety();
    }
}

// Strip + main toggles work before first audio gesture.
// Guard: mismatched ?v= imports used to load this module twice → double-toggle (panel flashes off).
if (!globalThis.__ingysynthAcidToggleWired) {
    globalThis.__ingysynthAcidToggleWired = true;
    document.getElementById('acidModeToggle')?.addEventListener('click', () => {
        setAcidMode(!state.acidMode);
    });
    document.getElementById('kbAcidStripToggle')?.addEventListener('click', () => {
        setAcidMode(!state.acidMode);
    });
}
syncAcidModeUi();

document.addEventListener('ingysynth:digital-off', () => {
    void applyDigitalEngine(false);
});
document.addEventListener('ingysynth:digital-on', () => {
    void applyDigitalEngine(true);
});

export function wireControls() {
    // Capture native steps before automation can set step="any"
    document.querySelectorAll('input[type="range"]').forEach(ensureDisplayStep);

    document.getElementById('startStop')?.addEventListener('click', togglePlay);
    document.getElementById('mobileStartStop')?.addEventListener('click', togglePlay);

    const kbStartStopButton = document.getElementById('kbStartStop');
    if (kbStartStopButton) kbStartStopButton.addEventListener('click', togglePlay);

    function syncReverseButtons() {
        const reverseButton = document.getElementById('reverse');
        const reverseFront = reverseButton?.querySelector('.front');
        if (reverseFront) {
            reverseFront.textContent = `Reverse: ${state.isReverse ? 'On' : 'Off'}`;
        }
        const kbRev = document.getElementById('kbRev');
        if (kbRev) {
            kbRev.classList.toggle('off', !state.isReverse);
            kbRev.classList.toggle('on', state.isReverse);
            kbRev.setAttribute('aria-pressed', state.isReverse ? 'true' : 'false');
        }
    }

    function toggleReverse() {
        state.isReverse = !state.isReverse;
        syncReverseButtons();
        if (state.isPlaying || state.isArping) {
            state.currentStep = state.isReverse
                ? Math.max(0, getNumber('stepCount', 8) - 1)
                : 0;
        }
    }

    document.addEventListener('keydown', function (event) {
        if (event.code !== 'Space') return;
        // Computer-keyboard capture handler owns Space when the keyboard is visible.
        if (state.keyboardVisible) return;
        event.preventDefault();
        togglePlay();
    });

    document.querySelectorAll('.osc-toggle').forEach((btn) => {
        btn.addEventListener('click', function () {
            if (this.id === 'lfoToggle') {
                toggle('lfoToggle');
            } else if (this.id === 'lfoRetrigger') {
                toggle('lfoRetrigger');
            } else {
                const oscIndex = parseInt(this.dataset.osc, 10);
                if (!Number.isFinite(oscIndex)) return;
                toggle(`osc-toggle-${oscIndex}`);
            }
        });
    });

    document.getElementById('noiseToggle')?.addEventListener('click', () => toggle('noiseToggle'));
    document.getElementById('filterEnvToggle')?.addEventListener('click', () => toggle('filterEnvToggle'));

    document.addEventListener('ingysynth:reverse-sync', syncReverseButtons);
    document.getElementById('reverse')?.addEventListener('click', toggleReverse);
    const kbRevButton = document.getElementById('kbRev');
    if (kbRevButton) kbRevButton.addEventListener('click', toggleReverse);
    syncReverseButtons();

    document.getElementById('ringModToggle')?.addEventListener('click', () => toggle('ringModToggle'));
    document.getElementById('distortionToggle')?.addEventListener('click', () => toggle('distortionToggle'));
    document.getElementById('bitcrusherToggle')?.addEventListener('click', () => toggle('bitcrusherToggle'));
    document.getElementById('delayToggle')?.addEventListener('click', () => toggle('delayToggle'));

    setReverbIrRebuilder(renderReverbImpulse);
    document.getElementById('reverbToggle')?.addEventListener('click', () => toggle('reverbToggle'));
    document.getElementById('compToggle')?.addEventListener('click', () => toggle('compToggle'));

    document.querySelectorAll('.step-toggle').forEach((btn) => {
        btn.addEventListener('click', function () {
            const front = this.querySelector('.front');
            if (!front) return;
            front.textContent = front.textContent === 'On' ? 'Off' : 'On';
            this.classList.toggle('off', front.textContent === 'Off');
        });
    });

    /** Which Plaits-style tone knobs are live for each digital model. */
    const OSC4_MODEL_TONES = {
        wavetable: { harmonics: true, timbre: true, morph: true },
        fm: { harmonics: true, timbre: true, morph: true },
        fm6: { harmonics: true, timbre: true, morph: true },
        waveshaper: { harmonics: true, timbre: true, morph: true },
        modal: { harmonics: true, timbre: true, morph: true },
        string: { harmonics: true, timbre: true, morph: true },
        bass_drum: { harmonics: true, timbre: true, morph: true },
        snare: { harmonics: true, timbre: true, morph: true },
        hihat: { harmonics: true, timbre: true, morph: true },
        va: { harmonics: true, timbre: true, morph: true },
        va_vcf: { harmonics: true, timbre: true, morph: true },
        additive: { harmonics: true, timbre: true, morph: true },
        grain: { harmonics: true, timbre: true, morph: true },
        swarm: { harmonics: true, timbre: true, morph: true },
        noise: { harmonics: true, timbre: true, morph: true },
        particle: { harmonics: true, timbre: true, morph: true },
        pd: { harmonics: true, timbre: true, morph: true },
        terrain: { harmonics: true, timbre: true, morph: true },
        string_machine: { harmonics: true, timbre: true, morph: true },
        chiptune: { harmonics: true, timbre: true, morph: true },
        chord: { harmonics: true, timbre: true, morph: true },
        speech: { harmonics: true, timbre: true, morph: true },
    };

    /** Per-model knob captions (Plaits manual meanings). */
    const OSC4_MODEL_LABELS = {
        wavetable: {
            harmonics: 'HARMONICS',
            timbre: 'TIMBRE',
            morph: 'MORPH',
        },
        fm: {
            harmonics: 'RATIO',
            timbre: 'INDEX',
            morph: 'FEEDBACK',
        },
        fm6: {
            harmonics: 'PRESET',
            timbre: 'MOD',
            morph: 'TIME',
        },
        waveshaper: {
            harmonics: 'WAVE',
            timbre: 'FOLDER',
            morph: 'ASYMM',
        },
        modal: {
            harmonics: 'INHARM',
            timbre: 'BRIGHT',
            morph: 'DECAY',
        },
        string: {
            harmonics: 'INHARM',
            timbre: 'BRIGHT',
            morph: 'DECAY',
        },
        bass_drum: {
            harmonics: 'DRIVE',
            timbre: 'TONE',
            morph: 'DECAY',
        },
        snare: {
            harmonics: 'TONE/N',
            timbre: 'TONE',
            morph: 'DECAY',
        },
        hihat: {
            harmonics: 'METAL',
            timbre: 'COLOR',
            morph: 'DECAY',
        },
        va: {
            harmonics: 'DETUNE',
            timbre: 'SQUARE',
            morph: 'SAW',
        },
        va_vcf: {
            harmonics: 'RESO',
            timbre: 'CUTOFF',
            morph: 'WAVE',
        },
        additive: {
            harmonics: 'BUMPS',
            timbre: 'INDEX',
            morph: 'SHAPE',
        },
        grain: {
            harmonics: 'RATIO',
            timbre: 'FORMANT',
            morph: 'WINDOW',
        },
        swarm: {
            harmonics: 'SPREAD',
            timbre: 'DENSITY',
            morph: 'DURATION',
        },
        noise: {
            harmonics: 'MODE',
            timbre: 'CLOCK',
            morph: 'RESO',
        },
        particle: {
            harmonics: 'RANDOM',
            timbre: 'DENSITY',
            morph: 'TYPE',
        },
        pd: {
            harmonics: 'FREQ',
            timbre: 'AMOUNT',
            morph: 'ASYMM',
        },
        terrain: {
            harmonics: 'TERRAIN',
            timbre: 'RADIUS',
            morph: 'OFFSET',
        },
        string_machine: {
            harmonics: 'CHORD',
            timbre: 'CHORUS',
            morph: 'WAVE',
        },
        chiptune: {
            harmonics: 'CHORD',
            timbre: 'ARP',
            morph: 'PW',
        },
        chord: {
            harmonics: 'CHORD',
            timbre: 'INV/SPREAD',
            morph: 'WAVE',
        },
        speech: {
            harmonics: 'MODEL',
            timbre: 'FORMANT',
            morph: 'SPEECH',
        },
    };

    /** Models that must not run under Ingy-6 poly. Chord is allowed in Multitudes. */
    const OSC4_MONO_ONLY_MODELS = new Set(['chord']);

    const FM6_BANK_OPTIONS = [
        { value: '0', label: 'Bass' },
        { value: '1', label: 'Keys' },
        { value: '2', label: 'Pads' },
    ];
    const WT_BANK_OPTIONS = [
        { value: '-1', label: 'Scan (Harmonics)' },
        { value: '0', label: 'A' },
        { value: '1', label: 'B' },
        { value: '2', label: 'C' },
        { value: '3', label: 'D' },
    ];

    const OSC4_MODELS = new Set(Object.keys(OSC4_MODEL_TONES));

    /** Plaits chord table, CCW→CW. Index matches worklet xChordIndex. */
    const OSC4_CHORD_NAME_MODELS = new Set(['chord', 'chiptune', 'string_machine']);

    function syncOsc4ChordNameUi() {
        const model = OSC4_MODELS.has(state.osc4Model) ? state.osc4Model : 'wavetable';
        const show = !!state.osc4Wavetable && OSC4_CHORD_NAME_MODELS.has(model);
        const h = getNumber('osc4Harmonics', 0.5);
        const name = chordNameFromHarmonics(h);
        document.querySelectorAll('.osc4-chord-name').forEach((el) => {
            el.hidden = !show;
            if (show) el.textContent = name;
        });
        document.querySelectorAll('.osc4-tone-knob[data-osc4-tone="harmonics"]').forEach((knob) => {
            knob.classList.toggle('has-chord-name', show);
        });
        document.getElementById('miHarmonicsKnob')?.closest('.mi-knob')
            ?.classList.toggle('has-chord-name', show);
        if (show) {
            ['kbOsc4HarmonicsValue', 'osc4HarmonicsKnobValue'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.textContent = name;
            });
        }
        const caption = (OSC4_MODEL_LABELS[model] || OSC4_MODEL_LABELS.wavetable).harmonics;
        ['kbOsc4HarmonicsKnob', 'osc4HarmonicsKnob', 'miHarmonicsKnob'].forEach((id) => {
            const dial = document.getElementById(id);
            if (!dial) return;
            if (show) dial.setAttribute('aria-valuetext', name);
            else dial.removeAttribute('aria-valuetext');
            dial.setAttribute('aria-label', show ? `${caption} ${name}` : caption);
        });
    }

    /** Models where ALT (AUX) is a meaningful alternate path — not grey. */
    const OSC4_ALT_ACTIVE = new Set([
        'additive', 'grain', 'swarm', 'pd', 'noise', 'particle', 'va', 'va_vcf',
        'waveshaper', 'fm', 'chiptune', 'terrain', 'bass_drum', 'snare', 'hihat',
        'speech',
    ]);
    /** Models where MODE 1/2 (TRIG unpatched/patched) changes behavior. */
    const OSC4_MODE_ACTIVE = new Set([
        'chiptune', 'fm6', 'swarm', 'string', 'modal', 'bass_drum', 'speech',
    ]);
    const OSC4_MODE_LABELS = {
        chiptune: { m1: 'CHORD', m2: 'ARP' },
        fm6: { m1: 'DRONE', m2: 'TRIG' },
        swarm: { m1: 'CLOUD', m2: 'BURST' },
        string: { m1: 'DUST', m2: 'STRIKE' },
        modal: { m1: 'DUST', m2: 'STRIKE' },
        bass_drum: { m1: 'DRONE', m2: 'HIT' },
        speech: { m1: 'MORPH', m2: 'TRIG' },
    };

    function syncOsc4AltModeUi() {
        const model = OSC4_MODELS.has(state.osc4Model) ? state.osc4Model : 'wavetable';
        const altActive = OSC4_ALT_ACTIVE.has(model);
        const modeActive = OSC4_MODE_ACTIVE.has(model);
        if (!altActive && state.osc4Alt) {
            state.osc4Alt = false;
            applyOsc4AltModeToLive();
        }
        const labels = OSC4_MODE_LABELS[model] || { m1: 'MODE 1', m2: 'MODE 2' };
        const altOn = !!state.osc4Alt;
        const mode2 = state.osc4TrigPatched !== false;
        document.querySelectorAll('.osc4-alt-btn').forEach((btn) => {
            btn.classList.toggle('off', !altOn);
            btn.classList.toggle('is-grey', !altActive);
            btn.disabled = !altActive;
            btn.setAttribute('aria-pressed', altOn && altActive ? 'true' : 'false');
            btn.title = altActive
                ? (altOn ? 'ALT on — Plaits AUX' : 'ALT off — Plaits OUT')
                : 'ALT unavailable for this model';
        });
        const modeLabel = mode2 ? labels.m2 : labels.m1;
        const modeTitle = modeActive
            ? (mode2
                ? `Mode 2 — ${labels.m2} (TRIG patched). Click to cycle.`
                : `Mode 1 — ${labels.m1} (TRIG unpatched). Click to cycle.`)
            : 'MODE unused for this model';
        document.querySelectorAll('.osc4-mode-btn').forEach((btn) => {
            btn.textContent = modeActive ? `MODE: ${modeLabel}` : 'MODE';
            btn.title = modeTitle;
            btn.classList.toggle('off', !modeActive);
            btn.classList.toggle('is-grey', !modeActive);
            btn.disabled = !modeActive;
            btn.setAttribute('aria-pressed', modeActive ? 'true' : 'false');
            btn.dataset.osc4Mode = mode2 ? '2' : '1';
        });
        syncSpeechRecUi();
    }

    function fillBankSelect(sel, options, value) {
        if (!sel) return;
        const cur = String(value);
        sel.innerHTML = '';
        options.forEach(({ value: v, label }) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = label;
            sel.appendChild(opt);
        });
        const ok = options.some((o) => o.value === cur);
        sel.value = ok ? cur : options[0].value;
    }

    function syncFm6PatchNameUi() {
        const model = state.osc4Model;
        const show = !!state.osc4Wavetable && model === 'fm6';
        document.querySelectorAll('.osc4-patch-name-row').forEach((el) => {
            el.hidden = !show;
        });
        const miRow = document.getElementById('miOsc4PatchRow');
        if (miRow) miRow.hidden = !show;
        if (!show) return;
        const bank = Math.max(0, Math.min(2, Number(state.osc4Bank) || 0));
        const preset = fm6PresetFromHarmonics(state.osc4Harmonics);
        const name = readFm6PatchName(bank, preset) || '—';
        ['osc4PatchName', 'kbOsc4PatchName', 'miOsc4PatchName'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = name;
        });
    }

    function syncOsc4WavetableUi() {
        const on = !!state.osc4Wavetable;
        document.body.classList.toggle('osc4-wavetable', on);
        document.querySelectorAll('.osc4-engine-btn').forEach((btn) => {
            const digital = btn.dataset.engine === 'digital';
            const active = digital ? on : !on;
            btn.classList.toggle('off', !active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const waveGroup = document.querySelector(`.keyboard-osc-wave[data-osc="${OSC4_INDEX}"]`);
        waveGroup?.classList.toggle('is-wavetable-hidden', on);
        const typeSelect = document.querySelector(`.osc-type[data-osc="${OSC4_INDEX}"]`);
        if (typeSelect) typeSelect.disabled = on;
        document.querySelectorAll('.osc4-digital-params').forEach((el) => {
            el.hidden = !on;
        });
        document.querySelectorAll('.osc4-wt-params').forEach((el) => {
            el.hidden = !on;
        });
        const model = OSC4_MODELS.has(state.osc4Model) ? state.osc4Model : 'wavetable';
        state.osc4Model = model;
        ['osc4Model', 'kbOsc4Model', 'miOsc4Model'].forEach((id) => {
            const sel = document.getElementById(id);
            if (!sel) return;
            if (sel && sel.value !== model) sel.value = model;
            // Chord unavailable under Ingy-6 poly (classic OSC1). Allowed in Multitudes.
            const chordOpt = sel.querySelector('option[value="chord"]');
            if (chordOpt) {
                const blocked = !!(state.keyboardPoly && !state.keyboardMultitudes);
                chordOpt.disabled = blocked;
                if (blocked && sel.value === 'chord') sel.value = 'wavetable';
            }
        });

        const isFm6 = model === 'fm6';
        let bankNum = Number(state.osc4Bank);
        if (isFm6) {
            if (!Number.isFinite(bankNum) || bankNum < 0 || bankNum > 2) bankNum = 0;
            state.osc4Bank = bankNum;
        } else {
            bankNum = Number.isFinite(bankNum) ? Math.max(-1, Math.min(3, bankNum)) : -1;
            state.osc4Bank = bankNum;
        }
        const bank = String(bankNum);
        const showBank = on && (model === 'wavetable' || isFm6);
        document.querySelectorAll('.osc4-bank-row').forEach((el) => {
            el.hidden = !showBank;
        });
        ['osc4Bank', 'kbOsc4Bank', 'miOsc4Bank'].forEach((id) => {
            const sel = document.getElementById(id);
            if (!sel) return;
            fillBankSelect(sel, isFm6 ? FM6_BANK_OPTIONS : WT_BANK_OPTIONS, bank);
        });

        // Grey out inactive knobs + swap captions to the active model's meanings
        const activeTones = { ...(OSC4_MODEL_TONES[model] || OSC4_MODEL_TONES.wavetable) };
        // Wavetable: HARMONICS only live while BANK is on Scan (-1)
        if (model === 'wavetable' && Number(bank) >= 0) {
            activeTones.harmonics = false;
        }
        // Voice USER bank pins LPC words — factory MODEL (HARMONICS) is off
        if (model === 'speech' && state.osc4SpeechUserBank) {
            activeTones.harmonics = false;
        }
        const labels = { ...(OSC4_MODEL_LABELS[model] || OSC4_MODEL_LABELS.wavetable) };
        if (model === 'speech' && state.osc4SpeechUserBank) {
            labels.harmonics = 'USER';
        }
        document.querySelectorAll('.osc4-tone-knob[data-osc4-tone]').forEach((knob) => {
            const tone = knob.dataset.osc4Tone;
            const active = !!activeTones[tone];
            const caption = labels[tone] || tone.toUpperCase();
            knob.classList.toggle('is-model-inactive', !active);
            const labelEl = knob.querySelector('.synth-knob-label');
            if (labelEl) labelEl.textContent = caption;
            const dial = knob.querySelector('.synth-knob-dial');
            if (dial) {
                dial.setAttribute('aria-label', caption);
                dial.setAttribute('aria-disabled', active ? 'false' : 'true');
                dial.tabIndex = active ? 0 : -1;
            }
        });
        // Multitudes MI pills
        document.querySelectorAll('#multitudesPanel [data-mi-tone]').forEach((pill) => {
            const tone = pill.dataset.miTone;
            pill.textContent = labels[tone] || tone.toUpperCase();
        });
        const harmInput = document.getElementById('osc4Harmonics');
        if (harmInput) harmInput.disabled = !activeTones.harmonics;
        syncFm6PatchNameUi();
        syncOsc4AltModeUi();
        syncOsc4ChordNameUi();
    }

    function setOsc4Bank(next) {
        const model = state.osc4Model;
        const n = Number(next);
        let bank;
        if (model === 'fm6') {
            bank = Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n))) : 0;
        } else {
            bank = Number.isFinite(n) ? Math.max(-1, Math.min(3, Math.round(n))) : -1;
        }
        if (state.osc4Bank === bank) {
            if (getString('osc4Bank') !== String(bank)) set('osc4Bank', bank);
            syncOsc4WavetableUi();
            return;
        }
        state.osc4Bank = bank;
        if (getString('osc4Bank') !== String(bank)) set('osc4Bank', bank);
        if (model === 'fm6') applyFm6BankToLive(bank);
        syncOsc4WavetableUi();
        applyOsc4MorphToLive();
    }

    function setOsc4Model(next) {
        let model = OSC4_MODELS.has(next) ? next : 'wavetable';
        // Chord is blocked in Ingy-6 only; Multitudes can run it on OSC1.
        if (OSC4_MONO_ONLY_MODELS.has(model) && state.keyboardPoly && !state.keyboardMultitudes) {
            model = 'wavetable';
        }
        const earlyReturn = state.osc4Model === model;
        if (earlyReturn && getString('osc4Model') === model) {
            syncOsc4WavetableUi();
            return;
        }
        state.osc4Model = model;
        if (getString('osc4Model') !== model) set('osc4Model', model);
        if (earlyReturn) {
            syncOsc4WavetableUi();
            return;
        }
        if (model === 'fm6') {
            // Default to Bass bank when entering 6-op
            if (state.osc4Bank < 0 || state.osc4Bank > 2) state.osc4Bank = 0;
            if (getString('osc4Bank') !== String(state.osc4Bank)) set('osc4Bank', state.osc4Bank);
            applyFm6BankToLive(state.osc4Bank);
        }
        syncOsc4WavetableUi();
        // Worklet engines share the same node; tell live voices which model to run.
        const now = state.audioContext?.currentTime ?? 0;
        const polyMode = !!(state.keyboardMultitudes || state.keyboardPoly);
        const touch = (osc) => {
            if (!osc?.isWavetable || !osc._worklet || osc.isBerlinDrum) return;
            try {
                osc._worklet.port.postMessage({
                    engine: model,
                    polyMode,
                    alt: !!state.osc4Alt,
                    trigPatched: state.osc4TrigPatched !== false,
                });
                const nowT = state.audioContext?.currentTime ?? 0;
                const altP = osc._worklet.parameters?.get('alt');
                if (altP) altP.setValueAtTime(state.osc4Alt ? 1 : 0, nowT);
                const trigP = osc._worklet.parameters?.get('trigPatched');
                if (trigP) trigP.setValueAtTime(state.osc4TrigPatched === false ? 0 : 1, nowT);
            } catch (_) { /* ignore */ }
            void now;
        };
        if (Array.isArray(state.activeOscillators)) state.activeOscillators.forEach(touch);
        if (state.oscillators?.[OSC4_INDEX]) touch(state.oscillators[OSC4_INDEX]);
        if (Array.isArray(state.berlinOscVoices)) {
            state.berlinOscVoices.forEach((voice) => {
                voice?.oscs?.forEach(({ osc }) => touch(osc));
            });
        }
        forEachPolyWavetableOsc(touch);
    }

    function rebuildOsc4EngineSources() {
        const ctx = state.audioContext;
        if (!ctx) return;
        const now = ctx.currentTime;
        const i = OSC4_INDEX;

        // Tear down phase-reset / live OSC4 voices so the next hit uses the new engine
        if (Array.isArray(state.activeOscillators) && state.activeOscillators.length) {
            const survivors = [];
            let hadOsc4 = false;
            const freq = Math.max(20, state.lastStepFreqs?.[i] || 261.63);
            for (const osc of state.activeOscillators) {
                if (osc?.oscIndex === i) {
                    hadOsc4 = true;
                    fadeStopOsc(osc, now + 0.02, { fadeSec: 0.018, hard: !!osc.isTriggered });
                } else {
                    survivors.push(osc);
                }
            }
            state.activeOscillators = survivors;
            // Keyboard live note still held — respawn OSC4 in the new mode
            if (
                hadOsc4
                && state.oscStates?.[i]
                && state.keyboardVoiceActive
                && !state.isPlaying
                && state.phaseResetEnabled
            ) {
                spawnOscStack(i, freq, now, {
                    oscStart: now,
                    gainRampStart: now,
                    gainRampEnd: now + 0.012,
                });
            }
        }

        // Berlin lane voices for OSC4
        if (Array.isArray(state.berlinOscVoices) && state.berlinOscVoices.length) {
            const keep = [];
            for (const voice of state.berlinOscVoices) {
                if (voice?.oscIndex !== i) {
                    keep.push(voice);
                    continue;
                }
                try {
                    voice.amp?.gain.cancelScheduledValues(now);
                    voice.amp?.gain.setValueAtTime(
                        Math.max(0.00001, voice.amp.gain.value || 0.00001),
                        now,
                    );
                    voice.amp?.gain.exponentialRampToValueAtTime(0.00001, now + 0.04);
                } catch (_) { /* ignore */ }
                voice.oscs?.forEach(({ osc }) => fadeStopOsc(osc, now + 0.04, { fadeSec: 0.03, hard: !!osc.isTriggered }));
            }
            state.berlinOscVoices = keep;
        }

        // Persistent oscillators (phase reset off)
        if (!state.phaseResetEnabled && state.oscillators?.[i]) {
            const old = state.oscillators[i];
            const freq = old.frequency?.value || state.lastStepFreqs?.[i] || 261.63;
            try {
                if (old.isTriggered) old.stop(now + 0.02, { hard: true });
                else if (old.started) old.stop(now + 0.02);
                else if (typeof old.stop === 'function') old.stop(now + 0.02);
            } catch (_) { /* ignore */ }
            try { fadeStopOsc(old, now + 0.02, { fadeSec: 0.018, hard: !!old.isTriggered }); } catch (_) { /* ignore */ }
            const osc = createOscSource(ctx, {
                oscIndex: i,
                wave: getOscType(i),
                frequency: freq,
            });
            try { osc.frequency.value = freq; } catch (_) { /* ignore */ }
            try { osc.connect(state.oscGains[i]); } catch (_) { /* ignore */ }
            try {
                osc.start(now + 0.005);
                osc.started = true;
            } catch (_) { /* ignore */ }
            state.oscillators[i] = osc;
            const pitchLfo = [
                state.lfoGainOsc1Pitch,
                state.lfoGainOsc2Pitch,
                state.lfoGainOsc3Pitch,
                state.lfoGainOsc4Pitch,
            ][i];
            if (pitchLfo) {
                try { pitchLfo.disconnect(); } catch (_) { /* ignore */ }
                try { pitchLfo.connect(osc.detune); } catch (_) { /* ignore */ }
            }
        }
    }

    async function setOsc4Wavetable(next) {
        const want = !!next;
        // Acid Mode owns OSC1 as analog saw/square; Poly uses classic OSC1 voices
        if (want && (state.acidMode || state.keyboardPoly)) return;
        // Multitudes requires Plaits on OSC1
        if (!want && state.keyboardMultitudes) return;
        if (want) {
            if (!state.audioContext) {
                // Flag on; audio init will load the worklet and build the right digital source
                state.osc4Wavetable = true;
                syncOsc4WavetableUi();
                return;
            }
            const ok = await ensurePlaitsWorklet(state.audioContext);
            if (!ok) {
                console.warn('Digital engine unavailable');
                state.osc4Wavetable = false;
                syncOsc4WavetableUi();
                return;
            }
        }
        const changed = state.osc4Wavetable !== want;
        state.osc4Wavetable = want;
        syncOsc4WavetableUi();
        if (state.audioContext) refreshFilterInputDrive();
        // Always rebuild so DIGITAL isn't "UI only" while old analog voices keep ringing
        if (state.audioContext && (changed || want)) {
            rebuildOsc4EngineSources();
        }
    }

    applyDigitalEngine = setOsc4Wavetable;

    document.querySelectorAll('.osc4-engine-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if ((state.acidMode || state.keyboardPoly) && btn.dataset.engine === 'digital') return;
            if (state.keyboardMultitudes && btn.dataset.engine !== 'digital') return;
            setOsc4Wavetable(btn.dataset.engine === 'digital');
        });
    });
    document.querySelectorAll('.osc4-alt-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const model = OSC4_MODELS.has(state.osc4Model) ? state.osc4Model : 'wavetable';
            if (!OSC4_ALT_ACTIVE.has(model)) return;
            state.osc4Alt = !state.osc4Alt;
            syncOsc4AltModeUi();
            applyOsc4AltModeToLive();
        });
    });
    document.querySelectorAll('.osc4-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const model = OSC4_MODELS.has(state.osc4Model) ? state.osc4Model : 'wavetable';
            if (!OSC4_MODE_ACTIVE.has(model)) return;
            // Cycle Mode 1 ↔ Mode 2 (same pattern as ARP Range)
            state.osc4TrigPatched = state.osc4TrigPatched === false;
            syncOsc4AltModeUi();
            applyOsc4AltModeToLive();
        });
    });
    ['osc4Model', 'kbOsc4Model'].forEach((id) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.addEventListener('change', () => {
            const otherId = id === 'osc4Model' ? 'kbOsc4Model' : 'osc4Model';
            const other = document.getElementById(otherId);
            if (other && other.value !== sel.value) other.value = sel.value;
            setOsc4Model(sel.value);
        });
    });
    ['osc4Bank', 'kbOsc4Bank'].forEach((id) => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.addEventListener('change', () => {
            const otherId = id === 'osc4Bank' ? 'kbOsc4Bank' : 'osc4Bank';
            const other = document.getElementById(otherId);
            if (other && other.value !== sel.value) other.value = sel.value;
            setOsc4Bank(sel.value);
        });
    });

    function formatTone01(n) {
        const v = Number(n);
        return Number.isFinite(v) ? v.toFixed(2) : '0.00';
    }

    function syncOsc4ToneValueLabels() {
        const h = getNumber('osc4Harmonics', 0.5);
        const x = getNumber('osc4MorphX', 0.5);
        const y = getNumber('osc4MorphY', 0.5);
        const pairs = [
            ['kbOsc4HarmonicsValue', 'osc4HarmonicsKnobValue', formatTone01(h)],
            ['kbOsc4TimbreValue', 'osc4TimbreKnobValue', formatTone01(x)],
            ['kbOsc4MorphValue', 'osc4MorphKnobValue', formatTone01(y)],
        ];
        const chordNames = !!state.osc4Wavetable && OSC4_CHORD_NAME_MODELS.has(state.osc4Model);
        pairs.forEach(([a, b, text], i) => {
            if (i === 0 && chordNames) return;
            const elA = document.getElementById(a);
            const elB = document.getElementById(b);
            if (elA) elA.textContent = text;
            if (elB) elB.textContent = text;
        });
        if (chordNames) syncOsc4ChordNameUi();
    }

    ['osc4Harmonics', 'osc4MorphX', 'osc4MorphY'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            syncOsc4ToneValueLabels();
            applyOsc4MorphToLive();
            if (id === 'osc4Harmonics') {
                syncFm6PatchNameUi();
                syncOsc4ChordNameUi();
            }
        });
    });
    syncOsc4ToneValueLabels();
    syncOsc4ChordNameUi();

    syncOsc4WavetableUi();
    setSpeechUserBankUiHook(() => syncOsc4WavetableUi());
    initSpeechRecUi();

    subscribe('osc4Model', (v) => setOsc4Model(String(v || '')));
    subscribe('osc4Bank', (v) => setOsc4Bank(v));
    subscribe('osc4Harmonics', () => {
        applyOsc4MorphToLive();
        syncFm6PatchNameUi();
        syncOsc4ChordNameUi();
        syncOsc4ToneValueLabels();
    });
    subscribe('osc4MorphX', () => {
        applyOsc4MorphToLive();
        syncOsc4ToneValueLabels();
    });
    subscribe('osc4MorphY', () => {
        applyOsc4MorphToLive();
        syncOsc4ToneValueLabels();
    });

    initLfoRateControls();

    updateStepVisibility(getNumber('stepCount', 8));
    drawOscilloscope();

    const phaseResetToggle = document.getElementById('phaseResetToggle');

    function setPhaseResetUi(on) {
        if (!phaseResetToggle) return;
        const front = phaseResetToggle.querySelector('.front');
        if (front) front.textContent = on ? 'On' : 'Off';
        phaseResetToggle.classList.toggle('off', !on);
        phaseResetToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function setPhaseResetEnabled(enabled) {
        if (!state.audioContext) return;
        const next = !!enabled;
        if (state.phaseResetEnabled === next) {
            setPhaseResetUi(next);
            return;
        }

        state.phaseResetEnabled = next;
        setPhaseResetUi(next);

        if (!next) {
            state.oscillators.forEach(osc => {
                if (osc.started) {
                    osc.stop();
                }
            });
            state.oscillators = Array(OSC_COUNT).fill().map((_, i) => {
                const osc = createOscSource(state.audioContext, {
                    oscIndex: i,
                    wave: getOscType(i),
                    frequency: 261.63,
                });
                osc.frequency.value = 261.63;
                osc.connect(state.oscGains[i]);
                try { state.oscGains[i].disconnect(); } catch (_) { /* ignore */ }
                state.oscGains[i].connect(state.oscPanners[i] || state.ringModInput);
                osc.start();
                osc.started = true;
                return osc;
            });
            // Reconnect LFO pitch → persistent osc detune
            [
                state.lfoGainOsc1Pitch,
                state.lfoGainOsc2Pitch,
                state.lfoGainOsc3Pitch,
                state.lfoGainOsc4Pitch,
            ].forEach((gain, i) => {
                if (!gain || !state.oscillators[i]) return;
                try { gain.disconnect(); } catch (_) { /* ignore */ }
                gain.connect(state.oscillators[i].detune);
            });
        } else {
            state.oscillators.forEach(osc => {
                if (osc.started) {
                    osc.stop();
                    osc.disconnect();
                }
            });
            state.oscillators = Array(OSC_COUNT).fill().map((_, i) => createOscSource(state.audioContext, {
                oscIndex: i,
                wave: getOscType(i),
                frequency: 261.63,
            }));
            state.activeOscillators.forEach(osc => {
                if (osc.started) {
                    osc.stop();
                    osc.disconnect();
                }
            });
            state.activeOscillators = [];
        }

        syncUnisonControlsEnabled();
    }

    if (phaseResetToggle) {
        phaseResetToggle.addEventListener('click', () => toggle('phaseResetToggle'));
    }
    subscribe('phaseResetToggle', (on) => setPhaseResetEnabled(!!on));

    const unisonVoices = document.getElementById('unisonVoices');
    const unisonDetune = document.getElementById('unisonDetune');
    const unisonDetuneValue = document.getElementById('unisonDetuneValue');
    const unisonToggle = document.getElementById('unisonToggle');

    function formatUnisonDetune(n) {
        return `${Math.round(n)}¢`;
    }

    function setUnisonEnabled(enabled) {
        const next = !!enabled;
        if (next && !get('phaseResetToggle')) {
            set('phaseResetToggle', true);
        }
        state.unisonEnabled = next;
        if (unisonToggle) {
            const front = unisonToggle.querySelector('.front');
            if (front) front.textContent = next ? 'On' : 'Off';
            unisonToggle.classList.toggle('off', !next);
            unisonToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
        }
    }

    if (unisonToggle) {
        unisonToggle.addEventListener('click', function () {
            if (!state.audioContext || state.keyboardPoly || state.keyboardMultitudes) return;
            toggle('unisonToggle');
        });
    }
    subscribe('unisonToggle', (on) => {
        if (state.keyboardPoly || state.keyboardMultitudes) return;
        setUnisonEnabled(!!on);
    });

    subscribe('unisonVoices', (v) => {
        const n = parseInt(v, 10);
        state.unisonVoices = 3;
    });
    subscribe('unisonDetune', (v) => {
        state.unisonSpread = parseFloat(v) || 0;
        if (unisonDetuneValue) unisonDetuneValue.textContent = formatUnisonDetune(state.unisonSpread);
    });

    if (unisonDetune) {
        unisonDetune.addEventListener('input', function () {
            state.unisonSpread = parseFloat(this.value) || 0;
            if (unisonDetuneValue) unisonDetuneValue.textContent = formatUnisonDetune(state.unisonSpread);
        });
        state.unisonSpread = parseFloat(unisonDetune.value) || 0;
        if (unisonDetuneValue) unisonDetuneValue.textContent = formatUnisonDetune(state.unisonSpread);
    }

    syncUnisonControlsEnabled();

    // Initialize MIDI
    if (navigator.requestMIDIAccess) {
        navigator.requestMIDIAccess({ sysex: false })
            .then(onMIDISuccess, onMIDIFailure);
    } else {
        console.warn("WebMIDI is not supported in this browser.");
    }

    function syncMidiMappingUi() {
        const on = !!state.midiMappingMode;
        const mappingBtn = document.getElementById('midiMapping');
        if (mappingBtn) {
            mappingBtn.classList.toggle('off', !on);
            mappingBtn.classList.toggle('active', on);
            mappingBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
            mappingBtn.setAttribute('aria-label', on ? 'Disable MIDI mapping' : 'Enable MIDI mapping');
        }
        if (on) {
            document.body.classList.add('midi-mapping-active');
            setupMappingListeners(true);
        } else {
            document.body.classList.remove('midi-mapping-active');
            setupMappingListeners(false);
            if (state.currentMappingControl) {
                clearMappingHighlight();
                state.currentMappingControl = null;
                state.currentMappingHost = null;
            }
            document.querySelectorAll('.midi-mapped').forEach((el) => {
                el.classList.remove('midi-mapped');
            });
        }
    }

    function setMidiMappingMode(want, { alertIfEmpty = true } = {}) {
        const next = !!want;
        const changed = state.midiMappingMode !== next;
        state.midiMappingMode = next;
        syncMidiMappingUi();
        if (changed && next && alertIfEmpty && state.midiInputs.length === 0) {
            alert('No MIDI inputs detected. Please connect a MIDI controller and refresh the page.');
        }
    }

    function syncMidiSectionUi() {
        const on = !!state.midiSectionOpen;
        const logoBtn = document.getElementById('midiLogoToggle');
        const fieldset = document.getElementById('midiFieldset');
        const devicePanels = document.getElementById('midiDevicePanels');
        if (logoBtn) {
            logoBtn.disabled = false;
            logoBtn.classList.toggle('off', !on);
            logoBtn.classList.toggle('active', on);
            logoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
            logoBtn.setAttribute('aria-label', on ? 'Disable MIDI' : 'Enable MIDI');
        }
        if (fieldset) {
            fieldset.hidden = false;
            fieldset.setAttribute('aria-hidden', 'false');
            fieldset.classList.toggle('midi-section-on', on);
            fieldset.classList.toggle('midi-section-off', !on);
        }
        if (devicePanels) devicePanels.hidden = !on;
        const mappingBtn = document.getElementById('midiMapping');
        if (mappingBtn) mappingBtn.hidden = !on;
        state.sendMidiEnabled = on;
        if (on) {
            populateMidiOutputDropdown();
            const noInputs = state.midiInputs.length === 0;
            const noOutputs = state.midiOutputs.length === 0;
            const webMidiSupported = typeof navigator.requestMIDIAccess === 'function';
            if (!webMidiSupported) {
                alert('WebMIDI is not supported in this browser.');
            } else if (noInputs && noOutputs) {
                alert('No MIDI devices detected. Please connect a MIDI controller and refresh the page.');
            } else if (noInputs) {
                alert('No MIDI inputs detected. Please connect a MIDI controller and refresh the page.');
            } else if (noOutputs) {
                alert('No MIDI outputs detected. Please connect a MIDI device and refresh the page.');
            }
        } else if (state.midiMappingMode) {
            setMidiMappingMode(false, { alertIfEmpty: false });
        }
    }

    document.getElementById('midiLogoToggle')?.addEventListener('click', () => {
        state.midiSectionOpen = !state.midiSectionOpen;
        syncMidiSectionUi();
    });
    document.getElementById('midiMapping')?.addEventListener('click', () => {
        if (!state.midiSectionOpen) return;
        setMidiMappingMode(!state.midiMappingMode);
    });
    syncMidiMappingUi();
    syncMidiSectionUi();

    document.getElementById('midiInputSelect')?.addEventListener('change', function() {
        state.selectedMidiInput = this.value;
        console.log(`Selected MIDI input device: ${this.options[this.selectedIndex].text}`);
    });

    document.getElementById('midiOutputSelect')?.addEventListener('change', function() {
        const outputId = this.value;
        if (outputId === 'none') {
            state.selectedMidiOutput = null;
        } else {
            state.selectedMidiOutput = state.midiOutputs.find(output => output.id === outputId);
            console.log(`Selected MIDI output device: ${this.options[this.selectedIndex].text}`);
        }
    });

    document.getElementById('midiOutputChannel')?.addEventListener('change', function() {
        state.selectedMidiChannel = parseInt(this.value);
        console.log(`Selected MIDI channel: ${state.selectedMidiChannel}`);
    });

    document.getElementById('midiBaseNote')?.addEventListener('change', function() {
        state.midiBaseNote = parseInt(this.value);
        console.log(`Selected MIDI base note: ${state.midiBaseNote}`);
    });

    // Only initialize chorus nodes if they don't already exist
    if (!state.chorusDryGain) {
        // Initialize chorus settings
        state.chorusDryGain = state.audioContext.createGain();
        state.chorusWetGain = state.audioContext.createGain();
        state.chorusLeftDelay = state.audioContext.createDelay(0.05);
        state.chorusRightDelay = state.audioContext.createDelay(0.05);
        state.chorusLFO = state.audioContext.createOscillator();
        state.chorusLFOGain = state.audioContext.createGain();
        state.chorusSplitter = state.audioContext.createChannelSplitter(2);
        state.chorusMerger = state.audioContext.createChannelMerger(2);
        
        // Initialize chorus settings
        state.chorusDryGain.gain.value = 1;
        state.chorusWetGain.gain.value = 0; // Start with chorus off by default
        state.chorusLFO.type = 'triangle';
        state.chorusLFOGain.gain.value = 0; // No modulation by default
        
        // Start the chorus LFO
        state.chorusLFO.start();
    }

    document.getElementById('chorusI')?.addEventListener('click', () => toggle('chorusI'));
    document.getElementById('chorusII')?.addEventListener('click', () => toggle('chorusII'));
    applyStoreToAudio();
}

function updateDisplay(element, valueElementId) {
    if (!element) return;
    ensureDisplayStep(element);
    const el = document.getElementById(valueElementId);
    if (el) el.textContent = formatRangeValue(element);
}

function updateStepVisibility(stepCount) {
    updateKeyboardStepVisibility(stepCount);
}

/** Stage pattern sliders write the store — not the classic range + dispatch. */
function bindKeyboardPatternRange(mirrorId, mainId, kbValueId) {
    const mirror = document.getElementById(mirrorId);
    const kbValue = document.getElementById(kbValueId);
    if (!mirror) return;

    const syncFromStore = () => {
        const v = String(getNumber(mainId));
        if (mirror.value !== v) mirror.value = v;
        if (kbValue) kbValue.textContent = formatRangeValue(mirror);
    };

    mirror.addEventListener('input', () => {
        set(mainId, mirror.value);
        if (kbValue) kbValue.textContent = formatRangeValue(mirror);
    });
    subscribe(mainId, syncFromStore);
}

bindKeyboardPatternRange('kbSlideTime', 'slideTime', 'kbSlideTimeValue');
bindKeyboardPatternRange('kbAccentAmount', 'accentAmount', 'kbAccentAmountValue');
bindKeyboardPatternRange('kbGateLength', 'gateLength', 'kbGateLengthValue');

const scaleSelect = document.getElementById('scaleSelect');
if (scaleSelect) {
    SCALE_BANKS.forEach((bank) => {
        const group = document.createElement('optgroup');
        group.label = bank.name;
        bank.scales.forEach((scale) => {
            const option = document.createElement('option');
            option.value = scale.id;
            option.textContent = scale.name;
            group.appendChild(option);
        });
        scaleSelect.appendChild(group);
    });
    scaleSelect.addEventListener('change', () => set('scaleSelect', scaleSelect.value));
}

document.getElementById('scaleToggle')?.addEventListener('click', () => toggle('scaleToggle'));
subscribe('scaleToggle', (on) => applyScaleState(!!on, getString('scaleSelect')));
subscribe('scaleSelect', (id) => applyScaleState(!!get('scaleToggle'), String(id || '')));
