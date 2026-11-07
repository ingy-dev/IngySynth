// Digital oscillator panel text and state, shared by every panel that shows the
// engine (OSC 1 mainstage, OSC 2-4 slots, the Multitudes modules): what each knob
// is called on each model, which controls the current patch actually uses, and
// what the TIMBRE / FM / MORPH attenuverters do. Names follow the hardware manual
// and the firmware 1.2 notes for the second bank of models.

/** HARMONICS / TIMBRE / MORPH captions per model. */
const LABELS = {
    va: { harmonics: 'DETUNE', timbre: 'SQUARE', morph: 'SAW' },
    waveshaper: { harmonics: 'WAVE', timbre: 'FOLD', morph: 'ASYMM' },
    fm: { harmonics: 'RATIO', timbre: 'INDEX', morph: 'FEEDBACK' },
    grain: { harmonics: 'RATIO', timbre: 'FORMANT', morph: 'WIDTH' },
    additive: { harmonics: 'BUMPS', timbre: 'INDEX', morph: 'SHAPE' },
    wavetable: { harmonics: 'BANK', timbre: 'ROW', morph: 'COLUMN' },
    chord: { harmonics: 'CHORD', timbre: 'INVERSION', morph: 'WAVE' },
    speech: { harmonics: 'MODEL', timbre: 'SPECIES', morph: 'PHONEME' },
    swarm: { harmonics: 'SPREAD', timbre: 'DENSITY', morph: 'DURATION' },
    noise: { harmonics: 'FILTER', timbre: 'CLOCK', morph: 'RESO' },
    particle: { harmonics: 'RANDOM', timbre: 'DENSITY', morph: 'FILTER' },
    string: { harmonics: 'INHARM', timbre: 'BRIGHT', morph: 'DECAY' },
    modal: { harmonics: 'MATERIAL', timbre: 'BRIGHT', morph: 'DECAY' },
    bass_drum: { harmonics: 'DRIVE', timbre: 'BRIGHT', morph: 'DECAY' },
    snare: { harmonics: 'NOISE', timbre: 'MODES', morph: 'DECAY' },
    hihat: { harmonics: 'NOISE', timbre: 'CUTOFF', morph: 'DECAY' },
    // Firmware 1.2 bank
    va_vcf: { harmonics: 'RESO', timbre: 'CUTOFF', morph: 'WAVE' },
    pd: { harmonics: 'FREQ', timbre: 'AMOUNT', morph: 'ASYMM' },
    fm6: { harmonics: 'PRESET', timbre: 'MOD', morph: 'TIME' },
    terrain: { harmonics: 'TERRAIN', timbre: 'RADIUS', morph: 'OFFSET' },
    string_machine: { harmonics: 'CHORD', timbre: 'CHORUS', morph: 'WAVE' },
    chiptune: { harmonics: 'CHORD', timbre: 'ARP', morph: 'PW/SYNC' },
};

/** Full names for the value bubble, where the panel label is abbreviated or ambiguous. */
const LONG = {
    va: { harmonics: 'DETUNE', timbre: 'SQUARE', morph: 'SAW' },
    waveshaper: { harmonics: 'WAVESHAPE', timbre: 'WAVEFOLD', morph: 'ASYMMETRY' },
    fm: { harmonics: 'FREQUENCY RATIO', timbre: 'MOD INDEX', morph: 'FEEDBACK' },
    grain: { harmonics: 'FORMANT RATIO', timbre: 'FORMANT', morph: 'FORMANT WIDTH' },
    additive: { harmonics: 'BUMPS', timbre: 'MAIN HARMONIC', morph: 'BUMP SHAPE' },
    wavetable: { harmonics: 'BANK', timbre: 'ROW', morph: 'COLUMN' },
    chord: { harmonics: 'CHORD', timbre: 'INVERSION', morph: 'WAVEFORM' },
    speech: { harmonics: 'MODEL', timbre: 'SPECIES', morph: 'PHONEME' },
    swarm: { harmonics: 'PITCH SPREAD', timbre: 'GRAIN DENSITY', morph: 'GRAIN DURATION' },
    noise: { harmonics: 'FILTER RESPONSE', timbre: 'CLOCK', morph: 'RESONANCE' },
    particle: { harmonics: 'RANDOMNESS', timbre: 'DENSITY', morph: 'FILTER TYPE' },
    string: { harmonics: 'INHARMONICITY', timbre: 'BRIGHTNESS', morph: 'DECAY' },
    modal: { harmonics: 'MATERIAL', timbre: 'BRIGHTNESS', morph: 'DECAY' },
    bass_drum: { harmonics: 'ATTACK / DRIVE', timbre: 'BRIGHTNESS', morph: 'DECAY' },
    snare: { harmonics: 'NOISE BALANCE', timbre: 'MODE BALANCE', morph: 'DECAY' },
    hihat: { harmonics: 'NOISE BALANCE', timbre: 'HPF CUTOFF', morph: 'DECAY' },
    va_vcf: { harmonics: 'RESONANCE', timbre: 'CUTOFF', morph: 'WAVEFORM' },
    pd: { harmonics: 'DISTORTION FREQ', timbre: 'DISTORTION', morph: 'ASYMMETRY' },
    fm6: { harmonics: 'PRESET', timbre: 'MOD LEVEL', morph: 'ENVELOPE TIME' },
    terrain: { harmonics: 'TERRAIN', timbre: 'PATH RADIUS', morph: 'PATH OFFSET' },
    string_machine: { harmonics: 'CHORD', timbre: 'CHORUS / FILTER', morph: 'WAVEFORM' },
    chiptune: { harmonics: 'CHORD', timbre: 'ARPEGGIO', morph: 'PULSE WIDTH / SYNC' },
};

