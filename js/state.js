// Shared mutable state. In the original single-file version these were
// top-level `let` declarations in one script scope.
export const OSC_COUNT = 4;

export const state = {
    audioContext: undefined,
    isPlaying: false,
    isArping: false,
    currentStep: 0,
    nextStepTime: 0,
    oscillators: [],
    oscGains: [],
    oscPanners: [],                    // StereoPannerNode per OSC (shared mono/spawn path)
    oscTunes: [0, 0, 0, 0],
    filter: undefined,
    // Pre-filter headroom: pad → soft-clip → filter → makeup (keeps high-Q stable)
    filterInputPad: undefined,
    filterPreLimit: undefined,
    filterSoftClip: undefined,
    filterMakeup: undefined,
    highPassFilter: undefined,
    filterCutoffMin: undefined,
    filterEnvConstant: undefined,
    filterEnvGain: undefined,
    filterEnvDepth: undefined,
    // ACID accent sweep (adds Hz to filter.frequency; stacks across accents)
    accentSweepConstant: undefined,
    accentSweepGain: undefined,
    acidMode: false,                   // TB-303-style AD envs + accent sweep
    envelope: undefined,
    ringModulator: undefined,
    ringModulatorOsc: undefined,
    distortion: undefined,
    bitcrusher: undefined,
    delay: undefined,
    delayGain: undefined,
    reverb: undefined,
    reverbInput: undefined,            // wet bus fan-out (predelay + early reflections)
    reverbPreDelay: undefined,
    reverbMultitap: undefined,         // DelayNode[] early reflections (bypass convolver)
    reverbErGain: undefined,           // early-reflection level
    reverbDryGain: undefined,
    reverbWetGain: undefined,          // convolver / diffuse-tail level
    postFxGain: undefined,
    reverbImpulseResponse: undefined,
    reverbErMix: 0.2,                  // Size-driven ER share of wet
    reverbTailMix: 0.8,                // Size-driven tail share of wet
    reverbRenderGen: 0,                // invalidate stale OfflineAudioContext renders
    masterGain: undefined,
    compressor: undefined,
    analyser: undefined,
    oscStates: [true, true, true, false], // OSC 4 Off on load
    // OSC 1 digital engine (wavetable | fm | …)
    osc4Wavetable: false,
    osc4Model: 'wavetable',
    osc4MorphX: 0.5,
    osc4MorphY: 0.5,
    osc4Harmonics: 0.5,
    osc4Bank: -1, // -1 = Scan via HARMONICS; 0–3 = pinned (fm6: 0–2 Bass/Keys/Pads)
    /** Plaits AUX path on the single OSC1 jack (0=OUT, 1=ALT/AUX). */
    osc4Alt: false,
    /** Plaits TRIG patched: true=Mode 2 (default), false=Mode 1 unpatched. */
    osc4TrigPatched: true,
    /** Voice USER bank active (factory MODEL blend off; pin LPC bank 5). */
    osc4SpeechUserBank: false,
    lastVelocity: 0.8, // 0–1; drives Plaits fm6 DX velocity
    plaitsWorkletReady: false,
    plaitsWorkletPromise: null,
    plaitsWorkletCtx: null,
    isReverse: false,
    noiseSource: undefined,
    noiseGain: undefined,
    noiseState: false,
    noiseBuffers: {},
    lfo: undefined,
    lfoSmooth: undefined,              // lowpass on LFO to soften square/saw edges
    lfoShaper: undefined,              // soft-clip peaks before AudioParams
    lfoFilterSlew: undefined,          // extra smoothing on cutoff mod path only
    lfoFilterPad: undefined,           // headroom pad on cutoff mod (anti-clip)
    lfoHpSlew: undefined,              // smoothing on highpass mod path
    lfoHpPad: undefined,               // headroom pad on highpass mod
    lfoMasterGain: undefined,          // soft on/off for LFO
    lfoGainCutoff: undefined,
    lfoGainResonance: undefined,
    lfoGainHighpass: undefined,
    lfoGainOsc1Pitch: undefined,
    lfoGainOsc2Pitch: undefined,
    lfoGainOsc3Pitch: undefined,
    lfoGainOsc4Pitch: undefined,
    lfoState: true,
    lfoAmount: 0,                      // performance strip 0…1 (scales master when On)
    lfoSync: false,                    // false = Hz, true = tempo-synced divisions
    lfoSyncDivisionIndex: 6,           // default 1/4 in LFO_SYNC_DIVISIONS
    lfoRetriggerState: false,
    activeOscillators: [],
    phaseResetEnabled: true,

    // Global unison (phase-reset path only; forced off when phase reset Off)
    unisonEnabled: false,
    unisonVoices: 3,
    unisonSpread: 10,

    // Master compressor (true bypass when false)
    compressorEnabled: true,

    // Effects enable (amount knobs still hold settings when off)
    ringModEnabled: false,
    distortionEnabled: false,
    bitcrusherEnabled: false,
    delayEnabled: false,
    reverbEnabled: false,

    // Slide / microtuning playback tracking
    lastStepFreqs: [null, null, null, null], // last scheduled frequency per oscillator
    lastStepSounded: false,            // previous step produced a note (slide source exists)
    envelopeHeld: false,               // envelope held at sustain awaiting a slide step
    filterEnvelopeHeld: false,         // filter envelope held at sustain awaiting a slide step
    /** Independent ratch voices (own oscs + amp) that can outlive the next step. */
    ratchVoices: [],
    filterEnvState: false,
    filterEnvInvert: false,            // when true, env closes cutoff from knob instead of opening toward it
    lastSentBendCents: 0,              // last pitch bend (in cents) sent over MIDI
    microtuneLock: false,              // false = Full continuous cents; true = ±25¢ grid
    // Write-mode Acc/Sld arms (sticky until toggled; applied on next note write)
    writeArmAccent: false,
    writeArmSlide: false,

    // Ring mod internals (created in initAudio)
    ringModInput: undefined,          // shared input fanning out to dry + wet paths
    ringModDryGain: undefined,
    ringModWetGain: undefined,
    ringModModulatorGain: undefined,

    // Chromatic keyboard
    keyboardTranspose: 0,              // sticky sequencer transpose (play-mode keys)
    arpTranspose: 0,                   // temporary root while keyboard-gated arp runs
    keyboardArp: false,
    keyboardArpChord: false,           // classic chord arp (requires keyboardArp)
    arpOrder: 'up',                    // up | down | upDown | random
    arpRange: 1,                       // Juno-style octave range 1 | 2 | 3
    arpChordIndex: 0,                  // cursor in chord-arp order list
    arpFrozenNotes: null,              // latch-frozen chord pool (cell semitones)
    arpFrozenPressOrder: null,
    arpLastPolySemi: null,             // cell semi currently gated by Poly Arp
    chordMemoryLearning: false,        // one-shot Chord Mem learn armed
    keyboardPoly: false,               // Kb-only 6-voice playground (Ingy 6 / Juno-60)
    keyboardPolyUnison: false,         // stack 6 voices on one note (Alpha Juno-style)
    keyboardMultitudes: false,         // Multitudes: kb-only 6-voice Plaits poly
    polyVcaGate: false,                // Ingy 6 VCA: false=ENV ADSR, true=GATE
    polySubCeil: 0.1,                  // backup: Ingy SUB fader 10 = live OSC2 vol knob
    keyboardLatch: false,
    keyboardHeldSemitone: null,
    keyboardVisible: true,
    keyboardStepsExpanded: true,
    keyboardVoiceActive: false,
    keyboardWrite: false,
    writeStep: 0,
    pitchBendSemitones: 0,             // live pitch-bend strip (−range…+range)
    computerKeyboardEnabled: false,
    computerKeyboardOctave: -12,       // A-key root relative to C4 (default ~C3)

    // MIDI
    midiAccess: null,
    midiInputs: [],
    midiOutputs: [],
    midiMappingMode: false,
    midiSectionOpen: false,            // MIDI logo switch: arms MIDI section (green off / cyan on)
    currentMappingControl: null,
    currentMappingHost: null,
    midiMappings: {},
    lastMIDIValues: {},
    selectedMidiInput: 'all',
    sendMidiEnabled: false,
    selectedMidiOutput: null,
    selectedMidiChannel: 1,
    midiBaseNote: 60, // Middle C by default

    // Track the logo display timeout
    logoDisplayTimeout: undefined,
    stopCleanupTimeout: undefined,
    playGeneration: 0,

    // Pattern bank (P1–P8) + Berlin Dream-960 (8 lanes)
    patterns: [],                      // 8 × Pattern (see pattern-bank.js)
    editSlot: 0,                       // bank slot shown in the step strips (0–7 normal)
    pendingEditSlot: null,             // armed slot; commits at next loop start
    berlinMode: false,                 // eight rows in parallel, own clocks/destinations
    berlinOscCount: 3,                 // 1–4 visible oscillator lanes (O1–O4)
    berlinModCount: 1,                 // 1–4 visible modulation lanes (M1–M4)
    berlinSoloRow: null,               // exclusive Solo index, or null when none
    berlinPlayheads: [],               // playhead × 8
    berlinLoopAnchor: 0,               // audio time the master loop last wrapped
    berlinOscVoices: [],               // independent per-osc amp voices while Berlin runs
    berlinSharedPathArmed: false,      // envelope open + main oscs muted for shared-filter CV

    // Chorus effect nodes
    chorusDryGain: undefined,
    chorusWetGain: undefined,
    chorusLeftDelay: undefined,
    chorusRightDelay: undefined,
    chorusLFO: undefined,
    chorusLFOGain: undefined,
    chorusSplitter: undefined,
    chorusMerger: undefined,
};
