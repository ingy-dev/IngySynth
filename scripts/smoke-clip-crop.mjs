#!/usr/bin/env node
/**
 * A trimmed pattern clip dropped on a square lands as only the steps it plays.
 * Run: node scripts/smoke-clip-crop.mjs
 */
import { invertClip, reverseClip, applyTake, playOrderData, createSong, placeClip, trimClipStart, resizeClip, trimmedClipData, clipIsTrimmed, retargetClip, clipCycleTicks, undo } from '../js/song-model.js';
const st=(tune,on=true,slide=false)=>({tune,fine:0,on,accent:false,slide,ratch:1,chord:[]});
const pad=(a)=>a.concat(Array.from({length:32-a.length},()=>st(0,false)));
const show=(l)=>l.steps.slice(0,l.stepCount).map(s=>s.on?`${s.tune}${s.slide?'~':''}`:'.').join(' ');
let fails=0; const eq=(name,got,want)=>{const ok=got===want; if(!ok) fails++; console.log(ok?'  PASS ':'  FAIL ',name, ok?'':`got [${got}] want [${want}]`);};
const mk=(spec)=>{const song=createSong(); const r=placeClip(song,spec); const clip=song[spec.track].clips[0]; return {song,clip,r};};
// normal: 8 steps at 1/16, tunes 0..7
{
  const data={steps:pad([0,1,2,3,4,5,6,7].map(t=>st(t))),stepCount:8,division:16,reverse:false,gate:.9,repeat:1,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  if(!clip){console.log('placeClip shape?',Object.keys(song.synth));}
  eq('untrimmed is not trimmed', clipIsTrimmed(clip), false);
  trimClipStart(song,clip.id,480); // cut 2 steps off the front
  resizeClip(song,clip.id,960);    // keep 4 steps
  const c=trimmedClipData(clip);
  eq('n: front and back cut', show(c.data)+` x${c.data.repeat}`, '2 3 4 5 x1');
  retargetClip(song,clip.id,3,'h2',null,c.data);
  eq('baked clip is no longer trimmed', clipIsTrimmed(clip), false);
  eq('baked clip keeps its length', clip.lengthTick, 960);
  eq('baked clip cycle', clipCycleTicks(clip), 960);
  undo(song);
  {const now=song.synth.clips[0]; eq("undo restores the trim", `${now.startOffset} ${now.data.stepCount}`, "480 8");}
}
// normal reversed
{
  const data={steps:pad([0,1,2,3].map(t=>st(t))),stepCount:4,division:16,reverse:true,gate:.9,repeat:1,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  trimClipStart(song,clip.id,240); // plays 3 2 1 0 -> 2 1 0
  const c=trimmedClipData(clip);
  eq('n reversed: stored so it still plays 2 1 0', show(c.data)+` rev=${c.data.reverse}`, '0 1 2 rev=true');
}
// normal with repeat 4, clip resized to 3 repeats, and extended past the pattern
{
  const data={steps:pad([0,5].map(t=>st(t))),stepCount:2,division:8,reverse:false,gate:.9,repeat:4,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  resizeClip(song,clip.id,480*6);
  let c=trimmedClipData(clip);
  eq('n: three of four repeats fold', show(c.data)+` x${c.data.repeat}`, '0 5 x3');
  resizeClip(song,clip.id,480*10);
  c=trimmedClipData(clip);
  eq('n: space past the pattern is rests', show(c.data)+` x${c.data.repeat}`, '0 5 0 5 0 5 0 5 . . x1');
}
// drums: lanes at 1/16 x8 and 1/8 x3 (polymeter), cut one beat off the front, keep 2 beats
{
  const lane=(tunes,division)=>({steps:pad(tunes.map(t=>st(t))),stepCount:tunes.length,division,reverse:false,gate:.9,enabled:true});
  const data={lanes:[lane([0,1,2,3,4,5,6,7],16),lane([10,11,12],8),lane([0],16),lane([0],16)]};
  const {song,clip}=mk({track:'drums',kind:'d',source:0,startTick:0,data,copiedHash:'h'});
  trimClipStart(song,clip.id,960); resizeClip(song,clip.id,960);
  const c=trimmedClipData(clip);
  eq('d: 1/16 lane', show(c.data.lanes[0]), '4 5 6 7');
  eq('d: 1/8 lane keeps its own loop', show(c.data.lanes[1]), '12 10');
}
// berlin: two osc lanes
{
  const lane=(tunes,division)=>({steps:pad(tunes.map(t=>st(t))),stepCount:tunes.length,division,reverse:false,gate:.9,enabled:true});
  const lanes=[lane([0,1,2,3,4,5,6,7],16),lane([10,11,12],16),lane([0],16),lane([0],16),lane([0],16),lane([0],16),lane([0],16),lane([0],16)];
  const data={lanes,oscCount:2,modCount:1,repeat:2};
  const {song,clip}=mk({track:'synth',kind:'b',source:0,startTick:0,data,copiedHash:'h'});
  trimClipStart(song,clip.id,240*6); // 6 steps in; whole clip is 16 steps
  const c=trimmedClipData(clip);
  eq('b: long lane runs on through the repeat', show(c.data.lanes[0]), '6 7 0 1 2 3 4 5 6 7');
  eq('b: short lane starts over with the long one', show(c.data.lanes[1]), '10 11 10 11 12 10 11 12 10 11');
  eq('b: repeat folded into the lanes', c.data.repeat, 1);
}
// A reversed pattern placed on the timeline holds its notes in the order they sound.
{
  const data={steps:pad([0,1,2,3].map((t,i)=>st(t,true,i===3))),stepCount:4,division:16,reverse:true,gate:.9,repeat:1,enabled:true};
  const out=playOrderData('n',data);
  eq('n reversed: flipped, slides stay on their steps', show(out)+` rev=${out.reverse}`, '3~ 2 1 0 rev=false');
  eq('source pattern is untouched', show(data)+` rev=${data.reverse}`, '0 1 2 3~ rev=true');
  const fwd={...data,reverse:false};
  eq('forward pattern is unchanged', show(playOrderData('n',fwd)), '0 1 2 3~');
  const lane=(tunes,reverse)=>({steps:pad(tunes.map(t=>st(t))),stepCount:tunes.length,division:16,reverse,gate:.9,enabled:true});
  const d=playOrderData('d',{lanes:[lane([0,1,2],true),lane([5,6],false)]});
  eq('d: only the reversed lane flips', `${show(d.lanes[0])} | ${show(d.lanes[1])} | ${d.lanes[0].reverse}`, '2 1 0 | 5 6 | false');
}
// Reverse from the clip menu: the clip's notes are mirrored inside its edges.
{
  const tie=[st(0,true,true),st(0,true,true),st(0),st(5),st(7,true,true),st(9),st(0,false),st(0,false)];
  const data={steps:pad(tie),stepCount:8,division:16,reverse:false,gate:.9,repeat:1,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  eq('before', show(clip.data), '0~ 0~ 0 5 7~ 9 . .');
  reverseClip(song,clip.id);
  let now=song.synth.clips[0];
  eq('n: mirrored, the tie and the slide stay joined', show(now.data), '. . 9~ 7 5 0~ 0~ 0');
  eq('n: marked edited, stays 8 steps', `${now.edited} ${now.data.stepCount} ${now.lengthTick}`, 'true 8 1920');
  reverseClip(song,now.id);
  eq('n: twice is the original', show(song.synth.clips[0].data), '0~ 0~ 0 5 7~ 9 . .');
  undo(song); undo(song);
  eq('undo', `${show(song.synth.clips[0].data)} ${!!song.synth.clips[0].edited}`, '0~ 0~ 0 5 7~ 9 . . false');
}
{
  const data={steps:pad([0,1,2,3,4,5,6,7].map(t=>st(t))),stepCount:8,division:16,reverse:false,gate:.9,repeat:1,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  trimClipStart(song,clip.id,480); resizeClip(song,clip.id,960); // plays 2 3 4 5
  reverseClip(song,clip.id);
  const now=song.synth.clips[0];
  eq('trimmed n: only what it plays is mirrored', `${show(now.data)} off=${now.startOffset} len=${now.lengthTick}`, '5 4 3 2 off=undefined len=960');
}
{
  const lane=(tunes,division)=>({steps:pad(tunes.map(t=>st(t))),stepCount:tunes.length,division,reverse:false,gate:.9,enabled:true});
  const data={lanes:[lane([0,1,2,3,4,5,6,7],16),lane([10,11,12],16),lane([0],16),lane([0],16)]};
  const {song,clip}=mk({track:'drums',kind:'d',source:0,startTick:0,data,copiedHash:'h'});
  reverseClip(song,clip.id);
  const now=song.drums.clips[0];
  eq('d: short lane is mirrored over the whole clip', show(now.data.lanes[1]), '11 10 12 11 10 12 11 10');
  eq('d: long lane', show(now.data.lanes[0]), '7 6 5 4 3 2 1 0');
}
{
  const song=createSong();
  const n=(semi,startTick,durTick,legato=false)=>({semi,fine:0,startTick,durTick,vel:.8,legato});
  applyTake(song,{transpose:[],regions:[{startTick:0,lengthTick:1920,notes:[n(0,0,480),n(3,480,240,true),n(7,960,240)]}]});
  reverseClip(song,song.synth.clips[0].id);
  eq('notes: mirrored in time, legato moves to the later note of the pair',
     song.synth.clips[0].notes.map(x=>`${x.semi}@${x.startTick}+${x.durTick}${x.legato?'L':''}`).join(' '),
     '7@720+240 3@1200+240 0@1440+480L');
}
// Invert: pitches mirror about the middle of the clip's range.
{
  const steps=[st(0,true,true),st(0),st(7),{...st(12),fine:10},{...st(3),chord:[4,7]},st(40,false)];
  const data={steps:pad(steps),stepCount:6,division:16,reverse:false,gate:.9,repeat:1,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  invertClip(song,clip.id);
  let now=song.synth.clips[0];
  const chordOf=(s)=>`${s.tune}[${s.chord.join(',')}]`;
  eq('n: highest becomes lowest, timing and slides stay', show(now.data), '12~ 12 5 0 2 .');
  eq('n: chord 3-7-10 becomes 2-5-9', chordOf(now.data.steps[4]), '2[3,7]');
  eq('n: fine flips, rest untouched, edited', `${now.data.steps[3].fine} ${now.data.steps[5].tune} ${now.edited}`, '-10 40 true');
  invertClip(song,now.id);
  eq('n: twice is the original', `${show(song.synth.clips[0].data)} ${chordOf(song.synth.clips[0].data.steps[4])}`, '0~ 0 7 12 3 . 3[4,7]');
}
{
  const data={steps:pad([st(5),st(5)]),stepCount:2,division:16,reverse:false,gate:.9,repeat:1,enabled:true};
  const {song,clip}=mk({track:'synth',kind:'n',source:0,startTick:0,data,copiedHash:'h'});
  eq('one pitch: nothing to invert', invertClip(song,clip.id), null);
  const lane=(tunes)=>({steps:pad(tunes.map(t=>st(t))),stepCount:tunes.length,division:16,reverse:false,gate:.9,enabled:true});
  const d=mk({track:'drums',kind:'d',source:0,startTick:0,data:{lanes:[lane([0,5]),lane([0]),lane([0]),lane([0])]},copiedHash:'h'});
  eq('drums are left alone', invertClip(d.song,d.clip.id), null);
}
{
  const lane=(tunes)=>({steps:pad(tunes.map(t=>st(t))),stepCount:tunes.length,division:16,reverse:false,gate:.9,enabled:true});
  const lanes=[lane([0,4]),lane([7,12]),lane([0]),lane([0]),lane([3,9]),lane([0]),lane([0]),lane([0])];
  const {song,clip}=mk({track:'synth',kind:'b',source:0,startTick:0,data:{lanes,oscCount:2,modCount:1,repeat:1},copiedHash:'h'});
  invertClip(song,clip.id);
  const now=song.synth.clips[0].data.lanes;
  eq('b: oscillator lanes share one axis, mod lane untouched', `${show(now[0])} | ${show(now[1])} | ${show(now[4])}`, '12 8 | 5 0 | 3 9');
}
{
  const song=createSong();
  const n=(semi,startTick,durTick,fine=0)=>({semi,fine,startTick,durTick,vel:.8,legato:false});
  applyTake(song,{transpose:[],regions:[{startTick:0,lengthTick:1920,notes:[n(0,0,480),n(7,480,240,25),n(-5,960,240)]}]});
  invertClip(song,song.synth.clips[0].id);
  eq('notes: mirrored about the range, time unchanged',
     song.synth.clips[0].notes.map(x=>`${x.semi}@${x.startTick}${x.fine?`f${x.fine}`:''}`).join(' '), '2@0 -5@480f-25 7@960');
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
