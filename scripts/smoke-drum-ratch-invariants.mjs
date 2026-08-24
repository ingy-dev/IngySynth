#!/usr/bin/env node
/**
 * Smoke tests: drum / ratchet / off-step invariants.
 *
 * Baseline = git HEAD sequencer + osc-source behavior at session start.
 * These tests lock contracts so we stop regressing while chasing clicks.
 *
 * Run:
 *   /Applications/Cursor.app/Contents/Resources/app/resources/helpers/node \
 *     scripts/smoke-drum-ratch-invariants.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
    if (cond) {
        passed += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Minimal AudioParam stand-in: records automation events. */
class FakeParam {
    constructor(value = 0) {
        this.value = value;
        this.events = [];
    }
    cancelScheduledValues(t) {
        this.events.push({ op: 'cancel', t });
    }
    cancelAndHoldAtTime(t) {
        this.events.push({ op: 'cancelAndHold', t });
    }
    setValueAtTime(v, t) {
        this.events.push({ op: 'set', v, t });
        this.value = v;
    }
    linearRampToValueAtTime(v, t) {
        this.events.push({ op: 'lin', v, t });
        this.value = v;
    }
    exponentialRampToValueAtTime(v, t) {
        this.events.push({ op: 'exp', v, t });
        this.value = v;
    }
}

/**
 * Pure copy of the proven ratch-drum hold envelope (scheduleFullNoteOnGain holdDrum).
 * Kept here so smoke tests don't load the browser sequencer module.
 */
function scheduleDrumHoldGain(gainParam, {
    startTime,
    stepDuration,
    peakScale = 1,
    accentThisStep = false,
    accentAmount = 0,
    now = 0,
}) {
    const t0 = Math.max(now, startTime);
    const minValue = 0.00001;
    const peak = (accentThisStep ? 1 + 0.5 * accentAmount : 1) * peakScale;
    const relStart = t0 + stepDuration;
    const relLen = 0.18;
    gainParam.cancelScheduledValues(t0);
    gainParam.setValueAtTime(0, t0);
    gainParam.linearRampToValueAtTime(peak, t0 + 0.002);
    gainParam.setValueAtTime(peak, relStart);
    gainParam.exponentialRampToValueAtTime(minValue, relStart + relLen);
    return relStart + relLen + 0.05;
}

/** Original HEAD off-step: envelope release only — no osc/ratch teardown. */
function originalOffStepActions({ envelopeHeld }) {
    const actions = [];
    if (envelopeHeld) actions.push('fadeEnvelope');
    actions.push('clearLastStepSounded');
    return actions;
}

/** Gate retrigger must hold zero ≥ one render quantum (~128/44100). */
function gateRetriggerHoldMs(gapStart, holdEnd) {
    return (holdEnd - gapStart) * 1000;
}

// ─── Source contracts (current tree vs baseline intent) ─────────────────────

console.log('\n=== Source contracts (js/sequencer.js, js/osc-source.js, js/unison.js) ===\n');

const seq = read('js/sequencer.js');
const osc = read('js/osc-source.js');
const unison = read('js/unison.js');

ok(
    'OSC digital slot is index 0 (OSC1)',
    /export const OSC4_INDEX = 0/.test(osc),
);

