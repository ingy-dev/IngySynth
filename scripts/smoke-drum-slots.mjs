#!/usr/bin/env node
/**
 * Drum patterns P1–P8 follow the pattern selector.
 * The synth clipboard can land on a drum lane or a Berlin lane.
 *
 * Run:
 *   node scripts/smoke-drum-slots.mjs
 */

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
    BANK_COUNT,
    DRUM_LANE_COUNT,
    FACTORY_DRUM_ONS,
    STEP_SLOTS,
    ensureBank,
    ensureBerlinBank,
    ensureBerlinDrumKit,
    ensureDrumPatterns,
    getDrumPattern,
    getPattern,
    getBerlinLane,
    setDrumSlot,
    selectSlot,
    selectBerlinSlot,
    commitPendingSlot,
    copyDrumPatternContent,
    pasteDrumPatternContent,
    copyPatternContent,
    pastePatternContent,
    clearPatternSteps,
    hasPatternClipboard,
    copyBerlinLane,
    copyBerlinPattern,
    pasteBerlinPattern,
    clearBerlinPattern,
    hasBerlinPatternClipboard,
    patternSlotPasteLabel,
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

function factoryOn(lane, step) {
    return (FACTORY_DRUM_ONS[lane] || []).some((n) => (n | 0) - 1 === step);
}

function isFactoryLane(pattern, lane) {
    if (pattern.stepCount !== 8 || Number(pattern.division) !== 8) return false;
    for (let i = 0; i < STEP_SLOTS; i++) {
        if ((pattern.steps[i]?.on === true) !== factoryOn(lane, i)) return false;
    }
    return true;
}

function isFactorySlot(slot) {
    const lanes = state.drumBank[slot]?.lanes;
    if (!lanes || lanes.length !== DRUM_LANE_COUNT) return false;
    return lanes.every((pattern, lane) => isFactoryLane(pattern, lane));
}

console.log('factory drum bank');

ensureBank();
ensureBerlinBank();
ensureBerlinDrumKit();
ensureDrumPatterns();

ok('eight drum slots', state.drumBank.length === BANK_COUNT);
ok('current lanes are the slot reference', state.drumPatterns === state.drumBank[state.drumSlot].lanes);
{
    let factory = true;
    const stepArrays = new Set();
    for (let slot = 0; slot < BANK_COUNT; slot++) {
        if (!isFactorySlot(slot)) factory = false;
        for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
            stepArrays.add(state.drumBank[slot].lanes[lane].steps);
        }
    }
    ok('all 8 drum slots start on the factory beat', factory);
    ok('each lane has its own steps', stepArrays.size === BANK_COUNT * DRUM_LANE_COUNT);
}

console.log('slot edits');

setDrumSlot(1);
getDrumPattern(3).steps[0].on = false;
getDrumPattern(0).steps[0].on = true;
getDrumPattern(0).steps[0].ratch = 4;
ok('editing P2 reads through drumPatterns', state.drumPatterns === state.drumBank[1].lanes);
setDrumSlot(0);
ok('P1 factory kick is unchanged', isFactoryLane(state.drumBank[0].lanes[3], 3));
ok('P1 factory hat is unchanged', isFactoryLane(state.drumBank[0].lanes[0], 0));
ok('P2 keeps the edit', state.drumBank[1].lanes[3].steps[0].on === false
    && state.drumBank[1].lanes[0].steps[0].on === true
    && state.drumBank[1].lanes[0].steps[0].ratch === 4);

console.log('selector and setDrumSlot');

const editBefore = state.editSlot | 0;
const berlinBefore = state.berlinSlot | 0;
setDrumSlot(4, { startTime: 9 });
ok('setDrumSlot changes only the drums', state.drumSlot === 4
    && state.drumPatterns === state.drumBank[4].lanes
    && (state.editSlot | 0) === editBefore
    && (state.berlinSlot | 0) === berlinBefore);
ok('setDrumSlot left the kit in place', state.berlinDrum.length === DRUM_LANE_COUNT);

selectSlot(2);
ok('normal P3 switches the drums', state.editSlot === 2 && state.drumSlot === 2
    && state.drumPatterns === state.drumBank[2].lanes);

state.berlinMode = true;
const editWhileBerlin = state.editSlot | 0;
selectBerlinSlot(6, { startTime: 4 });
ok('Berlin P7 switches the drums and not the normal slot', state.berlinSlot === 6
    && state.drumSlot === 6
    && (state.editSlot | 0) === editWhileBerlin);

