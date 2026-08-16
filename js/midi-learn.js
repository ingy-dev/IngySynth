// Stage MIDI learn: pick a visible widget, store the canonical range/button.
// Pointer capture runs in mapping mode so knobs/strips do not scrub while learning.

import { state } from './state.js?v=113';

const IGNORE_IDS = new Set([
    'midiMapping',
    'midiLogoToggle',
    'midiInputSelect',
    'midiOutputSelect',
    'midiOutputChannel',
    'midiBaseNote',
    'bendRange',
]);

const UNMAPPABLE_IDS = new Set([
    'keyboardVisibilityToggle',
]);

const KB_BUTTON_TO_MAIN = {
    kbDelayToggle: 'delayToggle',
    kbReverbToggle: 'reverbToggle',
    kbCompToggle: 'compToggle',
    kbRingModToggle: 'ringModToggle',
    kbDistortionToggle: 'distortionToggle',
    kbBitcrushToggle: 'bitcrusherToggle',
    kbChorusI: 'chorusI',
    kbChorusII: 'chorusII',
    kbFilterEnvToggle: 'filterEnvToggle',
    kbNoiseToggle: 'noiseToggle',
    kbUnisonToggle: 'unisonToggle',
    kbPhaseResetToggle: 'phaseResetToggle',
    kbLfoToggle: 'lfoToggle',
    kbLfoRetrigger: 'lfoRetrigger',
    kbLfoSync: 'lfoSyncToggle',
};

const INGY_PARAM_TO_MAIN = {
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
};

/** @type {((canvas: HTMLCanvasElement, e: PointerEvent) => object | null) | null} */
let adsrResolver = null;

export function registerAdsrMappingResolver(fn) {
    adsrResolver = typeof fn === 'function' ? fn : null;
}

export function mappingHostFor(el) {
    if (!el || !(el instanceof Element)) return null;
    return el.closest?.(
        '.synth-knob, .ingy6-fader, .keyboard-pitch-bend, .keyboard-lfo-strip, .control, .kb-step-btn, .pushable, .keyboard-step, .berlin-step, canvas'
    ) || el;
}

export function stageButtonHostsForKey(key) {
    const hosts = [];
    if (!key) return hosts;
    Object.entries(KB_BUTTON_TO_MAIN).forEach(([kbId, mainId]) => {
        if (mainId !== key) return;
        const el = document.getElementById(kbId);
        if (el) hosts.push(el);
    });
    return hosts;
}

export function midiControlId(el) {
    if (!el || !(el instanceof Element)) return '';
    if (el.dataset?.step !== undefined) {
        if (el.tagName === 'INPUT' && el.type === 'range') {
            return el.classList.contains('step-fine')
                ? `step-fine-${el.dataset.step}`
                : `step-slider-${el.dataset.step}`;
        }
        if (el.tagName === 'BUTTON') {
            if (el.classList.contains('step-slide')) return `step-slide-${el.dataset.step}`;
            if (el.classList.contains('step-accent')) return `step-accent-${el.dataset.step}`;
            if (el.classList.contains('step-ratch')) return `step-ratch-${el.dataset.step}`;
            return `step-toggle-${el.dataset.step}`;
        }
    }
    if (el.dataset?.osc !== undefined) {
        if (el.classList.contains('osc-tune')) return `osc-tune-${el.dataset.osc}`;
        if (el.classList.contains('osc-vol')) return `osc-vol-${el.dataset.osc}`;
        if (el.classList.contains('osc-toggle')) return `osc-toggle-${el.dataset.osc}`;
        if (el.classList.contains('osc-type')) return `osc-type-${el.dataset.osc}`;
        return `osc-${el.dataset.osc}`;
    }
    if (el.id) return el.id;
    const fader = el.closest?.('.ingy6-fader');
    if (fader?.dataset.param) return `ingy6-${fader.dataset.param}`;
    return '';
}

export function clearMappingHighlight() {
    const vis = state.currentMappingHost || state.currentMappingControl;
    vis?.classList.remove('midi-highlight', 'midi-unmappable');
    state.currentMappingControl?.classList.remove('midi-highlight', 'midi-unmappable');
}

function flashUnmappable(host) {
    if (!host) return;
    clearMappingHighlight();
    state.currentMappingControl = null;
    state.currentMappingHost = null;
    host.classList.add('midi-unmappable');
    setTimeout(() => host.classList.remove('midi-unmappable'), 900);
}

