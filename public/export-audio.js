// One master gain for mix and stems preserves their balance when recombined.
export function mixScale(layers) {
  let peak=1;
  const length=layers[0]?.channels[0]?.length||0;
  for(let i=0;i<length;i++)for(let c=0;c<2;c++){
    let sum=0;for(const layer of layers)sum+=layer.channels[c][i]*layer.gain;
    peak=Math.max(peak,Math.abs(sum));
  }
  return .98/peak;
}

export function encodeWav(channels,{gain=1,scale=1,rate=44100}={}) {
  const length=channels[0].length;
  if(channels.length!==2||channels[1].length!==length)throw new Error('Export requires equal stereo channels.');
  const result=new ArrayBuffer(44+length*4),view=new DataView(result);
  const text=(offset,value)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  text(0,'RIFF');view.setUint32(4,36+length*4,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,length*4,true);
  for(let i=0;i<length;i++){
    const fade=Math.min(1,i/128,(length-1-i)/256);
    for(let c=0;c<2;c++)view.setInt16(44+(i*2+c)*2,Math.round(Math.max(-1,Math.min(1,channels[c][i]*gain*scale*fade))*32767),true);
  }
  return result;
}

export function audibleTracks(tracks,includeAll=false){
  const solo=tracks.some(t=>t.solo);
  return tracks.map((track,index)=>({track,index})).filter(({track})=>track.id&&(includeAll||(!track.mute&&(!solo||track.solo))));
}
