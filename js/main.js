// Entry point: import order mirrors the original single-file script order.
import { initAudio } from './audio-engine.js?v=191';
import { initPerfHud } from './perf-hud.js?v=28';
import { startIdleMarquee } from './sequencer.js?v=383';
import './controls.js?v=311';
import './midi.js?v=111';
import './visualizers.js?v=115';
import { syncNoteVfdFromPeer } from './visualizers.js?v=115';
import { refreshXYPad } from './xy-pad.js?v=78';
import { initKeyboard } from './keyboard.js?v=218';
import { initComputerKeyboard } from './computer-keyboard.js?v=202';
import { initKeyboardKnobs, initDoubleClickReset } from './knobs.js?v=136';
import { initPitchBendStrip } from './pitch-bend.js?v=97';
import { initLfoStrip, applyLfoStartupDefaults, updateLfoSmoothing } from './lfo-strip.js?v=26';
import { initLfoRateKnob, initLfoRateControls, onLfoRateApplied } from './lfo-rate.js?v=22';
import { initKeyboardSteps } from './keyboard-steps.js?v=129';
import { initPatternShift } from './pattern-shift.js?v=124';
import { initKeyboardOscillators, syncKeyboardOscillatorsFromMain } from './keyboard-oscillators.js?v=97';
import { initKeyboardEffects, syncKeyboardEffectsFromMain } from './keyboard-effects.js?v=102';
import { initKeyboardNoise, syncKeyboardNoiseFromMain } from './keyboard-noise.js?v=76';
import { initKeyboardFilterEnv, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=89';
import { initKeyboardAcidStrip } from './keyboard-acid-strip.js?v=17';
import { initKeyboardLfo, syncKeyboardLfoFromMain } from './keyboard-lfo.js?v=7';
import { initCollapsibles } from './collapsible.js?v=75';
import { initAutomation } from './automation.js?v=52';
import { initParamStatus } from './param-status.js?v=7';
import { initStepTuneRange } from './step-tune-range.js?v=15';
import { initPatternBank } from './pattern-bank.js?v=16';
import { initBerlin } from './berlin.js?v=74';
import { initDrumDock } from './drum-dock.js?v=6';
import { initMixer, syncMixerFaderCaps } from './mixer.js?v=14';
import './params.js?v=14';

onLfoRateApplied(() => updateLfoSmoothing());
initLfoRateControls();

function syncAllKeyboardSynthFromMain() {
    syncKeyboardOscillatorsFromMain();
    syncKeyboardNoiseFromMain();
    syncKeyboardFilterEnvFromMain();
    syncKeyboardEffectsFromMain();
    syncKeyboardLfoFromMain();
}

// Capture so audio (and wireControls / Space→play) is ready before button/key handlers.
// Keydown matters: Space used to do nothing on a fresh load until a click first.
document.addEventListener('click', initAudio, { once: true, capture: true });
document.addEventListener('keydown', initAudio, { once: true, capture: true });
initKeyboard();
initComputerKeyboard();
initKeyboardAcidStrip(); // ticks before knob bind so Acid V arcs/glow sync on init
initKeyboardKnobs();
initLfoRateKnob();
initDoubleClickReset();
initPitchBendStrip();
initLfoStrip();
applyLfoStartupDefaults();
initKeyboardSteps();
initStepTuneRange();
initPatternBank();
initBerlin();
initDrumDock();
initMixer();
initPatternShift();
initAutomation();
initParamStatus();
initKeyboardOscillators();
initKeyboardEffects();
initKeyboardNoise();
initKeyboardFilterEnv();
initKeyboardLfo();
initCollapsibles(document.getElementById('midiFieldset'));
initCollapsibles(document.getElementById('keyboardPatternScaleFieldset'));
initCollapsibles(document.getElementById('keyboardXyScaleFieldset'));
initCollapsibles(document.querySelector('.keyboard-play-row'));

initCollapsibles(document.getElementById('keyboardSynthFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) syncAllKeyboardSynthFromMain();
    },
});

initCollapsibles(document.getElementById('keyboardEffectsFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) syncKeyboardEffectsFromMain();
    },
});

initCollapsibles(document.getElementById('keyboardMixerFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) requestAnimationFrame(() => syncMixerFaderCaps());
    },
});

initCollapsibles(document.getElementById('keyboardXyFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) {
            // Allow layout to settle before redrawing the canvas
            requestAnimationFrame(() => refreshXYPad());
        }
    },
});

initCollapsibles(document.getElementById('keyboardTuningFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) syncNoteVfdFromPeer('kbPatternNoteVisualizer', 'kbXyNoteVisualizer');
    },
});
initCollapsibles(document.getElementById('keyboardXyTuningFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) syncNoteVfdFromPeer('kbXyNoteVisualizer', 'kbPatternNoteVisualizer');
    },
});

// Synth / Effects open expanded — sync mirrored knobs once layout is live
syncAllKeyboardSynthFromMain();

startIdleMarquee();
initPerfHud();

