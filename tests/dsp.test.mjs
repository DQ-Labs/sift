import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeAnalysis, effectiveMetadata, AnalysisQueue } from '../lib/analysis.mjs';
import { StretchCache, analysisAudio } from '../lib/media.mjs';
import { parseWavHeader } from '../lib/audio.mjs';
import { wavFromChannels,chordFixture,clickFixture } from './fixtures.mjs';

test('audio analysis estimates rhythmic fixtures without relying on filenames',async()=>{
  for(const bpm of [80,120,160]){
    const result=await computeAnalysis(clickFixture(bpm),'Drums');
    assert.ok(Math.abs(result.bpm-bpm)<2,`${bpm} BPM detected as ${result.bpm}, confidence ${result.bpmConfidence}`);
    assert.equal(result.key,null);assert.ok(result.peaks.some(p=>p>.1));
  }
});
test('audio analysis identifies major and minor tonal fixtures',async()=>{
  for(const [minor,expected]of [[false,'C maj'],[true,'A min']]){
    const result=await computeAnalysis(chordFixture(minor));
    assert.equal(result.key,expected,`key strength ${result.keyStrength}`);
  }
});
test('silence, one-shots and noise do not receive confident musical labels',async()=>{
  const silence=await computeAnalysis(new Float32Array(44100*5));assert.equal(silence.bpm,null);assert.equal(silence.key,null);
  const oneShot=await computeAnalysis(clickFixture(120,.3));assert.equal(oneShot.bpm,null);assert.equal(oneShot.key,null);
  const noise=new Float32Array(44100*8);let seed=45;for(let i=0;i<noise.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;noise[i]=((seed>>>0)/2147483648-1)*.2;}
  const result=await computeAnalysis(noise);assert.equal(result.key,null,`noise key strength ${result.keyStrength}`);assert.equal(result.bpm,null,`noise beat confidence ${result.bpmConfidence}`);
});
test('manual values and explicit unknowns survive new automatic estimates',()=>{
  const sample={filename:'keys_100bpm_Cmaj.wav',analysis:{status:'done',bpm:101,key:'A min'},overrides:{bpm:80,key:null}};
  assert.equal(effectiveMetadata(sample).bpm,80);assert.equal(effectiveMetadata(sample).bpmSource,'manual');assert.equal(effectiveMetadata(sample).key,null);assert.equal(effectiveMetadata(sample).keySource,'manual');
  delete sample.overrides;assert.equal(effectiveMetadata(sample).bpm,100);assert.equal(effectiveMetadata(sample).keySource,'filename');
  sample.analysis.key=null;assert.equal(effectiveMetadata(sample).key,'C maj');assert.equal(effectiveMetadata(sample).keySource,'filename');
});
test('Rubber Band changes duration while preserving both stereo pitches and caches renders',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sift-stretch-')),file=path.join(directory,'unlabelled.wav'),rate=44100,seconds=6;
  const channels=[440,660].map(f=>Float32Array.from({length:rate*seconds},(_,i)=>.3*Math.sin(2*Math.PI*f*i/rate)));
  await writeFile(file,wavFromChannels(channels));const cache=new StretchCache(path.join(directory,'cache'));const sample={path:file,bpm:120,type:'Melodic'};
  for(const tempo of [90,180]){
    const output=await cache.render(sample,tempo),b=await readFile(output),header=parseWavHeader(b);
    assert.ok(Math.abs(header.duration-seconds*120/tempo)<.04,`duration ${header.duration}`);assert.equal(header.channels,2);assert.equal(header.bits,32);
    for(let c=0;c<2;c++){let crossings=0;const start=Math.floor(header.rate),end=Math.floor(header.rate*3);let previous=b.readFloatLE(header.dataOffset+(start*2+c)*4);for(let i=start+1;i<end;i++){const value=b.readFloatLE(header.dataOffset+(i*2+c)*4);if(previous<=0&&value>0)crossings++;previous=value;}const hz=crossings/((end-start)/header.rate);assert.ok(Math.abs(hz-[440,660][c])<2,`expected ${[440,660][c]} Hz, got ${hz} Hz at ${tempo} BPM`);}
    const before=(await stat(output)).birthtimeMs;assert.equal(await cache.render(sample,tempo),output);assert.equal((await stat(output)).birthtimeMs,before);
  }
  await assert.rejects(()=>cache.render(sample,999),/Session tempo/);
});

