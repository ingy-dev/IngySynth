// Entry point: import order mirrors the original single-file script order.
import { initAudio } from './audio-engine.js?v=227';
import { initPerfHud } from './perf-hud.js?v=39';
import { startIdleMarquee } from './sequencer.js?v=436';
import './controls.js?v=348';
import './midi.js?v=145';
import './visualizers.js?v=132';
import { syncNoteVfdFromPeer } from './visualizers.js?v=132';
import { refreshXYPad } from './xy-pad.js?v=88';
import { initKeyboard } from './keyboard.js?v=257';
import { initComputerKeyboard } from './computer-keyboard.js?v=257';
import { initKeyboardKnobs, initDoubleClickReset } from './knobs.js?v=167';
import { initTouchReadout } from './touch-readout.js?v=27';
import { initPitchBendStrip } from './pitch-bend.js?v=123';
import { initLfoStrip, applyLfoStartupDefaults, updateLfoSmoothing } from './lfo-strip.js?v=52';
import { initLfoRateKnob, initLfoRateControls, onLfoRateApplied } from './lfo-rate.js?v=49';
import { initKeyboardSteps } from './keyboard-steps.js?v=158';
import { initPatternShift } from './pattern-shift.js?v=153';
import { initKeyboardOscillators, syncKeyboardOscillatorsFromMain } from './keyboard-oscillators.js?v=124';
import { initKeyboardEffects, syncKeyboardEffectsFromMain } from './keyboard-effects.js?v=130';
import { initKeyboardNoise, syncKeyboardNoiseFromMain } from './keyboard-noise.js?v=85';
import { initKeyboardFilterEnv, syncKeyboardFilterEnvFromMain } from './keyboard-filter-env.js?v=115';
import { initKeyboardAcidStrip } from './keyboard-acid-strip.js?v=28';
import { initKeyboardLfo, syncKeyboardLfoFromMain } from './keyboard-lfo.js?v=16';
import { initCollapsibles, setCollapsibleExpanded } from './collapsible.js?v=75';
import { initViewMode } from './view-mode.js?v=13';
import { initAutomation } from './automation.js?v=81';
import { initParamStatus } from './param-status.js?v=16';
import { initStepTuneRange } from './step-tune-range.js?v=42';
import { initPatternBank } from './pattern-bank.js?v=31';
import { initBerlin } from './berlin.js?v=102';
import { initDrumDock } from './drum-dock.js?v=33';
import { initMixer, syncMixerFaderCaps } from './mixer.js?v=45';
import './params.js?v=24';
import { initSiteBar } from './site-bar.js?v=25';
import { initArrangeView } from './arrange-view.js?v=6';
import { initArrangeRoll } from './arrange-roll.js?v=5';
import { initSongConductor } from './song-conductor.js?v=4';
import { initSongRecord } from './song-record.js?v=2';
import { initSaveBoot } from './save-capture.js?v=1';

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
initSiteBar();
initArrangeView();
initSongConductor();
initSongRecord();
initArrangeRoll();
initSaveBoot();

