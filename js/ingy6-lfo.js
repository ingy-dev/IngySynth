// Ingy 6 panel LFO (Juno-60 LFO section): one triangle LFO for every Ingy 6 voice.
// In Ingy 6 mode it replaces the global LFO's osc pitch destinations; the global
// LFO's CUT / RES / HP / RING destinations stay connected.
//
//   triangle osc -> delay gain -> DCO gain -> each poly osc .detune (cents)
//                              -> VCF gain -> shared filter .detune (cents)
//
// Depths: DCO LFO full = +-300 cents, VCF LFO full = +-3 octaves. DELAY full waits
// 2.786 s and then fades in over 1 s (a Juno-60 measurement); both scale with the
// fader. Bare Metal runs the same model in C++ (core/voice/VoicePool.cpp).

import { state } from './state.js?v=120';
import { get, getNumber, subscribe } from './params.js?v=44';
import { LFO_SYNC_DIVISIONS, getTempoBpm, syncBeatsToHz } from './lfo-rate.js?v=69';

const DCO_FULL_CENTS = 300;
const VCF_FULL_CENTS = 3600;
const DELAY_HOLD_SEC = 2.786;
const DELAY_FADE_SEC = 1.0;
const RAMP = 0.02;

let subscribed = false;

export function ingy6LfoRateHz() {
    if (get('ingy6LfoSync')) {
        const idx = Math.max(0, Math.min(LFO_SYNC_DIVISIONS.length - 1, Math.round(getNumber('ingy6LfoSyncDivision', 6))));
        return syncBeatsToHz(getTempoBpm(), LFO_SYNC_DIVISIONS[idx].beats);
    }
    return Math.max(0.3, Math.min(20, getNumber('ingy6LfoRate', 3)));
}

function rampTo(param, value, now) {
    if (!param) return;
    try {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.setTargetAtTime(value, now, RAMP);
    } catch (_) { /* ignore */ }
}

/** Rate and depths from params. Depths are 0 outside Ingy 6 so nothing else moves. */
export function applyIngy6Lfo() {
    const ctx = state.audioContext;
    if (!ctx || !state.ingy6Lfo) return;
    const now = ctx.currentTime;
    const on = !!state.keyboardPoly;
    rampTo(state.ingy6Lfo.frequency, ingy6LfoRateHz(), now);
    rampTo(state.ingy6DcoGain.gain, on ? getNumber('ingy6DcoLfo', 0) * DCO_FULL_CENTS : 0, now);
    rampTo(state.ingy6VcfGain.gain, on ? getNumber('ingy6VcfLfo', 0) * VCF_FULL_CENTS : 0, now);
}

/** Juno-60 AUTO trigger: a key pressed while no key is down restarts the delay. */
export function restartIngy6LfoDelay(now) {
    const gain = state.ingy6LfoDelayGain?.gain;
    if (!gain) return;
    const t = Number.isFinite(now) ? now : state.audioContext.currentTime;
    const amount = Math.max(0, Math.min(1, getNumber('ingy6LfoDelay', 0)));
    try {
        gain.cancelScheduledValues(t);
        if (amount <= 0) {
            gain.setValueAtTime(1, t);
            return;
        }
        gain.setValueAtTime(0, t);
        gain.setValueAtTime(0, t + DELAY_HOLD_SEC * amount);
        gain.linearRampToValueAtTime(1, t + (DELAY_HOLD_SEC + DELAY_FADE_SEC) * amount);
    } catch (_) { /* ignore */ }
}

export function buildIngy6Lfo(ctx) {
    if (!ctx || state.ingy6Lfo) return;
    state.ingy6Lfo = ctx.createOscillator();
    state.ingy6Lfo.type = 'triangle';
    state.ingy6Lfo.frequency.value = ingy6LfoRateHz();
    state.ingy6LfoDelayGain = ctx.createGain();
    state.ingy6LfoDelayGain.gain.value = 1;
    // GainNode defaults to 1: start the depths at 0.
    state.ingy6DcoGain = ctx.createGain();
    state.ingy6DcoGain.gain.value = 0;
    state.ingy6VcfGain = ctx.createGain();
    state.ingy6VcfGain.gain.value = 0;
    state.ingy6Lfo.connect(state.ingy6LfoDelayGain);
    state.ingy6LfoDelayGain.connect(state.ingy6DcoGain);
    state.ingy6LfoDelayGain.connect(state.ingy6VcfGain);
    if (state.filter?.detune) state.ingy6VcfGain.connect(state.filter.detune);
    state.ingy6Lfo.start();
    applyIngy6Lfo();
    if (!subscribed) {
        subscribed = true;
        ['ingy6LfoRate', 'ingy6LfoSync', 'ingy6LfoSyncDivision', 'ingy6DcoLfo', 'ingy6VcfLfo', 'tempo']
            .forEach((key) => subscribe(key, () => applyIngy6Lfo()));
    }
}
