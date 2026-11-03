#!/usr/bin/env node
/**
 * Arrangement song model smoke test.
 *
 * Undo extra convention (locked here): `undo()` returns the bank payload
 * stored by retargetClip or checkpointUndo. checkpointUndo does not edit
 * clips. `redo()` always returns `extra: null`.
 *
 * Run: node scripts/smoke-song.mjs
 */

import {
    BAR_TICKS,
    PPQ,
    buildCues,
    canRedo,
    canUndo,
    checkpointUndo,
    clipAt,
    clipCycleTicks,
    clipShowsUpdate,
    clipStepTicks,
    createSong,
    deleteClip,
    duplicateClip,
    keepClip,
    markEdited,
    moveClip,
    placeClip,
    redo,
    resizeClip,
    retargetClip,
    setLaneMask,
    applyTake,
    setLoop,
    undo,
    updateFromSource,
    wrapTick,
} from '../js/song-model.js?v=4';

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

function snapCounts(song) {
    return {
        synth: song.synth.clips.length,
        drums: song.drums.clips.length,
    };
}

console.log('smoke-song.mjs');
ok('PPQ export', PPQ === 960);
ok('BAR_TICKS export', BAR_TICKS === 3840);

// 1. Snap to bar; snap to previous clip end within half bar (non-bar end)
{
    const song = createSong();
    const a = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 100,
        data: { stepCount: 7, division: 8, repeat: 1 },
        copiedHash: 'h0',
    });
    ok('place snap to bar', a && a.startTick === 0);

    const oddLen = 7 * 480;
    const b = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 1,
        startTick: BAR_TICKS * 2,
        data: { stepCount: 4, division: 8, repeat: 1 },
        copiedHash: 'h1',
    });
    ok('second clip placed', !!b);
    const prevEnd = a.startTick + a.lengthTick;
    ok('second ends off bar', prevEnd % BAR_TICKS !== 0);

    const before = snapCounts(song);
    moveClip(song, b.id, prevEnd + 500);
    ok('snap to prev end not bar', b.startTick === prevEnd);
    ok('move unchanged count', JSON.stringify(snapCounts(song)) === JSON.stringify(before));
}

// 2. Overlap refused; synth + drum may share tick
{
    const song = createSong();
    placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    const snap = JSON.stringify(song.synth.clips);
    const bad = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 1,
        startTick: 1000,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    ok('overlap place refused', bad === false);
    ok('song unchanged on overlap', JSON.stringify(song.synth.clips) === snap);

    const d = placeClip(song, {
        track: 'drums',
        kind: 'd',
        source: 0,
        startTick: 0,
        data: { lanes: [{ stepCount: 8, division: 8, enabled: true }] },
    });
    ok('drum at same tick as synth', d && d.startTick === 0);
}

// 3. Resize truncate/lengthen grid; lengthen refused when hitting next clip
{
    const song = createSong();
    const a = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    const grid = clipStepTicks(a);
    ok('n grid step', grid === 480);

    resizeClip(song, a.id, grid * 2 + 100);
    ok('lengthen snaps to grid multiple', a.lengthTick === grid * 2);

    const cycle = clipCycleTicks(a);
    resizeClip(song, a.id, cycle + grid);
    ok('length can exceed one cycle', a.lengthTick > cycle);

    placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 1,
        startTick: a.startTick + a.lengthTick,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    const lenBefore = a.lengthTick;
    const refused = resizeClip(song, a.id, lenBefore + grid * 4);
    ok('resize into next clip refused', refused === false);
    ok('length unchanged when refused', a.lengthTick === lenBefore);

    resizeClip(song, a.id, grid + 50);
    ok('truncate floors to grid', a.lengthTick === grid);
}

