// Engine param metadata (CP9). Keys match canonical IDs (`cutoff`, `osc-tune-0`, …).
// Not in this catalog: kb* mirrors, #kbWriteFineProxy, Berlin lanes, pitchBend,
// latch, speech, computer-keys, analog/digital engine buttons.

const OSC_WAVES = ['sawtooth', 'square', 'sine', 'triangle'];
const NOTE_DIVISIONS = ['2', '4', '8', '16'];
// Step divisions are steps per bar. Triplets: 3 = 1/2T, 6 = 1/4T, 12 = 1/8T, 24 = 1/16T, 48 = 1/32T.
const STEP_DIVISIONS = ['2', '3', '4', '6', '8', '12', '16', '24', '48'];
const OSC4_MODELS = [
    'va', 'va_vcf', 'waveshaper', 'pd', 'fm', 'fm6',
    'wavetable', 'terrain', 'additive', 'grain',
    'speech', 'chord', 'string_machine', 'chiptune',
    'swarm', 'noise', 'particle', 'string', 'modal',
    'bass_drum', 'snare', 'hihat',
];
const STEP_SLOTS = 32;

function range(min, max, def, step = 1, xy = null) {
    const spec = { type: 'range', min, max, step, default: def };
    if (xy) {
        spec.xyName = xy.name;
        spec.xyGroup = xy.group;
    }
    return spec;
}

function select(options, def) {
    return { type: 'select', options: options.slice(), default: def };
}

function button(def = false) {
    return { type: 'button', default: !!def };
}

