import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Essentia, EssentiaWASM } = require('essentia.js');
const engine = new Essentia(EssentiaWASM);
const sampleRate = 44100;
const peakBins = 160;

// Replaces non-finite values in place; returns the RMS level and 160 waveform peaks.
function levels(audio) {
  const peaks = Array(peakBins).fill(0);
  let energy = 0;
  for (let i = 0; i < audio.length; i++) {
    const value = Number.isFinite(audio[i]) ? audio[i] : 0;
    audio[i] = value;
    energy += value * value;
    const bin = Math.min(peakBins - 1, Math.floor(i / audio.length * peakBins));
    peaks[bin] = Math.max(peaks[bin], Math.abs(value));
  }
  return { rms: Math.sqrt(energy / Math.max(1, audio.length)), peaks };
}

// Beat trackers can find a plausible grid in stationary noise. Count actual
// separated amplitude attacks before accepting their tempo.
function countAttacks(audio, rms) {
  const envelope = [];
  for (let start = 0; start + 1024 <= audio.length; start += 1024) {
    let sum = 0;
    for (let i = start; i < start + 1024; i++) sum += audio[i] * audio[i];
    envelope.push(Math.sqrt(sum / 1024));
  }
  let attacks = 0;
  let lastAttack = -100;
  for (let i = 1; i < envelope.length; i++) {
    if (envelope[i] - envelope[i - 1] > rms * .08 && i - lastAttack > 6) {
      attacks++;
      lastAttack = i;
    }
  }
  return attacks;
}

function analyzeRhythm(vector, attacks, result) {
  const rhythm = engine.RhythmExtractor2013(vector, 240, 'multifeature', 40);
  try {
    result.bpmConfidence = rhythm.confidence;
    const ticks = rhythm.ticks.size();
    if (attacks >= 4 && rhythm.bpm >= 40 && rhythm.bpm <= 240 && rhythm.confidence >= 2 && ticks >= 4) {
      result.bpm = Math.round(rhythm.bpm * 10) / 10;
      // Beat positions in seconds from the file start, to 0.1 ms. Only kept
      // with a tempo we trust, so a beat grid always means a real pulse.
      result.beats = Array.from(engine.vectorToArray(rhythm.ticks), tick => Math.round(tick * 1e4) / 1e4);
    } else {
      result.warnings.push('No reliable repeating beat; tempo left unknown.');
    }
  } finally {
    for (const value of Object.values(rhythm)) value?.delete?.();
  }
}

function analyzeKey(vector, result) {
  const key = engine.KeyExtractor(vector, true, 4096, 2048, 36, 3500, 60, 25, .2, 'temperley', sampleRate);
  result.keyStrength = key.strength;
  if (key.strength >= .65 && ['major', 'minor'].includes(key.scale)) result.key = `${key.key} ${key.scale === 'minor' ? 'min' : 'maj'}`;
  else result.warnings.push('Tonal evidence is weak; key left unknown.');
}

function analyze(audio, type) {
  const duration = audio.length / sampleRate;
  const { rms, peaks } = levels(audio);
  const attacks = countAttacks(audio, rms);
  const result = {
    bpm: null,
    key: null,
    bpmConfidence: 0,
    keyStrength: 0,
    beats: [],
    onsetCount: attacks,
    analyzedSeconds: duration,
    peaks,
    rmsDb: 20 * Math.log10(Math.max(1e-9, rms)),
    warnings: []
  };
  if (rms < .0003 || duration < .4) {
    result.warnings.push(rms < .0003 ? 'Too quiet for reliable musical analysis.' : 'Too short for musical analysis.');
    return result;
  }
  const vector = engine.arrayToVector(audio);
  try {
    if (duration >= 4) analyzeRhythm(vector, attacks, result);
    else result.warnings.push('Under 4 seconds: tempo left unknown.');
    if (type !== 'Drums' && duration >= 1) analyzeKey(vector, result);
    else result.warnings.push('No key assigned to a drum-tagged or very short sample.');
  } finally {
    vector.delete();
  }
  return result;
}

parentPort.on('message', ({ audio, type }) => {
  try {
    parentPort.postMessage({ result: analyze(audio, type) });
  } catch (error) {
    parentPort.postMessage({ error: error.message || String(error) });
  }
});