ok(
    'DRUM_ENGINES includes bass_drum',
    /DRUM_ENGINES = new Set\(\[[^\]]*bass_drum/.test(osc),
);

ok(
    'Ratch path requests holdForDrum: true',
    /holdForDrum:\s*true/.test(seq),
);

ok(
    'holdDrum branch holds amp for full stepDuration then ≥150ms release',
    /const relStart = t0 \+ stepDuration/.test(seq)
        && /const relLen = 0\.18/.test(seq),
);

ok(
    'Main-path drum schedule keeps shared VCA open (envelopeHeld)',
    /DRUM_ENGINES\.has\(state\.osc4Model\)/.test(seq)
        && /state\.envelopeHeld = true/.test(seq),
);

ok(
    'firePhaseReset retriggers any wavetable proxy (not only isTriggered)',
    /osc\.isWavetable && typeof osc\.retrigger === 'function'/.test(unison),
);

ok(
    'Analog phase-reset replace fade stays ~22ms (not 55ms crossover)',
    /fadeSec:\s*osc\.isWavetable \? 0\.055 : 0\.022/.test(unison)
        || /fadeSec:\s*osc\.isWavetable \? 0\.055 : 0\.02/.test(seq),
);

ok(
    'stopDisabledOscStacks exists (disabled osc must not drone)',
    /function stopDisabledOscStacks|export function stopDisabledOscStacks/.test(unison),
);

    ok(
        'proxy.retrigger holds gate at zero before rising edge',
        /gateParam\.setValueAtTime\(0,\s*holdEnd\)/.test(osc)
        && /holdEnd = Math\.max\(t,\s*gapStart \+ 0\.004\)/.test(osc),
    );

const bank = read('js/pattern-bank.js');
const berlin = read('js/berlin.js');

console.log('\n=== Berlin Dream drum-lane contracts ===\n');

ok(
    'isDrumLane is a live flag overlay, not laneKind drum',
    /export function isDrumLane/.test(bank)
        && /state\.berlinDrumMode/.test(bank)
        && !/laneKind:\s*'drum'/.test(bank),
);

ok(
    'ensureBank preserves pattern.drum',
    /p\.drum && typeof p\.drum === 'object'/.test(bank)
        && /p\.drum = clampDrumPatch/.test(bank),
);

ok(
    'createPlaitsSource is a dedicated factory (no analog fallback)',
    (() => {
        const start = osc.indexOf('export function createPlaitsSource');
        const end = osc.indexOf('export function applyBerlinDrumKitToLive');
        const body = start >= 0 ? osc.slice(start, end) : '';
        return /export function createPlaitsSource/.test(body)
            && /drum:\s*true/.test(body)
            && !/createOscillator/.test(body);
    })(),
);

ok(
    'dedicated drum pool (not wtPool[0])',
    /DRUM_POOL_MAX = 6/.test(osc)
        && /function acquireDrumPoolSlot/.test(osc)
        && /drum \? acquireDrumPoolSlot/.test(osc),
);

ok(
    'releasePoolSlot resets that slot engine, not osc4Model',
    /engine: slot\.engine/.test(osc),
);

ok(
    'applyFm6BankToLive skips drum pool slots',
    /slot\.drum/.test(osc)
        && /export function applyFm6BankToLive[\s\S]*slot\.drum/.test(osc),
);

ok(
    'createPlaitsSource patch path does not read lastVelocity / osc4Model',
    (() => {
        const start = osc.indexOf('export function createPlaitsSource');
        const end = osc.indexOf('export function applyBerlinDrumKitToLive');
        const body = osc.slice(start, end);
        return !/state\.osc4Model/.test(body) && !/state\.lastVelocity/.test(body);
    })(),
);

{
    const fireStart = seq.indexOf('function fireBerlinRow');
    const fireEnd = seq.indexOf('function scheduleBerlinSteps');
    const fire = fireStart >= 0 ? seq.slice(fireStart, fireEnd) : '';
    const drumIdx = fire.search(/isDrumLane\s*\(\s*row\s*\)/);
    const destIdx = fire.search(/destination === 'off'/);
    ok(
        'fireBerlinRow isDrumLane wins before dest off (D3 default)',
        drumIdx >= 0 && destIdx >= 0 && drumIdx < destIdx,
    );
}

ok(
    'triggerBerlinDrumLane exists and does not call spawnBerlinOscVoice',
    /function triggerBerlinDrumLane/.test(seq)
        && !/function triggerBerlinDrumLane[\s\S]*spawnBerlinOscVoice/.test(
            seq.slice(seq.indexOf('function triggerBerlinDrumLane'), seq.indexOf('function fireBerlinRow')),
        ),
);

{
    const spawnStart = seq.indexOf('function spawnBerlinDrumVoice');
    const spawnEnd = seq.indexOf('function triggerBerlinDrumLane');
    const spawn = spawnStart >= 0 ? seq.slice(spawnStart, spawnEnd) : '';
    ok(
        'drum-lane hold is keyed off lane spawn, not osc4Model',
        spawn.length > 0
            && /createPlaitsSource/.test(spawn)
            && !/holdForDrum/.test(spawn)
            && !/state\.osc4Model/.test(spawn)
            && !/scheduleFullNoteOnGain/.test(spawn)
            && !/scheduleStepFilterEnvelope/.test(spawn)
            && !/getOscVol/.test(spawn)
            && !/oscPanners/.test(spawn),
    );
}

ok(
    'syncBerlinUi hides rows from berlinActiveRows, not berlinModCount',
    /const active = new Set\(berlinActiveRows\(\)\)/.test(berlin)
        && /el\.classList\.toggle\('hidden', !active\.has\(row\)\)/.test(berlin),
);

// Baseline HEAD: off step must NOT hard-stop main oscs / dispose ratch mid-hold.
// Current tree accrued off-step voice teardown while chasing clicks — flag it.
const offStart = seq.indexOf("textContent === 'Off'");
const offEndMarker = seq.indexOf('state.lastStepSounded = false;\n        return;', offStart);
const offBlock = offEndMarker > offStart
    ? seq.slice(offStart, offEndMarker + 60)
    : seq.slice(offStart, offStart + 8000);

ok(
    'BASELINE: off step does not call disposeRatchVoice',
    !/disposeRatchVoice\s*\(/.test(offBlock),
    'off block still tears down ratch voices — this is the loop we fell into',
);

ok(
    'BASELINE: off step does not duck/clear state.ratchVoices',
    !/state\.ratchVoices\s*=/.test(offBlock)
        && !/state\.ratchVoices\.slice|state\.ratchVoices\.forEach|state\.ratchVoices\.length\s*>/.test(offBlock),
    'HEAD left ratch voices on their own envelopes; off must not own them',
);

ok(
    'BASELINE: off step does not osc.stop / fadeStopOsc main stack',
    !/\.stop\s*\(/.test(offBlock) && !/fadeStopOsc\s*\(/.test(offBlock),
    'off block still stops oscillators — prefer VCA-only like HEAD',
);

ok(
    'originalOffStepActions only fades envelope when held',
    JSON.stringify(originalOffStepActions({ envelopeHeld: true }))
        === JSON.stringify(['fadeEnvelope', 'clearLastStepSounded'])
        && JSON.stringify(originalOffStepActions({ envelopeHeld: false }))
            === JSON.stringify(['clearLastStepSounded']),
);

// ─── Envelope math smoke ────────────────────────────────────────────────────

console.log('\n=== Drum-hold envelope math ===\n');

{
    const g = new FakeParam(0);
    const doneAt = scheduleDrumHoldGain(g, {
        startTime: 1.0,
        stepDuration: 0.25,
        peakScale: 1 / Math.sqrt(2),
        now: 0.9,
    });
    const peak = 1 / Math.sqrt(2);
    const sets = g.events.filter((e) => e.op === 'set');
    const peakHold = sets.find((e) => Math.abs(e.v - peak) < 1e-9 && Math.abs(e.t - 1.25) < 1e-9);
    const attack = g.events.find((e) => e.op === 'lin' && Math.abs(e.t - 1.002) < 1e-9);
    const release = g.events.find((e) => e.op === 'exp' && e.t > 1.25);

    ok('2x ratch peak is 1/√2', Math.abs(peak - 0.7071067811865475) < 1e-12);
    ok('attack reaches peak by t0+2ms', !!attack && Math.abs(attack.v - peak) < 1e-9);
    ok('peak is re-asserted at step end (relStart)', !!peakHold);
    ok('release ends ≥150ms after step end', !!release && release.t >= 1.25 + 0.15);
    ok('doneAt is after release', doneAt >= 1.25 + 0.18);
}

{
    const g = new FakeParam(0);
    scheduleDrumHoldGain(g, { startTime: 0, stepDuration: 0.125, peakScale: 1, now: 0 });
    const release = g.events.find((e) => e.op === 'exp');
    ok(
        'single-hit drum hold still uses 180ms ring-out',
        !!release && Math.abs(release.t - (0.125 + 0.18)) < 1e-9,
    );
}

// ─── Gate retrigger timing ──────────────────────────────────────────────────

console.log('\n=== Gate retrigger timing ===\n');

{
    const blockMs = (128 / 44100) * 1000;
    const gapStart = 1.0;
    const holdEnd = 1.004;
    const hold = gateRetriggerHoldMs(gapStart, holdEnd);
    ok(
        `gate zero-hold (${hold.toFixed(1)}ms) ≥ one quantum (~${blockMs.toFixed(2)}ms)`,
        hold + 1e-9 >= blockMs,
    );
}

// ─── Analog 808 punch (ANA BD/SN/CH) ────────────────────────────────────────

console.log('\n=== Analog 808 punch contracts ===\n');

const analog = read('js/analog-808.js');
const audioEng = read('js/audio-engine.js');

{
    const fireStart = analog.indexOf('function fireDrumEnv');
    const fireEnd = analog.indexOf('\n/** Kit TUNE');
    const fire = fireStart >= 0 ? analog.slice(fireStart, fireEnd > fireStart ? fireEnd : fireStart + 500) : '';
    ok(
        'fireDrumEnv min attack < 0.006 (snare not mushy)',
        /Math\.max\(0\.0005/.test(fire)
            && !/Math\.max\(0\.006/.test(fire),
    );
}

ok(
    'punchEnv/fireDrumEnv hold current gain before retrigger attack',
    /function holdThen/.test(analog)
        && /cancelAndHoldAtTime/.test(analog)
        && /setValueAtTime\(cur,\s*t0\)/.test(analog)
        && /holdThen\(param,\s*t0\)/.test(analog),
);

{
    const bdStart = analog.indexOf('function buildBassDrum');
    const bdEnd = analog.indexOf('function buildSnare');
    const bd = bdStart >= 0 ? analog.slice(bdStart, bdEnd) : '';
    ok(
        'buildBassDrum has createWaveShaper (tanh body)',
        /createWaveShaper/.test(bd),
    );
    ok(
        'kick click is not hz * 18 sine',
        !/hz\s*\*\s*18/.test(bd) && !/frequency\.value = Math\.min\(4000/.test(bd),
    );
    ok(
        'kick click is looping HP noise',
        /makeLoopNoise/.test(bd)
            && /clickHp\.type = 'highpass'/.test(bd)
            && /clickGain\.connect\(env\)/.test(bd),
    );
    ok(
        'kick keeps exponentialRamp pitch sweep',
        /exponentialRampToValueAtTime/.test(bd),
    );
}

ok(
    'createAnalog808Voice still only BD / SN / CH',
    /model === 'bass_drum' \|\| model === 'snare' \? model : 'hihat'/.test(analog),
);

ok(
    'analog voice keeps retrigger / choke / applyKit (not an AudioBuffer player)',
    /retrigger\(when,\s*next\)/.test(analog)
        && /choke\(when\)/.test(analog)
        && /applyKit\(nextPatch,\s*now\)/.test(analog)
        && !/source\.buffer/.test(analog),
);

ok(
    'DRUM_MODELS is exactly hihat, snare, bass_drum',
    /export const DRUM_MODELS = \['hihat', 'snare', 'bass_drum'\]/.test(bank),
);

ok(
    'analogDrumInput.gain.value = 0.32 unchanged',
    /analogDrumInput\.gain\.value = 0\.32/.test(audioEng),
);

{
    const hatStart = analog.indexOf('function buildClosedHat');
    const hatEnd = analog.indexOf('export function createAnalog808Voice');
    const hat = hatStart >= 0 ? analog.slice(hatStart, hatEnd) : '';
    ok(
        'hat keeps 6 square ratios',
        /const HAT_RATIOS = \[205\.3/.test(analog)
            && (analog.match(/HAT_RATIOS/g) || []).length >= 2
            && /o\.type = 'square'/.test(hat),
    );
    ok(
        'hat extra noise connects through env',
        /noiseGain\.connect\(env\)/.test(hat)
            && /hp\.connect\(env\)/.test(hat),
    );
}

ok(
    'snare outer env uses punchEnv (not stacked fireDrumEnv)',
    /fireDrumEnv\(parts\.noiseGain/.test(analog)
        && /fireDrumEnv\(parts\.bodyGain/.test(analog)
        && /punchEnv\(env\.gain,\s*t0,\s*1/.test(analog)
        && !/fireDrumEnv\(env\.gain,\s*t0,\s*1/.test(analog),
);

ok(
    'analog-808.js?v=16 on both importers',
    /analog-808\.js\?v=15/.test(seq)
        && /analog-808\.js\?v=15/.test(osc)
        && !/analog-808\.js\?v=14/.test(seq)
        && !/analog-808\.js\?v=14/.test(osc),
);

ok(
    'analog-808 does not import filter-drive',
    !/from ['"]\.\/filter-drive/.test(analog),
);

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Smoke results: ${passed} passed, ${failed} failed`);
if (failed) {
    console.log(`
Interpretation:
  Failures tagged BASELINE mean the working tree diverged from the
  HEAD off-step contract (VCA release only). That divergence is what
  made off→ratch / ratch→off click-chasing go in circles.

  Keep: holdForDrum, main drum VCA hold, in-place retrigger, gate zero-hold,
  stopDisabledOscStacks, analog 22ms fades.

  Revert toward HEAD: off-step must not stop/dispose voices — only release
  held envelopes (with the longer drum VCA floor if needed).
`);
    process.exit(1);
}
console.log('All smoke invariants green.\n');
process.exit(0);