/** @type {Record<string, object>} */
export const PARAMS = {
    tempo: range(20, 240, 120, 1, { name: 'Tempo', group: 'Sequencer' }),
    division: select(STEP_DIVISIONS, '8'),
    stepCount: range(1, 32, 8, 1),
    slideTime: range(10, 500, 60, 1, { name: 'Slide Time', group: 'Sequencer' }),
    accentAmount: range(0, 100, 100, 1, { name: 'Accent Amount', group: 'Sequencer' }),
    gateLength: range(5, 100, 90, 1, { name: 'Gate Length', group: 'Sequencer' }),
    swing: range(50, 75, 50, 1, { name: 'Swing', group: 'Sequencer' }),
    scaleToggle: button(false),
    scaleSelect: select([], ''),

    masterTune: range(-36, 36, 0, 1, { name: 'Master Tune', group: 'Tuning' }),
    octaveSwitch: range(-2, 2, 0, 1, { name: 'Octave Switch', group: 'Tuning' }),
    semitoneSwitch: range(-2, 2, 0, 1, { name: 'Semitone Switch', group: 'Tuning' }),
    semitoneAmount: select(
        ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'],
        '7',
    ),

    osc4Harmonics: range(0, 1, 0.5, 0.01, { name: 'Harmonics', group: 'Oscillator 1' }),
    osc4MorphX: range(0, 1, 0.5, 0.01, { name: 'Timbre', group: 'Oscillator 1' }),
    osc4MorphY: range(0, 1, 0.5, 0.01, { name: 'Morph', group: 'Oscillator 1' }),
    osc4Model: select(OSC4_MODELS, 'wavetable'),
    osc4Bank: select(['-1', '0', '1', '2', '3'], '-1'),
    // FREQUENCY knob: 8 octaves (the module's default range) around the played note.
    osc4Frequency: range(-48, 48, 0, 0.1, { name: 'Frequency', group: 'Oscillator 1' }),
    // Plaits internal decay envelope (voice.cc DecayEnvelope), fired on every note.
    // The amounts are the FM / TIMBRE / MORPH attenuverters; 0 leaves the engine untouched.
    osc4EnvDecay: range(0, 1, 0.5, 0.01, { name: 'Env Decay', group: 'Oscillator 1' }),
    osc4EnvPitch: range(-1, 1, 0, 0.01, { name: 'Env Pitch', group: 'Oscillator 1' }),
    osc4EnvTimbre: range(-1, 1, 0, 0.01, { name: 'Env Timbre', group: 'Oscillator 1' }),
    osc4EnvMorph: range(-1, 1, 0, 0.01, { name: 'Env Morph', group: 'Oscillator 1' }),

    unisonToggle: button(false),
    unisonVoices: select(['3'], '3'),
    unisonDetune: range(0, 50, 10, 1, { name: 'Unison Detune', group: 'Unison' }),
    phaseResetToggle: button(true),
    ringModToggle: button(false),
    ringMod: range(0, 1, 0, 0.01, { name: 'Ring Mod', group: 'Effects' }),
    noiseType: select(['white', 'pink', 'brown'], 'white'),
    noiseToggle: button(false),
    noiseVol: range(0, 1, 0, 0.01, { name: 'Noise Vol', group: 'Noise' }),

    cutoff: range(20, 10000, 1000, 1, { name: 'Cutoff', group: 'Filter' }),
    resonance: range(0, 20, 1, 1, { name: 'Resonance', group: 'Filter' }),
    highPass: range(20, 2000, 20, 1, { name: 'High Pass', group: 'Filter' }),
    filterEnvAmount: range(0, 100, 100, 1, { name: 'Env Amount', group: 'Filter' }),
    filterEnvToggle: button(false),
    filterAttack: range(0, 2, 0.1, 0.01, { name: 'Filter Attack', group: 'Filter' }),
    filterDecay: range(0, 2, 0.3, 0.01, { name: 'Filter Decay', group: 'Filter' }),
    filterSustain: range(0, 1, 0.5, 0.01, { name: 'Filter Sustain', group: 'Filter' }),
    filterRelease: range(0, 5, 0.5, 0.01, { name: 'Filter Release', group: 'Filter' }),

    attack: range(0, 2, 0, 0.01, { name: 'Attack', group: 'Amp' }),
    decay: range(0, 2, 0.5, 0.01, { name: 'Decay', group: 'Amp' }),
    sustain: range(0, 1, 0.5, 0.01, { name: 'Sustain', group: 'Amp' }),
    release: range(0, 5, 1, 0.01, { name: 'Release', group: 'Amp' }),

    distortionToggle: button(false),
    distortion: range(0, 100, 0, 1, { name: 'Distortion', group: 'Effects' }),
    bitcrusherToggle: button(false),
    bitDepth: range(2, 16, 16, 1, { name: 'Bit Depth', group: 'Effects' }),
    chorusI: button(false),
    chorusII: button(false),
    chorusAmount: range(0, 1, 0, 0.01, { name: 'Chorus Amount', group: 'Effects' }),
    delayToggle: button(false),
    delayTime: select(NOTE_DIVISIONS, '2'),
    delayAmount: range(0, 1, 0, 0.01, { name: 'Delay Amount', group: 'Effects' }),
    reverbToggle: button(false),
    reverbSize: range(0, 1, 0.45, 0.01, { name: 'Reverb Size', group: 'Effects' }),
    reverbDecay: range(0.45, 4.5, 1.8, 0.05, { name: 'Reverb Decay', group: 'Effects' }),
    reverbDamp: range(0, 1, 0.35, 0.01, { name: 'Reverb Damp', group: 'Effects' }),
    reverbAmount: range(0, 1, 0, 0.01, { name: 'Reverb Amount', group: 'Effects' }),
    volume: range(0, 1, 0.5, 0.01, { name: 'Volume', group: 'Master' }),
    compToggle: button(false),
    compThreshold: range(-100, 0, -24, 1, { name: 'Comp Threshold', group: 'Effects' }),
    scToggle: button(false),
    scSource: select(['d1', 'd2', 'd3', 'd4', 'o1', 'o2', 'o3', 'o4'], 'd4'),
    scDepth: range(0, 1, 0.6, 0.01, { name: 'Sidechain Depth', group: 'Effects' }),
    scTimeMs: range(50, 400, 150, 1, { name: 'Sidechain Time', group: 'Effects' }),
    scTimeSyncToggle: button(false),
    scTimeSyncDivision: range(0, 6, 2, 1, { name: 'Sidechain Sync', group: 'Effects' }),
    drumModeToggle: button(false),
    drumFiltToggle: button(false),

    lfoWaveform: select(OSC_WAVES, 'sine'),
    lfoSpeed: range(0.1, 20, 1, 0.1, { name: 'LFO Rate', group: 'LFO' }),
    lfoSyncDivision: range(0, 12, 6, 1, { name: 'LFO Sync', group: 'LFO' }),
    lfoSyncToggle: button(false),
    lfoToggle: button(true),
    lfoRetrigger: button(false),
    cutoffMod: range(-5000, 5000, 0, 100, { name: 'Cutoff Mod', group: 'LFO' }),
    resonanceMod: range(-20, 20, 0, 0.1, { name: 'Resonance Mod', group: 'LFO' }),
    highpassMod: range(-800, 800, 0, 1, { name: 'Highpass Mod', group: 'LFO' }),
    osc1PitchMod: range(-12, 12, 0, 0.1, { name: 'Osc 1 Pitch Mod', group: 'LFO' }),
    osc2PitchMod: range(-12, 12, 0, 0.1, { name: 'Osc 2 Pitch Mod', group: 'LFO' }),
    osc3PitchMod: range(-12, 12, 0, 0.1, { name: 'Osc 3 Pitch Mod', group: 'LFO' }),
    osc4PitchMod: range(-12, 12, 0, 0.1, { name: 'Osc 4 Pitch Mod', group: 'LFO' }),
    ringFreqMod: range(-2000, 2000, 0, 10, { name: 'Ring Freq Mod', group: 'LFO' }),

    // Ingy 6 panel LFO (Juno-60 LFO section). Drives Ingy 6 voice pitch and cutoff in
    // place of the global LFO's osc pitch destinations.
    ingy6LfoRate: range(0.3, 20, 3, 0.01, { name: 'Ingy 6 LFO Rate', group: 'Ingy 6' }),
    ingy6LfoDelay: range(0, 1, 0, 0.001, { name: 'Ingy 6 LFO Delay', group: 'Ingy 6' }),
    ingy6LfoSync: button(false),
    ingy6LfoSyncDivision: range(0, 12, 6, 1, { name: 'Ingy 6 LFO Sync', group: 'Ingy 6' }),
    ingy6DcoLfo: range(0, 1, 0, 0.001, { name: 'Ingy 6 DCO LFO', group: 'Ingy 6' }),
    ingy6VcfLfo: range(0, 1, 0, 0.001, { name: 'Ingy 6 VCF LFO', group: 'Ingy 6' }),
};

