import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readLegacyLibrary, checkMissingSamples } from '../lib/library.mjs';
import { normalizeWorkspace } from '../public/workspace.js';

const temporary = () => mkdtemp(path.join(os.tmpdir(), 'sift-library-'));

test('legacy catalogue reading preserves damaged files byte-for-byte and falls back to the backup', async () => {
  for (const damaged of ['{"samples": [', '{"samples":null}']) {
    const dir = await temporary();
    await writeFile(path.join(dir, 'library.json'), damaged);
    const legacy = await readLegacyLibrary(dir);
    assert.deepEqual(legacy.db.samples, []);
    assert.match(legacy.recovery.message, /fresh collection/);
    assert.equal(await readFile(path.join(dir, legacy.recovery.preserved[0]), 'utf8'), damaged);
  }
  const dir = await temporary();
  await writeFile(path.join(dir, 'library.json'), 'broken');
  await writeFile(path.join(dir, 'library.backup.json'), JSON.stringify({ favorites: ['kept'], analysisPaused: true }));
  const legacy = await readLegacyLibrary(dir);
  assert.match(legacy.recovery.message, /restored/);
  assert.deepEqual(legacy.db.favorites, ['kept']);
  assert.equal(legacy.db.analysisPaused, true);
  assert.equal(await readLegacyLibrary(await temporary()), null);
});

test('workspace validation rejects malformed types, fields and bounds while accepting older partial tracks', () => {
  const valid = { tracks: [{ id: 'sample', type: 'Bass', volume: .5, locked: true }], tempo: 120, sync: true, name: 'Keep' };
  const normalized = normalizeWorkspace(valid, { strict: true }); assert.equal(normalized.tracks.length, 4); assert.equal(normalized.tracks[0].volume, .5);
  for (const input of [null, [], {}, { ...valid, tracks: [null] }, { ...valid, tracks: [{ type: ['Drums'] }] }, { ...valid, tracks: [{ type: 'constructor' }] }, { ...valid, tracks: [{ id: {} }] }, { ...valid, tracks: [{ volume: 1.1 }] }, { ...valid, tracks: [{ volume: '0.5' }] }, { ...valid, tracks: [{ mute: 'false' }] }, { ...valid, tracks: Array(5).fill({}) }, { ...valid, tempo: 241 }, { ...valid, sync: 'false' }, { ...valid, name: {} }]) {
    assert.throws(() => normalizeWorkspace(input, { strict: true }), { status: 400 });
  }
  assert.equal(normalizeWorkspace({ tracks: [{ id: 'sample' }] }, { strict: true }).tracks[0].volume, .72);
});

test('missing-file checks preserve references, skip offline roots, and clear missing state when restored', async () => {
  const dir = await temporary(), root = path.join(dir, 'samples'); await mkdir(root);
  const samples = ['orphan', 'gem', 'set', 'workspace'].map(id => ({ id, root, path: path.join(root, id + '.wav') }));
  let result = await checkMissingSamples(samples); assert.equal(result.missing, 4); assert.equal(result.removed, 0);
  result = await checkMissingSamples(samples, { remove: true, referenced: new Set(['gem', 'set', 'workspace']) });
  assert.equal(result.removed, 1); assert.deepEqual(result.samples.map(s => s.id), ['gem', 'set', 'workspace']);
  await rename(root, root + '-offline'); result = await checkMissingSamples(samples, { remove: true });
  assert.equal(result.removed, 0); assert.equal(result.unavailableRoots, 1); assert.deepEqual(result.missingIds, []);
  await rename(root + '-offline', root); await writeFile(samples[1].path, 'audio'); samples[1].analysis = { status: 'error' };
  await checkMissingSamples(samples); assert.equal(samples[1].missing, undefined); assert.equal(samples[1].analysis, undefined);
});

test('permission errors and a source disappearing during cleanup never cause pruning', async () => {
  const sample = { id: 'sample', root: '/source', path: '/source/audio.wav' };
  const directory = { isDirectory: () => true };
  let result = await checkMissingSamples([sample], { remove: true, statFile: async name => { if (name === sample.root) return directory; throw Object.assign(new Error(), { code: 'EACCES' }); } });
  assert.equal(result.removed, 0); assert.equal(sample.missing, undefined);
  let rootChecks = 0;
  result = await checkMissingSamples([sample], { remove: true, statFile: async name => { if (name === sample.root && ++rootChecks === 1) return directory; throw Object.assign(new Error(), { code: 'ENOENT' }); } });
  assert.equal(result.removed, 0); assert.equal(result.unavailableRoots, 1);
});