/** Bubble captions for HARMONICS / TIMBRE / MORPH. */
export function plaitsCaptions(model, ctx = {}) {
    const m = modelOf(model);
    const labels = plaitsLabels(m, ctx);
    const out = { ...LONG[m] };
    if (m === 'chiptune' && ctx.trigPatched === false) out.timbre = 'INVERSION';
    if (m === 'speech') {
        if (labels.harmonics === 'USER') out.harmonics = 'USER BANK';
        if (labels.morph === 'WORD') out.morph = 'WORD';
    }
    return out;
}

// Speech: HARMONICS past 1/3 leaves the vowel models for the LPC word banks;
// words start around 11 o'clock (manual). The FM and MORPH attenuverters then
// stop driving the envelope and, with TRIG patched, set intonation and speed.
const SPEECH_LPC = 1 / 3;
const SPEECH_WORDS = 0.417;

/**
 * @typedef {Object} PlaitsCtx
 * @property {boolean} [trigPatched] MODE 2 (TRIG patched)
 * @property {number} [harmonics] 0..1
 * @property {number} [bank] osc4Bank / osc-bank-N value (-1 scans)
 * @property {boolean} [speechUser] Voice USER bank playing
 */

function modelOf(model) {
    return LABELS[model] ? model : 'wavetable';
}

/** @param {string} model @param {PlaitsCtx} ctx */
export function plaitsLabels(model, ctx = {}) {
    const m = modelOf(model);
    const out = { ...LABELS[m] };
    const h = Number(ctx.harmonics);
    if (m === 'chiptune' && ctx.trigPatched === false) out.timbre = 'INVERSION';
    if (m === 'speech') {
        if (ctx.speechUser) out.harmonics = 'USER';
        if (ctx.speechUser || h >= SPEECH_WORDS) out.morph = 'WORD';
    }
    return out;
}

/** Which controls the patch uses. Unused ones are greyed out. */
export function plaitsActive(model, ctx = {}) {
    const m = modelOf(model);
    const h = Number(ctx.harmonics);
    const active = {
        frequency: true,
        harmonics: true,
        timbre: true,
        morph: true,
        envTimbre: true,
        envPitch: true,
        envMorph: true,
    };
    // A pinned wavetable bank ignores HARMONICS; the Voice USER bank pins the words.
    if (m === 'wavetable' && Number(ctx.bank) >= 0) active.harmonics = false;
    if (m === 'speech') {
        if (ctx.speechUser) active.harmonics = false;
        const lpc = ctx.speechUser || h >= SPEECH_LPC;
        const prosody = ctx.trigPatched !== false && (ctx.speechUser || h >= SPEECH_WORDS);
        if (lpc && !prosody) {
            active.envPitch = false;
            active.envMorph = false;
        }
    }
    return active;
}

/** Readout captions for the three attenuverters (their meaning changes on some models). */
export function plaitsTrimCaptions(model, ctx = {}) {
    const m = modelOf(model);
    const long = plaitsCaptions(m, ctx);
    const out = {
        envTimbre: `${long.timbre} ENV`,
        envPitch: 'PITCH ENV',
        envMorph: `${long.morph} ENV`,
    };
    const h = Number(ctx.harmonics);
    if (m === 'chiptune' && ctx.trigPatched !== false) out.envTimbre = 'ENVELOPE SHAPE';
    if (m === 'speech' && ctx.trigPatched !== false && (ctx.speechUser || h >= SPEECH_WORDS)) {
        out.envPitch = 'INTONATION';
        out.envMorph = 'SPEED';
    }
    return out;
}

const WAVETABLE_BANKS = ['A', 'B', 'C', 'D'];
const ARP_MODES = ['UP', 'DOWN', 'UP/DOWN', 'RANDOM'];

/** wavetable_engine.cc: z = HARMONICS x 7. 0-3 blend banks A-D, 4-7 play D-A without blending. */
function wavetableBankName(h) {
    const z = Math.max(0, Math.min(1, h)) * 6.9999;
    // Past 3 the blend is quantized: the nearer bank plays, read back from the top (z0 = 7 - z).
    if (z >= 3) {
        const r = Math.min(7, Math.round(z));
        return r >= 4 ? `${WAVETABLE_BANKS[7 - r]} STEP` : 'D';
    }
    const zi = Math.floor(z);
    const f = z - zi;
    if (f < 0.15) return WAVETABLE_BANKS[zi];
    if (f > 0.85) return WAVETABLE_BANKS[zi + 1];
    return `${WAVETABLE_BANKS[zi]}/${WAVETABLE_BANKS[zi + 1]}`;
}