state.berlinMode = false;
state.berlinPendingSlot = null;
state.pendingEditSlot = 5;
commitPendingSlot(1.25);
ok('queued normal switch lands the drums on the same slot', state.editSlot === 5 && state.drumSlot === 5);

state.berlinMode = true;
state.berlinSlot = 0;
setDrumSlot(0);
state.berlinPendingSlot = 3;
commitPendingSlot(2.5);
ok('queued Berlin switch lands the drums on the same slot', state.berlinSlot === 3 && state.drumSlot === 3);
state.berlinMode = false;
state.berlinPendingSlot = null;

console.log('shared clipboard');

getPattern(0).steps[0].tune = 11;
getPattern(0).steps[0].on = true;
getPattern(0).steps[0].ratch = 3;
copyPatternContent(0);
state.editSlot = 4;
ok('paste names the copied pattern, not the slot on screen', patternSlotPasteLabel() === 'Paste P1');
state.editSlot = 0;
const otherDrums = JSON.stringify(state.drumBank[1]);
ok('synth copy pastes onto the current drum lane', pasteDrumPatternContent(0) === true
    && state.drumPatterns[0].steps[0].tune === 11
    && state.drumPatterns[0].steps[0].ratch === 3
    && JSON.stringify(state.drumBank[1]) === otherDrums);

setDrumSlot(0);
state.drumBank[0].lanes[3].steps[0].tune = 9;
state.drumBank[0].lanes[3].steps[0].on = false;
copyDrumPatternContent(3);
ok('paste names a copied drum lane', patternSlotPasteLabel() === 'Paste DRM 4');
ok('a drum lane pastes onto a synth pattern', pastePatternContent(5) === true
    && getPattern(5).steps[0].tune === 9
    && getPattern(5).steps[0].on === false);

ensureBerlinBank();
getBerlinLane(0, 0).steps[2].tune = 6;
getBerlinLane(0, 0).steps[2].on = true;
copyBerlinLane(0, 0);
setDrumSlot(2);
ok('a Berlin lane pastes onto the drum slot on screen', pasteDrumPatternContent(1) === true
    && state.drumBank[2].lanes[1].steps[2].tune === 6
    && state.drumBank[0].lanes[1].steps[2].tune !== 6);

const drumsBeforeBerlin = JSON.stringify(state.drumBank);
state.berlinMode = true;
ok('Berlin paste stays blank until a Berlin pattern is copied', patternSlotPasteLabel() === 'Paste');
copyBerlinPattern(2);
state.berlinSlot = 4;
ok('Berlin paste names the copied pattern', patternSlotPasteLabel() === 'Paste P3');
state.berlinMode = false;
state.berlinSlot = 0;
copyBerlinPattern(0);
pasteBerlinPattern(1);
clearBerlinPattern(1);
ok('a whole Berlin pattern copy does not rewrite the drum bank', JSON.stringify(state.drumBank) === drumsBeforeBerlin);
ok('P1 drums are still a different object from P2', state.drumBank[0].lanes !== state.drumBank[1].lanes);
ok('the shared clipboard stays armed beside a Berlin pattern copy', hasPatternClipboard() && hasBerlinPatternClipboard());

console.log('mainstage copy carries drums');
setDrumSlot(0);
state.drumBank[0].lanes[3].steps[4].on = true;
state.drumBank[0].lanes[3].steps[4].ratch = 4;
state.drumBank[0].lanes[1].stepCount = 5;
state.drumBank[0].lanes[1].division = 16;
const p2Before = JSON.stringify(state.drumBank[1]);
copyPatternContent(0);
state.drumBank[0].lanes[3].steps[4].on = false;
state.drumBank[4].lanes[3].steps[4].on = false;
state.drumBank[4].lanes[1].stepCount = 8;
pastePatternContent(4);
ok('pasting P1 onto P5 writes P1 drums', state.drumBank[4].lanes[3].steps[4].on === true
    && state.drumBank[4].lanes[3].steps[4].ratch === 4
    && state.drumBank[4].lanes[1].stepCount === 5
    && Number(state.drumBank[4].lanes[1].division) === 16);
ok('the drum copy does not follow a later edit', state.drumBank[0].lanes[3].steps[4].on === false);
ok('P2 drums are not part of a P1 copy', JSON.stringify(state.drumBank[1]) === p2Before);
const laneTarget = JSON.stringify(state.drumBank[3]);
copyDrumPatternContent(0);
pastePatternContent(3);
ok('pasting one lane does not replace the drum pattern', JSON.stringify(state.drumBank[3]) === laneTarget);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
