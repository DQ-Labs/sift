import { mkdir, readFile, writeFile, rename, lstat, realpath, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeWorkspace } from '../public/workspace.js';
import { audibleTracks } from '../public/export-audio.js';
import { sessionFrames } from '../public/timing.js';
import { pitchPlan } from '../public/harmony.js';
import { parseWavHeader } from './audio.mjs';

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=message=>Object.assign(new Error(message),{status:400});
const slug=value=>String(value||'Untitled').normalize('NFKD').replace(/[^a-zA-Z0-9 -]/g,'').replace(/\s+/g,' ').trim().slice(0,65)||'Untitled';
export const maxStemBytes=44+sessionFrames(40,44100)*4;
export const abandonedHandoffAge=7*24*60*60*1000;

export function checkWav(bytes,frames){
  const header=parseWavHeader(bytes);
  if(!header||header.format!==1||header.channels!==2||header.rate!==44100||header.bits!==16||header.blockAlign!==4||header.dataSize!==frames*4||header.dataOffset+header.dataSize!==bytes.length)throw fail('Use a stereo 44.1 kHz / 16-bit WAV with exactly four session bars.');
}

export class HandoffStore {
  constructor(directory){this.directory=path.resolve(directory);this.jobs=new Map();this.uploading=new Set();this.removing=new Set();}
  batchPath(id){if(!idPattern.test(id))throw fail('Invalid handoff ID.');return path.join(this.directory,id);}
  async pruneAbandoned(){
    let entries;
    try{entries=await readdir(this.directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return {removed:0};throw error;}
    const root=await realpath(this.directory),cutoff=Date.now()-abandonedHandoffAge;let removed=0;
    for(const entry of entries){
      const id=entry.name;
      if(!idPattern.test(id)||!entry.isDirectory()||entry.isSymbolicLink()||this.jobs.has(id)||this.uploading.has(id)||this.removing.has(id))continue;
      this.removing.add(id);
      try{
        const directory=this.batchPath(id),info=await lstat(directory);
        if(!info.isDirectory()||info.isSymbolicLink()||path.dirname(await realpath(directory))!==root)continue;
        const files=await readdir(directory);
        // Completed exports can be referenced by DAW projects and are never removed.
        if(files.includes('ready.json')||info.mtimeMs>=cutoff)continue;
        let recentOrUnsafe=false;
        for(const name of files){
          const file=await lstat(path.join(directory,name));
          if(!file.isFile()||file.isSymbolicLink()||file.mtimeMs>=cutoff){recentOrUnsafe=true;break;}
        }
        if(recentOrUnsafe)continue;
        // Resolve and check the exact target again before recursive removal.
        const target=await realpath(directory);
        if(path.dirname(target)!==root||(await lstat(directory)).isSymbolicLink())continue;
        await rm(target,{recursive:true});removed++;
      }catch(error){if(error.code!=='ENOENT')throw error;}
      finally{this.removing.delete(id);}
    }
    return {removed};
  }
  async create(input,samples){
    const workspace=normalizeWorkspace(input?.workspace,{strict:true});
    if(input.includeAll!==undefined&&typeof input.includeAll!=='boolean')throw fail('Choose whether to include all layers.');
    if(input.masterScale!==undefined&&(!Number.isFinite(input.masterScale)||input.masterScale<=0||input.masterScale>1))throw fail('Invalid master attenuation.');
    const selected=audibleTracks(workspace.tracks,input.includeAll===true);
    if(!selected.length)throw fail('No audible layers. Unmute a layer or include all loaded layers.');
    const files=selected.map(({track,index})=>{
      const sample=samples.find(s=>s.id===track.id);if(!sample||sample.missing)throw fail('A selected sample is unavailable. Reconnect its drive before exporting.');
      const pitch=pitchPlan(sample,workspace.key);
      const outputKey=pitch.outputKey?.replace('#','sharp').replace(' ','-')||(sample.type==='Drums'?'Unpitched':'Key-unknown');
      return {index,name:`${String(index+1).padStart(2,'0')}-${slug(track.type)}-${workspace.tempo}bpm-${outputKey}-${slug(sample.name||sample.filename)}.wav`,type:track.type,source:sample.filename,sourceBpm:sample.bpm,sourceKey:sample.key,outputKey:pitch.outputKey,semitones:pitch.semitones,volume:track.volume,timing:track.timing};
    });
    const id=randomUUID(),directory=this.batchPath(id);await mkdir(directory,{recursive:true});
    const batch={id,name:workspace.name,created:new Date().toISOString(),tempo:workspace.tempo,key:workspace.key,sync:workspace.sync,bars:4,meter:'4/4',rate:44100,bits:16,frames:sessionFrames(workspace.tempo,44100),masterScale:input.masterScale??1,includeAll:input.includeAll===true,files};
    await writeFile(path.join(directory,'session.json'),JSON.stringify(batch,null,2));return {...batch,ready:false};
  }
  async read(id){
    const directory=this.batchPath(id),info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())throw fail('Invalid export folder.');
    if(path.dirname(await realpath(directory))!==await realpath(this.directory))throw fail('Invalid export folder.');
    const batch=JSON.parse(await readFile(path.join(directory,'session.json'),'utf8'));
    if(batch.id!==id||!Array.isArray(batch.files)||batch.files.length>4||!Number.isInteger(batch.frames)||batch.frames<1||batch.frames>sessionFrames(40,44100))throw fail('Invalid handoff manifest.');
    for(const file of batch.files)if(!Number.isInteger(file.index)||file.index<0||file.index>3||typeof file.name!=='string'||path.basename(file.name)!==file.name||!/^\d{2}-[a-zA-Z0-9 .-]+\.wav$/.test(file.name))throw fail('Invalid stem filename.');
    return batch;
  }
  async upload(id,index,bytes){
    if(this.jobs.has(id)||this.uploading.has(id)||this.removing.has(id))throw fail('This handoff is busy. Wait for its current operation.');
    this.uploading.add(id);
    try{
    try{await readFile(path.join(this.batchPath(id),'ready.json'));throw fail('Prepared handoffs are immutable. Prepare a new handoff instead.');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(bytes.length>maxStemBytes)throw fail('Stem is too large.');
    const batch=await this.read(id),file=batch.files.find(f=>f.index===index);if(!file)throw fail('Unknown stem.');checkWav(bytes,batch.frames);
    const destination=path.join(this.batchPath(id),file.name);await writeFile(destination+'.tmp',bytes);await rename(destination+'.tmp',destination);return {ok:true};
    }finally{this.uploading.delete(id);}
  }
  async finish(id){
    if(this.removing.has(id))throw fail('This handoff is being cleaned up. Prepare a new snapshot.');
    if(this.jobs.has(id))return this.jobs.get(id);
    if(this.uploading.has(id))throw fail('Wait for the current stem upload.');
    const job=this.finalize(id);this.jobs.set(id,job);try{return await job;}finally{this.jobs.delete(id);}
  }
  async finalize(id){
    const batch=await this.read(id),directory=this.batchPath(id),entries=[];
    for(const file of batch.files){const filename=path.join(directory,file.name),info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw fail('Invalid stem file.');const bytes=await readFile(filename);checkWav(bytes,batch.frames);entries.push({name:file.name,bytes});}
    const notes=`Sift handoff — ${batch.name}\n${batch.tempo} BPM | ${batch.key||'Original keys'} | 4 bars in 4/4\nStereo WAV, 44.1 kHz / 16-bit. All files start together and have exactly ${batch.frames} frames.\n\nFL Studio: set your project to ${batch.tempo} BPM, then drop the WAVs into the Playlist and align their left edges at the same bar. Tempo/key processing and source starts/repeats are already rendered. Keep the imported audio at its rendered speed.\n\nFiles include layer levels and one shared master attenuation, so their sum preserves the exported mix balance. ${batch.includeAll?'All loaded layers were included, ignoring mute/solo.':'Mute and solo choices were respected.'}\nStart positions are first-sound detection or manual offsets; musical downbeat alignment remains your choice.\n`;
    entries.push({name:'README.txt',bytes:Buffer.from(notes)},{name:'session.json',bytes:Buffer.from(JSON.stringify(batch,null,2))});
    await writeFile(path.join(directory,'README.txt'),notes);
    await writeFile(path.join(directory,'Stems.zip.tmp'),storeZip(entries));await rename(path.join(directory,'Stems.zip.tmp'),path.join(directory,'Stems.zip'));
    await writeFile(path.join(directory,'ready.json'),JSON.stringify({ready:true}));return {...batch,ready:true};
  }
  async ready(id){const batch=await this.read(id);await readFile(path.join(this.batchPath(id),'ready.json'));return {...batch,ready:true};}
  async file(id,name){
    const batch=await this.ready(id);if(name!=='Stems.zip'&&!batch.files.some(f=>f.name===name))throw fail('Unknown handoff file.');
    const file=path.join(this.batchPath(id),name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('Invalid handoff file.');return file;
  }
}

const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
// Stored ZIP entries avoid another runtime dependency; audio remains lossless.
export function storeZip(entries){
  const local=[],central=[];let offset=0;
  for(const {name,bytes}of entries){
    const filename=Buffer.from(name),crc=crc32(bytes),header=Buffer.alloc(30+filename.length);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);filename.copy(header,30);local.push(header,bytes);
    const item=Buffer.alloc(46+filename.length);item.writeUInt32LE(0x02014b50);item.writeUInt16LE(20,4);item.writeUInt16LE(20,6);item.writeUInt16LE(0x800,8);item.writeUInt16LE(33,14);item.writeUInt32LE(crc,16);item.writeUInt32LE(bytes.length,20);item.writeUInt32LE(bytes.length,24);item.writeUInt16LE(filename.length,28);item.writeUInt32LE(offset,42);filename.copy(item,46);central.push(item);offset+=header.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
