// TR-808-style BD / SN / CH for Berlin D-lanes. Private oscillators + noise.
// Never use createOscSource({ oscIndex }) or state.noiseGain.

import { state } from './state.js?v=120';

const HAT_RATIOS = [205.3, 304.4, 369.6, 522.7, 540.4, 800];

/** Odd tanh, normalized so |y| ≤ 1. Local — do not import filter-drive.js. */
const KICK_TANH_CURVE = (() => {
    const n = 2048;
    const curve = new Float32Array(n);
    const d = 1.25;
    const norm = Math.tanh(d);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * d) / norm;
    }
    return curve;
})();

let noiseBuffer = null;
let noiseCtx = null;

function clamp01(n, fallback = 0.5) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(0, Math.min(1, v));
}

function getNoiseBuffer(ctx) {
    if (noiseBuffer && noiseCtx === ctx) return noiseBuffer;
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.8));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    noiseBuffer = buf;
    noiseCtx = ctx;
    return buf;
}

function safeStop(node, when) {
    if (!node) return;
    try { node.stop(when); } catch (_) { /* already stopped */ }
    try { node.disconnect(); } catch (_) { /* ignore */ }
}

function holdThen(param, t0) {
    let cur = 0.00001;
    try {
        cur = typeof param.getValueAtTime === 'function'
            ? param.getValueAtTime(t0)
            : Number(param.value);
    } catch (_) {
        cur = Number(param.value) || 0.00001;
    }
    if (!Number.isFinite(cur)) cur = 0.00001;
    cur = Math.max(0.00001, cur);
    try { param.cancelAndHoldAtTime(t0); } catch (_) {
        try { param.cancelScheduledValues(t0); } catch (_) { /* ignore */ }
    }
    // Pin a point at t0 so linearRamp cannot start at currentTime (lookahead swell).
    try { param.setValueAtTime(cur, t0); } catch (_) { /* hold already pinned t0 */ }
}

function snareHpHz(tone) {
    return 1400 + tone * 900;
}

function snareBpHz(tone) {
    return 1800 + tone * 2400;
}

function hatBpHz(tone) {
    return 7000 + tone * 4500;
}

function hatHpHz(tone) {
    return 5000 + tone * 4000;
}

function hatNoiseHpHz(tone) {
    return 7000 + tone * 4000;
}

function clickHpHz(tone) {
    return 800 + tone * 1600;
}

function clickDurSec(tone) {
    return 0.0015 + tone * 0.0015;
}

/** Soft retrigger for BD / CH: keep some body, new attack. */
function punchEnv(param, t0, peak, dur, attackSec = 0.0014) {
    const pk = Math.max(0.00001, peak);
    const attack = Math.max(0.0008, Math.min(0.004, attackSec));
    const end = t0 + Math.max(attack + 0.001, dur);
    holdThen(param, t0);
    try { param.linearRampToValueAtTime(pk, t0 + attack); } catch (_) { /* ignore */ }
    try { param.exponentialRampToValueAtTime(0.00001, end); } catch (_) { /* ignore */ }
    return end;
}

/** Snare VCA: linear attack, then exponential decay. */
function fireDrumEnv(param, t0, peak, dur, attackSec = 0.001) {
    const pk = Math.max(0.00001, peak);
    const attack = Math.max(0.0005, Math.min(0.04, attackSec));
    const end = t0 + Math.max(attack + 0.06, dur);
    holdThen(param, t0);
    param.linearRampToValueAtTime(pk, t0 + attack);
    param.exponentialRampToValueAtTime(Math.max(0.00001, pk * 0.01), end);
    param.linearRampToValueAtTime(0.00001, end + 0.08);
    return end;
}

/** Kit TUNE 0–1 → analog base Hz. Step semi/fine = ±3 st, no scale quantize. */
export function analogKitHz(model, tune, semi = 0, fine = 0) {
    const t = clamp01(tune, 0.5);
    let base;
    if (model === 'bass_drum') base = 40 * (2 ** t);
    else if (model === 'snare') base = 180 * (2 ** ((t - 0.5) * 0.5));
    else base = 200 * (2 ** t);
    const st = Math.max(-3, Math.min(3, (Number(semi) || 0) * (3 / 24)))
        + (Number(fine) || 0) / 100;
    return Math.max(20, base * (2 ** (st / 12)));
}

/** Digital: step Hz shifted ±12 st around TUNE 0.5. */
export function digitalDrumTuneHz(stepHz, tune) {
    const t = clamp01(tune, 0.5);
    return Math.max(20, (Number(stepHz) || 440) * (2 ** ((t - 0.5) * 24)));
}