export function selectMappingTarget(canonical, host) {
    if (!canonical) return false;
    if (canonical.tagName === 'SELECT' || UNMAPPABLE_IDS.has(canonical.id)) {
        flashUnmappable(host || mappingHostFor(canonical));
        return true;
    }
    clearMappingHighlight();
    const vis = host || mappingHostFor(canonical) || canonical;
    state.currentMappingControl = canonical;
    state.currentMappingHost = vis;
    vis.classList.add('midi-highlight');
    console.log(`Ready to map MIDI control to ${midiControlId(canonical)}`);
    return true;
}

/**
 * @returns {boolean} true if the event was consumed (learn or unmappable)
 */
export function beginMidiLearn(event, canonical, host) {
    if (!state.midiMappingMode) return false;
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (!canonical || canonical.tagName === 'SELECT' || UNMAPPABLE_IDS.has(canonical.id)) {
        flashUnmappable(host || mappingHostFor(canonical));
        return true;
    }
    return selectMappingTarget(canonical, host);
}

function isSelectWidget(el) {
    return !!el?.closest?.('select');
}

function resolveFromDial(dial) {
    const host = dial.closest('.synth-knob') || dial;
    if (dial.id === 'kbLfoRateKnob' || host.dataset?.param === 'lfoSpeed') {
        const id = state.lfoSync ? 'lfoSyncDivision' : 'lfoSpeed';
        return { canonical: document.getElementById(id), host };
    }
    const param = host.dataset?.param;
    if (param === 'division') {
        return { unmappable: true, host };
    }
    if (param && param !== 'write-fine') {
        const el = document.getElementById(param);
        if (el?.tagName === 'SELECT') return { unmappable: true, host };
        if (el) return { canonical: el, host };
    }
    if (param === 'write-fine') {
        const proxy = document.getElementById('kbWriteFineProxy');
        if (proxy) return { canonical: proxy, host };
    }
    const oscTune = dial.id.match(/^kbOsc(\d)TuneKnob$/);
    if (oscTune) {
        const n = String(Number(oscTune[1]) - 1);
        return { canonical: document.querySelector(`.osc-tune[data-osc="${n}"]`), host };
    }
    const oscVol = dial.id.match(/^kbOsc(\d)VolKnob$/);
    if (oscVol) {
        const n = String(Number(oscVol[1]) - 1);
        return { canonical: document.querySelector(`.osc-vol[data-osc="${n}"]`), host };
    }
    const stepTune = dial.id.match(/^kbStepTuneDial(\d+)$/);
    if (stepTune) {
        return {
            canonical: document.querySelector(`.step-tune[data-step="${stepTune[1]}"]`),
            host,
        };
    }
    const mi = {
        miCutoffKnob: 'cutoff',
        miResonanceKnob: 'resonance',
        miHighPassKnob: 'highPass',
        miFilterEnvAmountKnob: 'filterEnvAmount',
        miFilterAttackKnob: 'filterAttack',
        miFilterDecayKnob: 'filterDecay',
        miFilterSustainKnob: 'filterSustain',
        miFilterReleaseKnob: 'filterRelease',
        miVolumeKnob: 'volume',
        miAttackKnob: 'attack',
        miDecayKnob: 'decay',
        miSustainKnob: 'sustain',
        miReleaseKnob: 'release',
        miDelayAmountKnob: 'delayAmount',
        miReverbSizeKnob: 'reverbSize',
        miReverbDecayKnob: 'reverbDecay',
        miReverbDampKnob: 'reverbDamp',
        miReverbAmountKnob: 'reverbAmount',
    };
    if (mi[dial.id]) {
        return { canonical: document.getElementById(mi[dial.id]), host };
    }
    const berlinTune = dial.closest('.berlin-step')?.querySelector('.berlin-step-tune');
    if (berlinTune) return { canonical: berlinTune, host: dial.closest('.berlin-step') || host };
    return null;
}