/** speech_engine.cc: naive formants -> SAM -> LPC vowels, then the five LPC word banks. */
function speechModelName(h) {
    const group = Math.max(0, Math.min(1, h)) * 6;
    if (group < 0.5) return 'FORMANT';
    if (group < 1.5) return 'SAM';
    if (group <= 2) return 'LPC';
    const q = Math.max(0, Math.min(5, Math.floor((group - 2) * 0.275 * 6)));
    return q === 0 ? 'LPC' : `WORDS ${q}`;
}

/** chiptune_engine.cc: 12 arpeggiator patterns, mode = pattern / 3, range = 2^(pattern % 3) octaves. */
function arpPatternName(t) {
    const p = Math.max(0, Math.min(11, Math.floor(Math.max(0, Math.min(1, t)) * 12)));
    return `${ARP_MODES[Math.floor(p / 3)]} ${1 << (p % 3)} OCT`;
}

/**
 * Named knob positions for the value bubble, where the engine steps through
 * named settings. Empty where the knob is a plain amount.
 * @param {string} model @param {PlaitsCtx & { timbre?: number }} ctx
 */
export function plaitsReadouts(model, ctx = {}) {
    const m = modelOf(model);
    const out = {};
    const h = Number(ctx.harmonics);
    const t = Number(ctx.timbre);
    if (m === 'wavetable' && !(Number(ctx.bank) >= 0) && Number.isFinite(h)) out.harmonics = wavetableBankName(h);
    if (m === 'speech' && !ctx.speechUser && Number.isFinite(h)) out.harmonics = speechModelName(h);
    if (m === 'chiptune' && ctx.trigPatched !== false && Number.isFinite(t)) out.timbre = arpPatternName(t);
    return out;
}

const AREAS = [
    ['frequency', '.pg-freq'],
    ['harmonics', '.pg-harm'],
    ['timbre', '.pg-timbre'],
    ['morph', '.pg-morph'],
    ['envTimbre', '.pg-tt'],
    ['envPitch', '.pg-fm'],
    ['envMorph', '.pg-mt'],
];

/**
 * Names, greys out and captions one panel's knobs (a .plaits-grid). Knob labels
 * are left alone where `keepLabels` names them (HARMONICS showing a chord).
 * @param {Element | null} grid
 * @param {string} model
 * @param {PlaitsCtx} ctx
 * @param {{ keepLabels?: string[] }} [opts]
 */
export function applyPlaitsPanel(grid, model, ctx = {}, opts = {}) {
    if (!grid) return;
    const labels = plaitsLabels(model, ctx);
    const active = plaitsActive(model, ctx);
    const trims = plaitsTrimCaptions(model, ctx);
    const readouts = plaitsReadouts(model, ctx);
    const captions = plaitsCaptions(model, ctx);
    const keep = new Set(opts.keepLabels || []);
    AREAS.forEach(([name, sel]) => {
        const knob = grid.querySelector(sel);
        if (!knob) return;
        const on = active[name] !== false;
        knob.classList.toggle('is-model-inactive', !on);
        const dial = knob.querySelector('.synth-knob-dial, .mi-knob-dial');
        if (dial) {
            dial.setAttribute('aria-disabled', on ? 'false' : 'true');
            dial.tabIndex = on ? 0 : -1;
        }
        if (labels[name] && !keep.has(name)) {
            const labelEl = knob.querySelector('.synth-knob-label, .mi-knob-pill');
            if (labelEl) labelEl.textContent = labels[name];
            // HARMONICS may carry its chord ("CHORD Cm7"); keep that.
            if (dial && !dial.getAttribute('aria-label')?.startsWith(labels[name])) {
                dial.setAttribute('aria-label', labels[name]);
            }
        }
        // Bubble text for stepped knobs. Other code (six-op patch names) owns its own.
        if (dial && (name === 'harmonics' || name === 'timbre')) {
            if (readouts[name]) {
                dial.dataset.readoutValue = readouts[name];
                dial.dataset.readoutOwner = 'plaits';
            } else if (dial.dataset.readoutOwner === 'plaits') {
                delete dial.dataset.readoutValue;
                delete dial.dataset.readoutOwner;
            }
        }
        const bubbleCaption = trims[name] || captions[name];
        if (bubbleCaption) knob.setAttribute('data-readout-caption', bubbleCaption);
        if (trims[name]) {
            knob.title = trims[name];
        }
        if (dial?.id) {
            grid.querySelectorAll(`.mi-link[data-source="${dial.id}"]`).forEach((path) => {
                path.classList.toggle('is-inactive', !on);
            });
        }
    });
}