function analogDecaySec(model, morphY, gateLen) {
    const y = clamp01(morphY, 0.5);
    if (model === 'bass_drum') return 0.08 + y * y * 1.15;
    if (model === 'snare') return 0.08 + y * 0.32;
    const g = Math.max(0.05, Math.min(1, Number(gateLen) || 0.9));
    if (model === 'open_hat') return (0.16 + y * 0.9) * (0.7 + 0.3 * g);
    return (0.018 + y * 0.16) * (0.45 + g);
}

function makeVoiceShell(ctx, panner) {
    const env = ctx.createGain();
    env.gain.value = 0;
    const amp = ctx.createGain();
    amp.gain.value = 1;
    env.connect(amp);
    amp.connect(panner);
    return { env, amp, nodes: [env, amp] };
}

function startOsc(osc, t0) {
    try { osc.start(t0); } catch (_) { /* ignore */ }
}

function makeLoopNoise(ctx) {
    const src = ctx.createBufferSource();
    src.buffer = getNoiseBuffer(ctx);
    src.loop = true;
    return src;
}

function buildBassDrum(ctx, { hz, patch, accent, t0, env, nodes, warm = false }) {
    const tone = clamp01(patch.morphX, 0.5);
    const clickAmt = 0.12 + tone * 0.45;
    const sweep = 2.2 + tone * 2.4;
    const body = ctx.createOscillator();
    body.type = 'sine';
    const shaper = ctx.createWaveShaper();
    shaper.curve = KICK_TANH_CURVE;
    shaper.oversample = '2x';
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0.9 + accent * 0.35;
    body.connect(shaper);
    shaper.connect(bodyGain);
    bodyGain.connect(env);

    const click = makeLoopNoise(ctx);
    const clickHp = ctx.createBiquadFilter();
    clickHp.type = 'highpass';
    clickHp.frequency.value = clickHpHz(tone);
    clickHp.Q.value = 0.7;
    const clickGain = ctx.createGain();
    clickGain.gain.value = 0;
    click.connect(clickHp);
    clickHp.connect(clickGain);
    clickGain.connect(env);

    nodes.push(body, shaper, bodyGain, click, clickHp, clickGain);
    const sweepEnd = t0 + 0.035 + tone * 0.05;
    const startHz = hz * sweep;
    const endHz = Math.max(20, hz);
    try {
        body.frequency.setValueAtTime(startHz, t0);
        body.frequency.exponentialRampToValueAtTime(endHz, sweepEnd);
    } catch (_) {
        body.frequency.value = hz;
    }
    const clickDur = clickDurSec(tone);
    if (!warm) punchEnv(clickGain.gain, t0, clickAmt * (0.6 + accent * 0.5), clickDur, 0.0008);
    startOsc(body, t0);
    startOsc(click, t0);
    return { body, bodyGain, shaper, click, clickHp, clickGain };
}

function buildSnare(ctx, { hz, patch, accent, t0, env, nodes }) {
    const tone = clamp01(patch.morphX, 0.5);
    const snappy = clamp01(patch.harmonics, 0.5);
    const noise = makeLoopNoise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = snareHpHz(tone);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = snareBpHz(tone);
    bp.Q.value = 0.7;
    const noiseMix = ctx.createGain();
    const bodyMix = ctx.createGain();
    noiseMix.gain.value = 0.22 + snappy * 0.5;
    bodyMix.gain.value = 0.5 - snappy * 0.28;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(hp);
    hp.connect(bp);
    bp.connect(noiseGain);
    noiseGain.connect(noiseMix);
    noiseMix.connect(env);
    const f1 = ctx.createOscillator();
    const f2 = ctx.createOscillator();
    f1.type = 'triangle';
    f2.type = 'sine';
    f1.frequency.value = hz;
    f2.frequency.value = hz * 1.72;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0;
    f1.connect(bodyGain);
    f2.connect(bodyGain);
    bodyGain.connect(bodyMix);
    bodyMix.connect(env);
    nodes.push(noise, hp, bp, noiseGain, noiseMix, f1, f2, bodyGain, bodyMix);
    const noisePeak = 0.77 + accent * 0.39;
    const bodyPeak = 0.81 + accent * 0.31;
    startOsc(noise, t0);
    startOsc(f1, t0);
    startOsc(f2, t0);
    return { noise, hp, bp, noiseGain, noiseMix, f1, f2, bodyGain, bodyMix, noisePeak, bodyPeak };
}

