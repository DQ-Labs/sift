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

export function seededRandom(seed = 1) {
  let state = seed | 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 2 ** 32;
  };
}

const nameWords = ['Dust', 'break', 'Kick', 'snare', 'Warm', 'pad', 'Glass', 'keys', 'Low', 'sub', 'Vox', 'chop', 'Tape', 'hiss', 'after', 'Hours', 'room', 'tone'];
const separators = [' ', '_', '-', ' - ', '(', ')'];
const sampleTypes = ['Drums', 'Bass', 'Melodic', 'Texture', 'Vocal', 'Other'];
const sampleKeys = [null, null, 'A min', 'C maj', 'F# min', 'Bb maj'];

// A deterministic catalogue: `demo` demo samples, then real samples spread
// over `roots`, with every field the collection filters and sorts on.
export function syntheticSamples(count, { seed = 1, roots = ['/library/One', '/library/Two', '/library/Three'], demo = 12, peaks = false } = {}) {
  const random = seededRandom(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  return Array.from({ length: count }, (_, i) => {
    const words = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(nameWords));
    let name = words.join(pick(separators));
    if (random() < .5) name += `${pick(separators)}${Math.floor(random() * 200)}`;
    const isDemo = i < demo;
    const root = isDemo ? undefined : roots[i % roots.length];
    const conflictRoll = random();
    const conflicts = conflictRoll < .1 ? { bpm: { label: 120, estimate: 60, kind: 'half-double', resolved: false } }
      : conflictRoll < .15 ? { key: { label: 'A min', estimate: 'C maj', kind: 'relative-key', resolved: true } } : {};
    const bpmRoll = random();
    const filename = `${name}.wav`;
    return {
      id: `sample-${i}`,
      path: isDemo ? `/data/demo/${i}-${filename}` : `${root}/pack-${i % 40}/${i}-${filename}`,
      filename,
      name,
      type: pick(sampleTypes),
      typeHint: random() < .3 ? pick(nameWords) : null,
      bpm: bpmRoll < .15 ? null : bpmRoll < .18 ? 0 : 60 + Math.floor(random() * 120),
      key: pick(sampleKeys),
      duration: random() < .1 ? null : Math.round(random() * 30000) / 1000,
      size: 1000 + i,
      mtime: 1_700_000_000_000 + i,
      folder: isDemo ? 'Sift demo collection' : root.split('/').at(-1),
      root,
      demo: isDemo,
      conflicts,
      overrides: {},
      ...(peaks ? { peaks: Array.from({ length: 160 }, () => Math.round(random() * 1e4) / 1e4) } : {})
    };
  });
}

// A copy of sourceSamples() and filteredSamples() from public/app.js, as the
// reference the server-side query must match.
export function referenceFilter(samples, favorites, { source = '', view = 'all', q = '', type = '', bpm = '', conflicts = false, sort = 'name' } = {}) {
  const real = samples.filter(s => !s.demo);
  const fromSource = source === 'demo' ? samples.filter(s => s.demo) : source ? samples.filter(s => s.root === source) : real.length ? real : samples;
  const hasConflict = sample => Object.values(sample.conflicts || {}).some(c => !c.resolved);
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return fromSource
    .filter(s => (!conflicts || hasConflict(s)) && (view !== 'gems' || favorites.includes(s.id)) && (!type || type === s.type)
      && words.every(word => `${s.name} ${s.filename} ${s.folder} ${s.typeHint || ''} ${s.key || ''} ${s.type}`.toLowerCase().includes(word))
      && (!bpm || (bpm === 'unknown' ? !s.bpm : bpm === 'slow' ? s.bpm && s.bpm < 90 : bpm === 'mid' ? s.bpm >= 90 && s.bpm <= 120 : s.bpm > 120)))
    .sort((a, b) => sort === 'bpm' ? (a.bpm || 999) - (b.bpm || 999) : sort === 'duration' ? (a.duration ?? Infinity) - (b.duration ?? Infinity) : a.name.localeCompare(b.name));
}

// Reads the entries of an uncompressed (stored) ZIP, as storeZip() writes them.
export function readStoredZip(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  return entries;
}
