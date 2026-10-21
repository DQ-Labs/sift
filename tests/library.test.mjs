import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openLibrary, checkMissingSamples } from '../lib/library.mjs';
import { normalizeWorkspace } from '../public/workspace.js';

const temporary = () => mkdtemp(path.join(os.tmpdir(), 'sift-library-'));

test('a damaged catalogue is preserved byte-for-byte and replaced without preventing startup', async () => {
  for (const damaged of ['{"samples": [', '{"samples":null}']) {
    const dir = await temporary(); await writeFile(path.join(dir, 'library.json'), damaged);
    const store = await openLibrary(dir);
    assert.deepEqual(store.db.samples, []); assert.match(store.recovery.message, /fresh collection/);
    assert.equal(await readFile(path.join(dir, store.recovery.preserved[0]), 'utf8'), damaged);
    await store.persist(); assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'library.json'), 'utf8')).samples, []);
  }
});

test('rolling backup recovers gems, sets, workspace and metadata after corruption or a missing primary', async () => {
  const dir = await temporary(), store = await openLibrary(dir);
  const sample = { id: 'sample', path: path.join(dir, 'test.wav'), filename: 'test.wav', overrides: { bpm: 123, key: null } };
  store.db.samples.push(sample); store.db.favorites.push(sample.id);
  store.db.sets.push({ id: 'set', name: 'Keep this', tracks: [{ id: sample.id,timing:{offset:.25,repeat:'2bars'} }], tempo: 123, key:'D min' });
  store.db.workspace = { tracks: [{ id: sample.id }], tempo: 123, sync: true, key:'C maj', name: 'Working' };
  await store.persist(); await store.persist();
  await writeFile(path.join(dir, 'library.json'), 'broken');
  let recovered = await openLibrary(dir);
  assert.match(recovered.recovery.message, /restored/); assert.deepEqual(recovered.db.favorites, [sample.id]);
  assert.equal(recovered.db.sets[0].tracks[0].id, sample.id); assert.equal(recovered.db.workspace.sync, true);
  assert.equal(recovered.db.workspace.key,'C maj');assert.equal(recovered.db.sets[0].key,'D min');
  assert.deepEqual(recovered.db.sets[0].tracks[0].timing,{offset:.25,repeat:'2bars'});
  assert.deepEqual(recovered.db.samples[0].overrides, sample.overrides);
  await recovered.persist(); await unlink(path.join(dir, 'library.json'));
  recovered = await openLibrary(dir); assert.deepEqual(recovered.db.favorites, [sample.id]); assert.match(recovered.recovery.message, /restored/);
});

test('both damaged catalogue files survive recovery and invalid legacy workspaces are repaired', async () => {
  const dir = await temporary();
  await writeFile(path.join(dir, 'library.json'), 'primary damage'); await writeFile(path.join(dir, 'library.backup.json'), 'backup damage');
  let store = await openLibrary(dir); assert.equal(store.recovery.preserved.length, 2);
  assert.equal((await readdir(dir)).filter(name => name.includes('.corrupt-')).length, 2);
  await writeFile(path.join(dir, 'library.json'), JSON.stringify({ workspace: { tracks: [{ type: ['Drums'], volume: 'bad' }], name: {}, sync: 'false' } }));
  store = await openLibrary(dir); assert.equal(store.recovery, null);
  assert.equal(store.db.workspace.tracks[0].type, 'Drums'); assert.equal(store.db.workspace.name, 'Untitled set'); assert.equal(store.db.workspace.sync, false);
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