function buildClosedHat(ctx, { hz, patch, accent, t0, env, nodes }) {
    const tone = clamp01(patch.morphX, 0.5);
    const mix = ctx.createGain();
    mix.gain.value = 0.45 * (0.75 + accent * 0.4);
    const oscs = [];
    const scale = hz / 200;
    HAT_RATIOS.forEach((f) => {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = Math.max(40, Math.min(8000, f * scale));
        o.connect(mix);
        oscs.push(o);
        nodes.push(o);
        startOsc(o, t0);
    });
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hatBpHz(tone);
    bp.Q.value = 1.2;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = hatHpHz(tone);
    hp.Q.value = 0.8;
    mix.connect(bp);
    bp.connect(hp);
    hp.connect(env);

    const hatNoise = makeLoopNoise(ctx);
    const noiseHp = ctx.createBiquadFilter();
    noiseHp.type = 'highpass';
    noiseHp.frequency.value = hatNoiseHpHz(tone);
    noiseHp.Q.value = 0.7;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.22 * (0.75 + accent * 0.4);
    hatNoise.connect(noiseHp);
    noiseHp.connect(noiseGain);
    noiseGain.connect(env);
    startOsc(hatNoise, t0);

    nodes.push(mix, bp, hp, hatNoise, noiseHp, noiseGain);
    return { oscs, mix, bp, hp, hatNoise, noiseHp, noiseGain };
}

/**
 * One analog circuit. Oscillators start once; ratch restarts envelopes.
 * Connects env → amp → panner (caller supplies panner).
 */
