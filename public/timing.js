import { renderPlan, loopTolerance } from './harmony.js';

export const repeatModes = ['auto', 'once', 'beat', 'bar', '2bars', '4bars'];
// How a layer starts when it has no explicit offset: on the first beat of the
// analysed beat grid, or at the first sound after leading silence.
export const startModes = ['beat', 'sound'];
export const defaultTiming = () => ({ offset: null, repeat: 'auto', start: 'beat' });
export const sessionFrames = (tempo, rate) => Math.round(16 * 60 / tempo * rate);
export function cyclePosition(seconds, length, rate) {
  const frame = Math.floor(Math.max(0, seconds) * rate + 1e-6) % length;
  const fraction = frame / length;
  let beat = 0;while(beat < 15 && frame >= Math.round((beat+1)*length/16))beat++;
  return { seconds:frame/rate, fraction, bar:Math.floor(beat/4)+1, beat:beat%4+1 };
}

// All positions use the same integer frame grid. Subdivisions are computed
// from the full cycle, avoiding accumulated rounding at fractional tempos.
//
// automaticStart is the frame to start at when the layer has no explicit
// offset (see automaticStart() below); startMode says how it was found.
export function planCycle(sample, track, settings, frames, rate, automaticStart = 0, startMode = 'sound') {
  const timing = { ...defaultTiming(), ...track.timing };
  if (!Number.isFinite(settings.tempo) || settings.tempo < 40 || settings.tempo > 240 || !Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(frames) || frames < 1) throw new Error('Invalid audio timing.');
  if ((timing.offset !== null && (!Number.isFinite(timing.offset) || timing.offset < 0 || timing.offset > 3600)) || !repeatModes.includes(timing.repeat)) throw new Error('Choose a valid start offset and repeat mode.');
  const processing = renderPlan(sample, settings);
  const manual = timing.offset !== null;
  const sourceStart = manual ? Math.round(timing.offset / processing.rate * rate) : automaticStart;
  if (sourceStart >= frames) throw new Error('Start offset is past the end of this sample.');
  const length = sessionFrames(settings.tempo, rate), available = frames - sourceStart;
  const seconds = available / rate, beatSeconds = 60 / settings.tempo;
  const knownTempo = sample.bpm > 0 && sample.bpmSource !== 'filename-hint';
  const conflict = sample.conflicts?.bpm && !sample.conflicts.bpm.resolved;
  const tempoAligned = sample.bpm > 0 && (settings.sync || Math.abs(sample.bpm - settings.tempo) < .01);
  let beats = ({ beat:1, bar:4, '2bars':8, '4bars':16 })[timing.repeat] || 16;
  let inferred = false;
  if (timing.repeat === 'auto' && knownTempo && !conflict && tempoAligned) {
    const near = [1,2,4,8].find(n => Math.abs(seconds - n * beatSeconds) <= loopTolerance(n * beatSeconds));
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
  const start = manual ? 'manual' : startMode;
  const startLabel = start === 'beat' ? `beat @ ${offset.toFixed(2)}s` : offset ? `@ ${offset.toFixed(2)}s` : '';
  return { length, rate, beats, events, padded, cropped, label: startLabel ? `${startLabel} · ${label}` : label, warnings, offset, automatic: !manual, start };
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

// ---- Beat grid -------------------------------------------------------------
// Essentia's first one or two ticks are unreliable (they can fall in leading
// silence or well before the first hit), while later ticks sit within about
// 15 ms of the attacks. So the grid is fitted to the steady ticks and then
// projected back to the start of the file.

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Beat period and phase (both in source seconds) from analysed beat
// positions, or null when there are too few to trust.
export function beatGrid(beats) {
  if (!Array.isArray(beats) || beats.length < 4 || !beats.every(Number.isFinite)) return null;
  // Skip the tracker's warm-up ticks when there are enough to spare, and fit
  // near the start of the file so tempo drift later on does not matter.
  const steady = beats.slice(beats.length >= 8 ? 2 : 0, 18);
  const rough = median(steady.slice(1).map((beat, i) => beat - steady[i]));
  if (!(rough >= 60 / 300 && rough <= 60 / 30)) return null;
  // Number each tick by its beat (a missed tick leaves a gap in the count),
  // then fit time = phase + beat × period by least squares.
  const counts = steady.map(beat => Math.round((beat - steady[0]) / rough));
  const meanCount = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const meanTime = steady.reduce((sum, beat) => sum + beat, 0) / steady.length;
  let covariance = 0;
  let variance = 0;
  counts.forEach((n, i) => {
    covariance += (n - meanCount) * (steady[i] - meanTime);
    variance += (n - meanCount) ** 2;
  });
  const period = covariance / variance;
  if (!(variance > 0 && period >= 60 / 300 && period <= 60 / 30)) return null;
  const intercept = meanTime - period * meanCount;
  return { period, phase: ((intercept % period) + period) % period };
}

const preRoll = .005; // Matches the margin audibleStart() keeps before an attack.

// Where a layer should start, in source seconds, given the time of its first
// sound. Returns the first sound itself when it already lies on the grid,
// otherwise the first grid beat after it. Null without a usable grid.
export function snapToBeat(beats, soundStart = 0) {
  const grid = beatGrid(beats);
  if (!grid) return null;
  const { period, phase } = grid;
  // Closer than this to a grid line counts as on the beat; a quarter beat
  // keeps an eighth-note pickup clearly off it.
  const window = Math.min(.05, period / 4);
  const beat = phase + Math.ceil((soundStart - window - phase) / period) * period;
  if (beat - soundStart <= window) return soundStart;
  return Math.max(0, beat - preRoll);
}

// Finds the attack nearest `frame` within `radius` frames: the 5 ms block
// with the largest rise in level. Keeps `frame` when nothing rises clearly.
export function attackNear(buffer, frame, radius) {
  const block = Math.max(1, Math.round(buffer.sampleRate * .005));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const from = Math.max(0, frame - radius - block);
  const to = Math.min(buffer.length, frame + radius);
  const level = start => {
    const end = Math.min(buffer.length, start + block);
    let peak = 0;
    for (const channel of channels) {
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i] * channel[i];
      peak = Math.max(peak, Math.sqrt(sum / Math.max(1, end - start)));
    }
    return peak;
  };
  let best = frame;
  let bestRise = 0;
  let previous = level(from);
  for (let start = from + block; start + block <= to; start += block) {
    const current = level(start);
    const rise = current - previous;
    if (rise > bestRise && rise > previous) {
      bestRise = rise;
      best = start;
    }
    previous = current;
  }
  return Math.max(0, best - block);
}

// The automatic start of a layer in `buffer` frames. `stretch` is the render
// rate (source seconds = buffer seconds × stretch). Snaps to the first beat
// unless the layer asks for the first sound or no beat grid is known.
export function automaticStart(buffer, sample, timing = defaultTiming(), stretch = 1) {
  const sound = audibleStart(buffer);
  if (timing.start === 'sound') return { frame: sound, mode: 'sound' };
  const beat = snapToBeat(sample.beats, sound / buffer.sampleRate * stretch);
  if (beat === null) return { frame: sound, mode: 'sound' };
  let frame = Math.round(beat / stretch * buffer.sampleRate);
  if (frame !== sound) {
    // Ticks are only accurate to about 15 ms; start just before the real hit.
    const radius = Math.round(buffer.sampleRate * .02);
    frame = Math.max(sound, attackNear(buffer, frame + Math.round(preRoll * buffer.sampleRate), radius));
  }
  return { frame: Math.min(frame, buffer.length - 1), mode: 'beat' };
}

// Used unchanged by live playback and OfflineAudioContext export.
export function makeCycle(context, buffer, sample, track, settings) {
  const timing = { ...defaultTiming(), ...track.timing };
  const start = timing.offset === null ? automaticStart(buffer, sample, timing, renderPlan(sample, settings).rate) : { frame: 0, mode: 'manual' };
  const plan = planCycle(sample, track, settings, buffer.length, buffer.sampleRate, start.frame, start.mode);
  const cycle = context.createBuffer(buffer.numberOfChannels, plan.length, buffer.sampleRate);
  for (let channel=0;channel<buffer.numberOfChannels;channel++) fillCycle(buffer.getChannelData(channel), cycle.getChannelData(channel), plan);
  return { buffer:cycle, plan };
}

const loopBuffers = new WeakMap();
export function createCycleSource(context, buffer) {
  // Chromium can stop wrapping when duration * sampleRate rounds just past
  // the last frame. Keep the loop boundary inside the physical buffer with
  // one guard frame, without changing the musical cycle or its frame count.
  let guarded = loopBuffers.get(buffer);
  if (!guarded) {
    guarded = context.createBuffer(buffer.numberOfChannels, buffer.length + 1, buffer.sampleRate);
    for (let channel=0;channel<buffer.numberOfChannels;channel++) {
      const data = buffer.getChannelData(channel);
      guarded.copyToChannel(data, channel);
      guarded.getChannelData(channel)[buffer.length] = data[0];
    }
    loopBuffers.set(buffer, guarded);
  }
  const source = context.createBufferSource();
  source.buffer = guarded;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = buffer.duration;
  source.playbackRate.value = 1;
  return source;
}
