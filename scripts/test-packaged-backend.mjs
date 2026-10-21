import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';

// An actual shipped-runtime check that also works on the hosted headless server.
// FFmpeg processing and visible Electron windows are exercised separately by
// the full local Windows acceptance test, not silently skipped here.
export async function testPackagedBackend(executable,root){
  const data=await mkdtemp(path.join(os.tmpdir(),'sift-packaged-backend-'));
  const base='http://127.0.0.1:44319';
  const launch=async()=>{
    const child=spawn(executable,[path.join(root,'server.mjs')],{cwd:data,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',SIFT_DATA_DIR:data,PORT:'44319',SIFT_ANALYSIS_PAUSED:'1'}});
    let output='',failure;
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});child.on('error',error=>{failure=error;});
    try{
      const deadline=Date.now()+20000;
      while(true){
        if(failure)throw failure;
        if(child.exitCode!==null)throw new Error(`Packaged server exited (${child.exitCode}): ${output}`);
        try{const response=await fetch(`${base}/api/capabilities`,{signal:AbortSignal.timeout(1000)});if(response.ok){assert.equal((await response.json()).dataDirectory,data);break;}}catch(error){if(error.code==='ERR_ASSERTION')throw error;}
        assert.ok(Date.now()<deadline,`Packaged server startup timed out: ${output}`);
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return child;
    }catch(error){child.kill();throw error;}
  };
  const stop=async child=>{
    const exited=once(child,'exit');const timeout=setTimeout(()=>child.kill(),10000);
    try{child.send({type:'sift:shutdown'});assert.equal((await exited)[0],0);}finally{clearTimeout(timeout);}
    await assert.rejects(()=>fetch(`${base}/api/capabilities`,{signal:AbortSignal.timeout(1000)}),/fetch failed|timeout/i);
  };
  let child=await launch();
  try{
    const response=await fetch(`${base}/api/library`);assert.equal(response.status,200);
    const library=await response.json();assert.equal(library.samples.length,12);const id=library.samples[0].id;
    const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/Find what you forgot/);
    const audio=await fetch(`${base}/audio/${id}`,{headers:{Range:'bytes=0-43'}});assert.equal(audio.status,206);assert.equal(Buffer.from(await audio.arrayBuffer()).toString('ascii',0,4),'RIFF');
    const saved=await fetch(`${base}/api/favorites`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id]})});assert.equal(saved.status,200);
    await stop(child);child=null;
    assert.deepEqual(JSON.parse(await readFile(path.join(data,'library.json'),'utf8')).favorites,[id]);
    child=await launch();assert.deepEqual((await(await fetch(`${base}/api/library`)).json()).favorites,[id]);
    await stop(child);child=null;
    console.log('Packaged backend: shipped runtime, HTTP/UI assets, demo audio, writable catalogue, persistence across restart and clean shutdown passed.');
  }finally{child?.kill();}
}
