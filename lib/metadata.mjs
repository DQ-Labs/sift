import path from 'node:path';
import { tagsFromName, classifyType, tempoHintFromName } from './audio.mjs';

const notes = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const pitchClasses = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
export function normalizeKey(value) {
  const match = /^([A-G])([#b]?) (min|maj)$/.exec(value || '');
  if (!match) return value ?? null;
  const pitch = (pitchClasses[match[1]] + (match[2]==='#'?1:match[2]==='b'?-1:0) + 12) % 12;
  return `${notes[pitch]} ${match[3]}`;
}
function relativeKeys(a,b) {
  const [an,as]=a.split(' '), [bn,bs]=b.split(' ');
  return as!==bs && (notes.indexOf(an)+(as==='min'?3:0))%12 === (notes.indexOf(bn)+(bs==='min'?3:0))%12;
}
export function classification(sample) {
  if (sample.demo) return {type:sample.type,typeSource:'demo',typeHint:'Sift demo collection'};
  const fromName=tagsFromName(sample.filename).type;
  if(fromName!=='Other')return {type:fromName,typeSource:'filename',typeHint:sample.filename};
  if(sample.path) {
    const parent=path.dirname(sample.path),root=sample.root || parent,relative=path.relative(root,parent);
    // Do not infer roles from folders outside the source the user indexed.
    if(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep)){
      const folders=[path.basename(root),...relative.split(path.sep).filter(Boolean)];
      for(const folder of folders.reverse()){
        const type=classifyType(folder);
        if(type!=='Other')return {type,typeSource:'folder',typeHint:folder};
      }
    }
  }
  return {type:'Other',typeSource:'unknown',typeHint:null};
}
export function effectiveMetadata(sample) {
  const tags=tagsFromName(sample.filename), result={};
  const explicitBpm=tempoHintFromName(sample.filename).explicit;
  const labels={bpm:tags.bpm,key:normalizeKey(tags.key),bpmExplicit:explicitBpm};
  const conflicts={};
  for(const field of ['bpm','key']){
    const label=labels[field],estimate=sample.analysis?.status==='done' ? (field==='key'?normalizeKey(sample.analysis.key):sample.analysis[field]) : null;
    const explicit=field==='key' || explicitBpm;
    if(Object.hasOwn(sample.overrides||{},field)){result[field]=field==='key'?normalizeKey(sample.overrides[field]):sample.overrides[field];result[field+'Source']='manual';}
    else if(sample.demo){result[field]=field==='bpm'?92:sample.type==='Drums'?null:'A min';result[field+'Source']=result[field]===null?'unknown':'demo';}
    else if(explicit&&label!=null){result[field]=label;result[field+'Source']='filename';}
    else if(estimate!=null){result[field]=estimate;result[field+'Source']='analysis';}
    else {result[field]=label;result[field+'Source']=label==null?'unknown':field==='bpm'?'filename-hint':'filename';}
    if(!sample.demo&&explicit&&label!=null&&estimate!=null){
      const differs=field==='bpm'?Math.abs(label-estimate)>Math.max(2,label*.015):label!==estimate;
      if(differs)conflicts[field]={label,estimate,kind:field==='key'&&relativeKeys(label,estimate)?'relative-key':field==='bpm'&&(Math.abs(estimate/label-2)<.04||Math.abs(estimate/label-.5)<.02)?'half-double':'different',resolved:result[field+'Source']==='manual'};
    }
  }
  return {...result,labels,conflicts};
}
export function refreshSampleMetadata(sample) {
  const previousType=sample.type;
  Object.assign(sample,classification(sample));
  // Drum classification suppresses key estimation; re-run only when that rule changes.
  if(sample.analysis&&previousType!==sample.type&&(previousType==='Drums'||sample.type==='Drums'))delete sample.analysis;
  Object.assign(sample,effectiveMetadata(sample));
  return sample;
}