// 4. buildCues gaps, back-to-back, berlin silence in n, notes n vs b
{
    const song = createSong();
    placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: BAR_TICKS,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    const cuesGap = buildCues(song, 'n');
    ok(
        'gap null at 0 synth',
        cuesGap.some((c) => c.tick === 0 && c.track === 'synth' && c.clip === null),
    );

    const song2 = createSong();
    const c1 = placeClip(song2, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    placeClip(song2, {
        track: 'synth',
        kind: 'n',
        source: 1,
        startTick: c1.startTick + c1.lengthTick,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    const boundary = c1.startTick + c1.lengthTick;
    const cuesBtB = buildCues(song2, 'n').filter(
        (c) => c.track === 'synth' && c.tick === boundary,
    );
    ok('back-to-back one cue at boundary', cuesBtB.length === 1);
    ok('back-to-back not silence', cuesBtB[0].clip !== null);

    const song3 = createSong();
    const berlin = placeClip(song3, {
        track: 'synth',
        kind: 'b',
        source: 2,
        startTick: 0,
        data: {
            lanes: Array.from({ length: 8 }, () => ({ stepCount: 8, division: 8, enabled: true })),
            oscCount: 3,
            modCount: 1,
            repeat: 1,
        },
    });
    const berlinCue = buildCues(song3, 'n').find(
        (c) => c.track === 'synth' && c.tick === berlin.startTick,
    );
    ok('berlin null in mode n', berlinCue && berlinCue.clip === null);

    const notes = placeClip(song3, {
        track: 'synth',
        kind: 'notes',
        startTick: BAR_TICKS * 2,
        notes: [{ semi: 60, fine: 0, startTick: 0, durTick: 480, vel: 100, legato: false }],
    });
    const noteNc = buildCues(song3, 'n').find(
        (c) => c.track === 'synth' && c.tick === notes.startTick,
    );
    const noteBc = buildCues(song3, 'b').find(
        (c) => c.track === 'synth' && c.tick === notes.startTick,
    );
    ok('notes present in mode n', noteNc && noteNc.clip === notes);
    ok('notes null in mode b', noteBc && noteBc.clip === null);
}

// 5. edited / update dot / keep
{
    const song = createSong();
    const clip = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
        copiedHash: 'same',
    });
    ok('no dot when hash matches copied', !clipShowsUpdate(clip, 'same'));
    ok('dot when hash differs', clipShowsUpdate(clip, 'other'));

    markEdited(song, clip.id);
    ok('markEdited hides dot', !clipShowsUpdate(clip, 'other'));

    const songKeep = createSong();
    const kept = placeClip(songKeep, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
        copiedHash: 'copied',
    });
    keepClip(songKeep, kept.id, 'keep-me');
    ok('keep hides dot for kept hash', !clipShowsUpdate(kept, 'keep-me'));
    ok('keep shows dot for new hash', clipShowsUpdate(kept, 'third'));

    updateFromSource(song, clip.id, { stepCount: 8, division: 8, repeat: 1 }, null, 'fresh');
    ok('update clears edited', clip.edited === false);
    ok('update clears dot', !clipShowsUpdate(clip, 'fresh'));
}

// 6. retargetClip + undo extra bank payload
{
    const song = createSong();
    const clip = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
        copiedHash: 'a',
    });
    markEdited(song, clip.id);
    const bankPayload = { slot: 3, pattern: { steps: [1, 2, 3] } };
    retargetClip(song, clip.id, 3, 'bank-hash', bankPayload);
    ok('retarget source', clip.source === 3);
    ok('retarget clears edited', clip.edited === false);
    ok('retarget copiedHash', clip.copiedHash === 'bank-hash');

    const u = undo(song);
    ok('undo ok', u.ok === true);
    const clipAfterUndo = song.synth.clips.find((c) => c.id === clip.id);
    ok('undo restores source', clipAfterUndo && clipAfterUndo.source === 0);
    ok('undo restores edited', clipAfterUndo && clipAfterUndo.edited === true);
    ok('undo returns bank extra', u.extra === bankPayload);

    const r = redo(song);
    ok('redo ok', r.ok === true);
    ok('redo extra null', r.extra === null);
    const clipAfterRedo = song.synth.clips.find((c) => c.id === clip.id);
    ok('redo restores retarget', clipAfterRedo && clipAfterRedo.source === 3);
}

