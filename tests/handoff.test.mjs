import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,mkdir,utimes,lstat,symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HandoffStore,storeZip,crc32,checkWav,abandonedHandoffAge } from '../lib/handoff.mjs';
import { audibleTracks,mixScale,encodeWav } from '../public/export-audio.js';
import { sessionFrames } from '../public/timing.js';
import { parseWavHeader } from '../lib/audio.mjs';

test('stem sum preserves the mix balance with shared headroom, stereo, gain and fades',()=>{
  const count=1000,layers=[.7,.5,.3,.2].map((gain,n)=>({gain,channels:[new Float32Array(count).fill(.8-n*.05),new Float32Array(count).fill(-.6+n*.02)]}));
  const scale=mixScale(layers);assert.ok(scale<.98);
  const mixed=[new Float32Array(count),new Float32Array(count)];for(const layer of layers)for(let c=0;c<2;c++)for(let i=0;i<count;i++)mixed[c][i]+=layer.channels[c][i]*layer.gain;
  const reference=Buffer.from(encodeWav(mixed,{scale})),stems=layers.map(layer=>Buffer.from(encodeWav(layer.channels,{gain:layer.gain,scale})));
  for(let i=0;i<count*2;i++){const sum=stems.reduce((n,stem)=>n+stem.readInt16LE(44+i*2),0);assert.ok(Math.abs(sum-reference.readInt16LE(44+i*2))<=3);}
  const info=parseWavHeader(reference);assert.equal(info.channels,2);assert.equal(info.rate,44100);assert.equal(info.bits,16);assert.equal(reference.readInt16LE(44),0);
});

test('audible handoff selection follows mute/solo; including all is explicit',()=>{
  const tracks=[{id:'a',solo:true},{id:'b'},{id:'c',mute:true},{id:null}];
  assert.deepEqual(audibleTracks(tracks).map(t=>t.index),[0]);assert.equal(audibleTracks(tracks,true).length,3);
});

test('unfinished export cleanup removes only old inactive batches and keeps completed or unsafe folders',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sift-cleanup-')),store=new HandoffStore(path.join(directory,'exports'));
  assert.deepEqual(await store.pruneAbandoned(),{removed:0});
  const old=new Date(Date.now()-abandonedHandoffAge-60000);
  const batch=async(files=['session.json'])=>{
    const id=randomUUID(),folder=store.batchPath(id);await mkdir(folder,{recursive:true});
    for(const name of files){await writeFile(path.join(folder,name),'{}');await utimes(path.join(folder,name),old,old);}
    await utimes(folder,old,old);return {id,folder};
  };
  const abandoned=await batch(['session.json','01-Drums.wav','02-Bass.wav.tmp']);
  const empty=await batch([]),complete=await batch(['session.json','ready.json']);
  const recent=await batch();await utimes(recent.folder,new Date(),new Date());
  const recentFile=await batch();await utimes(path.join(recentFile.folder,'session.json'),new Date(),new Date());
  const uploading=await batch();store.uploading.add(uploading.id);
  const finishing=await batch();store.jobs.set(finishing.id,Promise.resolve());
  const nested=await batch();await mkdir(path.join(nested.folder,'keep'));await utimes(nested.folder,old,old);
  const unknown=path.join(store.directory,'keep-my-files');await mkdir(unknown);await utimes(unknown,old,old);
  // Junctions are supported without Windows developer-mode symlink privileges.
  const outside=path.join(directory,'outside');await mkdir(outside);await writeFile(path.join(outside,'keep.txt'),'keep');
  const linked=store.batchPath(randomUUID());await symlink(outside,linked,process.platform==='win32'?'junction':'dir');
  const childLink=await batch();await symlink(outside,path.join(childLink.folder,'linked'),process.platform==='win32'?'junction':'dir');await utimes(childLink.folder,old,old);
  assert.deepEqual(await store.pruneAbandoned(),{removed:2});
  for(const removed of [abandoned,empty])await assert.rejects(()=>lstat(removed.folder),{code:'ENOENT'});
  for(const kept of [complete,recent,recentFile,uploading,finishing,nested,childLink])assert.ok((await lstat(kept.folder)).isDirectory());
  assert.ok(await lstat(linked));assert.ok(await lstat(unknown));assert.equal(await readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
  store.removing.add(uploading.id);store.uploading.delete(uploading.id);
  await assert.rejects(()=>store.upload(uploading.id,0,Buffer.alloc(0)),/busy/);
  await assert.rejects(()=>store.finish(uploading.id),/cleaned up/);
  assert.deepEqual(await store.pruneAbandoned(),{removed:0});
});

test('handoffs validate exact aligned WAVs, persist immutable snapshots, and reject path escapes',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'sift-handoff-')),store=new HandoffStore(directory);
  const samples=[{id:'sample',filename:'Original - G minor.wav',name:'Name / with : punctuation',bpm:120,key:'G min',type:'Bass',path:'private/source/path'}];
  const input={workspace:{name:'Keep this',tempo:123.45,key:'A min',sync:true,tracks:[{id:'sample',type:'Bass',volume:.5,timing:{offset:.25,repeat:'bar'}}]}};
  const batch=await store.create(input,samples);assert.equal(batch.frames,sessionFrames(123.45,44100));assert.equal(batch.files[0].semitones,2);assert.ok(!JSON.stringify(batch).includes('private/source/path'));
  await assert.rejects(()=>store.ready(batch.id));
  const wav=Buffer.from(encodeWav([new Float32Array(batch.frames).fill(.1),new Float32Array(batch.frames).fill(.2)]));
  await assert.rejects(()=>store.upload(batch.id,0,Buffer.from('not a WAV')),/stereo/);
  await assert.rejects(()=>store.upload(batch.id,3,wav),/Unknown stem/);
  await store.upload(batch.id,0,wav);const ready=await store.finish(batch.id);assert.equal(ready.ready,true);
  assert.deepEqual(await readFile(await store.file(batch.id,batch.files[0].name)),wav);
  assert.equal((await new HandoffStore(directory).ready(batch.id)).tempo,123.45);
  await assert.rejects(()=>store.upload(batch.id,0,wav),/immutable/);
  await assert.rejects(()=>store.file(batch.id,'../library.json'),/Unknown/);
  await assert.rejects(()=>store.read('../outside'),/Invalid handoff/);
  const info=parseWavHeader(wav);assert.equal(info.dataSize,batch.frames*4);
  assert.throws(()=>checkWav(wav,batch.frames-1),/exactly four/);
  const archive=await readFile(await store.file(batch.id,'Stems.zip'));assert.equal(archive.readUInt32LE(0),0x04034b50);
  await writeFile(path.join(directory,'zip-fixture.zip'),storeZip([{name:'test.wav',bytes:wav},{name:'session.json',bytes:Buffer.from('{}')}])) ;
  assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
  await writeFile(path.join(store.batchPath(batch.id),'session.json'),JSON.stringify({...batch,files:[{index:0,name:'../escape.wav'}]}));
  await assert.rejects(()=>store.ready(batch.id),/Invalid stem filename/);
});
