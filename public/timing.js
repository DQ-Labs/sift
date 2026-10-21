import { renderPlan } from './harmony.js';

export const repeatModes = ['auto', 'once', 'beat', 'bar', '2bars', '4bars'];
export const defaultTiming = () => ({ offset: null, repeat: 'auto' });
export const sessionFrames = (tempo, rate) => Math.round(16 * 60 / tempo * rate);
export function cyclePosition(seconds, length, rate) {
  const frame = Math.floor(Math.max(0, seconds) * rate + 1e-6) % length;
  const fraction = frame / length;
  let beat = 0;while(beat < 15 && frame >= Math.round((beat+1)*length/16))beat++;
  return { seconds:frame/rate, fraction, bar:Math.floor(beat/4)+1, beat:beat%4+1 };
}

// All positions use the same integer frame grid. Subdivisions are computed
// from the full cycle, avoiding accumulated rounding at fractional tempos.
export function planCycle(sample, track, settings, frames, rate, audibleStart = 0) {
  const timing = track.timing || defaultTiming();
  if (!Number.isFinite(settings.tempo) || settings.tempo < 40 || settings.tempo > 240 || !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(frames) || frames < 1) throw new Error('Invalid audio timing.');
  if ((timing.offset !== null && (!Number.isFinite(timing.offset) || timing.offset < 0 || timing.offset > 3600)) || !repeatModes.includes(timing.repeat)) throw new Error('Choose a valid start offset and repeat mode.');
  const processing = renderPlan(sample, settings);
  const sourceStart = timing.offset === null ? audibleStart : Math.round(timing.offset / processing.rate * rate);
  if (sourceStart >= frames) throw new Error('Start offset is past the end of this sample.');
  const length = sessionFrames(settings.tempo, rate), available = frames - sourceStart;
  const seconds = available / rate, beatSeconds = 60 / settings.tempo;
  const knownTempo = sample.bpm > 0 && sample.bpmSource !== 'filename-hint';
  const conflict = sample.conflicts?.bpm && !sample.conflicts.bpm.resolved;
  const tempoAligned = sample.bpm > 0 && (settings.sync || Math.abs(sample.bpm - settings.tempo) < .01);
  let beats = ({ beat:1, bar:4, '2bars':8, '4bars':16 })[timing.repeat] || 16;
  let inferred = false;
  if (timing.repeat === 'auto' && knownTempo && !conflict && tempoAligned) {
    const near = [1,2,4,8].find(n => Math.abs(seconds - n * beatSeconds) <= Math.min(.08, Math.max(.02, n * beatSeconds * .015)));
    if (near) { beats = near; inferred = true; }
  }
  const count = 16 / beats, events = [];
  for (let n=0;n<count;n++) {
    const start = Math.round(n * length / count), end = Math.round((n+1) * length / count);
    events.push({ start, end, sourceStart, copy: Math.min(available, end-start) });
  }
  const padded = events.some(e => e.copy < e.end-e.start);
  const cropped = events.some(e => available > e.end-e.start);
  const label = count > 1 ? `${beats === 1 ? '1 beat' : beats === 2 ? '2 beats' : `${beats/4} ${beats===4?'bar':'bars'}`} · repeats ×${count}${inferred?' · auto':''}` : `${cropped?'First 4 bars':padded?'Once + silence':'4 bars'} · resets`;
  const warnings = [];
  if (!sample.bpm) warnings.push('BPM unknown; internal beats are not aligned');
  else if (sample.bpmSource === 'filename-hint' || conflict) warnings.push('Check source BPM before trusting beat alignment');
  else if (!tempoAligned) warnings.push('Original speed; internal beats may drift');
  const offset = sourceStart / rate * processing.rate;
  return { length, rate, beats, events, padded, cropped, label:offset ? `@ ${offset.toFixed(2)}s · ${label}` : label, warnings, offset, automatic:timing.offset===null };
}

// Leading silence only: this finds a sound onset, not a musical downbeat.
// Inspect every channel so a quiet/empty left channel cannot hide the right.
export function audibleStart(buffer) {
  const channels=Array.from({length:buffer.numberOfChannels},(_,c)=>buffer.getChannelData(c));
  const block=Math.max(1,Math.round(buffer.sampleRate*.005)),levels=[];let peak=0;
  for(let start=0;start<buffer.length;start+=block){
    const end=Math.min(buffer.length,start+block);let energy=0;
    for(const channel of channels){let sum=0;for(let i=start;i<end;i++)sum+=channel[i]*channel[i];energy=Math.max(energy,Math.sqrt(sum/(end-start)));}
    levels.push(energy);peak=Math.max(peak,energy);
  }
  if(peak<.0001)return 0;
  const threshold=Math.max(.0001,peak*.005),first=levels.findIndex(level=>level>=threshold);
  return Math.max(0,(first-1)*block); // Keep up to 5 ms before the attack.
}

export function fillCycle(source, destination, plan) {
  destination.fill(0);
  for (const event of plan.events) {
    const count = Math.min(event.copy, source.length-event.sourceStart, destination.length-event.start);
    const fadeIn = Math.min(16, Math.floor(count/2)), fadeOut = Math.min(128, Math.floor(count/2));
    for (let i=0;i<count;i++) {
      const fade = Math.min(1, fadeIn ? i/fadeIn : 1, fadeOut ? (count-1-i)/fadeOut : 1);
      destination[event.start+i] = source[event.sourceStart+i] * fade;
    }
  }
  return destination;
}

// Used unchanged by live playback and OfflineAudioContext export.
export function makeCycle(context, buffer, sample, track, settings) {
  const plan = planCycle(sample, track, settings, buffer.length, buffer.sampleRate, track.timing?.offset===null || !track.timing ? audibleStart(buffer) : 0);
  const cycle = context.createBuffer(buffer.numberOfChannels, plan.length, buffer.sampleRate);
  for (let channel=0;channel<buffer.numberOfChannels;channel++) fillCycle(buffer.getChannelData(channel), cycle.getChannelData(channel), plan);
  return { buffer:cycle, plan };
}
