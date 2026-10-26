import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCatalogue } from '../lib/catalogue.mjs';
import { seedDemoCollection } from '../lib/demo.mjs';
import { ANALYSIS_VERSION } from '../lib/analysis.mjs';
import { chooseCombination } from '../public/harmony.js';
import { syntheticSamples } from './fixtures.mjs';

const sampleCount = 50_000;
const queryBudgetMs = 100;
const startupBudgetMs = 3000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function timed(fn) {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

// The fastest of `runs` timings. node --test runs test files in parallel, so
// a single timing also measures whatever CPU-heavy file (analysis, Rubber
// Band renders) happens to run alongside; the fastest run is the query's cost.
function fastest(fn, runs = 3) {
  let best = timed(fn);
  for (let run = 1; run < runs; run++) {
    const next = timed(fn);
    if (next.ms < best.ms) best = next;
  }
  return best;
}

async function timedAsync(fn) {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

// Builds the catalogue once; every test below reads the same data directory.
const fixture = (async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sift-scale-'));
  const { catalogue } = await openCatalogue(dir);
  const samples = syntheticSamples(sampleCount, { seed: 7, peaks: true, roots: ['/studio/Splice', '/studio/Packs', '/studio/Field recordings', '/studio/Old drive'] });
  catalogue.putMany(samples);
  catalogue.setFavorites(samples.filter((_, i) => i % 50 === 0).map(sample => sample.id));
  await seedDemoCollection(catalogue, path.join(dir, 'demo'));
  catalogue.close();
  return dir;
})();

test(`a ${sampleCount.toLocaleString()}-sample catalogue opens in under ${startupBudgetMs} ms`, async () => {
  const dir = await fixture;
  const { result: catalogue, ms } = await timedAsync(async () => {
    const { catalogue } = await openCatalogue(dir);
    await seedDemoCollection(catalogue, path.join(dir, 'demo'));
    catalogue.counts();
    catalogue.pendingAnalysisIds(ANALYSIS_VERSION);
    catalogue.query({});
    return catalogue;
  });
  console.log(`Catalogue startup with ${sampleCount} samples: ${ms.toFixed(0)} ms`);
  assert.ok(ms < startupBudgetMs, `startup took ${ms.toFixed(0)} ms`);
  assert.equal(catalogue.counts().total, sampleCount + 12);
  catalogue.close({ backup: false });
});

test(`sample queries over ${sampleCount.toLocaleString()} samples each answer in under ${queryBudgetMs} ms`, async () => {
  const { catalogue } = await openCatalogue(await fixture);
  const filters = [
    {},
    { page: 400 },
    { sort: 'bpm' },
    { sort: 'duration', page: 200 },
    { source: '/studio/Packs' },
    { source: '/studio/Packs', sort: 'bpm', type: 'Drums' },
    { source: 'demo' },
    { view: 'gems' },
    { q: 'dust' },
    { q: 'warm pad 12' },
    { q: 'nothing matches this' },
    { type: 'Melodic', bpm: 'mid' },
    { bpm: 'unknown', sort: 'duration' },
    { conflicts: true },
    { conflicts: true, q: 'kick', source: '/studio/Splice', view: 'gems' }
  ];
  let slowest = { ms: 0 };
  for (const filter of filters) {
    const { result, ms } = fastest(() => catalogue.query({ pageSize: 50, ...filter }));
    assert.ok(result.items.length <= 50);
    if (process.env.SIFT_TIMINGS) console.log(`${ms.toFixed(1)} ms ${JSON.stringify(filter)}`);
    if (ms > slowest.ms) slowest = { ms, filter };
    assert.ok(ms < queryBudgetMs, `${JSON.stringify(filter)} took ${ms.toFixed(1)} ms`);
  }
  console.log(`Slowest query: ${slowest.ms.toFixed(1)} ms for ${JSON.stringify(slowest.filter)}`);
  const lite = fastest(() => catalogue.counts());
  assert.ok(lite.ms < queryBudgetMs, `counts took ${lite.ms.toFixed(1)} ms`);
  const batch = fastest(() => catalogue.getMany(Array.from({ length: 500 }, (_, i) => `sample-${i * 97}`)));
  assert.equal(batch.result.length, 500);
  assert.ok(batch.ms < queryBudgetMs, `batch of 500 took ${batch.ms.toFixed(1)} ms`);
  const combination = timed(() => {
    const tracks = ['Drums', 'Bass', 'Melodic', 'Texture'].map(type => ({ type, id: null }));
    return chooseCombination(tracks, catalogue.combinationCandidates(''), { tempo: 120, sync: true, key: 'A min' });
  });
  console.log(`Combination over ${sampleCount} samples: ${combination.ms.toFixed(0)} ms`);
  assert.ok(combination.result.every(track => track.id));
  catalogue.close({ backup: false });
});

test(`the server starts on a ${sampleCount.toLocaleString()}-sample catalogue in under ${startupBudgetMs} ms`, async t => {
  const dir = await fixture;
  const started = performance.now();
  const server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    env: { ...process.env, PORT: '44331', SIFT_DATA_DIR: dir, SIFT_ANALYSIS_PAUSED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  t.after(() => server.kill());
  let output = '';
  server.stderr.on('data', chunk => {
    output += chunk;
  });
  server.stdout.on('data', chunk => {
    output += chunk;
  });
  while (!/Sift is running/.test(output)) {
    assert.equal(server.exitCode, null, `server exited: ${output}`);
    assert.ok(performance.now() - started < 20000, `server did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const ms = performance.now() - started;
  console.log(`Server startup with ${sampleCount} samples: ${ms.toFixed(0)} ms`);
  assert.ok(ms < startupBudgetMs, `server startup took ${ms.toFixed(0)} ms`);
  const response = await fetch('http://127.0.0.1:44331/api/samples?pageSize=10&sort=bpm');
  assert.equal((await response.json()).total, sampleCount - 12);
  const stopped = once(server, 'exit');
  server.send({ type: 'sift:shutdown' });
  assert.equal((await stopped)[0], 0);
});
