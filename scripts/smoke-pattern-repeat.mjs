#!/usr/bin/env node
/**
 * Repeat Pattern cycle boundaries, and Berlin bank vs normal P1–P8.
 *
 * Run:
 *   node scripts/smoke-pattern-repeat.mjs
 */

import { nextCyclePass, clampRepeat, nextRepeat } from '../js/pattern-repeat.js';

globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
};

const { state } = await import('../js/state.js?v=119');
const {
    ensureBank,
    ensureBerlinBank,
    getPattern,
    getBerlinPattern,
    getBerlinLane,
    patternRepeat,
    copyPatternContent,
    pastePatternContent,
    copyBerlinPattern,
    pasteBerlinPattern,
    seedBerlinO1FromMain,
} = await import('../js/pattern-bank.js');

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

function runCycle(repeat, steps, first = true) {
    let pass = 0;
    let isFirst = first;
    const starts = [];
    for (let i = 0; i < steps; i++) {
        const next = nextCyclePass(pass, repeat, isFirst);
        isFirst = false;
        pass = next.cyclePass;
        if (next.isCycleStart) starts.push(i);
    }
    return { pass, starts };
}

console.log('repeat cycle');

ok('clamp rejects junk', clampRepeat('nope') === 1 && clampRepeat(0) === 1 && clampRepeat(9) === 8 && clampRepeat(4.6) === 5);
ok('repeat press cycles 1→2→8→1', nextRepeat(1) === 2 && nextRepeat(7) === 8 && nextRepeat(8) === 1 && nextRepeat(3) === 4);

{
    const x1 = runCycle(1, 6, true);
    ok('x1 starts a cycle on every pass', x1.starts.join(',') === '0,1,2,3,4,5', x1.starts.join(','));
}

{
    const x4 = runCycle(4, 8, true);
    ok('x4 cycle starts every 4 passes', x4.starts.join(',') === '0,4', x4.starts.join(','));
    ok('x4 ends on pass index 3', x4.pass === 3, String(x4.pass));
}

{
    // Mid-cycle: stored pass 3 (4th pass) and the user drops repeat to 2.
    // The next boundary ends the cycle. It does not cut the pass itself.
    const next = nextCyclePass(3, 2, false);
    ok('repeat drop ends at the next pass', next.isCycleStart && next.cyclePass === 0);
}

{
    // Stored pass 1 and the user raises repeat to 8: the cycle grows.
    const next = nextCyclePass(1, 8, false);
    ok('repeat raise waits', !next.isCycleStart && next.cyclePass === 2);
}

{
    // A commit lands on a cycle start, so the incoming pattern's pass index stays 0.
    const landed = nextCyclePass(3, 4, false);
    ok('commit lands at pass 0', landed.isCycleStart && landed.cyclePass === 0);
}

console.log('berlin bank');

ensureBank();
ensureBerlinBank();

getPattern(0).steps[0].tune = 7;
getPattern(0).repeat = 3;
getBerlinLane(0, 0).steps[0].tune = 3;
getBerlinLane(0, 1).steps[0].tune = 9;
getBerlinPattern(2).repeat = 4;

ok('normal P1 tune is not a Berlin lane', getPattern(0).steps[0].tune === 7);
ok('Berlin P1 lane is separate', getBerlinLane(0, 0).steps[0].tune === 3);
state.berlinSlot = 1;
ok('current Berlin slot follows berlinSlot', getBerlinLane(0).steps[0].tune === 9);
ok('normal P2 was not overwritten', getPattern(1).steps[0].tune !== 9);
state.berlinSlot = 0;
ok('normal repeat stays on the normal pattern', patternRepeat(getPattern(0)) === 3);
ok('Berlin repeat is per Berlin pattern', patternRepeat(getBerlinPattern(2)) === 4 && patternRepeat(getBerlinPattern(0)) === 1);
ok('Berlin P1 has 8 lanes and 3 osc', getBerlinPattern(0).lanes.length === 8 && getBerlinPattern(0).oscCount === 3);
ok('Berlin P1 lane 0 is on (factory)', getBerlinLane(0, 0).steps[0].on !== false);
ok('Berlin P2 lane 0 is on (factory)', getBerlinLane(0, 1).steps[0].on !== false);
{
    let allOn = true;
    for (let slot = 0; slot < 8 && allOn; slot++) {
        const pattern = getBerlinPattern(slot);
        for (let row = 0; row < pattern.lanes.length && allOn; row++) {
            const steps = pattern.lanes[row].steps || [];
            for (let s = 0; s < steps.length; s++) {
                if (steps[s].on === false) allOn = false;
            }
        }
    }
    ok('every Berlin pattern step starts on', allOn);
}
ok('Berlin P2 copied P1 clock', getBerlinLane(0, 1).stepCount === getBerlinLane(0, 0).stepCount
    && getBerlinLane(0, 1).division === getBerlinLane(0, 0).division);
ok('normal pattern has no lane destination', getPattern(0).destination === undefined);

copyBerlinPattern(0);
const pasted = pasteBerlinPattern(3);
ok('Berlin paste stays in the Berlin bank', pasted && getBerlinLane(0, 3).steps[0].tune === 3);
ok('Berlin paste did not touch normal P4', getPattern(3).steps[0].tune !== 3);

copyPatternContent(0);
const normalPaste = pastePatternContent(4);
ok('normal paste keeps repeat', normalPaste && patternRepeat(getPattern(4)) === 3 && getPattern(4).steps[0].tune === 7);

console.log('berlin o1 seed');

getPattern(1).steps[2].tune = 11;
getPattern(1).steps[2].on = false;
getPattern(1).steps[2].accent = true;
getPattern(1).steps[2].slide = true;
getPattern(1).stepCount = 12;
getPattern(1).division = 16;
getPattern(1).reverse = true;
getPattern(1).repeat = 6;
getPattern(1).gate = 0.5;
getPattern(3).steps[0].tune = 4;
getBerlinLane(1, 1).steps[2].tune = 2;

const seeded = seedBerlinO1FromMain();
const o1 = getBerlinLane(0, 1);
ok('first open copies P2 onto that slot O1', seeded
    && o1.steps[2].tune === 11
    && o1.steps[2].on === false
    && o1.steps[2].accent === true
    && o1.steps[2].slide === true
    && o1.stepCount === 12
    && o1.division === 16
    && o1.reverse === true
    && patternRepeat(getBerlinPattern(1)) === 6
    && Math.abs(o1.gate - 0.5) < 0.001);
ok('P4 lands on Berlin P4 O1', getBerlinLane(0, 3).steps[0].tune === 4);
ok('O2 is not replaced', getBerlinLane(1, 1).steps[2].tune === 2);
ok('main P2 is a copy, not the same array', getPattern(1).steps !== o1.steps);

getPattern(1).steps[2].tune = 1;
ok('opening again does not reimport', seedBerlinO1FromMain() === false && o1.steps[2].tune === 11);
ok('later main edits stay on the main bank', getPattern(1).steps[2].tune === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
