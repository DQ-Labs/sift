import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { analysisWorkerCount, AnalysisWorkerPool, AnalysisQueue, ANALYSIS_VERSION } from '../lib/analysis.mjs';
import { clickFixture } from './fixtures.mjs';

test('the pool defaults to min(4, cores - 1) workers and honours SIFT_ANALYSIS_WORKERS', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [3, 2], [4, 3], [8, 4], [32, 4]]) {
    assert.equal(analysisWorkerCount({ env: {}, cores }), expected, `${cores} cores`);
  }
  assert.equal(analysisWorkerCount({ env: { SIFT_ANALYSIS_WORKERS: '2' }, cores: 16 }), 2);
  assert.equal(analysisWorkerCount({ env: { SIFT_ANALYSIS_WORKERS: '8' }, cores: 2 }), 8);
  assert.equal(analysisWorkerCount({ env: { SIFT_ANALYSIS_WORKERS: '64' }, cores: 2 }), 16);
  for (const invalid of ['0', '-1', '1.5', 'many', '']) {
    assert.equal(analysisWorkerCount({ env: { SIFT_ANALYSIS_WORKERS: invalid }, cores: 8 }), 4, invalid);
  }
});

// Answers each job after `delay` ms, or fails as `behaviour` says.
class FakeWorker extends EventEmitter {
  constructor(behaviour) {
    super();
    this.behaviour = behaviour;
    this.terminated = false;
    this.jobs = 0;
  }

  postMessage({ type }) {
    this.jobs++;
    const { delay = 1, outcome = 'result' } = this.behaviour(type) || {};
    if (outcome === 'hang') return;
    setTimeout(() => {
      if (outcome === 'report-error') this.emit('message', { error: 'Essentia could not read this audio.' });
      else this.emit('message', { result: { bpm: 120, type } });
    }, delay);
  }

  terminate() {
    this.terminated = true;
    return Promise.resolve();
  }

  ref() {}

  unref() {}
}

function fakePool(size, behaviour = () => ({})) {
  const created = [];
  const pool = new AnalysisWorkerPool(size, {
    createWorker: () => {
      const worker = new FakeWorker(behaviour);
      created.push(worker);
      return worker;
    }
  });
  return { pool, created };
}

test('workers are reused between jobs and run at most `size` jobs at once', async () => {
  const { pool, created } = fakePool(2, () => ({ delay: 10 }));
  for (let i = 0; i < 3; i++) await pool.run(new Float32Array(4), 'Drums');
  assert.equal(created.length, 1);
  assert.equal(created[0].jobs, 3);
  const results = await Promise.all(Array.from({ length: 6 }, () => pool.run(new Float32Array(4), 'Bass')));
  assert.equal(results.length, 6);
  assert.equal(created.length, 2);
  assert.equal(pool.workerCount, 2);
  pool.close();
  assert.ok(created.every(worker => worker.terminated));
});

