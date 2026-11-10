#!/usr/bin/env node
/**
 * Pairing contracts for poly sequencer slide / gliss-roll.
 *
 * Run:
 *   node scripts/smoke-poly-seq-slide.mjs
 */

import {
    pairPolySeqSlidePitches,
    pairPolySeqGlissPitches,
    sortedPolySeqIntervals,
} from '../js/poly-seq-slide.js';

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

function pitches(pairs) {
    return pairs.map((p) => `${p.from}->${p.to}${p.same ? '(same)' : ''}`).join(' ');
}

console.log('poly seq slide pairing');

ok(
    'sorts intervals low-to-low',
    sortedPolySeqIntervals([7, 0, 4]).join(',') === '0,4,7',
);

{
    const p = pairPolySeqSlidePitches(0, [0, 4, 7], 2, [0, 4, 7]);
    ok('C-E-G → D-F#-A three parallel slews', pitches(p) === '0->2 4->6 7->9', pitches(p));
    ok('none marked same', p.every((x) => !x.same));
}

{
    const p = pairPolySeqSlidePitches(0, [0, 4, 7], 0, [0, 4, 7]);
    ok('same chord is tie (all same)', p.every((x) => x.same) && pitches(p) === '0->0(same) 4->4(same) 7->7(same)', pitches(p));
}

{
    const p = pairPolySeqSlidePitches(0, [0, 4, 7], 0, [0, 7]);
    ok('3→2 drops the extra dest (engine releases surplus)', p.length === 2 && pitches(p) === '0->0(same) 4->7', pitches(p));
}

{
    const p = pairPolySeqSlidePitches(0, [0], 0, [0, 4, 7]);
    ok('1→3 new tones slew from previous root', pitches(p) === '0->0(same) 0->4 0->7', pitches(p));
}

{
    const p = pairPolySeqGlissPitches(0, [0, 4, 7], 2, [0, 4, 7]);
    ok('gliss this chord → next chord', pitches(p) === '0->2 4->6 7->9', pitches(p));
}

{
    const p = pairPolySeqGlissPitches(0, [0, 4, 7], 0, [0, 4, 7]);
    ok('gliss same chord is no-op ramp', p.every((x) => x.same), pitches(p));
}

{
    const p = pairPolySeqGlissPitches(0, [0, 4, 7], 2, [0, 7]);
    ok('gliss extra this-tone holds', pitches(p) === '0->2 4->9 7->7(same)', pitches(p));
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\nsource contracts');

const seq = read('js/sequencer.js');
const poly = read('js/poly-voice.js');

ok('lastPolySounding stores root+intervals', /lastPolySounding = \{\s*root: soundingRoot[^,]*,\s*intervals: intervals\.slice\(\),?\s*\}/.test(seq));
ok('playPolySeqStep receives nextStepWillSlideEnv and glissRoll', /nextStepWillSlideEnv,\s*glissRoll/.test(seq));
ok('pulse ratch off on slide dest', /pulseRatch = hits > 1 && !slideThisStep/.test(seq));
ok('OFF releases poly slide-hold', /lastPolySeqHeld/.test(seq) && /releasePolySeqHold\(startTime\)/.test(seq));
ok('MIDI overlap on slide-out', /holdGate \? stepDuration \* 1\.1/.test(seq));
ok('slew every paired voice (not root-only)', /slidePairs\[i\]/.test(poly) || /pairAt\(i\)/.test(poly));
ok('slide dest skips amp retrigger on reused voices', /if \(!slideThisStep\) \{\s*triggerVoiceAmp\(voice, when/.test(poly));
ok('gliss uses linearRampToValueAtTime', /linearRampToValueAtTime/.test(poly));
ok('releasePolySeqHold exported', /export function releasePolySeqHold/.test(poly));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
