import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadVerified } from '../scripts/download.mjs';

const body = Buffer.from('a pinned upstream archive');
const sha256 = createHash('sha256').update(body).digest('hex');
const url = 'https://mirror.example/archive.tar.gz';

function connectionReset() {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
}

// Replaces fetch with a queue of outcomes for one test; returns the call count.
function stubFetch(t, outcomes) {
  const calls = { count: 0 };
  t.mock.method(globalThis, 'fetch', async () => {
    const outcome = outcomes[Math.min(calls.count++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    return outcome();
  });
  t.mock.method(console, 'warn', () => {});
  return calls;
}

async function target() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sift-download-'));
  return { directory, destination: path.join(directory, 'archive.tar.gz') };
}

const options = { url, sha256, retryDelayMs: 1 };

test('a dropped connection or a busy server is tried again, and the file is still verified', async t => {
  const { directory, destination } = await target();
  const calls = stubFetch(t, [connectionReset(), () => new Response('busy', { status: 503 }), () => new Response(body)]);
  const result = await downloadVerified({ ...options, destination });
  assert.equal(calls.count, 3);
  assert.deepEqual(result, { file: destination, sha256 });
  assert.deepEqual(await readFile(destination), body);
  assert.deepEqual(await readdir(directory), ['archive.tar.gz'], 'no partial file is left behind');
  // A verified file is reused without another request.
  await downloadVerified({ ...options, destination });
  assert.equal(calls.count, 3);
});

test('retries stop after the given number of attempts and report the last error', async t => {
  const { directory, destination } = await target();
  const calls = stubFetch(t, [connectionReset()]);
  await assert.rejects(() => downloadVerified({ ...options, destination, attempts: 3 }), /fetch failed/);
  assert.equal(calls.count, 3);
  assert.deepEqual(await readdir(directory), []);
});

test('a refusal and a wrong checksum are not retried', async t => {
  const { directory, destination } = await target();
  let calls = stubFetch(t, [() => new Response('gone', { status: 404 })]);
  await assert.rejects(() => downloadVerified({ ...options, destination }), /Download failed \(404\)/);
  assert.equal(calls.count, 1);
  t.mock.restoreAll();
  calls = stubFetch(t, [() => new Response('tampered')]);
  await assert.rejects(() => downloadVerified({ ...options, destination }), /Checksum mismatch/);
  assert.equal(calls.count, 1);
  assert.deepEqual(await readdir(directory), []);
});
