import test from 'node:test';
import assert from 'node:assert/strict';
import { tempoMatch, renderPlan, combinationCost, chooseCombination, loopBars, octaveCost } from '../public/harmony.js';
import { planCycle } from '../public/timing.js';
import { tempoFeel } from '../public/workbench-model.js';
import { attackBins, tempoFromLength } from '../lib/loop-tempo.mjs';
import { effectiveMetadata } from '../lib/metadata.mjs';
import { computeAnalysis } from '../lib/analysis.mjs';
import { clickFixture } from './fixtures.mjs';

const near = (actual, expected, tolerance = 1e-9) => Math.abs(actual - expected) <= tolerance;

// ---- Half time and double time ---------------------------------------------

test('tempos an octave apart play at their own speed; the rest stretch by at most 1.41×', () => {
  assert.deepEqual(tempoMatch(70, 140), { rate: 1, octaves: 1 });
  assert.deepEqual(tempoMatch(140, 70), { rate: 1, octaves: -1 });
  assert.deepEqual(tempoMatch(60, 240), { rate: 1, octaves: 2 });
  assert.deepEqual(tempoMatch(120, 120), { rate: 1, octaves: 0 });
  // 72 in a 140 session: half time, slowed slightly, never sped up 1.94×.
  const close = tempoMatch(72, 140);
  assert.equal(close.octaves, 1);
  assert.ok(near(close.rate, 140 / 144));
  for (let bpm = 40; bpm <= 240; bpm += 7) {
    for (let tempo = 40; tempo <= 240; tempo += 11) {
      const { rate, octaves } = tempoMatch(bpm, tempo);
      assert.ok(rate >= Math.SQRT1_2 - 1e-9 && rate <= Math.SQRT2 + 1e-9, `${bpm} at ${tempo}: rate ${rate}`);
      assert.ok(near(bpm * rate * 2 ** octaves, tempo, 1e-6), `${bpm} at ${tempo} lands on the session grid`);
    }
  }
});

test('a half-time loop is not processed at all, and unsynced or unknown tempos are left alone', () => {
  const loop = { type: 'Drums', bpm: 70, key: null };
  const plan = renderPlan(loop, { tempo: 140, sync: true, key: null });
  assert.equal(plan.rate, 1);
  assert.equal(plan.octaves, 1);
  assert.equal(plan.processed, false);
  assert.equal(renderPlan(loop, { tempo: 140, sync: false }).octaves, 0);
  assert.equal(renderPlan({ ...loop, bpm: null }, { tempo: 140 }).octaves, 0);
});

test('half-time and double-time matches cost a little more than the session tempo, far less than a stretch', () => {
  const settings = { tempo: 140, key: null };
  const cost = bpm => combinationCost({ type: 'Drums', bpm }, settings);
  assert.equal(cost(140), 0);
  assert.equal(cost(70), octaveCost);
  assert.equal(cost(35), 2 * octaveCost);
  // Before folding, 70 in a 140 session scored a full octave: 10.
  assert.ok(cost(70) < cost(125));
  // A length-derived tempo has no octave to charge for.
  assert.equal(combinationCost({ type: 'Drums', bpm: 70, bpmSource: 'length' }, settings), 1);
});

test('rerolls reach half-time loops at balanced variety and keep to the session tempo when safe', () => {
  const settings = { tempo: 140, sync: true, key: null };
  const pool = [[140, 'full'], [70, 'half'], [100, 'far']].map(([bpm, id]) => ({ id, type: 'Drums', bpm, size: 1000, duration: 4 }));
  const picks = variety => {
    const seen = new Set();
    for (let n = 0; n < 200; n++) seen.add(chooseCombination([{ type: 'Drums' }], pool, { ...settings, variety }, null, () => n / 200)[0].id);
    return [...seen].sort();
  };
  assert.deepEqual(picks(0), ['full']);
  assert.deepEqual(picks(.5), ['full', 'half']);
});

