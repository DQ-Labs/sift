import test from 'node:test';
import assert from 'node:assert/strict';
import { planCycle, fillCycle, makeCycle, sessionFrames, cyclePosition, audibleStart } from '../public/timing.js';
import { normalizeWorkspace } from '../public/workspace.js';
import { chooseCombination } from '../public/harmony.js';

const rate=44100,settings={tempo:120,sync:true,key:null},sample={bpm:120,bpmSource:'filename',type:'Drums'};
const track=(offset=0,repeat='auto')=>({timing:{offset,repeat}});
const plan=(seconds,t=track(),s=sample,options=settings)=>planCycle(s,t,options,Math.round(seconds*rate),rate);
const fakeContext={createBuffer(channels,length,sampleRate){const data=Array.from({length:channels},()=>new Float32Array(length));return {length,sampleRate,numberOfChannels:channels,duration:length/sampleRate,getChannelData:c=>data[c]};}};

test('automatic starts skip leading silence across stereo, while manual zero and offsets stay exact',()=>{
  const input=fakeContext.createBuffer(2,rate*12,rate);
  input.getChannelData(1).fill(.02,rate*10,rate*11);
  const first=audibleStart(input);assert.ok(first/rate>=9.99&&first/rate<=10);
  const automatic=makeCycle(fakeContext,input,sample,track(null,'once'),settings);
  assert.equal(automatic.plan.automatic,true);assert.ok(automatic.plan.offset>9.99);
  assert.ok(automatic.buffer.getChannelData(1).subarray(0,rate).some(n=>n>.01));
  const manual=makeCycle(fakeContext,input,sample,track(0,'once'),settings);
  assert.equal(manual.plan.offset,0);assert.ok(manual.buffer.getChannelData(1).every(n=>n===0));
  const shifted=makeCycle(fakeContext,input,sample,track(null,'once'),{...settings,tempo:180});
  assert.ok(Math.abs(shifted.plan.offset-first/rate*1.5)<1e-6);
  assert.equal(audibleStart(fakeContext.createBuffer(2,rate,rate)),0);
});

test('auto loops repeat short beat-aligned excerpts and crop tails to exact shared bar boundaries',()=>{
  const p=plan(2.02);assert.equal(p.length,8*rate);assert.equal(p.beats,4);
  assert.deepEqual(p.events.map(e=>e.start),[0,2*rate,4*rate,6*rate]);assert.equal(p.cropped,true);
  const source=Float32Array.from({length:Math.round(2.02*rate)},(_,i)=>i<2*rate?.5:1);
  const out=fillCycle(source,new Float32Array(p.length),p);
  for(const event of p.events){assert.equal(out[event.start+32],.5);assert.equal(out[event.end-1],0);}
  assert.ok(!out.some(value=>value===1),'tail must not leak into the next repetition');
});

test('unknown, disputed and unsynced BPM never silently assert an automatic beat loop',()=>{
  for(const s of [{...sample,bpm:null},{...sample,bpmSource:'filename-hint'},{...sample,conflicts:{bpm:{resolved:false}}},{...sample,bpm:60}]){
    const p=plan(2,track(),s,{...settings,sync:false});assert.equal(p.events.length,1);assert.equal(p.warnings.length,1);
    assert.equal(plan(2,track(0,'bar'),s,settings).events.length,4,'explicit repetition remains available');
  }
  assert.equal(plan(2,track(),{...sample,conflicts:{bpm:{resolved:true}}}).events.length,4);
  assert.equal(plan(.3,track(),{...sample,bpm:null}).padded,true);
  assert.equal(plan(2,track(0,'once')).events.length,1);
  assert.equal(plan(20).events[0].copy,8*rate);
});

