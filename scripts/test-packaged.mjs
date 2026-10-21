import assert from 'node:assert/strict';
import { access, readFile, readdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory=path.resolve('dist','win-unpacked'),root=path.join(directory,'resources','app');
const executable=path.join(directory,'Sift.exe');
assert.equal(process.platform,'win32','Run the packaged smoke test on Windows.');
assert.equal((await readFile(executable)).toString('ascii',0,2),'MZ');
for(const file of ['server.mjs','desktop/main.cjs','desktop/runtime.cjs','lib/analysis-worker.mjs','public/app.js','LICENSE','node_modules/essentia.js/LICENSE'])await access(path.join(root,file));
const files=await readdir(root);
for(const excluded of ['data','sounds','test-output','tests','.git','.env','CODE-REVIEW-REPORT.md'])assert.ok(!files.includes(excluded),`${excluded} must not ship in the application.`);
if(process.argv.includes('--headless')){
  const {testPackagedBackend}=await import('./test-packaged-backend.mjs');
  await testPackagedBackend(executable,root);
  console.log('Headless Windows package checks passed. Full FFmpeg and desktop/portable GUI acceptance tests require a desktop Windows machine: npm run test:packaged.');
  process.exit(0);
}
// Run the full API/analysis/stretch/handoff workflow using the shipped Electron
// executable as Node and the packaged source, from a separate writable directory.
const result=spawnSync(process.execPath,['--test','tests/server.test.mjs'],{
  stdio:'inherit',windowsHide:true,
  env:{...process.env,SIFT_TEST_EXECUTABLE:executable,SIFT_TEST_ROOT:root}
});
assert.equal(result.status,0,'The packaged application failed its backend smoke test.');
const {version}=JSON.parse(await readFile('package.json','utf8'));
for(const desktop of [executable,path.resolve('dist',`Sift-${version}-Portable-x64.exe`)]){
  const data=await mkdtemp(path.join(os.tmpdir(),'sift-desktop-smoke-'));
  const result=spawnSync(desktop,['--sift-smoke-test','--disable-gpu'],{windowsHide:true,stdio:'inherit',timeout:45000,env:{...process.env,SIFT_DATA_DIR:data,PORT:'44319',SIFT_ANALYSIS_PAUSED:'1'}});
  assert.equal(result.status,0,`${path.basename(desktop)} did not shut down cleanly: ${result.error?.message||''}`);
  const status=JSON.parse(await readFile(path.join(data,'desktop-smoke.json'),'utf8'));assert.equal(status.rendererReady,true);assert.equal(status.dataDirectory,data);
  await assert.rejects(()=>fetch('http://127.0.0.1:44319/api/capabilities',{signal:AbortSignal.timeout(2000)}),/fetch failed|timeout/i,'A packaged desktop left its backend running.');
  console.log(`${path.basename(desktop)}: renderer, preload, writable data and backend shutdown passed.`);
}
console.log('Packaged runtime, desktop, portable launcher, Essentia worker, FFmpeg processing and handoff smoke tests passed.');