// 7. loop wrap, clipAt, undo delete, redo, new edit clears redo
{
    const song = createSong();
    const clip = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    setLoop(song, { on: true, startTick: 0, endTick: BAR_TICKS * 2 });
    ok('wrap end to start', wrapTick(song, BAR_TICKS * 2) === 0);
    ok('wrap inside unchanged', wrapTick(song, 500) === 500);
    ok('clipAt finds clip', clipAt(song, 'synth', 100) === clip);

    const id = clip.id;
    deleteClip(song, id);
    ok('deleted', song.synth.clips.length === 0);
    undo(song);
    ok('undo restores delete', song.synth.clips.some((c) => c.id === id));
    redo(song);
    ok('redo removes again', song.synth.clips.length === 0);

    undo(song);
    ok('undo again for redo clear test', song.synth.clips.some((c) => c.id === id));
    ok('can redo before new edit', canRedo(song));
    placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 1,
        startTick: BAR_TICKS * 4,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    ok('new edit clears redo', !canRedo(song));
}

// 8. duplicate at end; refused when occupied
{
    const song = createSong();
    const clip = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 4, division: 8, repeat: 1 },
    });
    const dup = duplicateClip(song, clip.id);
    ok('duplicate placed', dup && dup.startTick === clip.startTick + clip.lengthTick);
    ok('duplicate new id', dup && dup.id !== clip.id);

    const dup2 = duplicateClip(song, clip.id);
    ok('duplicate refused when end taken', dup2 === false);
}

