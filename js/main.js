// Entry point: import order mirrors the original single-file script order.
import { initAudio } from './audio-engine.js?v=146';
import { startIdleMarquee } from './sequencer.js?v=241';
import './controls.js?v=255';
import './midi.js?v=87';
import './visualizers.js?v=98';
import { syncNoteVfdFromPeer } from './visualizers.js?v=98';
import './mobile.js?v=74';
import { refreshXYPad } from './xy-pad.js?v=75';
import { initKeyboard } from './keyboard.js?v=181';
import { initComputerKeyboard } from './computer-keyboard.js?v=172';
import { initKeyboardKnobs, initDoubleClickReset } from './knobs.js?v=113';
import { initPitchBendStrip } from './pitch-bend.js?v=84';
import { initLfoStrip, applyLfoStartupDefaults, updateLfoSmoothing } from './lfo-strip.js?v=17';
import { initLfoRateKnob, initLfoRateControls, onLfoRateApplied } from './lfo-rate.js?v=10';
import { initKeyboardSteps } from './keyboard-steps.js?v=103';
import { initPatternShift } from './pattern-shift.js?v=102';
import { initKeyboardOscillators, syncKeyboardOscillatorsFromMain } from './keyboard-oscillators.js?v=85';
import { initKeyboardEffects, syncKeyboardEffectsFromMain } from './keyboard-effects.js?v=88';
import { initKeyboardNoise, syncKeyboardNoiseFromMain } from './keyboard-noise.js?v=74';
import { initKeyboardFilterEnv, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=80';
import { initKeyboardAcidStrip } from './keyboard-acid-strip.js?v=11';
import { initKeyboardLfo, syncKeyboardLfoFromMain } from './keyboard-lfo.js?v=5';
import { initCollapsibles } from './collapsible.js?v=74';
import { initAutomation } from './automation.js?v=35';
import { initParamStatus } from './param-status.js?v=5';
import { initStepTuneRange } from './step-tune-range.js?v=3';
import { initPatternBank } from './pattern-bank.js?v=9';
import { initBerlin } from './berlin.js?v=35';
import './params.js?v=5';

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
initPatternShift();
initAutomation();
initParamStatus();
initKeyboardOscillators();
initKeyboardEffects();
initKeyboardNoise();
initKeyboardFilterEnv();
initKeyboardLfo();
const keyboardSynthCollapsibles = initCollapsibles(document.getElementById('keyboardSynthFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) syncAllKeyboardSynthFromMain();
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
        if (expanded) syncNoteVfdFromPeer('kbPatternNoteVisualizer');
    },
});
initCollapsibles(document.getElementById('keyboardXyTuningFieldset'), {
    onToggle(_fieldset, expanded) {
        if (expanded) syncNoteVfdFromPeer('kbXyNoteVisualizer');
    },
});

// Effects collapses on mobile only; always expanded on desktop.
const keyboardEffectsFieldset = document.getElementById('keyboardEffectsFieldset');
const keyboardEffectsMq = window.matchMedia('(max-width: 768px)');
function syncKeyboardEffectsCollapsible() {
    const ctrl = keyboardSynthCollapsibles.get(keyboardEffectsFieldset);
    if (!ctrl) return;
    ctrl.setExpanded(!keyboardEffectsMq.matches);
}
keyboardEffectsMq.addEventListener('change', syncKeyboardEffectsCollapsible);
syncKeyboardEffectsCollapsible();

// Synth opens expanded — sync mirrored knobs once layout is live
syncAllKeyboardSynthFromMain();

startIdleMarquee();
