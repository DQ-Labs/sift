import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKey, pitchPlan, renderPlan, chooseCombination } from '../public/harmony.js';
import { normalizeWorkspace } from '../public/workspace.js';

test('key matching uses the shortest scale transposition and preserves major/minor', () => {
  assert.equal(parseKey('Bb min').name, 'A# min');
  assert.equal(parseKey('Cb maj').name, 'B maj');
  assert.equal(parseKey({}), null);
  for (const [source, target, shift, output] of [
    ['G# min','A min',1,'A min'], ['G min','A min',2,'A min'], ['E min','A min',5,'A min'],
    ['B min','A min',-2,'A min'], ['C maj','A min',0,'C maj'], ['A min','C maj',0,'A min'],
    ['E maj','A min',-4,'C maj'], ['F# maj','C maj',-6,'C maj'], ['Bb min','A# min',0,'A# min']
  ]) {
    const plan = pitchPlan({ type:'Melodic', key:source }, target);
    assert.equal(plan.semitones, shift, `${source} -> ${target}`);
    assert.equal(plan.outputKey, output);
  }
  assert.equal(pitchPlan({type:'Drums',key:'G min'},'A min').semitones,0);
  assert.equal(pitchPlan({type:'Texture',key:null},'A min').status,'unknown');
  assert.equal(pitchPlan({type:'Bass',key:'G min'},null).status,'original');
});

test('key and tempo processing are independent, and unknown metadata never implies a match', () => {
  const sample={type:'Bass',bpm:120,key:'G min'};
  assert.deepEqual(renderPlan(sample,{tempo:180,sync:false,key:'A min'}),{...pitchPlan(sample,'A min'),rate:1,tempoUnknown:false,processed:true});
  assert.equal(renderPlan(sample,{tempo:180,sync:true,key:null}).rate,1.5);
  const unknown=renderPlan({...sample,bpm:null,key:null},{tempo:180,sync:true,key:'A min'});
  assert.equal(unknown.processed,false);assert.equal(unknown.tempoUnknown,true);assert.equal(unknown.status,'unknown');
});

test('rerolls favor nearby tempo/key, retain variety, and preserve untouched layers and controls', () => {
  const settings={tempo:120,sync:true,key:'A min'};
  const sample=(id,bpm,key,type='Bass',extra={})=>({id,bpm,key,type,size:1000,duration:8,...extra});
  const pool=[sample('near',120,'A min'),sample('relative',122,'C maj'),sample('far',60,'D# min'),sample('unknown',null,null),sample('missing',120,'A min','Bass',{missing:true})];
  for(const random of [()=>0,()=>.9999]){
    const result=chooseCombination([{type:'Bass',id:null,volume:.4}],pool,settings,null,random);
    assert.ok(['near','relative'].includes(result[0].id));assert.equal(result[0].volume,.4);
  }
  const tracks=[{type:'Bass',id:'near',locked:true,volume:.3},{type:'Bass',id:'relative',mute:true},{type:'Texture',id:'texture',solo:true}];
  const result=chooseCombination(tracks,pool,settings,1,()=>0);
  assert.deepEqual(result[0],tracks[0]);assert.deepEqual(result[2],tracks[2]);assert.equal(result[1].mute,true);
  assert.notEqual(result[1].id,'near');assert.notEqual(result[1].id,'relative');
  const all=chooseCombination([{type:'Bass'},{type:'Bass'},{type:'Bass'}],pool,settings,null,()=>0);
  assert.equal(new Set(all.map(t=>t.id)).size,3);
  const scarce=chooseCombination([{type:'Bass',id:'gone'},{type:'Bass',id:'near'}],[pool[0]],settings,null,()=>0);
  assert.deepEqual(scarce.map(t=>t.id),['near',null]);
  assert.equal(chooseCombination([{type:'Bass',id:'old'}],[],settings)[0].id,'old');
  const long=sample('long',120,'G min','Bass',{duration:181});
  assert.equal(chooseCombination([{type:'Bass'}],[long],settings)[0].id,undefined);
  assert.equal(chooseCombination([{type:'Bass'}],[long],{...settings,key:null})[0].id,'long');
  const single=chooseCombination([{type:'Bass',id:'near'},{type:'Bass',id:'relative'}],pool,settings,0,()=>0);
  assert.notEqual(single[0].id,'relative');assert.deepEqual(single[1],{type:'Bass',id:'relative'});
});

test('session keys persist canonically, old sets keep original pitch, and new workspaces match by default', () => {
  assert.equal(normalizeWorkspace(null).key,'A min');assert.equal(normalizeWorkspace(null).sync,true);
  assert.equal(normalizeWorkspace({tracks:[],sync:false}).key,null);
  assert.equal(normalizeWorkspace({tracks:[],key:'Bb min'},{strict:true}).key,'A# min');
  for(const key of ['',false,{},12,'C','H min'])assert.throws(()=>normalizeWorkspace({tracks:[],key},{strict:true}),{status:400});
  assert.equal(normalizeWorkspace({tracks:[],key:'invalid'}).key,null);
});
