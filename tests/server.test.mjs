import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rename, utimes, lstat, rmdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import http from 'node:http';
import { makeDemo } from '../lib/audio.mjs';
import { encodeWav } from '../public/export-audio.js';

test('local server indexes, streams and persists without exposing arbitrary files', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(),'sift-test-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const port = 44317;
  const proc = spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SIFT_DATA_DIR:path.join(data,'data'),SIFT_ANALYSIS_PAUSED:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>proc.kill());
  let startupTimer;
  try { await Promise.race([once(proc.stdout,'data'),new Promise((_,reject)=>{ startupTimer=setTimeout(()=>reject(new Error('Server startup timeout')),10000); proc.once('error',reject); proc.once('exit',code=>reject(new Error(`Server exited during startup: ${code}`))); proc.stderr.once('data',data=>reject(new Error(data.toString()))); })]); }
  finally { clearTimeout(startupTimer); }
  const base=`http://127.0.0.1:${port}`,get=route=>fetch(base+route),post=(route,value)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  let response=await get('/api/library');assert.equal(response.status,200);let library=await response.json();assert.equal(library.samples.length,12);
  const id=library.samples[0].id;
  response=await fetch(`http://localhost:${port}/api/library`);assert.equal(response.status,200);
  response=await fetch(`http://[::1]:${port}/api/library`,{headers:{Origin:`http://[::1]:${port}`}});assert.equal(response.status,200);
  response=await fetch(`http://[::1]:${port}/api/library`,{headers:{Origin:'https://attacker.example'}});assert.equal(response.status,403);
  response=await fetch(`${base}/audio/${id}`,{headers:{Range:'bytes=0-43'}});assert.equal(response.status,206);const header=Buffer.from(await response.arrayBuffer());assert.equal(header.length,44);assert.equal(header.toString('ascii',0,4),'RIFF');
  response=await fetch(`${base}/audio/${id}`,{headers:{Range:'bytes=-8'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,8);
  response=await fetch(`${base}/audio/${id}`,{headers:{Range:'bytes=999999999-'}});assert.equal(response.status,416);
  response=await get('/audio/not-indexed');assert.equal(response.status,404);
  response=await get('/server.mjs');assert.equal(response.status,404);
  response=await get('/data/library.json');assert.equal(response.status,404);
  response=await fetch(`${base}/api/library`,{headers:{Origin:'https://attacker.example'}});assert.equal(response.status,403);
  const hostileHostStatus=await new Promise((resolve,reject)=>{const request=http.get(`${base}/api/library`,{headers:{Host:'attacker.example'}},result=>{result.resume();resolve(result.statusCode);});request.on('error',reject);});assert.equal(hostileHostStatus,403);
  response=await fetch(`${base}/api/scan`,{method:'POST',body:'{}'});assert.equal(response.status,415);
  const samples=path.join(data,'My samples');await mkdir(path.join(samples,'nested'),{recursive:true});
  await writeFile(path.join(samples,'nested','dust_drums_110bpm.wav'),makeDemo('Drums',1,110).buffer);
  await writeFile(path.join(samples,'ignore.txt'),'not audio');
  response=await post('/api/scan',{path:samples});assert.equal(response.status,202);
  for(let i=0;i<100;i++){const scan=await(await get('/api/scan')).json();if(!scan.running)break;await new Promise(resolve=>setTimeout(resolve,20));}
  library=await(await get('/api/library')).json();assert.equal(library.samples.length,13);const imported=library.samples.find(s=>!s.demo);assert.equal(imported.bpm,110);assert.equal(imported.type,'Drums');assert.ok(imported.duration>8);
  response=await post('/api/favorites',{ids:[imported.id,'fake',imported.id]});assert.equal(response.status,200);
  response=await post('/api/sets',{name:'First find',tempo:110,key:'Bb min',sync:true,tracks:[{id:imported.id,volume:.5}]});assert.equal(response.status,200);
  response=await post('/api/workspace',{tempo:110,key:'C maj',tracks:[{id:imported.id,timing:{offset:.125,repeat:'bar'}}]});assert.equal(response.status,200);
  const saved=JSON.parse(await readFile(path.join(data,'data','library.json'),'utf8'));assert.deepEqual(saved.favorites,[imported.id]);assert.equal(saved.sets[0].name,'First find');assert.equal(saved.workspace.tempo,110);
  assert.equal(saved.sets[0].key,'A# min');assert.equal(saved.workspace.key,'C maj');
  assert.deepEqual(saved.workspace.tracks[0].timing,{offset:.125,repeat:'bar'});assert.deepEqual(saved.sets[0].tracks[0].timing,{offset:null,repeat:'auto'});
  response=await get('/');assert.equal(response.status,200);assert.match(await response.text(),/Find what you forgot/);
  response=await get('/app.js');assert.equal(response.status,200);assert.ok((await response.text()).length>10000);
  response=await post('/api/metadata',{id:imported.id,bpm:55,key:null});assert.equal(response.status,200);let updated=await response.json();assert.equal(updated.bpmSource,'manual');assert.equal(updated.bpm,55);
  response=await post('/api/metadata',{id:imported.id,bpm:999,key:null});assert.equal(response.status,400);
  response=await post('/api/metadata',{id:imported.id,key:'C maj'});assert.equal(response.status,200);updated=await response.json();assert.equal(updated.bpm,55);assert.equal(updated.key,'C maj');
  response=await post('/api/metadata',{id:imported.id,bpm:null});assert.equal(response.status,200);updated=await response.json();assert.equal(updated.bpm,null);assert.equal(updated.key,'C maj');
  response=await post('/api/metadata',{id:imported.id,bpm:55});assert.equal(response.status,200);updated=await response.json();assert.equal(updated.bpm,55);assert.equal(updated.key,'C maj');
  response=await post('/api/metadata',{id:imported.id,bpm:999,key:'A min'});assert.equal(response.status,400);
  library=await(await get('/api/library')).json();assert.equal(library.samples.find(s=>s.id===imported.id).key,'C maj');
  response=await post('/api/metadata',{id:imported.id,key:null});assert.equal(response.status,200);updated=await response.json();assert.equal(updated.bpm,55);assert.equal(updated.key,null);
  response=await post('/api/analysis',{action:'reanalyze',ids:[imported.id]});assert.equal(response.status,200);
  const deadline=Date.now()+45000;
  while(true){library=await(await get('/api/library')).json();updated=library.samples.find(s=>s.id===imported.id);if(updated.analysis?.status==='done')break;assert.ok(Date.now()<deadline,'Analysis did not complete');await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(updated.bpm,55);assert.equal(updated.bpmSource,'manual');assert.ok(Math.abs(updated.analysis.bpm-110)<2);
  response=await post('/api/metadata',{id:imported.id,reset:true});updated=await response.json();assert.equal(updated.bpmSource,'filename');assert.equal(updated.bpm,110);
  response=await post('/api/stretch',{id:imported.id,tempo:140});assert.equal(response.status,200);const rendered=await response.json();assert.match(rendered.url,/^\/rendered\/[a-f0-9]{64}\.wav$/);
  response=await get(rendered.url);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>1000);
  response=await post('/api/stretch',{id:imported.id,tempo:0});assert.equal(response.status,400);
  response=await post('/api/stretch',{id:imported.id,tempo:120,key:'A min'});assert.equal(response.status,200);assert.equal((await response.json()).semitones,0);
  const tonal=library.samples.find(s=>s.type==='Melodic'&&s.demo);
  response=await post('/api/metadata',{id:tonal.id,bpm:null});assert.equal(response.status,200);
  response=await post('/api/stretch',{id:tonal.id,tempo:120,key:'B min'});assert.equal(response.status,200);
  const pitchOnly=await response.json();assert.equal(pitchOnly.rate,1);assert.equal(pitchOnly.semitones,2);assert.equal(pitchOnly.outputKey,'B min');assert.equal(pitchOnly.tempoUnknown,true);
  response=await post('/api/stretch',{id:tonal.id,tempo:120,key:'B min',sync:false});assert.equal(response.status,200);assert.equal((await response.json()).url,pitchOnly.url);
  for(const settings of [{key:'invalid'},{key:{}},{sync:'false'}]){response=await post('/api/stretch',{id:tonal.id,tempo:120,...settings});assert.equal(response.status,400);}
  response=await get('/harmony.js');assert.equal(response.status,200);
  response=await get('/timing.js');assert.equal(response.status,200);
  response=await get('/export-audio.js');assert.equal(response.status,200);
  response=await get('/api/capabilities');assert.equal((await response.json()).handoff,1);
  response=await post('/api/handoffs',{workspace:{tracks:[{id:tonal.id,type:'Melodic'}],tempo:120,key:'B min',sync:true}});assert.equal(response.status,201);
  const handoff=await response.json(),stem=Buffer.from(encodeWav([new Float32Array(handoff.frames).fill(.1),new Float32Array(handoff.frames).fill(-.1)]));
  response=await get(`/api/handoffs/${handoff.id}`);assert.equal(response.status,400);
  response=await fetch(`${base}/api/handoffs/${handoff.id}/stems/0`,{method:'PUT',headers:{'Content-Type':'audio/wav',Origin:'https://attacker.example'},body:stem});assert.equal(response.status,403);
  response=await fetch(`${base}/api/handoffs/${handoff.id}/stems/0`,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:stem});assert.equal(response.status,200);
  response=await post(`/api/handoffs/${handoff.id}/finish`,{});assert.equal(response.status,200);assert.equal((await response.json()).ready,true);
  response=await get(`/api/handoffs/${handoff.id}/files/${encodeURIComponent(handoff.files[0].name)}`);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),stem);
  response=await get(`/api/handoffs/${handoff.id}/files/Stems.zip`);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');assert.equal(Buffer.from(await response.arrayBuffer()).readUInt32LE(0),0x04034b50);
  response=await fetch(`${base}/api/handoffs/${handoff.id}/stems/0`,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:stem});assert.equal(response.status,400);
  const abandoned=path.join(data,'data','exports',randomUUID());await mkdir(abandoned);await writeFile(path.join(abandoned,'session.json'),'{}');
  const old=new Date(Date.now()-8*24*60*60*1000);await utimes(path.join(abandoned,'session.json'),old,old);await utimes(abandoned,old,old);
  response=await post('/api/handoffs/cleanup',{});assert.equal(response.status,200);assert.deepEqual(await response.json(),{removed:1});
  await assert.rejects(()=>lstat(abandoned),{code:'ENOENT'});
  response=await get(`/api/handoffs/${handoff.id}/files/Stems.zip`);assert.equal(response.status,200);await response.arrayBuffer();
  response=await post('/api/handoffs',{workspace:{tracks:[{id:'missing'}]}});assert.equal(response.status,400);
  response=await get('/rendered/library.json');assert.equal(response.status,404);
  response=await get('/workspace.js');assert.equal(response.status,200);assert.match(await response.text(),/export function normalizeWorkspace/);
  const workspaceBefore=(await(await get('/api/library')).json()).workspace;
  for(const timing of [null,{offset:-1},{offset:3601},{offset:'1'},{repeat:'forever'}]){
    response=await post('/api/workspace',{tracks:[{id:imported.id,timing}]});assert.equal(response.status,400);
    assert.deepEqual((await(await get('/api/library')).json()).workspace,workspaceBefore);
    response=await post('/api/sets',{name:'Invalid timing',tracks:[{id:imported.id,timing}]});assert.equal(response.status,400);
  }
  for(const invalid of [null,{tracks:[{type:['Drums']}]},{tracks:[],tempo:999},{tracks:[],sync:'false'},{tracks:[],key:'invalid'},{tracks:[],key:{}},{tracks:[],name:{}}]){
    response=await post('/api/workspace',invalid);assert.equal(response.status,400);
    assert.deepEqual((await(await get('/api/library')).json()).workspace,workspaceBefore);
  }
  response=await post('/api/sets',{name:'Invalid',tracks:[{type:['Drums']}]});assert.equal(response.status,400);
  const orphanPath=path.join(samples,'orphan.wav');await writeFile(orphanPath,makeDemo('Bass',0).buffer);
  const rescan=async()=>{const r=await post('/api/scan',{path:samples});assert.equal(r.status,202);for(let i=0;i<100;i++){if(!(await(await get('/api/scan')).json()).running)return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Scan did not complete');};
  await rescan();library=await(await get('/api/library')).json();const orphan=library.samples.find(s=>s.filename==='orphan.wav');
  await unlink(orphanPath);await unlink(imported.path);await rescan();
  library=await(await get('/api/library')).json();assert.equal(library.samples.find(s=>s.id===imported.id).missing,true);
  response=await get('/audio/'+imported.id);assert.equal(response.status,404);
  response=await post('/api/library/cleanup',{});assert.equal(response.status,200);assert.equal((await response.json()).removed,1);
  library=await(await get('/api/library')).json();assert.ok(!library.samples.some(s=>s.id===orphan.id));assert.ok(library.samples.some(s=>s.id===imported.id));
  assert.deepEqual(library.favorites,[imported.id]);assert.equal(library.sets[0].tracks[0].id,imported.id);assert.equal(library.workspace.tracks[0].id,imported.id);
  await rename(samples,samples+'-offline');response=await post('/api/library/cleanup',{});const offline=await response.json();assert.equal(offline.removed,0);assert.equal(offline.unavailableRoots,1);
  await rename(samples+'-offline',samples);await writeFile(imported.path,makeDemo('Drums',1,110).buffer);await rescan();
  library=await(await get('/api/library')).json();assert.ok(!library.samples.find(s=>s.id===imported.id).missing);
  response=await post('/api/analysis',{action:'pause'});assert.equal(response.status,200);
  while((await(await get('/api/analysis')).json()).running){assert.ok(Date.now()<deadline,'Analysis did not pause');await new Promise(resolve=>setTimeout(resolve,30));}
  const blockedSave=path.join(data,'data','library.backup.json.tmp');await mkdir(blockedSave);
  response=await post('/api/analysis',{action:'resume'});assert.equal(response.status,400);
  let status=await(await get('/api/analysis')).json();assert.ok(status.saveError);assert.equal(status.paused,true);
  response=await post('/api/analysis',{action:'reanalyze',ids:[imported.id]});assert.equal(response.status,400);
  status=await(await get('/api/analysis')).json();assert.ok(status.saveError);assert.equal(status.paused,true);assert.equal(status.running,false);
  await rmdir(blockedSave);
  response=await post('/api/analysis',{action:'resume'});assert.equal(response.status,200);
  status=await response.json();assert.equal(status.saveError,null);assert.equal(status.paused,false);
});
