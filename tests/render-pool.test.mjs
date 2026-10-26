import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderPool, renderWorkerCount } from '../lib/media.mjs';

// A task the test finishes by hand, recording when it starts.
function controlled(log, name) {
  let finish;
  const done = new Promise(resolve => {
    finish = resolve;
  });
  const task = async () => {
    log.push(name);
    await done;
    return name;
  };
  return { task, finish: () => finish() };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('render workers default to two or three and SIFT_RENDER_WORKERS overrides them', () => {
  assert.equal(renderWorkerCount({ env: {}, cores: 1 }), 2);
  assert.equal(renderWorkerCount({ env: {}, cores: 3 }), 2);
  assert.equal(renderWorkerCount({ env: {}, cores: 4 }), 3);
  assert.equal(renderWorkerCount({ env: {}, cores: 32 }), 3);
  assert.equal(renderWorkerCount({ env: { SIFT_RENDER_WORKERS: '1' }, cores: 32 }), 1);
  assert.equal(renderWorkerCount({ env: { SIFT_RENDER_WORKERS: '6' }, cores: 2 }), 6);
  assert.equal(renderWorkerCount({ env: { SIFT_RENDER_WORKERS: '99' }, cores: 2 }), 8);
  for (const value of ['0', '-1', '1.5', 'many']) assert.equal(renderWorkerCount({ env: { SIFT_RENDER_WORKERS: value }, cores: 4 }), 3);
});

test('audible renders run ahead of queued prefetches and always find a free worker', async () => {
  const log = [];
  const pool = new RenderPool(3);
  const jobs = Object.fromEntries(['p1', 'p2', 'p3', 'p4', 'n1', 'n2'].map(name => [name, controlled(log, name)]));
  const results = ['p1', 'p2', 'p3', 'p4'].map(name => pool.run(name, 'prefetch', jobs[name].task));
  await tick();
  // Prefetches use two of the three workers; one stays free for 'now'.
  assert.deepEqual(log, ['p1', 'p2']);
  assert.deepEqual(pool.status(), { workers: 3, running: 2, queued: { now: 0, prefetch: 2 } });
  results.push(pool.run('n1', 'now', jobs.n1.task));
  await tick();
  assert.deepEqual(log, ['p1', 'p2', 'n1'], 'an audible render starts at once');
  results.push(pool.run('n2', 'now', jobs.n2.task));
  jobs.p1.finish();
  await tick();
  assert.deepEqual(log, ['p1', 'p2', 'n1', 'n2'], 'a waiting audible render takes the next free worker');
  for (const name of ['p2', 'n1', 'n2', 'p3', 'p4']) {
    jobs[name].finish();
    await tick();
  }
  assert.deepEqual(log, ['p1', 'p2', 'n1', 'n2', 'p3', 'p4']);
  assert.deepEqual(await Promise.all(results), ['p1', 'p2', 'p3', 'p4', 'n1', 'n2']);
  assert.equal(pool.status().running, 0);
});

test('identical renders share one job and a queued prefetch is promoted by a now request', async () => {
  const log = [];
  const pool = new RenderPool(2);
  const busy = controlled(log, 'busy');
  const first = controlled(log, 'first');
  const second = controlled(log, 'second');
  const duplicate = controlled(log, 'duplicate');
  const running = pool.run('busy', 'prefetch', busy.task);
  const queued = [pool.run('first', 'prefetch', first.task), pool.run('second', 'prefetch', second.task)];
  await tick();
  assert.deepEqual(log, ['busy']);
  // The same key again, now audible: same promise, jumps the prefetch queue.
  const promoted = pool.run('second', 'now', duplicate.task);
  assert.equal(promoted, queued[1]);
  await tick();
  assert.deepEqual(log, ['busy', 'second'], 'the promoted render starts on the free worker');
  second.finish();
  busy.finish();
  await tick();
  assert.deepEqual(log, ['busy', 'second', 'first']);
  first.finish();
  assert.deepEqual(await Promise.all([running, ...queued, promoted]), ['busy', 'first', 'second', 'second']);
  assert.ok(!log.includes('duplicate'), 'the duplicate task never ran');
});

test('a full queue drops the oldest prefetch for an audible render and refuses more prefetches', async () => {
  const log = [];
  const pool = new RenderPool(1, { limit: 3 });
  const jobs = Object.fromEntries(['a', 'b', 'c', 'n'].map(name => [name, controlled(log, name)]));
  const a = pool.run('a', 'prefetch', jobs.a.task);
  const b = pool.run('b', 'prefetch', jobs.b.task);
  const c = pool.run('c', 'prefetch', jobs.c.task);
  assert.throws(() => pool.run('d', 'prefetch', async () => 'd'), /queue is full/);
  const n = pool.run('n', 'now', jobs.n.task);
  await assert.rejects(b, /dropped to make room/);
  for (const name of ['a', 'n', 'c']) {
    await tick();
    jobs[name].finish();
  }
  assert.deepEqual(await Promise.all([a, n, c]), ['a', 'n', 'c']);
  assert.deepEqual(log, ['a', 'n', 'c']);
  assert.throws(() => pool.run('x', 'soon', async () => {}), /priority/);
});

test('a failed render rejects every waiter and frees its worker', async () => {
  const pool = new RenderPool(1);
  const failing = pool.run('bad', 'now', async () => {
    throw new Error('Audio processing failed');
  });
  const shared = pool.run('bad', 'now', async () => 'unused');
  await assert.rejects(failing, /failed/);
  await assert.rejects(shared, /failed/);
  assert.equal(await pool.run('good', 'now', async () => 'ok'), 'ok');
});