test('a half-time bar fills two session bars and repeats on the shared grid', () => {
  const rate = 44100;
  const settings = { tempo: 140, sync: true, key: null };
  const oneBarAt70 = 4 * 60 / 70;
  const sample = { type: 'Drums', bpm: 70, bpmSource: 'analysis', duration: oneBarAt70 };
  assert.equal(loopBars(sample), 1);
  // Rendered at rate 1, so the buffer is as long as the source.
  const plan = planCycle(sample, { timing: { offset: 0, repeat: 'auto' } }, settings, Math.round(oneBarAt70 * rate), rate);
  assert.equal(plan.beats, 8);
  assert.equal(plan.events.length, 2);
  assert.deepEqual(plan.warnings, []);
});

test('layers are labelled by how they sit against the session tempo', () => {
  assert.deepEqual([0, 1, -1, 2, -2].map(tempoFeel), ['', 'half-time', 'double-time', '1/4 time', '4× time']);
});

// ---- Tempo from a short clip's length --------------------------------------

// A 160-bin waveform with a decaying hit at each given fraction of the clip.
function waveform(hits, bins = 160) {
  const peaks = Array(bins).fill(.01);
  for (const hit of hits) {
    const start = Math.round(hit * bins);
    for (let n = 0; n < 4 && start + n < bins; n++) peaks[start + n] = Math.max(peaks[start + n], .9 * .5 ** n);
  }
  return peaks;
}

function analysed(seconds, peaks, extra = {}) {
  return { filename: 'untitled.wav', analysis: { status: 'done', bpm: null, analyzedSeconds: seconds }, peaks, ...extra };
}

const quarters = [0, .25, .5, .75];
const eighths = [0, .125, .25, .375, .5, .625, .75, .875];

test('attacks are found once each, including one at the very start', () => {
  assert.deepEqual(attackBins(waveform(quarters)), [0, 40, 80, 120]);
  // A slow rise over neighbouring bins is one attack.
  const swell = Array(160).fill(.01);
  [.3, .6, .9].forEach((level, n) => {
    swell[50 + n] = level;
  });
  assert.deepEqual(attackBins(swell), [50]);
  assert.deepEqual(attackBins(Array(160).fill(0)), []);
});

test('a short clip with evenly spaced attacks gets its tempo from its length', () => {
  // Two seconds: one bar at 120, which is already inside 80–160.
  assert.equal(tempoFromLength(analysed(2, waveform(quarters))), 120);
  // 1.5 s is one bar at 160; folded into range as 80.
  assert.equal(tempoFromLength(analysed(1.5, waveform(quarters))), 80);
  // 3.43 s: two bars at 140.
  assert.equal(tempoFromLength(analysed(3.4286, waveform(eighths))), 140);
  // Hits on every thirty-second division sit on the finer grid only; eight
  // or more of them are enough.
  const fine = Array.from({ length: 16 }, (_, n) => (2 * n + 1) / 32);
  assert.equal(tempoFromLength(analysed(3.4286, waveform([0, ...fine]))), 140);
});

test('one-shots, uneven clips and anything the beat tracker handled are left unknown', () => {
  assert.equal(tempoFromLength(analysed(1.2, waveform([0]))), null);
  // Three hits are too few to tell a loop from an echo.
  assert.equal(tempoFromLength(analysed(2, waveform([0, .25, .5]))), null);
  // A three-beat clip: hits fall between sixteenth divisions.
  assert.equal(tempoFromLength(analysed(1.5, waveform([0, 1 / 3, 2 / 3, .86]))), null);
  // Starts after a gap, so its length is not a whole number of beats.
  assert.equal(tempoFromLength(analysed(2, waveform([.1, .35, .6, .85]))), null);
  // Too short, or long enough that analysis already ran the beat tracker.
  assert.equal(tempoFromLength(analysed(.5, waveform(quarters))), null);
  assert.equal(tempoFromLength(analysed(4, waveform(quarters))), null);
  // Pending analysis, a tracked tempo, or no waveform.
  assert.equal(tempoFromLength({ peaks: waveform(quarters) }), null);
  assert.equal(tempoFromLength({ peaks: waveform(quarters), analysis: { status: 'done', bpm: 118, analyzedSeconds: 2 } }), null);
  assert.equal(tempoFromLength(analysed(2, undefined)), null);
});

