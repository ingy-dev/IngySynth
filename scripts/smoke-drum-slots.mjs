#!/usr/bin/env node
/**
 * Drum patterns P1–P8 follow the pattern selector.
 * The step clipboard can land on a drum lane or a Berlin lane.
 * A synth pattern copy does not carry that slot's drums.
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

const { state } = await import('../js/state.js?v=120');
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
    SONG_SLOT,
    copyDrumBank,
    pasteDrumBank,
    clearDrumBank,
    hasDrumBankClipboard,
    snapshotDrumSlot,
    writeDrumSlot,
    snapshotSynthSlot,
    writeSynthSlot,
    loadSongSlot,
    patternHash,
    getBerlinPattern,
    requestSlot,
    syncPatternSlotUi,
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

console.log('mainstage copy does not carry drums');
setDrumSlot(0);
state.drumBank[0].lanes[3].steps[4].on = true;
state.drumBank[0].lanes[3].steps[4].ratch = 4;
state.drumBank[0].lanes[1].stepCount = 5;
state.drumBank[0].lanes[1].division = 16;
getPattern(0).steps[0].tune = 12;
getPattern(0).steps[0].on = true;
const p2Before = JSON.stringify(state.drumBank[1]);
copyPatternContent(0);
state.drumBank[0].lanes[3].steps[4].on = false;
state.drumBank[4].lanes[3].steps[4].on = false;
state.drumBank[4].lanes[1].stepCount = 8;
state.drumBank[4].lanes[1].division = 8;
const drumsAtPaste = JSON.stringify(state.drumBank);
pastePatternContent(4);
ok('pasting a synth pattern does not write drums', JSON.stringify(state.drumBank) === drumsAtPaste
    && state.drumBank[4].lanes[3].steps[4].on === false
    && state.drumBank[4].lanes[1].stepCount === 8
    && Number(state.drumBank[4].lanes[1].division) === 8);
ok('the synth paste still lands on the synth pattern', getPattern(4).steps[0].tune === 12
    && getPattern(4).steps[0].on === true);
ok('P2 drums are not part of a P1 copy', JSON.stringify(state.drumBank[1]) === p2Before);
const laneTarget = JSON.stringify(state.drumBank[3]);
copyDrumPatternContent(0);
pastePatternContent(3);
ok('pasting one lane does not replace the drum pattern', JSON.stringify(state.drumBank[3]) === laneTarget);

console.log('drum bank clipboard');

setDrumSlot(0);
state.drumBank[0].lanes[1].steps[2].on = true;
state.drumBank[0].lanes[1].steps[2].tune = 8;
state.drumBank[0].lanes[1].stepCount = 11;
state.drumBank[0].lanes[1].division = 16;
state.drumBank[0].lanes[1].reverse = true;
state.drumBank[0].lanes[1].gate = 0.4;
state.drumBank[0].lanes[1].enabled = false;
ok('drum paste is empty until a drum pattern is copied', hasDrumBankClipboard() === false && pasteDrumBank(5) === false);
copyDrumBank(0);
state.drumBank[0].lanes[1].steps[2].tune = 1;
getPattern(2).steps[0].tune = 19;
const pattern5Before = JSON.stringify(getPattern(5));
copyPatternContent(2);
ok('a synth copy does not clobber the drum clipboard', hasDrumBankClipboard() === true);
ok('pasteDrumBank does not change the synth pattern', pasteDrumBank(5) === true
    && JSON.stringify(getPattern(5)) === pattern5Before
    && getPattern(2).steps[0].tune === 19);
ok('pasteDrumBank writes the copied drums, not a later edit', state.drumBank[5].lanes[1].steps[2].on === true
    && state.drumBank[5].lanes[1].steps[2].tune === 8
    && state.drumBank[5].lanes[1].stepCount === 11
    && Number(state.drumBank[5].lanes[1].division) === 16);
clearDrumBank(5);
{
    let allOff = true;
    for (let lane = 0; lane < DRUM_LANE_COUNT; lane++) {
        const pattern = state.drumBank[5].lanes[lane];
        for (let step = 0; step < STEP_SLOTS; step++) {
            if (pattern.steps[step]?.on !== false) allOff = false;
        }
    }
    ok('clearDrumBank turns D1–D4 steps off', allOff);
}
ok('clearDrumBank keeps stepCount and division', state.drumBank[5].lanes[1].stepCount === 11
    && Number(state.drumBank[5].lanes[1].division) === 16
    && state.drumBank[5].lanes[0].stepCount === 8);
ok('clearDrumBank keeps reverse, gate, and enabled', state.drumBank[5].lanes[1].reverse === true
    && Math.abs(state.drumBank[5].lanes[1].gate - 0.4) < 1e-6
    && state.drumBank[5].lanes[1].enabled === false);
{
    const whole = JSON.stringify(state.drumBank);
    copyPatternContent(1);
    pastePatternContent(6);
    ok('synth copy/paste does not change any drum bank slot', JSON.stringify(state.drumBank) === whole);
}

console.log('followDrums');

setDrumSlot(1);
selectSlot(4);
ok('selectSlot still moves drums by default', state.editSlot === 4 && state.drumSlot === 4
    && state.drumPatterns === state.drumBank[4].lanes);
state.berlinMode = true;
selectBerlinSlot(6);
ok('selectBerlinSlot still moves drums by default', state.berlinSlot === 6 && state.drumSlot === 6
    && state.drumPatterns === state.drumBank[6].lanes);
state.berlinMode = false;
setDrumSlot(1);
const drumLanes = state.drumPatterns;
const drumSlotBefore = state.drumSlot;
selectSlot(3, { followDrums: false });
ok('selectSlot can leave the drums put', state.editSlot === 3
    && state.drumSlot === drumSlotBefore
    && state.drumPatterns === drumLanes);
state.berlinMode = true;
selectBerlinSlot(0, { followDrums: false });
ok('selectBerlinSlot can leave the drums put', state.berlinSlot === 0
    && state.drumSlot === drumSlotBefore
    && state.drumPatterns === drumLanes);
state.berlinMode = false;

console.log('song scratch');

{
    const scratch = getPattern(SONG_SLOT);
    ok('song synth scratch is not a bank pattern', scratch !== state.patterns[7]
        && state.patterns.every((pattern) => pattern !== scratch));
    ok('song synth scratch starts as an empty normal pattern', scratch.steps.length === STEP_SLOTS
        && scratch.stepCount === 8
        && scratch.division === 8
        && scratch.reverse === false
        && scratch.enabled === true
        && scratch.gate === 0.9
        && scratch.repeat === 1);
    const berlinScratch = getBerlinPattern(SONG_SLOT);
    ok('song Berlin scratch is not P8', berlinScratch !== state.berlinBank[7]
        && berlinScratch.lanes.length === 8
        && berlinScratch.oscCount === 4
        && berlinScratch.modCount === 1
        && berlinScratch.repeat === 1);
    ok('getBerlinLane reads the song scratch', getBerlinLane(3, SONG_SLOT) === berlinScratch.lanes[3]);

    const banks = {
        patterns: JSON.stringify(state.patterns),
        berlin: JSON.stringify(state.berlinBank),
        drums: JSON.stringify(state.drumBank),
    };
    const normalSnap = snapshotSynthSlot('n', 0);
    const normalTune = normalSnap.steps[0].tune;
    normalSnap.steps[0].tune = normalTune + 3;
    loadSongSlot('n', normalSnap);
    const berlinSnap = snapshotSynthSlot('b', 0);
    berlinSnap.lanes[0].steps[1].tune = 6;
    loadSongSlot('b', berlinSnap);
    const drumSnap = snapshotDrumSlot(0);
    drumSnap[0].steps[0].on = !drumSnap[0].steps[0].on;
    loadSongSlot('d', drumSnap);
    ok('writing the scratch does not change P1–P8', JSON.stringify(state.patterns) === banks.patterns
        && JSON.stringify(state.berlinBank) === banks.berlin
        && JSON.stringify(state.drumBank) === banks.drums);
    ok('scratch synth took the loaded copy', getPattern(SONG_SLOT).steps[0].tune === normalTune + 3
        && getPattern(0).steps[0].tune === normalTune);
    ok('a snapshot edit does not leak into the bank or the scratch', (() => {
        normalSnap.steps[0].tune = normalTune + 9;
        return getPattern(0).steps[0].tune === normalTune
            && getPattern(SONG_SLOT).steps[0].tune === normalTune + 3;
    })());
    ok('scratch Berlin and drums took their copies', getBerlinPattern(SONG_SLOT).lanes[0].steps[1].tune === 6
        && state.songDrumLanes[0].steps[0].on === drumSnap[0].steps[0].on);

    const songFrozen = {
        n: JSON.stringify(state.songPattern),
        b: JSON.stringify(state.songBerlinPattern),
        d: JSON.stringify(state.songDrumLanes),
    };
    state.editSlot = 5;
    state.berlinSlot = 5;
    state.berlinMode = false;
    setDrumSlot(5);
    writeSynthSlot('n', 1, snapshotSynthSlot('n', 2));
    writeSynthSlot('b', 1, snapshotSynthSlot('b', 2));
    writeDrumSlot(1, snapshotDrumSlot(2));
    ok('writing P1–P8 does not change the scratch', JSON.stringify(state.songPattern) === songFrozen.n
        && JSON.stringify(state.songBerlinPattern) === songFrozen.b
        && JSON.stringify(state.songDrumLanes) === songFrozen.d);

    const bankSlots = state.drumBank.slice();
    const bankLanes = state.drumBank.map((slot) => slot.lanes);
    setDrumSlot(SONG_SLOT);
    ok('setDrumSlot(8) points at song drums', state.drumSlot === SONG_SLOT
        && state.drumPatterns === state.songDrumLanes
        && state.drumBank.every((slot) => slot.lanes !== state.songDrumLanes));
    ok('setDrumSlot(8) does not replace drum bank slots', bankSlots.every((slot, i) => state.drumBank[i] === slot)
        && bankLanes.every((lanes, i) => state.drumBank[i].lanes === lanes)
        && state.drumBank.length === BANK_COUNT);

    const p8 = JSON.stringify(state.patterns[7]);
    const b8 = JSON.stringify(state.berlinBank[7]);
    const d8 = JSON.stringify(state.drumBank[7]);
    state.editSlot = 0;
    selectSlot(SONG_SLOT);
    ok('selectSlot(8) hydrates the scratch and skips P8', state.editSlot === SONG_SLOT
        && getPattern(SONG_SLOT) !== state.patterns[7]
        && JSON.stringify(state.patterns[7]) === p8
        && JSON.stringify(state.drumBank[7]) === d8);
    selectBerlinSlot(SONG_SLOT);
    ok('selectBerlinSlot(8) hydrates the scratch and skips P8', state.berlinSlot === SONG_SLOT
        && getBerlinPattern(SONG_SLOT) !== state.berlinBank[7]
        && JSON.stringify(state.berlinBank[7]) === b8
        && state.patterns.every((pattern) => pattern !== getPattern(SONG_SLOT)));
    state.berlinMode = false;
}

console.log('song playing ignores pattern presses');

state.editSlot = 2;
state.berlinSlot = 3;
state.drumSlot = 4;
state.berlinMode = false;
state.pendingEditSlot = 1;
state.berlinPendingSlot = 5;
state.songPlaying = true;
requestSlot(7);
ok('requestSlot does nothing while a song is playing', state.editSlot === 2
    && state.berlinSlot === 3
    && state.drumSlot === 4);
ok('commitPendingSlot does nothing while a song is playing', commitPendingSlot(1.5) === false
    && state.editSlot === 2
    && state.drumSlot === 4);
state.berlinMode = true;
requestSlot(0);
ok('Berlin presses do nothing while a song is playing', commitPendingSlot(2) === false
    && state.berlinSlot === 3
    && state.editSlot === 2
    && state.drumSlot === 4);
selectSlot(6, { followDrums: false });
ok('selectSlot still works while a song is playing', state.editSlot === 6 && state.drumSlot === 4);
state.songPlaying = false;
state.berlinMode = false;

console.log('pattern hash');

{
    const hash = patternHash('n', 0);
    ok('identical snapshots hash the same', hash === patternHash('n', 0) && typeof hash === 'string');
    const step = getPattern(0).steps[0];
    const tune = step.tune;
    step.tune = tune + 1;
    ok('patternHash changes when a step changes', patternHash('n', 0) !== hash);
    step.tune = tune;
    ok('patternHash returns when the step is restored', patternHash('n', 0) === hash);
    const snap = snapshotSynthSlot('n', 0);
    loadSongSlot('n', snap);
    ok('two copies of one snapshot hash equal', patternHash('n', 0) === patternHash('n', SONG_SLOT));
}

console.log('slot 8 lights no pattern button');

{
    const buttons = [];
    for (let slot = 0; slot < BANK_COUNT; slot++) {
        const classes = new Map();
        buttons.push({
            dataset: { slot: String(slot) },
            classList: {
                toggle(name, on) { classes.set(name, !!on); },
            },
            attrs: {},
            setAttribute(name, value) { this.attrs[name] = value; },
            removeAttribute(name) { delete this.attrs[name]; },
            querySelector() { return null; },
            classes,
        });
    }
    const previous = document.querySelectorAll;
    document.querySelectorAll = (sel) => (sel === '.pattern-slot-btn' ? buttons : []);
    state.berlinMode = false;
    state.editSlot = SONG_SLOT;
    state.pendingEditSlot = null;
    state.berlinPendingSlot = null;
    let threw = false;
    try {
        syncPatternSlotUi();
    } catch (err) {
        threw = true;
    }
    document.querySelectorAll = previous;
    ok('syncPatternSlotUi accepts the song slot', threw === false);
    ok('no P1–P8 button lights for the song slot', buttons.every((btn) => btn.classes.get('off') === true
        && btn.attrs['aria-pressed'] === 'false'));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
