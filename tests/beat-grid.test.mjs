import test from 'node:test';
import assert from 'node:assert/strict';
import { beatGrid, snapToBeat, automaticStart, makeCycle, planCycle, audibleStart } from '../public/timing.js';
import { loopBars, chooseCombination } from '../public/harmony.js';
import { computeAnalysis } from '../lib/analysis.mjs';
import { clickFixture, seededRandom } from './fixtures.mjs';

const rate = 44100;
const settings = { tempo: 120, sync: true, key: null };
const fakeContext = {
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: c => data[c] };
  }
};

// A buffer holding `audio` in both channels.
function bufferOf(audio) {
  const buffer = fakeContext.createBuffer(2, audio.length, rate);
  buffer.getChannelData(0).set(audio);
  buffer.getChannelData(1).set(audio);
  return buffer;
}

// Quiet crackle from the first frame, then 120 BPM hits from `firstHit`.
function crackleThenHits(firstHit, seconds = 12, bpm = 120) {
  const random = seededRandom(7);
  const audio = new Float32Array(rate * seconds);
  for (let i = 0; i < audio.length; i++) audio[i] = (random() - .5) * .04;
  const hits = clickFixture(bpm, seconds - firstHit);
  audio.set(hits, Math.round(firstHit * rate));
  return audio;
}

// Essentia-like ticks: two unreliable warm-up ticks, then the true grid with jitter.
const jittered = (phase, period, count = 20) => [phase - 0.21, phase + 0.083, ...Array.from({ length: count }, (_, n) => phase + (n + 1) * period + [0.012, -0.008, 0.004, -0.013][n % 4])];

test('the beat grid is fitted from steady ticks, ignoring warm-up ticks and jitter', () => {
  const grid = beatGrid(jittered(0.3, 0.5));
  assert.ok(Math.abs(grid.period - 0.5) < 0.005, `period ${grid.period}`);
  assert.ok(Math.abs(grid.phase - 0.3) < 0.01, `phase ${grid.phase}`);
  for (const beats of [undefined, [], [0.5, 1, 1.5], [0, 0.01, 0.02, 0.03], [0, 1, Number.NaN, 3]]) assert.equal(beatGrid(beats), null);
});

test('snap keeps a first sound that lies on the grid and moves an off-beat one to the next beat', () => {
  const beats = jittered(0.5, 0.5);
  // On the grid, including when the tracker missed the first beat.
  assert.equal(snapToBeat(beats, 0.5), 0.5);
  assert.equal(snapToBeat(beats, 0.02), 0.02);
  assert.equal(snapToBeat(beats, 0.47), 0.47);
  // An eighth-note pickup and a slow fade-in start on the next beat.
  assert.ok(Math.abs(snapToBeat(beats, 0.25) - 0.495) < 0.01);
  assert.ok(Math.abs(snapToBeat(beats, 0.62) - 0.995) < 0.01);
  assert.equal(snapToBeat([], 0.25), null);
});

test('automatic starts snap to the first real hit after off-beat noise, at the session tempo too', () => {
  const firstHit = 0.35;
  const buffer = bufferOf(crackleThenHits(firstHit));
  assert.equal(audibleStart(buffer), 0, 'crackle counts as sound');
  const sample = { bpm: 120, bpmSource: 'analysis', type: 'Drums', beats: jittered(firstHit, 0.5) };
  const snapped = automaticStart(buffer, sample);
  assert.equal(snapped.mode, 'beat');
  const error = snapped.frame / rate - firstHit;
  // Starts before the hit, by at most two 5 ms analysis blocks.
  assert.ok(error <= 0 && error >= -0.0105, `starts ${(error * 1000).toFixed(1)} ms from the hit`);
  assert.deepEqual(automaticStart(buffer, sample, { start: 'sound' }), { frame: 0, mode: 'sound' });
  assert.deepEqual(automaticStart(buffer, { ...sample, beats: undefined }), { frame: 0, mode: 'sound' });
  // Rendered at 1.5× speed: beats stay in source seconds, frames follow the render.
  const fast = bufferOf(crackleThenHits(firstHit / 1.5, 8, 180));
  const stretched = automaticStart(fast, sample, undefined, 1.5);
  assert.ok(Math.abs(stretched.frame / rate - firstHit / 1.5) <= 0.0105, `stretched start ${stretched.frame / rate}`);
});

test('real Essentia beats snap a loop with a noisy lead-in onto its first hit', async () => {
  const firstHit = 0.3;
  const audio = crackleThenHits(firstHit);
  const analysis = await computeAnalysis(Float32Array.from(audio), 'Drums');
  assert.ok(Math.abs(analysis.bpm - 120) < 2, `bpm ${analysis.bpm}`);
  assert.ok(analysis.beats.length >= 8, 'beats are kept with a trusted tempo');
  const start = automaticStart(bufferOf(audio), { bpm: analysis.bpm, beats: analysis.beats });
  assert.equal(start.mode, 'beat');
  assert.ok(Math.abs(start.frame / rate - firstHit) < 0.01, `snapped to ${start.frame / rate}`);
  const oneShot = await computeAnalysis(clickFixture(120, 0.3));
  assert.deepEqual(oneShot.beats, [], 'no beat grid without a trusted tempo');
});

