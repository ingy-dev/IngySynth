// Entry point: import order mirrors the original single-file script order.
import { initAudio } from './audio-engine.js?v=208';
import { initPerfHud } from './perf-hud.js?v=29';
import { startIdleMarquee } from './sequencer.js?v=416';
import './controls.js?v=329';
import './midi.js?v=126';
import './visualizers.js?v=121';
import { syncNoteVfdFromPeer } from './visualizers.js?v=121';
import { refreshXYPad } from './xy-pad.js?v=79';
import { initKeyboard } from './keyboard.js?v=238';
import { initComputerKeyboard } from './computer-keyboard.js?v=217';
import { initKeyboardKnobs, initDoubleClickReset } from './knobs.js?v=147';
import { initTouchReadout } from './touch-readout.js?v=8';
import { initPitchBendStrip } from './pitch-bend.js?v=106';
import { initLfoStrip, applyLfoStartupDefaults, updateLfoSmoothing } from './lfo-strip.js?v=35';
import { initLfoRateKnob, initLfoRateControls, onLfoRateApplied } from './lfo-rate.js?v=32';
import { initKeyboardSteps } from './keyboard-steps.js?v=140';
import { initPatternShift } from './pattern-shift.js?v=135';
import { initKeyboardOscillators, syncKeyboardOscillatorsFromMain } from './keyboard-oscillators.js?v=106';
import { initKeyboardEffects, syncKeyboardEffectsFromMain } from './keyboard-effects.js?v=112';
import { initKeyboardNoise, syncKeyboardNoiseFromMain } from './keyboard-noise.js?v=76';
import { initKeyboardFilterEnv, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=98';
import { initKeyboardAcidStrip } from './keyboard-acid-strip.js?v=18';
import { initKeyboardLfo, syncKeyboardLfoFromMain } from './keyboard-lfo.js?v=7';
import { initCollapsibles, setCollapsibleExpanded } from './collapsible.js?v=75';
import { initViewMode } from './view-mode.js?v=4';
import { initAutomation } from './automation.js?v=62';
import { initParamStatus } from './param-status.js?v=7';
import { initStepTuneRange } from './step-tune-range.js?v=24';
import { initPatternBank } from './pattern-bank.js?v=16';
import { initBerlin } from './berlin.js?v=83';
import { initDrumDock } from './drum-dock.js?v=15';
import { initMixer, syncMixerFaderCaps } from './mixer.js?v=27';
import './params.js?v=15';

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
initTouchReadout();
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

// Mobile layout and coarse-pointer devices start with the pad open so the
// touch surface is visible. A manual toggle sticks for the rest of the session.
const XY_TOUCH_MQ = '(max-width: 768px), (hover: none) and (pointer: coarse)';

function syncXyPadForTouchView() {
    const fieldset = document.getElementById('keyboardXyFieldset');
    if (!fieldset || fieldset.dataset.xyUserToggled === 'true') return;
    if (document.body.classList.contains('write-mode-on')) return;
    const touchView = window.matchMedia(XY_TOUCH_MQ).matches;
    const expanded = !fieldset.classList.contains('collapsed');
    if (touchView && !expanded) {
        setCollapsibleExpanded(fieldset, true);
        fieldset.dataset.xyAutoOpened = 'true';
        requestAnimationFrame(() => refreshXYPad());
    } else if (!touchView && fieldset.dataset.xyAutoOpened === 'true' && expanded) {
        setCollapsibleExpanded(fieldset, false);
        delete fieldset.dataset.xyAutoOpened;
    }
}

initCollapsibles(document.getElementById('keyboardXyFieldset'), {
    onToggle(fieldset, expanded) {
        fieldset.dataset.xyUserToggled = 'true';
        delete fieldset.dataset.xyAutoOpened;
        if (expanded) {
            // Allow layout to settle before redrawing the canvas
            requestAnimationFrame(() => refreshXYPad());
        }
    },
});
syncXyPadForTouchView();
{
    const xyTouchMq = window.matchMedia(XY_TOUCH_MQ);
    if (typeof xyTouchMq.addEventListener === 'function') {
        xyTouchMq.addEventListener('change', syncXyPadForTouchView);
    } else {
        xyTouchMq.addListener(syncXyPadForTouchView);
    }
}

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

initViewMode({
    onTabShow: {
        keyboardSynthFieldset: () => syncAllKeyboardSynthFromMain(),
        keyboardEffectsFieldset: () => syncKeyboardEffectsFromMain(),
        keyboardMixerFieldset: () => requestAnimationFrame(() => syncMixerFaderCaps()),
        keyboardStepsFieldset: () => document.dispatchEvent(new CustomEvent('ingysynth-kb-steps-sync')),
        keyboardTuningFieldset: () => syncNoteVfdFromPeer('kbPatternNoteVisualizer', 'kbXyNoteVisualizer'),
    },
});

// Synth / Effects open expanded — sync mirrored knobs once layout is live
syncAllKeyboardSynthFromMain();

startIdleMarquee();
initPerfHud();

