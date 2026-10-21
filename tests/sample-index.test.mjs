import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SampleIndex } from '../lib/sample-index.mjs';

test('existing catalogue IDs survive rescans, including legacy Windows IDs', async () => {
  const sample = { id: 'keep-gems-and-sets', path: 'D:\\Samples\\Foo.wav', overrides: { bpm: 123 } };
  const index = new SampleIndex([sample], { platform: 'win32' });
  assert.deepEqual(await index.identify(sample.path), { id: sample.id, old: sample });
});

test('case-sensitive Windows paths remain separate even when their old folded ID collides', async () => {
  const lowerPath = 'D:\\Samples\\foo.wav', upperPath = 'D:\\Samples\\Foo.wav';
  const old = { id: createHash('sha256').update(lowerPath).digest('hex').slice(0, 20), path: upperPath, overrides: { bpm: 80 } };
  const index = new SampleIndex([old], { platform: 'win32', statFile: async () => ({ dev: 1, ino: 101 }) });
  const result = await index.identify(lowerPath, { dev: 1, ino: 102 });
  assert.notEqual(result.id, old.id); assert.equal(result.old, undefined);
  const lower = { id: result.id, path: lowerPath }; index.remember(lower);
  assert.equal((await index.identify(upperPath)).old, old);
  assert.equal((await index.identify(lowerPath)).old, lower);
  const restarted = new SampleIndex([old, lower], { platform: 'win32' });
  assert.equal((await restarted.identify(lowerPath)).id, lower.id);
});

test('case-only aliases of one Windows file reuse the ID and keep corrections', async () => {
  const old = { id: 'existing', path: 'D:\\Samples\\Foo.wav', overrides: { bpm: 120 } };
  const index = new SampleIndex([old], { platform: 'win32', statFile: async () => ({ dev: 1, ino: 101 }) });
  const result = await index.identify('D:\\Samples\\foo.wav', { dev: 1, ino: 101 });
  assert.equal(result.id, old.id); assert.deepEqual(result.old.overrides, { bpm: 120 });
  const replacement = { ...old, path: 'D:\\Samples\\foo.wav' }; index.remember(replacement);
  assert.equal((await index.identify(replacement.path)).old, replacement);
});

test('different volumes and unavailable old paths cannot be mistaken for the same file', async () => {
  const old = { id: 'existing', path: 'D:\\Samples\\Foo.wav' };
  let index = new SampleIndex([old], { platform: 'win32', statFile: async () => ({ dev: 2, ino: 101 }) });
  assert.equal((await index.identify('D:\\Samples\\foo.wav', { dev: 1, ino: 101 })).old, undefined);
  index = new SampleIndex([old], { platform: 'win32', statFile: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } });
  assert.equal((await index.identify('D:\\Samples\\foo.wav', { dev: 1, ino: 101 })).old, undefined);
});