test('explicit offsets stay exact and plans report how each layer starts', () => {
  const buffer = bufferOf(crackleThenHits(0.35));
  const sample = { bpm: 120, bpmSource: 'analysis', type: 'Drums', beats: jittered(0.35, 0.5) };
  const manual = makeCycle(fakeContext, buffer, sample, { timing: { offset: 0.25, repeat: 'once', start: 'beat' } }, settings);
  assert.equal(manual.plan.offset, 0.25);
  assert.equal(manual.plan.start, 'manual');
  assert.equal(manual.plan.events[0].sourceStart, Math.round(0.25 * rate));
  const zero = makeCycle(fakeContext, buffer, sample, { timing: { offset: 0, repeat: 'once' } }, settings);
  assert.equal(zero.plan.events[0].sourceStart, 0);
  const automatic = makeCycle(fakeContext, buffer, sample, { timing: { offset: null, repeat: 'auto' } }, settings);
  assert.equal(automatic.plan.start, 'beat');
  assert.match(automatic.plan.label, /^beat @ 0\.3\ds/);
  const sound = makeCycle(fakeContext, buffer, sample, { timing: { offset: null, repeat: 'auto', start: 'sound' } }, settings);
  assert.equal(sound.plan.start, 'sound');
  assert.equal(sound.plan.offset, 0);
  // Older callers that pass a first-sound frame keep working.
  assert.equal(planCycle(sample, { timing: { offset: null, repeat: 'once' } }, settings, rate * 4, rate, 100).events[0].sourceStart, 100);
});

test('loops are whole 1, 2, 4 or 8 bars at a trusted tempo, within the shared tolerance', () => {
  const at = (duration, extra = {}) => loopBars({ bpm: 120, bpmSource: 'analysis', duration, ...extra });
  assert.equal(at(2), 1);
  assert.equal(at(4.03), 2);
  assert.equal(at(8 - 0.079), 4, 'just under 80 ms short of four bars still counts');
  assert.equal(at(8 - 0.1), null);
  assert.equal(at(16.05), 8);
  assert.equal(at(1.98), 1, '20 ms is always allowed');
  assert.equal(at(1.97), null);
  assert.equal(at(6), null, 'three bars is not a loop length');
  assert.equal(at(32), null, 'sixteen bars is beyond the loop lengths');
  assert.equal(loopBars({ bpm: 92, bpmSource: 'filename', duration: 4 * 4 * 60 / 92 }), 4);
  assert.equal(at(8, { bpmSource: 'filename-hint' }), null);
  assert.equal(at(8, { conflicts: { bpm: { resolved: false } } }), null);
  assert.equal(at(8, { conflicts: { bpm: { resolved: true } } }), 4);
  assert.equal(loopBars({ bpm: null, duration: 8 }), null);
  assert.equal(loopBars({ bpm: 120, duration: null }), null);
});

test('drum, bass and melodic layers prefer loops; without loops the odds do not change', () => {
  const settings = { tempo: 120, sync: true, key: 'A min', variety: 0 };
  const base = { key: 'A min', size: 1000, bpmSource: 'analysis' };
  // 'exact' matches the session tempo; 'loop' is 2 BPM off but four whole bars.
  const pool = type => [
    { ...base, id: 'exact', type, bpm: 120, duration: 7 },
    { ...base, id: 'loop', type, bpm: 118, duration: 4 * 4 * 60 / 118 }
  ];
  for (const type of ['Drums', 'Bass', 'Melodic']) {
    assert.equal(chooseCombination([{ type }], pool(type), settings, null, () => 0)[0].id, 'loop', type);
  }
  for (const type of ['Texture', 'Vocal']) {
    assert.equal(chooseCombination([{ type }], pool(type), settings, null, () => 0)[0].id, 'exact', type);
  }
  // The server's precomputed loopBars wins over the record's own fields.
  const server = pool('Drums').map(sample => ({ ...sample, loopBars: null }));
  assert.equal(chooseCombination([{ type: 'Drums' }], server, settings, null, () => 0)[0].id, 'exact');
  // With no loops, a loop-preferring role draws exactly like any other role.
  const nonLoops = [120, 123, 132, 160].map((bpm, n) => ({ ...base, id: `b${n}`, type: 'Bass', bpm, duration: 7 }));
  for (let n = 0; n < 50; n++) {
    const random = () => n / 50;
    const draw = role => chooseCombination([{ type: role }], nonLoops, { ...settings, variety: .5 }, null, random)[0].id;
    assert.equal(draw('Bass'), draw('Texture'));
  }
});
