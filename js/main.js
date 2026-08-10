// Entry point: import order mirrors the original single-file script order.
import { initAudio } from './audio-engine.js?v=117';
import { startIdleMarquee } from './sequencer.js?v=163';
import './controls.js?v=160';
import './midi.js?v=79';
import './visualizers.js?v=90';
import { syncNoteVfdFromPeer } from './visualizers.js?v=90';
import './mobile.js?v=73';
import { refreshXYPad } from './xy-pad.js?v=75';
import { initKeyboard } from './keyboard.js?v=153';
import { initComputerKeyboard } from './computer-keyboard.js?v=150';
import { initKeyboardKnobs, initDoubleClickReset } from './knobs.js?v=97';
import { initPitchBendStrip } from './pitch-bend.js?v=76';
import { initLfoStrip, applyLfoStartupDefaults, updateLfoSmoothing } from './lfo-strip.js?v=15';
import { initLfoRateKnob, initLfoRateControls, onLfoRateApplied } from './lfo-rate.js?v=7';
import { initKeyboardSteps } from './keyboard-steps.js?v=92';
import { initPatternShift } from './pattern-shift.js?v=93';
import { initKeyboardOscillators, syncKeyboardOscillatorsFromMain } from './keyboard-oscillators.js?v=82';
import { initKeyboardEffects, syncKeyboardEffectsFromMain } from './keyboard-effects.js?v=87';
import { initKeyboardNoise, syncKeyboardNoiseFromMain } from './keyboard-noise.js?v=73';
import { initKeyboardFilterEnv, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=79';
import { initKeyboardAcidStrip } from './keyboard-acid-strip.js?v=6';
import { initKeyboardLfo, syncKeyboardLfoFromMain } from './keyboard-lfo.js?v=4';
import { initCollapsibles } from './collapsible.js?v=74';
import { initAutomation } from './automation.js?v=33';
import { initParamStatus } from './param-status.js?v=4';
import { initStepTuneRange } from './step-tune-range.js?v=2';
import { initPatternBank } from './pattern-bank.js?v=7';
import { initBerlin } from './berlin.js?v=27';

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
initCollapsibles(document.getElementById('keyboardControlsFieldset'));
initCollapsibles(document.getElementById('midiFieldset'));

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

startIdleMarquee();
