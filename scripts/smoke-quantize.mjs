#!/usr/bin/env node
/**
 * Quantize notes onto a 1/16 synth pattern.
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

const { quantizeToPattern } = await import('../js/song-quantize.js?v=1');

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

// Legato → slide. A tie into the next onset does too. vel 1 accents; 0.8 does not.
{
    const { data } = quantizeToPattern([
        note(0, 0, { durTick: 50, vel: 1, legato: true }),
        note(2, SIXTEENTH, { durTick: SIXTEENTH, vel: 0.8, legato: false }),
        note(5, SIXTEENTH * 2, { durTick: 80, vel: 0.8, legato: false }),
    ], { startTick: 0, endTick: SIXTEENTH * 3 });
    expectSig('legato slide and vel 1 accent', data.steps[0], {
        on: true, tune: 0, accent: true, slide: true,
    });
    expectSig('vel 0.8 is not accent, tie sets slide', data.steps[1], {
        on: true, tune: 2, accent: false, slide: true,
    });
    expectSig('following step is not slid', data.steps[2], {
        on: true, tune: 5, accent: false, slide: false,
    });
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

// Notes outside the range are ignored. The range start snaps down to a 16th.
{
    const { data } = quantizeToPattern([
        note(1, 50),
        note(9, 120),
    ], { startTick: 100, endTick: 300 });
    expectSig('onset in the snapped step', data.steps[0], { on: true, tune: 9 });
    ok('partial next step is a rest', data.steps[1].on === false);
    ok('snap span is two steps', data.stepCount === 2 && data.repeat === 1);
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