test('an unlabelled filename number picks the octave when it fits, and is ignored when it does not', () => {
  const peaks = waveform(quarters);
  // 2.7429 s is one bar at 87.5, or two at 175.
  assert.equal(tempoFromLength(analysed(2.7429, peaks)), 87.5);
  assert.equal(tempoFromLength(analysed(2.7429, peaks), 175), 175);
  assert.equal(tempoFromLength(analysed(2.7429, peaks), 174), 175);
  assert.equal(tempoFromLength(analysed(2.7429, peaks), 128), 87.5);
});

test('metadata uses the length tempo only below labels, corrections and tracked estimates', () => {
  const peaks = waveform(quarters);
  let metadata = effectiveMetadata(analysed(2, peaks));
  assert.equal(metadata.bpm, 120);
  assert.equal(metadata.bpmSource, 'length');
  assert.deepEqual(metadata.conflicts, {});
  // A bare number that agrees sets the octave; one that disagrees gives way
  // to the length.
  metadata = effectiveMetadata(analysed(2, peaks, { filename: 'break_240.wav' }));
  assert.deepEqual([metadata.bpm, metadata.bpmSource], [240, 'length']);
  metadata = effectiveMetadata(analysed(2, peaks, { filename: 'break_97.wav' }));
  assert.deepEqual([metadata.bpm, metadata.bpmSource], [120, 'length']);
  // An explicit label wins untouched, with no conflict raised against it.
  metadata = effectiveMetadata(analysed(2, peaks, { filename: 'break_97bpm.wav' }));
  assert.deepEqual([metadata.bpm, metadata.bpmSource, metadata.conflicts], [97, 'filename', {}]);
  metadata = effectiveMetadata(analysed(2, peaks, { overrides: { bpm: 111 } }));
  assert.deepEqual([metadata.bpm, metadata.bpmSource], [111, 'manual']);
  metadata = effectiveMetadata(analysed(2, peaks, { overrides: { bpm: null } }));
  assert.deepEqual([metadata.bpm, metadata.bpmSource], [null, 'manual']);
  // A one-shot with a bare number stays a weak hint, as before.
  metadata = effectiveMetadata(analysed(1.2, waveform([0]), { filename: 'kick_120.wav' }));
  assert.deepEqual([metadata.bpm, metadata.bpmSource], [120, 'filename-hint']);
  // A length tempo makes a whole-bar clip a loop.
  assert.equal(loopBars({ bpm: 120, bpmSource: 'length', duration: 2 }), 1);
});

test('the real analysis worker leaves a short loop for the length rule, which then names its tempo', async () => {
  // One bar of clicks at 100 BPM: 2.4 s, under the beat tracker's four seconds.
  const { peaks, ...loop } = await computeAnalysis(clickFixture(100, 2.4), 'Drums');
  assert.equal(loop.bpm, null);
  assert.equal(tempoFromLength({ analysis: { ...loop, status: 'done' }, peaks }), 100);
  // One click followed by silence is not a loop.
  const single = clickFixture(100, .5);
  const padded = new Float32Array(44100);
  padded.set(single.subarray(0, Math.min(single.length, padded.length)));
  const { peaks: shotPeaks, ...shot } = await computeAnalysis(padded, 'Drums');
  assert.equal(tempoFromLength({ analysis: { ...shot, status: 'done' }, peaks: shotPeaks }), null);
});