export function createAnalog808Voice(ctx, {
    model,
    patch,
    accent = 0,
    gateLen = 0.9,
    hz,
    startTime,
    panner,
    hitDur = 0,
    warm = false,
} = {}) {
    if (!ctx || !panner) return null;
    const kind = model === 'bass_drum' || model === 'snare' || model === 'open_hat' ? model : 'hihat';
    const kit = {
        tune: clamp01(patch?.tune, 0.5),
        morphX: clamp01(patch?.morphX, 0.5),
        morphY: clamp01(patch?.morphY, 0.5),
        harmonics: clamp01(patch?.harmonics, 0.5),
        vol: Math.max(0, Math.min(1, Number(patch?.vol) || 0.8)),
    };
    const t0 = Math.max(ctx.currentTime, startTime ?? ctx.currentTime);
    const { env, amp, nodes } = makeVoiceShell(ctx, panner);
    amp.gain.value = Math.max(0.00001, kit.vol);
    const peak = 0.85 + accent * 0.4;
    const decaySec = analogDecaySec(kind, kit.morphY, gateLen);
    let parts;
    if (kind === 'bass_drum') {
        parts = buildBassDrum(ctx, { hz, patch: kit, accent, t0, env, nodes, warm });
        if (!warm) punchEnv(env.gain, t0, peak, decaySec);
        else env.gain.value = 0;
    } else if (kind === 'snare') {
        parts = buildSnare(ctx, { hz, patch: kit, accent, t0, env, nodes });
        if (!warm) {
            fireDrumEnv(parts.noiseGain.gain, t0, parts.noisePeak, decaySec * 0.9, 0.0008);
            fireDrumEnv(parts.bodyGain.gain, t0, parts.bodyPeak, decaySec * 0.5, 0.001);
            punchEnv(env.gain, t0, 1, decaySec, 0.001);
        } else env.gain.value = 0;
    } else {
        parts = buildClosedHat(ctx, { hz, patch: kit, accent, t0, env, nodes });
        if (!warm) punchEnv(env.gain, t0, peak, decaySec, 0.001);
        else env.gain.value = 0;
    }

    const voice = {
        isAnalog: true,
        isBerlinDrum: true,
        model: kind,
        env,
        amp,
        nodes,
        parts,
        hz,
        decaySec,
        dead: false,
        retrigger(when, next) {
            if (voice.dead) return;
            const t = Math.max(ctx.currentTime, when || 0);
            const p = next.patch || kit;
            const acc = next.accent ?? accent;
            const gLen = next.gateLen ?? gateLen;
            const nextHz = Math.max(20, next.hz || voice.hz);
            voice.hz = nextHz;
            kit.tune = clamp01(p.tune, kit.tune);
            kit.morphX = clamp01(p.morphX, kit.morphX);
            kit.morphY = clamp01(p.morphY, kit.morphY);
            kit.harmonics = clamp01(p.harmonics, kit.harmonics);
            kit.vol = Math.max(0, Math.min(1, Number(p.vol) || kit.vol));
            const dec = analogDecaySec(kind, kit.morphY, gLen);
            voice.decaySec = dec;
            const pk = 0.85 + acc * 0.4;
            try { amp.gain.setValueAtTime(Math.max(0.00001, kit.vol), t); } catch (_) { /* ignore */ }
            if (kind === 'bass_drum' && parts.body) {
                const tone = clamp01(p.morphX, 0.5);
                const sweep = 2.2 + tone * 2.4;
                const sweepEnd = t + 0.035 + tone * 0.05;
                try {
                    const startHz = Math.max(20, nextHz * sweep);
                    const endHz = Math.max(20, nextHz);
                    let curHz = endHz;
                    try {
                        curHz = typeof parts.body.frequency.getValueAtTime === 'function'
                            ? parts.body.frequency.getValueAtTime(t)
                            : Number(parts.body.frequency.value);
                    } catch (_) { /* ignore */ }
                    if (!Number.isFinite(curHz) || curHz < 20) curHz = endHz;
                    parts.body.frequency.cancelScheduledValues(t);
                    parts.body.frequency.setValueAtTime(curHz, t);
                    parts.body.frequency.exponentialRampToValueAtTime(startHz, t + 0.003);
                    parts.body.frequency.exponentialRampToValueAtTime(endHz, Math.max(sweepEnd, t + 0.004));
                } catch (_) { /* ignore */ }
                try {
                    if (parts.clickHp) parts.clickHp.frequency.setValueAtTime(clickHpHz(tone), t);
                } catch (_) { /* ignore */ }
                if (parts.clickGain) {
                    try {
                        punchEnv(parts.clickGain.gain, t, (0.12 + tone * 0.45) * (0.6 + acc * 0.5), clickDurSec(tone), 0.0008);
                    } catch (_) { /* ignore */ }
                }
                try { punchEnv(env.gain, t, pk, dec); } catch (_) { /* ignore */ }
            } else if (kind === 'snare') {
                try {
                    parts.f1.frequency.setValueAtTime(nextHz, t);
                    parts.f2.frequency.setValueAtTime(nextHz * 1.72, t);
                    const tone = clamp01(p.morphX, 0.5);
                    if (parts.hp) parts.hp.frequency.setValueAtTime(snareHpHz(tone), t);
                    parts.bp.frequency.setValueAtTime(snareBpHz(tone), t);
                } catch (_) { /* ignore */ }
                const snappy = clamp01(p.harmonics, 0.5);
                const noisePeak = 0.77 + acc * 0.39;
                const bodyPeak = 0.81 + acc * 0.31;
                parts.noisePeak = noisePeak;
                parts.bodyPeak = bodyPeak;
                try {
                    parts.noiseMix.gain.setValueAtTime(0.22 + snappy * 0.5, t);
                    parts.bodyMix.gain.setValueAtTime(0.5 - snappy * 0.28, t);
                } catch (_) { /* ignore */ }
                fireDrumEnv(parts.noiseGain.gain, t, noisePeak, dec * 0.9, 0.0008);
                fireDrumEnv(parts.bodyGain.gain, t, bodyPeak, dec * 0.5, 0.001);
                punchEnv(env.gain, t, 1, dec, 0.001);
            } else {
                const scale = nextHz / 200;
                try {
                    parts.oscs?.forEach((o, i) => {
                        o.frequency.setValueAtTime(Math.max(40, Math.min(8000, HAT_RATIOS[i] * scale)), t);
                    });
                    const tone = clamp01(p.morphX, 0.5);
                    parts.bp.frequency.setValueAtTime(hatBpHz(tone), t);
                    parts.hp.frequency.setValueAtTime(hatHpHz(tone), t);
                    if (parts.noiseHp) parts.noiseHp.frequency.setValueAtTime(hatNoiseHpHz(tone), t);
                } catch (_) { /* ignore */ }
                punchEnv(env.gain, t, pk, dec, 0.001);
            }
        },
        choke(when) {
            if (voice.dead) return;
            const t = Math.max(ctx.currentTime, when || 0);
            try {
                const cur = Math.max(0.00001, env.gain.value || 0.00001);
                let held = cur;
                try {
                    if (typeof env.gain.getValueAtTime === 'function') {
                        const v = env.gain.getValueAtTime(t);
                        if (Number.isFinite(v)) held = Math.max(0.00001, v);
                    }
                } catch (_) { /* ignore */ }
                if (typeof env.gain.cancelAndHoldAtTime === 'function') {
                    env.gain.cancelAndHoldAtTime(t);
                } else {
                    env.gain.cancelScheduledValues(t);
                    env.gain.setValueAtTime(held, t);
                }
                const fade = kind === 'bass_drum' ? 0.06 : 0.02;
                env.gain.exponentialRampToValueAtTime(0.00001, t + fade);
            } catch (_) { /* ignore */ }
        },
        applyKit(nextPatch, now) {
            if (voice.dead || !nextPatch) return;
            const t = now ?? ctx.currentTime;
            try {
                amp.gain.setValueAtTime(Math.max(0.00001, amp.gain.value || 0.00001), t);
                amp.gain.linearRampToValueAtTime(Math.max(0.00001, nextPatch.vol), t + 0.012);
            } catch (_) { /* ignore */ }
            const nextHz = analogKitHz(kind, nextPatch.tune, 0, 0);
            const prevKit = analogKitHz(kind, kit.tune, 0, 0);
            const scaled = voice.hz * (nextHz / Math.max(20, prevKit));
            voice.hz = scaled;
            kit.tune = clamp01(nextPatch.tune, kit.tune);
            kit.morphX = clamp01(nextPatch.morphX, kit.morphX);
            kit.morphY = clamp01(nextPatch.morphY, kit.morphY);
            kit.harmonics = clamp01(nextPatch.harmonics, kit.harmonics);
            kit.vol = Math.max(0, Math.min(1, Number(nextPatch.vol) || kit.vol));
            voice.decaySec = analogDecaySec(kind, kit.morphY, gateLen);
            try {
                if (kind === 'bass_drum' && parts.body) {
                    parts.body.frequency.setValueAtTime(scaled, t);
                    const tone = clamp01(nextPatch.morphX, 0.5);
                    if (parts.clickHp) parts.clickHp.frequency.setValueAtTime(clickHpHz(tone), t);
                } else if (kind === 'snare') {
                    parts.f1.frequency.setValueAtTime(scaled, t);
                    parts.f2.frequency.setValueAtTime(scaled * 1.72, t);
                    const tone = clamp01(nextPatch.morphX, 0.5);
                    const snappy = clamp01(nextPatch.harmonics, 0.5);
                    if (parts.hp) parts.hp.frequency.setValueAtTime(snareHpHz(tone), t);
                    parts.bp.frequency.setValueAtTime(snareBpHz(tone), t);
                    parts.noiseMix.gain.setValueAtTime(0.22 + snappy * 0.5, t);
                    parts.bodyMix.gain.setValueAtTime(0.5 - snappy * 0.28, t);
                } else {
                    const scale = scaled / 200;
                    parts.oscs?.forEach((o, i) => {
                        o.frequency.setValueAtTime(Math.max(40, Math.min(8000, HAT_RATIOS[i] * scale)), t);
                    });
                    const tone = clamp01(nextPatch.morphX, 0.5);
                    parts.bp.frequency.setValueAtTime(hatBpHz(tone), t);
                    parts.hp.frequency.setValueAtTime(hatHpHz(tone), t);
                    if (parts.noiseHp) parts.noiseHp.frequency.setValueAtTime(hatNoiseHpHz(tone), t);
                }
            } catch (_) { /* ignore */ }
        },
        dispose(when, { hard = false } = {}) {
            if (voice.dead) return;
            voice.dead = true;
            const t = Math.max(ctx.currentTime, when ?? ctx.currentTime);
            const cut = hard ? t : t + 0.02;
            try {
                env.gain.cancelScheduledValues(t);
                env.gain.setValueAtTime(0, t);
            } catch (_) { /* ignore */ }
            nodes.forEach((n) => {
                if (n && typeof n.stop === 'function') safeStop(n, cut);
                else {
                    try { n.disconnect(); } catch (_) { /* ignore */ }
                }
            });
            try { amp.disconnect(); } catch (_) { /* ignore */ }
        },
    };
    return voice;
}

export function applyAnalog808KitToLive(lane) {
    const i = lane | 0;
    const patch = state.berlinDrum?.[i];
    if (!patch || !state.audioContext) return;
    const now = state.audioContext.currentTime;
    state.berlinDrumVoices?.forEach((voice) => {
        if (voice?.lane !== i || !voice.isAnalog || typeof voice.applyKit !== 'function') return;
        voice.applyKit(patch, now);
    });
}
