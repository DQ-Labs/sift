import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { effectiveMetadata, classification, refreshSampleMetadata } from '../lib/metadata.mjs';

test('explicit pack labels survive conflicting estimates, manual choices survive reanalysis',()=>{
  const sample={filename:'Cymatics - Carota Drum Loop - 140 BPM.wav',analysis:{status:'done',bpm:92.6,key:null}};
  let m=effectiveMetadata(sample);
  assert.equal(m.bpm,140);assert.equal(m.bpmSource,'filename');assert.equal(m.conflicts.bpm.estimate,92.6);assert.equal(m.conflicts.bpm.resolved,false);
  sample.overrides={bpm:92.6,key:null};sample.analysis.bpm=70;m=effectiveMetadata(sample);
  assert.equal(m.bpm,92.6);assert.equal(m.conflicts.bpm.resolved,true);assert.equal(m.conflicts.bpm.kind,'half-double');
  sample.overrides={bpm:null,key:null};assert.equal(effectiveMetadata(sample).bpm,null);
  delete sample.overrides;assert.equal(effectiveMetadata(sample).bpm,140);
});
test('small tempo drift and enharmonic spelling do not create conflicts; relative keys do',()=>{
  const sample={filename:'Intro - 95 BPM D# Maj.wav',analysis:{status:'done',bpm:95.8,key:'Eb maj'}};
  assert.deepEqual(effectiveMetadata(sample).conflicts,{});assert.equal(effectiveMetadata(sample).key,'D# maj');
  sample.filename='Omega Vocal Chop 17 - 125 BPM E Min.wav';sample.analysis={status:'done',bpm:83.4,key:'G maj'};
  const m=effectiveMetadata(sample);assert.equal(m.bpm,125);assert.equal(m.key,'E min');assert.equal(m.conflicts.key.kind,'relative-key');
});
test('bare numbers remain weak hints and analysis fills missing metadata',()=>{
  const sample={filename:'take_120.wav',analysis:{status:'done',bpm:93,key:'Bb min'}};
  const m=effectiveMetadata(sample);assert.equal(m.bpm,93);assert.equal(m.bpmSource,'analysis');assert.equal(m.key,'A# min');assert.deepEqual(m.conflicts,{});
  sample.analysis.bpm=null;assert.equal(effectiveMetadata(sample).bpm,120);assert.equal(effectiveMetadata(sample).bpmSource,'filename-hint');
  sample.overrides={bpm:110};assert.equal(effectiveMetadata(sample).bpmSource,'manual');delete sample.overrides;
  sample.filename='untitled.wav';assert.equal(effectiveMetadata(sample).bpm,null);
});
test('folder inference is bounded, nearest-first, and specific filename roles win',()=>{
  const root=path.resolve('Melody Loops'),make=(name,dirs=[])=>({root,path:path.join(root,...dirs,name),filename:name});
  assert.deepEqual(classification(make('Americano - 143 BPM A# Min.wav')), {type:'Melodic',typeSource:'folder',typeHint:'Melody Loops'});
  assert.equal(classification(make('Mystery.wav',['Bass','Stems'])).type,'Bass');
  assert.equal(classification(make('Nueva - 118 BPM A# Min Bass.wav')).type,'Bass');
  assert.equal(classification(make('She Goes Pad 3.wav')).type,'Texture');
  assert.equal(classification(make('Americano Ride.wav')).type,'Drums');
  assert.equal(classification(make('Violin.wav')).typeSource,'filename');
  assert.equal(classification(make('What Monkey.wav')).typeSource,'folder');
  const unrelated={root:path.join(root,'Unsorted'),path:path.join(root,'Unsorted','What Monkey.wav'),filename:'What Monkey.wav'};
  assert.equal(classification(unrelated).type,'Other');
  assert.equal(classification({...unrelated,path:path.join(root,'Outside.wav')}).type,'Other');
});
test('existing records refresh without losing overrides and invalidate changed drum rules only',()=>{
  const root=path.resolve('Melody Loops');
  const sample={root,path:path.join(root,'Intro - 95 BPM D# Maj.wav'),filename:'Intro - 95 BPM D# Maj.wav',type:'Other',analysis:{status:'done',bpm:92,key:'Eb maj'},overrides:{bpm:96,key:null}};
  refreshSampleMetadata(sample);assert.equal(sample.type,'Melodic');assert.equal(sample.typeSource,'folder');assert.equal(sample.analysis.status,'done');assert.equal(sample.bpm,96);assert.equal(sample.key,null);
  sample.filename='Kick.wav';refreshSampleMetadata(sample);assert.equal(sample.type,'Drums');assert.equal(sample.analysis,undefined);assert.equal(sample.bpm,96);
});
