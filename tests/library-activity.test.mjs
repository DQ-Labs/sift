import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryActivity } from '../public/library-activity.js';
import { AnalysisQueue } from '../lib/analysis.mjs';

test('indexing stays visible above background analysis and never invents a percentage',()=>{
  const scan={running:true,count:12345,current:'Pack/Drums'},analysis={running:true,pending:200};
  const activity=libraryActivity(scan,analysis);
  assert.equal(activity.visible,true);assert.equal(activity.busy,true);assert.equal(activity.progress,undefined);
  assert.match(activity.detail,/12,345 samples indexed/);assert.equal(activity.current,'Pack/Drums');assert.equal(activity.action,'cancel');
  assert.match(libraryActivity({...scan,phase:'saving'},analysis).title,/Saving/);
  const stopping=libraryActivity({...scan,cancelled:true},analysis);assert.match(stopping.title,/Stopping/);assert.equal(stopping.action,null);
});

test('analysis progress survives collapsed collection, pause, failure and completion states',()=>{
  const status={running:true,paused:false,pending:89,remaining:90,processed:10,total:100,failed:2,current:'Kick.wav'};
  const active=libraryActivity({running:false},status);
  assert.deepEqual(active.progress,{value:10,max:100});assert.equal(active.action,'pause');assert.match(active.current,/Kick.wav/);
  assert.match(active.detail,/90 remaining · 2 failed/);
  const paused=libraryActivity(null,{...status,paused:true});assert.equal(paused.visible,true);assert.equal(paused.busy,false);assert.equal(paused.action,'resume');assert.match(paused.current,/Finishing/);
  const idlePaused=libraryActivity(null,{...status,paused:true,running:false});assert.equal(idlePaused.current,null);
  const failedSave=libraryActivity(null,{...status,saveError:'Disk full'});assert.equal(failedSave.visible,true);assert.equal(failedSave.action,'resume');assert.match(failedSave.detail,/could not be saved/);
  const ready=libraryActivity(null,{...status,running:false,pending:0,remaining:0});assert.equal(ready.visible,false);assert.equal(ready.label,'Library ready');
});

test('lost connections and scan errors cannot look ready or continue showing stale progress',()=>{
  const disconnected=libraryActivity({running:true},{running:true},true);
  assert.equal(disconnected.busy,false);assert.equal(disconnected.progress,undefined);assert.match(disconnected.title,/unavailable/);
  const failed=libraryActivity({running:false,error:'Drive disconnected'},null);
  assert.equal(failed.visible,true);assert.equal(failed.detail,'Drive disconnected');assert.match(failed.label,/attention/);
});

test('large paused analysis queues deduplicate work and report the number remaining',()=>{
  const queue=new AnalysisQueue({samples:()=>[],persist:async()=>{},paused:true});
  const samples=Array.from({length:20000},(_,i)=>({id:String(i)}));
  queue.enqueue(samples);queue.enqueue(samples);
  assert.equal(queue.status().total,20000);assert.equal(queue.status().remaining,20000);
  assert.equal(queue.status().processed,0);queue.close();
});