test('a hung worker is terminated and replaced; a worker that reports an error is kept', async () => {
  const { pool, created } = fakePool(1, type => (type === 'hang' ? { outcome: 'hang' } : type === 'bad' ? { outcome: 'report-error' } : {}));
  await assert.rejects(() => pool.run(new Float32Array(4), 'bad'), /could not read/);
  await pool.run(new Float32Array(4), 'Drums');
  assert.equal(created.length, 1);
  await assert.rejects(() => pool.run(new Float32Array(4), 'hang', { timeout: 20 }), /timed out/);
  assert.equal(created[0].terminated, true);
  const controller = new AbortController();
  const cancelled = pool.run(new Float32Array(4), 'hang', { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => cancelled, /cancelled/);
  assert.deepEqual((await pool.run(new Float32Array(4), 'Drums')).bpm, 120);
  assert.equal(created.length, 3);
  pool.close();
});

test('the real Essentia worker analyzes several files on one warm worker', async () => {
  let created = 0;
  const pool = new AnalysisWorkerPool(1, {
    createWorker: () => {
      created++;
      return new Worker(new URL('../lib/analysis-worker.mjs', import.meta.url), { execArgv: [] });
    }
  });
  try {
    for (const bpm of [90, 140]) {
      const result = await pool.run(clickFixture(bpm), 'Drums');
      assert.ok(Math.abs(result.bpm - bpm) < 2, `${bpm} detected as ${result.bpm}`);
    }
    assert.equal(created, 1);
  } finally {
    pool.close();
  }
});

// A queue over in-memory records whose decode and analysis steps are fakes.
function fakeQueue({ samples, concurrency = 2, files = {}, analyze, commit, statFile } = {}) {
  const records = new Map(samples.map(sample => [sample.id, structuredClone(sample)]));
  let running = 0;
  let peak = 0;
  const queue = new AnalysisQueue({
    load: id => (records.has(id) ? structuredClone(records.get(id)) : undefined),
    commit: commit || ((id, apply) => {
      const current = records.get(id);
      if (current) apply(current);
      return current;
    }),
    concurrency,
    paused: true,
    statFile: statFile || (async file => {
      if (!(file in files)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return { mtimeMs: files[file], size: 100 };
    }),
    decode: async () => ({ audio: new Float32Array(8), metadata: { duration: 4 } }),
    analyze: analyze || (async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      return { bpm: 100, key: null, peaks: [1, 0.5] };
    })
  });
  return { queue, records, peak: () => peak };
}

async function drain(queue) {
  const deadline = Date.now() + 5000;
  while (queue.status().running || (queue.status().pending && !queue.status().paused)) {
    assert.ok(Date.now() < deadline, 'queue did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const sampleAt = (id, file) => ({ id, name: id, path: file, type: 'Melodic', filename: `${id}.wav`, size: 100, mtime: 1 });

test('the queue runs up to its concurrency and stores each result once', async () => {
  const samples = Array.from({ length: 7 }, (_, i) => sampleAt(`s${i}`, `/f/${i}.wav`));
  const files = Object.fromEntries(samples.map(sample => [sample.path, 1]));
  const { queue, records, peak } = fakeQueue({ samples, files, concurrency: 3 });
  queue.enqueue(samples);
  assert.equal(queue.status().pending, 7);
  queue.resume();
  await drain(queue);
  assert.equal(peak(), 3);
  assert.equal(queue.status().completed, 7);
  assert.equal(queue.status().workers, 3);
  for (const sample of records.values()) {
    assert.equal(sample.analysis.status, 'done');
    assert.equal(sample.analysis.version, ANALYSIS_VERSION);
    assert.deepEqual(sample.peaks, [1, 0.5]);
    assert.equal(sample.analysis.peaks, undefined);
  }
  queue.enqueue([...records.values()]);
  assert.equal(queue.status().pending, 0, 'finished samples are not queued again');
  queue.close();
});

test('files on a disconnected drive are skipped, not failed, and stay unanalyzed', async () => {
  const samples = [sampleAt('here', '/drive/here.wav'), sampleAt('gone', '/unplugged/gone.wav')];
  const { queue, records } = fakeQueue({ samples, files: { '/drive/here.wav': 1 } });
  queue.enqueue(samples);
  queue.resume();
  await drain(queue);
  assert.equal(queue.status().skipped, 1);
  assert.equal(queue.status().failed, 0);
  assert.equal(records.get('gone').analysis, undefined);
  assert.equal(records.get('here').analysis.status, 'done');
  queue.close();
});

test('a record that changed during analysis is analyzed again instead of overwritten', async () => {
  const samples = [sampleAt('a', '/f/a.wav')];
  let calls = 0;
  const { queue, records } = fakeQueue({
    samples,
    files: { '/f/a.wav': 1 },
    analyze: async () => {
      calls++;
      // A rescan replaces the record while the first analysis runs.
      if (calls === 1) records.get('a').mtime = 2;
      return { bpm: 100 + calls, peaks: [] };
    }
  });
  queue.enqueue(samples);
  queue.resume();
  await drain(queue);
  assert.equal(calls, 2);
  assert.equal(records.get('a').analysis.bpm, 102);
  queue.close();
});

test('results that cannot be saved pause the queue and are written on a successful retry', async () => {
  const samples = [sampleAt('a', '/f/a.wav')];
  let failure = 'disk I/O error';
  const stored = new Map();
  const { queue } = fakeQueue({
    samples,
    files: { '/f/a.wav': 1 },
    commit: (id, apply) => {
      if (failure) throw new Error(failure);
      const sample = sampleAt('a', '/f/a.wav');
      apply(sample);
      stored.set(id, sample);
      return sample;
    }
  });
  queue.enqueue(samples);
  queue.resume();
  await drain(queue);
  let status = queue.status();
  assert.equal(status.saveError, 'disk I/O error');
  assert.equal(status.paused, true);
  assert.equal(stored.size, 0);
  failure = null;
  await queue.save();
  status = queue.status();
  assert.equal(status.saveError, null);
  assert.equal(stored.get('a').analysis.status, 'done');
  queue.close();
});
