export function wavFromChannels(channels,rate=44100){
  const frames=channels[0].length,count=channels.length,b=Buffer.alloc(44+frames*count*2);
  b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(count,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*count*2,28);b.writeUInt16LE(count*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let i=0;i<frames;i++)for(let c=0;c<count;c++)b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,channels[c][i]))*32767),44+(i*count+c)*2);
  return b;
}
export function chordFixture(minor=false,seconds=16){
  const rate=44100,audio=new Float32Array(rate*seconds),progression=minor?[[57,60,64],[62,65,69],[64,68,71],[57,60,64]]:[[60,64,67],[65,69,72],[67,71,74],[60,64,67]];
  for(let i=0;i<audio.length;i++){const t=i/rate,chord=progression[Math.floor(t/2)%4],env=Math.min(1,(t%2)*20)*Math.exp(-.5*(t%2));audio[i]=chord.reduce((sum,note)=>{const f=440*2**((note-69)/12);return sum+.16*Math.sin(2*Math.PI*f*t)+.04*Math.sin(4*Math.PI*f*t);},0)*env;}
  return audio;
}
export function clickFixture(bpm=120,seconds=16){
  const rate=44100,audio=new Float32Array(rate*seconds);let seed=123;
  for(let i=0;i<audio.length;i++){const t=i/rate,beat=t%(60/bpm);seed=(Math.imul(seed,1664525)+1013904223)|0;const noise=(seed>>>0)/2147483648-1;audio[i]=(.7*Math.sin(2*Math.PI*120*beat)+noise*.2)*Math.exp(-beat*45);}
  return audio;
}
