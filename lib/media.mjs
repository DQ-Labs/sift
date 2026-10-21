import { spawn } from 'node:child_process';
import { stat, mkdir, readdir, unlink, rename, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseKey, renderPlan } from '../public/harmony.js';

export function runMedia(command, args, { maxBytes = 16 * 1024 * 1024, timeout = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let length = 0, stderr = '', failure;
    const abort = () => { failure = new Error('Audio processing cancelled.'); child.kill(); };
    const timer = setTimeout(() => { failure = new Error('Audio processing timed out.'); child.kill(); }, timeout);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { length += chunk.length; if (length > maxBytes) { failure = new Error('Audio exceeds the processing limit.'); child.kill(); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', error => { failure = new Error(error.code === 'ENOENT' ? `${command} is unavailable. Install FFmpeg with Rubber Band support and restart Sift.` : error.message); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (failure || code) reject(failure || new Error(`Audio processing failed: ${stderr.trim().slice(-500)}`)); else resolve(Buffer.concat(chunks)); });
  });
}
export const ffmpeg = process.env.SIFT_FFMPEG || 'ffmpeg';
export const ffprobe = process.env.SIFT_FFPROBE || 'ffprobe';
export async function probeAudio(filename, signal) {
  const raw = await runMedia(ffprobe, ['-v','error','-protocol_whitelist','file,pipe','-select_streams','a:0','-show_entries','stream=sample_rate,channels,bits_per_raw_sample,bits_per_sample,duration:format=duration','-of','json',filename], { maxBytes: 65536, timeout: 20000, signal });
  const info = JSON.parse(raw), stream = info.streams?.[0]; if (!stream) throw new Error('No audio stream found.');
  const duration = Number(stream.duration || info.format?.duration);
  return { duration: Number.isFinite(duration) ? duration : null, rate: +stream.sample_rate || null, channels: +stream.channels || null, bits: +stream.bits_per_raw_sample || +stream.bits_per_sample || null };
}
export async function analysisAudio(filename, signal) {
  const metadata = await probeAudio(filename, signal);
  const pcm = await runMedia(ffmpeg, ['-hide_banner','-loglevel','error','-nostdin','-threads','1','-protocol_whitelist','file,pipe','-i',filename,'-map','0:a:0','-t','60','-vn','-ac','1','-ar','44100','-f','f32le','pipe:1'], { maxBytes: 44100 * 60 * 4 + 4096, signal });
  const audio = new Float32Array(pcm.length / 4); for (let i=0;i<audio.length;i++) audio[i] = pcm.readFloatLE(i*4);
  return { audio, metadata };
}

// A single render lane bounds CPU use. Identical requests share one render.
export class StretchCache {
  constructor(directory) { this.directory = directory; this.pending = new Map(); this.queue = Promise.resolve(); }
  async render(sample, tempo, { signal, sync = true, key = null } = {}) {
    if (!Number.isFinite(tempo) || tempo < 40 || tempo > 240) throw new Error('Session tempo must be 40–240 BPM.');
    if (typeof sync !== 'boolean' || (key !== null && !parseKey(key))) throw new Error('Choose valid tempo sync and session key settings.');
    const { rate, semitones } = renderPlan(sample, { tempo, sync, key });
    if (!Number.isFinite(rate) || rate < .25 || rate > 4) throw new Error('Supported stretch range is 0.25×–4×.');
    const info = await stat(sample.path);
    if (info.size > 100*1024*1024) throw new Error('Choose a file under 100 MB for tempo/key sync.');
    const cacheKey = createHash('sha256').update(JSON.stringify(['rubberband-v2',sample.path,info.size,info.mtimeMs,rate,semitones,sample.type])).digest('hex');
    const output = path.join(this.directory,`${cacheKey}.wav`);
    await mkdir(this.directory,{recursive:true});
    try { await stat(output); await utimes(output,new Date(),new Date()); return output; } catch(e) { if(e.code!=='ENOENT')throw e; }
    if(this.pending.has(cacheKey))return this.pending.get(cacheKey);
    if(this.pending.size>=12)throw new Error('The stretch queue is full. Wait for the current sounds to finish.');
    const job=this.queue.catch(()=>{}).then(async()=>{
      if(signal?.aborted)throw new Error('Audio processing cancelled.');
      const metadata=await probeAudio(sample.path,signal);
      if(!metadata.duration || metadata.duration>180 || metadata.duration/rate>360)throw new Error('Tempo/key sync supports source clips up to 3 minutes and output up to 6 minutes. Use a shorter excerpt.');
      const temporary=output+'.tmp';
      try {
        await runMedia(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','1','-protocol_whitelist','file,pipe','-i',sample.path,'-map','0:a:0','-vn','-af',`rubberband=tempo=${rate.toFixed(8)}:pitch=${(2 ** (semitones / 12)).toFixed(10)}:transients=${sample.type==='Drums'?'crisp':'mixed'}:channels=together`,'-ar','44100','-ac',String(Math.min(2,metadata.channels||2)),'-c:a','pcm_f32le','-f','wav',temporary],{maxBytes:65536,timeout:120000,signal});
        await rename(temporary,output); await this.prune(output); return output;
      } catch(error) { await unlink(temporary).catch(()=>{}); throw error; }
    });
    this.queue=job;this.pending.set(cacheKey,job);
    try{return await job;}finally{this.pending.delete(cacheKey);}
  }
  async prune(keep) {
    const entries=await readdir(this.directory); const files=[];
    for(const name of entries.filter(n=>/^[a-f0-9]{64}\.wav$/.test(n))) { const filename=path.join(this.directory,name);try{files.push({filename,...await stat(filename)});}catch{} }
    let bytes=files.reduce((n,f)=>n+f.size,0);
    for(const file of files.sort((a,b)=>a.mtimeMs-b.mtimeMs)){if(bytes<=512*1024*1024)break;if(file.filename===keep)continue;try{await unlink(file.filename);bytes-=file.size;}catch{}}
  }
}