function resolveMappingHit(target, event) {
    if (!(target instanceof Element)) return { ignore: true };
    if (target.closest('#midiMapping, #midiLogoToggle, .midi-device-panels')) {
        return { ignore: true };
    }
    const ignoreEl = target.closest('[id]');
    if (ignoreEl && IGNORE_IDS.has(ignoreEl.id)) return { ignore: true };

    if (target.closest('.piano-key, .chromatic-keyboard, .computer-keyboard-board, .ckb-key')) {
        return { ignore: true };
    }

    if (isSelectWidget(target)) {
        const sel = target.closest('select');
        return { unmappable: true, host: sel };
    }

    if (target.closest('#xyPad, #xyPointer, .xy-pad-wrapper, .xy-pad-container')) {
        return { unmappable: true, host: document.getElementById('xyPad') || target };
    }

    const canvas = target.closest('canvas');
    if (canvas && adsrResolver) {
        const hit = adsrResolver(canvas, event);
        if (hit) return hit;
        if (canvas.id === 'kbAdsrVisualizer' || canvas.id === 'kbFilterAdsrVisualizer'
            || canvas.id === 'adsrVisualizer' || canvas.id === 'filterAdsrVisualizer') {
            return { unmappable: true, host: canvas };
        }
    }

    if (target.closest('#keyboardPitchBend, .keyboard-pitch-bend')) {
        return { unmappable: true, host: document.getElementById('keyboardPitchBend') || target };
    }
    if (target.closest('#keyboardLfoStrip, .keyboard-lfo-strip')) {
        return { unmappable: true, host: document.getElementById('keyboardLfoStrip') || target };
    }

    const fader = target.closest('.ingy6-fader');
    if (fader) {
        const param = fader.dataset.param;
        const mainId = INGY_PARAM_TO_MAIN[param];
        const main = mainId ? document.getElementById(mainId) : null;
        const input = fader.querySelector('.ingy6-fader-input');
        return { canonical: main || input, host: fader };
    }

    const dial = target.closest('.synth-knob-dial');
    if (dial) {
        const resolved = resolveFromDial(dial);
        if (resolved) return resolved;
    }

    const kbFine = target.closest('.kb-step-fine');
    if (kbFine) {
        const step = kbFine.dataset.step;
        return {
            canonical: document.querySelector(`.step-fine[data-step="${step}"]`),
            host: kbFine.closest('.synth-knob') || kbFine,
        };
    }

    const berlinFine = target.closest('.berlin-step-fine');
    if (berlinFine) {
        return { canonical: berlinFine, host: berlinFine.closest('.berlin-step') || berlinFine };
    }

    const stepBtn = target.closest('.kb-step-accent, .kb-step-slide, .kb-step-toggle, .kb-step-ratch');
    if (stepBtn) {
        const step = stepBtn.dataset.step;
        let canonical = null;
        if (stepBtn.classList.contains('kb-step-accent')) {
            canonical = document.querySelector(`.step-accent[data-step="${step}"]`);
        } else if (stepBtn.classList.contains('kb-step-slide')) {
            canonical = document.querySelector(`.step-slide[data-step="${step}"]`);
        } else if (stepBtn.classList.contains('kb-step-ratch')) {
            canonical = document.querySelector(`.step-ratch[data-step="${step}"]`);
        } else {
            canonical = document.querySelector(`.step-toggle[data-step="${step}"]`);
        }
        return { canonical, host: stepBtn };
    }

    const oscToggle = target.closest('.kb-osc-toggle');
    if (oscToggle) {
        return {
            canonical: document.querySelector(`.osc-toggle[data-osc="${oscToggle.dataset.osc}"]`),
            host: oscToggle,
        };
    }

    const chorus = target.closest('.ingy6-chorus-btn');
    if (chorus) {
        const key = chorus.dataset.chorus;
        if (key === 'i') {
            return { canonical: document.getElementById('chorusI'), host: chorus };
        }
        if (key === 'ii') {
            return { canonical: document.getElementById('chorusII'), host: chorus };
        }
        return { unmappable: true, host: chorus };
    }

    const btn = target.closest('button');
    if (btn) {
        if (UNMAPPABLE_IDS.has(btn.id)) return { unmappable: true, host: btn };
        if (KB_BUTTON_TO_MAIN[btn.id]) {
            const main = document.getElementById(KB_BUTTON_TO_MAIN[btn.id]);
            return { canonical: main || btn, host: btn };
        }
        if (btn.id) return { canonical: btn, host: btn };
        return { unmappable: true, host: btn };
    }

    const range = target.closest('input[type="range"]');
    if (range) {
        const host = mappingHostFor(range) || range;
        if (range.closest('#synthContainer')) return { ignore: true };
        return { canonical: range, host };
    }

    return { ignore: true };
}

function onMappingPointerDownCapture(e) {
    if (!state.midiMappingMode) return;
    if (e.button != null && e.button !== 0) return;
    const hit = resolveMappingHit(e.target, e);
    if (!hit || hit.ignore) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    if (hit.unmappable) {
        flashUnmappable(hit.host);
        return;
    }
    if (hit.canonical) selectMappingTarget(hit.canonical, hit.host);
}

export function setupMappingPointerCapture(enable) {
    document.removeEventListener('pointerdown', onMappingPointerDownCapture, true);
    if (enable) {
        document.addEventListener('pointerdown', onMappingPointerDownCapture, true);
    }
}
