#!/usr/bin/env node
/**
 * Quantize notes onto a synth pattern: snapping, ties, slides, ratchets, grids.
 * Run: node scripts/smoke-quantize.mjs
 */

globalThis.document ??= {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
};

const { quantizeToPattern } = await import('../js/song-quantize.js?v=19');

const SIXTEENTH = 240;
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

function note(semi, startTick, extra = {}) {
    return {
        semi,
        fine: 0,
        startTick,
        durTick: 40,
        vel: 0.5,
        legato: false,
        ...extra,
    };
}

function sig(step) {
    return JSON.stringify({
        on: !!step?.on,
        tune: step?.tune,
        fine: step?.fine,
        accent: !!step?.accent,
        slide: !!step?.slide,
        ratch: step?.ratch,
        chord: step?.chord || [],
    });
}

function expectSig(name, step, spec) {
    const want = sig({
        on: false,
        tune: 0,
        fine: 0,
        accent: false,
        slide: false,
        ratch: 1,
        chord: [],
        ...spec,
    });
    ok(name, sig(step) === want, `got ${sig(step)} want ${want}`);
}

function expectShape(name, result, { stepCount, repeat, truncated }) {
    const data = result?.data;
    ok(`${name} truncated`, result?.truncated === truncated);
    ok(`${name} stepCount`, data?.stepCount === stepCount, `got ${data?.stepCount}`);
    ok(`${name} repeat`, data?.repeat === repeat, `got ${data?.repeat}`);
    ok(`${name} division 16`, data?.division === 16);
    ok(`${name} gate`, data?.gate === 0.9);
    ok(`${name} reverse off`, data?.reverse === false);
    ok(`${name} enabled`, data?.enabled === true);
    ok(`${name} 32 steps`, Array.isArray(data?.steps) && data.steps.length === 32, `len ${data?.steps?.length}`);
}

console.log('smoke-quantize.mjs');

// Chord → chord[]. Different pitches are not a ratchet.
{
    const { data, truncated } = quantizeToPattern([
        note(7, 0),
        note(0, 0),
        note(4, 0),
        note(12, 500),
    ], { startTick: 0, endTick: SIXTEENTH });
    expectShape('chord', { data, truncated }, { stepCount: 1, repeat: 1, truncated: false });
    expectSig('chord step', data.steps[0], {
        on: true, tune: 0, chord: [4, 7], ratch: 1,
    });
    ok('chord pads the rest', data.steps[1].on === false && data.steps[1].ratch === 1);
}

// Slide into a new note: the note before overlaps it, or the new note is legato and
// starts where the old one ends. Notes that only touch do not slide. vel 1 accents; 0.8 does not.
{
    const { data } = quantizeToPattern([
        note(0, 0, { durTick: SIXTEENTH + 20, vel: 1 }),
        note(2, SIXTEENTH, { durTick: SIXTEENTH, vel: 0.8 }),
        note(5, SIXTEENTH * 2, { durTick: SIXTEENTH, vel: 0.8 }),
        note(7, SIXTEENTH * 3, { durTick: 80, vel: 0.8, legato: true }),
    ], { startTick: 0, endTick: SIXTEENTH * 4 });
    expectSig('overlap slides, vel 1 accents', data.steps[0], {
        on: true, tune: 0, accent: true, slide: true,
    });
    expectSig('touching notes do not slide, vel 0.8 is not accent', data.steps[1], {
        on: true, tune: 2, accent: false, slide: false,
    });
    expectSig('a legato note slides the step before it', data.steps[2], {
        on: true, tune: 5, slide: true,
    });
    expectSig('the legato note itself is not slid', data.steps[3], {
        on: true, tune: 7, slide: false,
    });
}

// A long note fills its steps, tied by Slide on all but the last. 1.4 steps is one step.
{
    const { data } = quantizeToPattern([
        note(0, 0, { durTick: SIXTEENTH * 3 }),
        note(5, SIXTEENTH * 4, { durTick: 336 }),
        note(5, SIXTEENTH * 6, { durTick: SIXTEENTH * 2 }),
    ], { startTick: 0, endTick: SIXTEENTH * 8 });
    expectSig('tie step 1', data.steps[0], { on: true, tune: 0, slide: true });
    expectSig('tie step 2', data.steps[1], { on: true, tune: 0, slide: true });
    expectSig('tie last step', data.steps[2], { on: true, tune: 0, slide: false });
    ok('rest after the tie', data.steps[3].on === false);
    expectSig('1.4 steps is one step', data.steps[4], { on: true, tune: 5, slide: false });
    ok('rest after the short note', data.steps[5].on === false);
    expectSig('tie to the range end', data.steps[6], { on: true, tune: 5, slide: true });
    expectSig('last step does not slide round the loop', data.steps[7], { on: true, tune: 5, slide: false });
}