test('Rubber Band shifts stereo pitches independently of tempo and separates render cache entries',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sift-pitch-')),file=path.join(directory,'stereo.wav'),rate=44100,seconds=6;
  await writeFile(file,wavFromChannels([440,660].map(f=>Float32Array.from({length:rate*seconds},(_,i)=>.3*Math.sin(2*Math.PI*f*i/rate)))));
  const cache=new StretchCache(path.join(directory,'cache')),sample={path:file,bpm:120,key:'A min',type:'Melodic'};
  const outputs=[];
  for(const [tempo,sync,key,semitones]of [[180,true,'B min',2],[90,true,'G min',-2],[180,false,'B min',2]]){
    const options={sync,key},output=await cache.render(sample,tempo,options),b=await readFile(output),header=parseWavHeader(b);outputs.push(output);
    assert.ok(Math.abs(header.duration-seconds*(sync?120/tempo:1))<.04,`duration ${header.duration}`);
    assert.equal(header.channels,2);
    for(let c=0;c<2;c++){
      let crossings=0;const start=rate,end=rate*3;let previous=b.readFloatLE(header.dataOffset+(start*2+c)*4);
      for(let i=start+1;i<end;i++){const value=b.readFloatLE(header.dataOffset+(i*2+c)*4);if(previous<=0&&value>0)crossings++;previous=value;}
      // Pitch accuracy is judged in cents. Rubber Band builds differ by a few
      // cents when tempo and pitch change together; a wrong shift is 100.
      const actual=crossings/2,expected=[440,660][c]*2**(semitones/12),cents=1200*Math.log2(actual/expected);
      assert.ok(Math.abs(cents)<10,`${expected} Hz expected; got ${actual} (${cents.toFixed(1)} cents)`);
    }
    assert.equal(await cache.render(sample,tempo,options),output);
  }
  assert.equal(new Set(outputs).size,3);
  assert.notEqual(await cache.render(sample,180,{key:'A min'}),outputs[0]);
  // Relative major needs no pitch shift; unknown BPM still supports key-only rendering.
  assert.equal(await cache.render(sample,180,{key:'C maj'}),await cache.render(sample,180,{key:'A min'}));
  const unknownTempo=await cache.render({...sample,bpm:null},180,{key:'B min'});
  assert.equal(unknownTempo,outputs[2]);
  const drums=await cache.render({...sample,type:'Drums'},120,{key:'B min'});
  assert.equal(drums,await cache.render({...sample,type:'Drums'},120,{key:null}));
  await assert.rejects(()=>cache.render(sample,120,{key:'invalid'}),/session key/);
});
test('analysis queue persists results, continues past corrupt files, and retains corrections',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sift-analysis-'));const valid=path.join(directory,'untagged.wav'),broken=path.join(directory,'broken.wav');
  await writeFile(valid,wavFromChannels([clickFixture(120)]));await writeFile(broken,'not audio');
  const samples=[{id:'bad',name:'bad',filename:'broken.wav',path:broken,type:'Other'},{id:'good',name:'good',filename:'untagged.wav',path:valid,type:'Drums',overrides:{bpm:60,key:null}}];let saved=0;
  const progress=[];
  const queue=new AnalysisQueue({samples:()=>samples,persist:async()=>{saved++;progress.push(queue.status());},paused:true});queue.enqueue(samples);assert.equal(queue.status().pending,2);assert.equal(queue.status().running,false);queue.resume();
  const deadline=Date.now()+20000;while(queue.status().running||queue.status().pending){assert.ok(Date.now()<deadline,'analysis timeout');await new Promise(r=>setTimeout(r,30));}
  assert.equal(samples[0].analysis.status,'error');assert.equal(samples[1].analysis.status,'done');assert.ok(Math.abs(samples[1].analysis.bpm-120)<2);assert.equal(samples[1].bpm,60);assert.equal(samples[1].bpmSource,'manual');assert.equal(saved,2);
  assert.deepEqual(progress.map(s=>[s.processed,s.total,s.remaining]),[[1,2,1],[2,2,0]],'Saving an active result must not count that sample twice');
  queue.enqueue(samples);assert.equal(queue.status().pending,0);queue.close();
});

test('analysis save failures pause work and clear only after a successful retry, even with an empty queue',async()=>{
  let failure='Disk is full',saved=0;
  const queue=new AnalysisQueue({samples:()=>[],persist:async()=>{if(failure)throw new Error(failure);saved++;}});
  queue.dirty=3;
  await assert.rejects(()=>queue.save(),/Disk is full/);
  assert.equal(queue.status().paused,true);assert.equal(queue.status().saveError,'Disk is full');assert.equal(queue.dirty,3);
  failure='Write access denied';
  await assert.rejects(()=>queue.save(),/Write access denied/);
  assert.equal(queue.status().saveError,'Write access denied');assert.equal(queue.status().paused,true);
  failure=null;await queue.save();
  assert.equal(saved,1);assert.equal(queue.status().saveError,null);assert.equal(queue.dirty,0);
  queue.resume();assert.equal(queue.status().paused,false);assert.equal(queue.status().pending,0);queue.close();
});