for (let i = 0; i < 4; i++) {
    const group = `Oscillator ${i + 1}`;
    PARAMS[`osc-tune-${i}`] = range(-12, 12, i === 1 ? -12 : 0, 1, { name: 'Tune', group });
    PARAMS[`osc-fine-${i}`] = range(-50, 50, 0, 1, { name: 'Fine', group });
    PARAMS[`osc-vol-${i}`] = range(0, 1, 0.25, 0.01, { name: 'Volume', group });
    PARAMS[`osc-pan-${i}`] = range(-1, 1, 0, 0.01);
    PARAMS[`osc-type-${i}`] = select(OSC_WAVES, 'sawtooth');
    PARAMS[`osc-toggle-${i}`] = button(i < 2);
}

for (let i = 0; i < STEP_SLOTS; i++) {
    PARAMS[`step-slider-${i}`] = { type: 'range', min: -39, max: 48, step: 1, default: 0, stepIndex: i, stepField: 'tune' };
    PARAMS[`step-fine-${i}`] = { type: 'range', min: -100, max: 100, step: 1, default: 0, stepIndex: i, stepField: 'fine' };
    PARAMS[`step-accent-${i}`] = { type: 'button', default: false, stepIndex: i, stepField: 'accent' };
    PARAMS[`step-slide-${i}`] = { type: 'button', default: false, stepIndex: i, stepField: 'slide' };
    PARAMS[`step-toggle-${i}`] = { type: 'button', default: true, stepIndex: i, stepField: 'on' };
    PARAMS[`step-ratch-${i}`] = { type: 'ratch', default: 1, stepIndex: i, stepField: 'ratch' };
}

export function getParam(key) {
    return key ? PARAMS[key] || null : null;
}

export function isCatalogKey(key) {
    return !!getParam(key);
}

export function isStepKey(key) {
    return !!getParam(key)?.stepField;
}

export function catalogDefault(key) {
    const spec = getParam(key);
    return spec ? spec.default : undefined;
}

export function clampToCatalog(key, value) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range' || !Number.isFinite(value)) return value;
    let v = value;
    if (Number.isFinite(spec.min)) v = Math.max(spec.min, v);
    if (Number.isFinite(spec.max)) v = Math.min(spec.max, v);
    return v;
}

/**
 * Index-valued ranges: switch positions and sync divisions. Only whole numbers mean
 * anything, so every write lands on one (params.js set). A fraction here once put the
 * keyboard's note names out by a fraction of a semitone (NaN labels).
 */
export const WHOLE_STEP_KEYS = new Set([
    'octaveSwitch', 'semitoneSwitch',
    'lfoSyncDivision', 'ingy6LfoSyncDivision', 'scTimeSyncDivision',
]);

/** Lands `value` on the param's own `step` grid (from `min`), inside its range. */
export function snapToStep(key, value) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range' || !Number.isFinite(value)) return value;
    const v = clampToCatalog(key, value);
    const step = Number(spec.step);
    if (!(step > 0)) return v;
    const min = Number.isFinite(spec.min) ? spec.min : 0;
    const snapped = min + Math.round((v - min) / step) * step;
    // Trim float noise (0.1 * 3 = 0.30000000000000004) to the step's decimals.
    const decimals = Math.min(10, (String(step).split('.')[1] || '').length);
    return clampToCatalog(key, Number(snapped.toFixed(decimals)));
}

/** Scale a 0–127 CC onto a catalog range, on the param's step grid. Never uses || 127 as max. */
export function scaleCcToCatalog(key, ccValue) {
    const spec = getParam(key);
    if (!spec || spec.type !== 'range') return null;
    const min = Number.isFinite(spec.min) ? spec.min : 0;
    const max = Number.isFinite(spec.max) ? spec.max : min;
    const cc = Math.max(0, Math.min(127, Number(ccValue) || 0));
    return snapToStep(key, min + (cc / 127) * (max - min));
}

/** XY dropdown rows: today's scrape minus kb* / write proxy / steps / Berlin. */
export function xyPadEntries() {
    const rows = [];
    Object.entries(PARAMS).forEach(([id, spec]) => {
        if (spec.type !== 'range' || !spec.xyName) return;
        if (spec.stepField) return;
        rows.push({
            id,
            name: spec.xyName,
            group: spec.xyGroup || 'Synth',
            min: spec.min,
            max: spec.max,
            value: spec.default,
        });
    });
    return rows;
}