// A same-pitch note struck again ends the tie before it.
{
    const { data } = quantizeToPattern([
        note(3, 0, { durTick: SIXTEENTH * 2 }),
        note(3, SIXTEENTH * 2, { durTick: SIXTEENTH * 2 }),
    ], { startTick: 0, endTick: SIXTEENTH * 4 });
    expectSig('tie into the second step', data.steps[0], { on: true, tune: 3, slide: true });
    expectSig('no slide into the re-strike', data.steps[1], { on: true, tune: 3, slide: false });
    ok('the two notes fold to a 2-step phrase twice', data.stepCount === 2 && data.repeat === 2);
}

// Onsets snap to the nearest step: early and late notes keep their beat.
{
    const { data } = quantizeToPattern([
        note(0, -20),
        note(2, SIXTEENTH - 25),
        note(4, SIXTEENTH * 2 + 30),
        note(9, SIXTEENTH * 4 - 15),
    ], { startTick: 0, endTick: SIXTEENTH * 4 });
    ok('early and late notes snap', [0, 2, 4].every((semi, i) => data.steps[i].on && data.steps[i].tune === semi));
    ok('a note early for the next range is left out', data.steps[3].on === false);
}

// A note held over the range start (clip trimmed through it) plays from step 1.
{
    const { data } = quantizeToPattern([
        note(12, -SIXTEENTH * 4, { durTick: SIXTEENTH * 7 }),
        note(0, SIXTEENTH * 4),
    ], { startTick: 0, endTick: SIXTEENTH * 8 });
    expectSig('held note starts the range', data.steps[0], { on: true, tune: 12, slide: true });
    expectSig('held note keeps its length', data.steps[2], { on: true, tune: 12, slide: false });
    ok('then a rest', data.steps[3].on === false);
    expectSig('later note kept', data.steps[4], { on: true, tune: 0 });
}
{
    const { data } = quantizeToPattern([
        note(12, -SIXTEENTH * 4, { durTick: SIXTEENTH * 4 + 60 }),
        note(0, SIXTEENTH),
    ], { startTick: 0, endTick: SIXTEENTH * 2 });
    ok('a sliver held over the start is dropped', data.steps[0].on === false && data.steps[1].tune === 0);
}

// A held note under a new note: cut unless it lasts through the new note's whole step.
{
    const { data } = quantizeToPattern([
        note(-12, 0, { durTick: SIXTEENTH * 4 }),
        note(7, SIXTEENTH * 2, { durTick: 100 }),
    ], { startTick: 0, endTick: SIXTEENTH * 4 });
    expectSig('pedal joins the new note as a chord', data.steps[2], { on: true, tune: -12, chord: [19], slide: true });
    expectSig('pedal carries on alone', data.steps[3], { on: true, tune: -12 });
}

// Same pitch twice in one step → ratch 2. Mixed repeats use the highest count.
{
    const { data } = quantizeToPattern([
        note(5, 0, { durTick: 20 }),
        note(5, 80, { durTick: 20 }),
        note(0, SIXTEENTH, { durTick: 10 }),
        note(0, SIXTEENTH + 40, { durTick: 10 }),
        note(0, SIXTEENTH + 80, { durTick: 10 }),
        note(4, SIXTEENTH + 20, { durTick: 10 }),
        note(4, SIXTEENTH + 120, { durTick: 10 }),
    ], { startTick: 0, endTick: SIXTEENTH * 2 });
    expectSig('two hits ratch 2', data.steps[0], {
        on: true, tune: 5, ratch: 2, chord: [], slide: false,
    });
    expectSig('highest repeat is ratch, other pitch is chord', data.steps[1], {
        on: true, tune: 0, chord: [4], ratch: 3, slide: false,
    });
}

{
    const hits = [];
    for (let i = 0; i < 5; i += 1) hits.push(note(3, i * 30, { durTick: 10 }));
    const { data } = quantizeToPattern(hits, { startTick: 0, endTick: SIXTEENTH });
    expectSig('five hits clamp ratch to 4', data.steps[0], {
        on: true, tune: 3, ratch: 4, chord: [],
    });
}

// Shared fine is kept. Mixed fine becomes 0.
{
    const { data } = quantizeToPattern([
        note(1, 0, { fine: 15 }),
        note(1, 40, { fine: 15 }),
        note(2, SIXTEENTH, { fine: 15 }),
        note(2, SIXTEENTH + 40, { fine: 3 }),
    ], { startTick: 0, endTick: SIXTEENTH * 2 });
    ok('shared fine kept', data.steps[0].fine === 15 && data.steps[0].ratch === 2);
    ok('mixed fine is 0', data.steps[1].fine === 0);
}