// 9. setLaneMask does not edit; undo restores the previous mask.
//    A snapped move or resize that does not change the clip records no undo.
{
    const song = createSong();
    const drum = placeClip(song, {
        track: 'drums',
        kind: 'd',
        source: 0,
        startTick: 0,
        data: { lanes: [{ stepCount: 8, division: 8, enabled: true }] },
        copiedHash: 'd0',
    });
    ok('lane mask starts null', drum.laneMask == null);
    ok('lane mask clip not edited', drum.edited !== true);
    const input = [true, false, true, true];
    const masked = setLaneMask(song, drum.id, input);
    ok('setLaneMask returns clip', masked === drum);
    ok('setLaneMask deep-copies', drum.laneMask !== input && drum.laneMask[1] === false);
    input[0] = false;
    ok('caller mutation does not leak', drum.laneMask[0] === true);
    ok('setLaneMask does not edit', drum.edited !== true);
    setLaneMask(song, drum.id, null);
    ok('null mask clears', drum.laneMask === null);
    const undone = undo(song);
    const drumAgain = song.drums.clips.find((c) => c.id === drum.id);
    ok('mask undo ok', undone.ok === true);
    ok('undo restores previous mask', drumAgain
        && drumAgain.laneMask
        && drumAgain.laneMask[0] === true
        && drumAgain.laneMask[1] === false
        && drumAgain.laneMask[2] === true);
    ok('mask undo leaves edited clear', drumAgain && drumAgain.edited !== true);

    const refused = setLaneMask(song, 'missing', [false, false, false, false]);
    ok('setLaneMask missing id', refused === null);

    const synthSong = createSong();
    const synth = placeClip(synthSong, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    ok('setLaneMask refuses normal clips', setLaneMask(synthSong, synth.id, [true]) === null);
    undo(synthSong);
    ok('refused mask did not push undo', synthSong.synth.clips.length === 0);

    const moveSong = createSong();
    const moved = placeClip(moveSong, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    ok('noop move returns true', moveClip(moveSong, moved.id, 100) === true);
    ok('noop move stays on bar', moved.startTick === 0);
    undo(moveSong);
    ok('noop move recorded no undo', moveSong.synth.clips.length === 0);

    const sizeSong = createSong();
    const sized = placeClip(sizeSong, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    const len = sized.lengthTick;
    ok('noop resize returns true', resizeClip(sizeSong, sized.id, len + 10) === true);
    ok('noop resize length unchanged', sized.lengthTick === len);
    undo(sizeSong);
    ok('noop resize recorded no undo', sizeSong.synth.clips.length === 0);

    const realSong = createSong();
    const real = placeClip(realSong, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    ok('real move still returns true', moveClip(realSong, real.id, BAR_TICKS + 50) === true);
    ok('real move lands one bar later', real.startTick === BAR_TICKS);
    undo(realSong);
    const realAgain = realSong.synth.clips.find((c) => c.id === real.id);
    ok('real move still undoes', realAgain && realAgain.startTick === 0);
}

// One take replaces two notes clips in a gap, leaves the pattern, one undo restores both.
{
    const song = createSong();
    const pattern = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: BAR_TICKS * 2,
        lengthTick: BAR_TICKS,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    const first = placeClip(song, {
        track: 'synth',
        kind: 'notes',
        startTick: 0,
        lengthTick: BAR_TICKS,
        notes: [{ semi: 1, fine: 0, startTick: 0, durTick: 480, vel: 0.8, legato: false }],
    });
    const second = placeClip(song, {
        track: 'synth',
        kind: 'notes',
        startTick: BAR_TICKS,
        lengthTick: BAR_TICKS,
        notes: [{ semi: 3, fine: 0, startTick: 120, durTick: 240, vel: 0.8, legato: true }],
    });
    song.transpose = [{ tick: 100, semi: 4 }];
    const patternId = pattern.id;
    const oldIds = [first.id, second.id];
    ok('take setup has two notes clips', song.synth.clips.filter((c) => c.kind === 'notes').length === 2);

    const applied = applyTake(song, {
        transpose: [{ tick: 480, semi: 7 }],
        regions: [{
            startTick: 0,
            lengthTick: BAR_TICKS * 2,
            notes: [{ semi: 5, fine: 0, startTick: 10, durTick: 200, vel: 0.8, legato: true }],
        }],
    });
    const notesNow = song.synth.clips.filter((c) => c.kind === 'notes');
    const patternNow = song.synth.clips.find((c) => c.id === patternId);
    ok('applyTake returns true', applied === true);
    ok('one take leaves one notes clip', notesNow.length === 1);
    ok('take notes clip covers the gap', notesNow[0]
        && notesNow[0].startTick === 0
        && notesNow[0].lengthTick === BAR_TICKS * 2
        && notesNow[0].notes[0].semi === 5);
    ok('take leaves the pattern clip', !!patternNow && patternNow.kind === 'n' && patternNow.startTick === BAR_TICKS * 2);
    ok('take replaces transpose', song.transpose.length === 1 && song.transpose[0].semi === 7 && song.transpose[0].tick === 480);

    const undone = undo(song);
    const restored = song.synth.clips.filter((c) => c.kind === 'notes');
    const patternBack = song.synth.clips.find((c) => c.id === patternId);
    ok('one undo restores the take', undone.ok === true);
    ok('undo restores both notes clips', restored.length === 2
        && oldIds.every((id) => restored.some((c) => c.id === id)));
    ok('undo restores old transpose', song.transpose.length === 1
        && song.transpose[0].tick === 100
        && song.transpose[0].semi === 4);
    ok('undo keeps the pattern clip', !!patternBack && patternBack.kind === 'n');
}

// checkpointUndo stores the bank payload and leaves clips alone
{
    const song = createSong();
    const clip = placeClip(song, {
        track: 'synth',
        kind: 'n',
        source: 0,
        startTick: 0,
        data: { stepCount: 8, division: 8, repeat: 1 },
    });
    const id = clip.id;
    const extra = { kind: 'n', slot: 2, data: { stepCount: 4 }, automation: null };
    checkpointUndo(song, extra);
    ok('checkpoint leaves the clip', song.synth.clips.length === 1
        && song.synth.clips[0].id === id
        && song.synth.clips[0].source === 0);
    const undone = undo(song);
    ok('checkpoint undo returns extra', undone.ok === true && undone.extra === extra);
    ok('checkpoint undo keeps the clip', song.synth.clips.some((c) => c.id === id));
    const redone = redo(song);
    ok('checkpoint redo extra is null', redone.ok === true && redone.extra === null);
    ok('checkpoint redo keeps the clip', song.synth.clips.some((c) => c.id === id));
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
