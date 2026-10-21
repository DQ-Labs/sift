import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { Essentia, EssentiaWASM }=require('essentia.js');
const engine=new Essentia(EssentiaWASM);
parentPort.on('message',({audio,type})=>{
  let vector, rhythm;
  try {
    const duration=audio.length/44100,peaks=Array(160).fill(0);let energy=0;
    for(let i=0;i<audio.length;i++){const value=Number.isFinite(audio[i])?audio[i]:0;audio[i]=value;energy+=value*value;const bin=Math.min(159,Math.floor(i/audio.length*160));peaks[bin]=Math.max(peaks[bin],Math.abs(value));}
    const rms=Math.sqrt(energy/Math.max(1,audio.length));
    // Beat trackers can find a plausible grid in stationary noise. Require
    // actual separated amplitude attacks before accepting their tempo.
    const envelope=[];for(let start=0;start+1024<=audio.length;start+=1024){let sum=0;for(let i=start;i<start+1024;i++)sum+=audio[i]*audio[i];envelope.push(Math.sqrt(sum/1024));}
    let attacks=0,lastAttack=-100;for(let i=1;i<envelope.length;i++){if(envelope[i]-envelope[i-1]>rms*.08&&i-lastAttack>6){attacks++;lastAttack=i;}}
    const result={bpm:null,key:null,bpmConfidence:0,keyStrength:0,onsetCount:attacks,analyzedSeconds:duration,peaks,rmsDb:20*Math.log10(Math.max(1e-9,rms)),warnings:[]};
    if(rms<.0003||duration<.4){result.warnings.push(rms<.0003?'Too quiet for reliable musical analysis.':'Too short for musical analysis.');parentPort.postMessage({result});return;}
    vector=engine.arrayToVector(audio);
    if(duration>=4){
      rhythm=engine.RhythmExtractor2013(vector,240,'multifeature',40);
      result.bpmConfidence=rhythm.confidence;
      if(attacks>=4&&rhythm.bpm>=40&&rhythm.bpm<=240&&rhythm.confidence>=2&&rhythm.ticks.size()>=4)result.bpm=Math.round(rhythm.bpm*10)/10;
      else result.warnings.push('No reliable repeating beat; tempo left unknown.');
    }else result.warnings.push('Under 4 seconds: tempo left unknown.');
    if(type!=='Drums'&&duration>=1){
      const key=engine.KeyExtractor(vector,true,4096,2048,36,3500,60,25,.2,'temperley',44100);
      result.keyStrength=key.strength;
      if(key.strength>=.65&&['major','minor'].includes(key.scale))result.key=`${key.key} ${key.scale==='minor'?'min':'maj'}`;
      else result.warnings.push('Tonal evidence is weak; key left unknown.');
    }else result.warnings.push('No key assigned to a drum-tagged or very short sample.');
    parentPort.postMessage({result});
  }catch(error){parentPort.postMessage({error:error.message||String(error)});}
  finally{for(const value of Object.values(rhythm||{}))if(value?.delete)value.delete();vector?.delete();}
});
