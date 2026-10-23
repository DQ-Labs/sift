import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { analysisAudio } from './media.mjs';
import { effectiveMetadata } from './metadata.mjs';
export { effectiveMetadata } from './metadata.mjs';

export const ANALYSIS_VERSION=1;
export function computeAnalysis(audio,type='Other',{timeout=60000,signal}={}) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./analysis-worker.mjs',import.meta.url),{execArgv:[]});
    let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result);};
    const abort=()=>finish(new Error('Audio analysis cancelled.'));
    const timer=setTimeout(()=>finish(new Error('Audio analysis timed out.')),timeout);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
    worker.on('message',({result,error})=>finish(error?new Error(error):null,result));worker.on('error',error=>finish(error));worker.on('exit',code=>{if(!settled)finish(new Error(`Analysis worker exited (${code}).`));});
    worker.postMessage({audio,type},[audio.buffer]);
  });
}
export class AnalysisQueue {
  constructor({samples,persist,paused=false,onUpdate=()=>{}}){this.samples=samples;this.persist=persist;this.onUpdate=onUpdate;this.paused=paused;this.queue=[];this.active=null;this.completed=0;this.failed=0;this.revision=0;this.closed=false;this.saveError=null;this.dirty=0;this.lastSave=0;}
  status(){const processed=this.completed+this.failed,remaining=this.queue.length+(this.active&&!this.active.finished?1:0);return{running:!!this.active,paused:this.paused,pending:this.queue.length,completed:this.completed,failed:this.failed,processed,total:processed+remaining,remaining,current:this.active?.sample.name||null,revision:this.revision,saveError:this.saveError};}
  enqueue(samples,{force=false}={}){
    const queued=new Set(this.queue);
    for(const s of samples){if(s.missing||this.active?.sample.id===s.id||queued.has(s.id))continue;if(!force&&s.analysis?.version===ANALYSIS_VERSION&&['done','error'].includes(s.analysis.status))continue;this.queue.push(s.id);queued.add(s.id);}
    this.pump();return this.status();
  }
  pause(){this.paused=true;return this.status();}
  resume(){this.paused=false;this.pump();return this.status();}
  close(){this.closed=true;this.active?.controller.abort();}
  async save(){
    try{await this.persist();this.saveError=null;this.dirty=0;this.lastSave=Date.now();}
    catch(error){this.saveError=error.message;this.paused=true;throw error;}
  }
  async pump(){
    if(this.closed||this.paused||this.active||!this.queue.length)return;
    const id=this.queue.shift(),sample=this.samples().find(s=>s.id===id);if(!sample||sample.missing){setImmediate(()=>this.pump());return;}
    const controller=new AbortController();this.active={sample,controller};
    let before;
    try{
      before=await stat(sample.path);
      const {audio,metadata}=await analysisAudio(sample.path,controller.signal);
      const result=await computeAnalysis(audio,sample.type,{signal:controller.signal});
      const after=await stat(sample.path);
      if(after.mtimeMs!==before.mtimeMs||after.size!==before.size||this.samples().find(s=>s.id===id)!==sample){this.queue.push(id);return;}
      sample.analysis={...result,status:'done',version:ANALYSIS_VERSION,analyzedAt:new Date().toISOString(),mtime:after.mtimeMs,size:after.size};
      Object.assign(sample,metadata,{peaks:result.peaks,mtime:after.mtimeMs,size:after.size},effectiveMetadata(sample));this.completed++;
    }catch(error){if(this.closed)return;sample.analysis={status:'error',version:ANALYSIS_VERSION,error:error.message,analyzedAt:new Date().toISOString()};this.failed++;}
    finally{
      if(!this.closed){this.active.finished=true;this.revision++;this.onUpdate();this.dirty++;
        if(this.dirty>=10||!this.queue.length||this.paused||Date.now()-this.lastSave>5000){try{await this.save();}catch{}}
      }
      this.active=null;setImmediate(()=>this.pump());
    }
  }
}