test('offsets stay in original seconds through tempo stretching and are identical in both stereo channels',()=>{
  const stretched={...settings,tempo:180},input=fakeContext.createBuffer(2,rate*2,rate);
  const start=Math.round(.25/1.5*rate);input.getChannelData(0)[start+32]=.8;input.getChannelData(1)[start+32]=-.4;
  input.getChannelData(0)[32]=1;
  const {buffer,plan:p}=makeCycle(fakeContext,input,sample,track(.25,'bar'),stretched);
  assert.equal(p.events[0].sourceStart,start);assert.equal(buffer.length,sessionFrames(180,rate));
  for(const event of p.events){assert.ok(Math.abs(buffer.getChannelData(0)[event.start+32]-.8)<1e-6);assert.ok(Math.abs(buffer.getChannelData(1)[event.start+32]+.4)<1e-6);}
  assert.ok(!buffer.getChannelData(0).some(value=>value===1),'audio before selected downbeat must be omitted');
  const unknown=plan(1,track(.25),{...sample,bpm:null},stretched);assert.equal(unknown.events[0].sourceStart,Math.round(.25*rate));
});

test('one-shots are padded with silence and manual repeats do not stretch or sustain them',()=>{
  const p=plan(.3,track(0,'bar'),{...sample,bpm:null});
  const out=fillCycle(new Float32Array(Math.round(.3*rate)).fill(.25),new Float32Array(p.length),p);
  for(const event of p.events){assert.equal(out[event.start+32],.25);assert.ok(out.subarray(event.start+event.copy,event.end).every(n=>n===0));}
  const once=plan(.3,track(0,'once'));assert.equal(once.events.length,1);assert.equal(once.events[0].copy,Math.round(.3*rate));
});

test('fractional tempos use exact whole-cycle frames without subdivision drift, even after many cycles',()=>{
  for(const sampleRate of [44100,48000])for(const tempo of [40,92,123.45,240]){
    const length=sessionFrames(tempo,sampleRate),p=planCycle({...sample,bpm:tempo},track(0,'beat'),{...settings,tempo},sampleRate,sampleRate);
    assert.equal(p.events.length,16);assert.equal(p.events.at(-1).end,length);
    for(let i=1;i<16;i++)assert.equal(p.events[i].start,p.events[i-1].end);
    const restart=cyclePosition(length/sampleRate*1000,length,sampleRate);assert.equal(restart.fraction,0);assert.equal(restart.bar,1);assert.equal(restart.beat,1);
    const mid=cyclePosition((length*1000+Math.round(length/2))/sampleRate,length,sampleRate);assert.equal(mid.bar,3);assert.equal(mid.beat,1);
    for(let n=0;n<16;n++){const cursor=cyclePosition(p.events[n].start/sampleRate,length,sampleRate);assert.equal(cursor.bar,Math.floor(n/4)+1);assert.equal(cursor.beat,n%4+1);}
  }
});

test('timing fields are validated, legacy sets receive safe defaults, and replacements reset source-specific offsets',()=>{
  assert.deepEqual(normalizeWorkspace({tracks:[{id:'old'}]}).tracks[0].timing,{offset:null,repeat:'auto',start:'beat'});
  const input={tracks:[{id:'sample',timing:{offset:.25,repeat:'bar',start:'sound'}}]};assert.deepEqual(normalizeWorkspace(input,{strict:true}).tracks[0].timing,input.tracks[0].timing);
  for(const timing of [null,[],{offset:-1},{offset:'1'},{offset:3601},{repeat:'forever'},{start:'downbeat'}])assert.throws(()=>normalizeWorkspace({tracks:[{timing}]},{strict:true}),{status:400});
  assert.throws(()=>plan(1,track(1)),/past the end/);
  assert.throws(()=>plan(1,track(-1)),/valid start offset/);
  const layers=[{id:'old',type:'Bass',timing:{offset:2,repeat:'bar'}},{id:'keep',type:'Drums',locked:true,timing:{offset:1,repeat:'once'}}];
  const result=chooseCombination(layers,[{id:'new',type:'Bass',bpm:120,size:100,duration:8}],settings);
  assert.deepEqual(result[0].timing,{offset:null,repeat:'auto'});assert.deepEqual(result[1],layers[1]);
});