// A range drawn by hand: notes before it are ignored and both edges snap to the nearest step.
{
    const { data } = quantizeToPattern([
        note(1, 50),
        note(9, 250),
        note(4, 250 + SIXTEENTH * 3),
    ], { startTick: 200, endTick: SIXTEENTH * 5 + 30 });
    expectSig('first note in the range is step 1', data.steps[0], { on: true, tune: 9 });
    expectSig('last note kept', data.steps[3], { on: true, tune: 4 });
    ok('drawn a little over a beat is still 4 steps', data.stepCount === 4 && data.repeat === 1, `got ${data.stepCount} x${data.repeat}`);
}

// Triplet onsets pick a triplet grid.
{
    const notes = [0, 1, 2, 3, 4, 5].map((semi, i) => note(semi, i * 320 + (i % 2 ? 6 : -6)));
    const { data } = quantizeToPattern(notes, { startTick: 0, endTick: 1920 });
    ok('1/8T grid', data.division === 12 && data.stepCount === 6, `got ${data.division} / ${data.stepCount}`);
    ok('one note per triplet step', [0, 1, 2, 3, 4, 5].every((semi, i) => data.steps[i].tune === semi));
}

// A range longer than 32 sixteenths uses 1/8 steps when every note starts on one.
{
    const notes = [];
    for (let i = 0; i < 32; i += 1) notes.push(note(i, i * SIXTEENTH * 2));
    const fits = quantizeToPattern(notes, { startTick: 0, endTick: 64 * SIXTEENTH });
    ok('1/8 grid keeps all four bars', fits.data.division === 8 && fits.data.stepCount === 32 && fits.truncated === false);
    notes.push(note(40, SIXTEENTH));
    const cut = quantizeToPattern(notes, { startTick: 0, endTick: 64 * SIXTEENTH });
    ok('an off-16th note keeps 1/16 and truncates', cut.data.division === 16 && cut.truncated === true);
}

// 16 sixteenths that are an 8-step phrase twice.
{
    const phrase = [0, null, 3, null, 5, null, null, 7];
    const notes = [];
    for (let rep = 0; rep < 2; rep += 1) {
        phrase.forEach((semi, i) => {
            if (semi == null) return;
            notes.push(note(semi, (rep * 8 + i) * SIXTEENTH));
        });
    }
    const result = quantizeToPattern(notes, { startTick: 0, endTick: 16 * SIXTEENTH });
    expectShape('8 twice', result, { stepCount: 8, repeat: 2, truncated: false });
    expectSig('phrase step 0', result.data.steps[0], { on: true, tune: 0 });
    expectSig('phrase step 2', result.data.steps[2], { on: true, tune: 3 });
    expectSig('phrase step 4', result.data.steps[4], { on: true, tune: 5 });
    expectSig('phrase step 7', result.data.steps[7], { on: true, tune: 7 });
    ok('phrase rests', [1, 3, 5, 6].every((i) => result.data.steps[i].on === false));
    ok('period is stored once', result.data.steps[8].on === false);
}

// 40 steps with an exact period of 5 repeat 8 times and are not truncated.
{
    const phrase = [1, null, 4, null, null];
    const notes = [];
    for (let rep = 0; rep < 8; rep += 1) {
        phrase.forEach((semi, i) => {
            if (semi == null) return;
            notes.push(note(semi, (rep * 5 + i) * SIXTEENTH));
        });
    }
    const result = quantizeToPattern(notes, { startTick: 0, endTick: 40 * SIXTEENTH });
    expectShape('period inside 40', result, { stepCount: 5, repeat: 8, truncated: false });
    expectSig('period step 0', result.data.steps[0], { on: true, tune: 1 });
    expectSig('period step 2', result.data.steps[2], { on: true, tune: 4 });
    ok('period unused steps rest', result.data.steps[5].on === false);
}

// 40 unique steps have no legal period, so the pattern truncates to 32.
{
    const notes = [];
    for (let i = 0; i < 40; i += 1) notes.push(note(i, i * SIXTEENTH));
    const result = quantizeToPattern(notes, { startTick: 0, endTick: 40 * SIXTEENTH });
    expectShape('40 unique', result, { stepCount: 32, repeat: 1, truncated: true });
    expectSig('kept first step', result.data.steps[0], { on: true, tune: 0 });
    expectSig('kept last of 32', result.data.steps[31], { on: true, tune: 31 });
    ok('step 33 is dropped', result.data.steps.every((step) => step.tune !== 39));
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
