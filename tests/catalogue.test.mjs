import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, unlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCatalogue, catalogueFiles, nameKey, caseKey } from '../lib/catalogue.mjs';
import { DatabaseSync } from '../lib/sqlite.mjs';
import { chooseCombination } from '../public/harmony.js';
import { syntheticSamples, referenceFilter } from './fixtures.mjs';

const temporary = () => mkdtemp(path.join(os.tmpdir(), 'sift-catalogue-'));
const exists = async file => access(file).then(() => true, () => false);

function legacyLibrary(dir) {
  const sample = { id: 'sample', path: path.join(dir, 'test.wav'), filename: 'test.wav', name: 'test', overrides: { bpm: 123, key: null }, peaks: [0.25, 0.5, 1] };
  const other = { id: 'other', path: path.join(dir, 'Kick 120bpm.wav'), filename: 'Kick 120bpm.wav', name: 'Kick 120bpm' };
  return {
    samples: [sample, other],
    folders: [{ path: dir, name: 'Library' }],
    favorites: [sample.id],
    sets: [
      { id: 'newest', name: 'Newest', tracks: [{ id: sample.id, timing: { offset: 0.25, repeat: '2bars' } }], tempo: 123, key: 'D min' },
      { id: 'older', name: 'Older', tracks: [{ id: other.id }], tempo: 90 }
    ],
    workspace: { tracks: [{ id: sample.id }], tempo: 123, sync: true, key: 'C maj', name: 'Working' },
    analysisPaused: true
  };
}

function assertLibraryKept(catalogue) {
  assert.deepEqual(catalogue.favorites, ['sample']);
  assert.deepEqual(catalogue.sets.map(set => set.id), ['newest', 'older']);
  assert.deepEqual(catalogue.sets[0].tracks[0].timing, { offset: 0.25, repeat: '2bars', start: 'beat' });
  assert.equal(catalogue.sets[0].key, 'D min');
  assert.equal(catalogue.workspace.key, 'C maj');
  assert.equal(catalogue.workspace.sync, true);
  assert.equal(catalogue.analysisPaused, true);
  assert.deepEqual(catalogue.folders, [{ path: path.dirname(catalogue.get('sample').path), name: 'Library' }]);
  const sample = catalogue.get('sample');
  assert.deepEqual(sample.overrides, { bpm: 123, key: null });
  assert.equal(sample.bpm, 123);
  assert.equal(sample.bpmSource, 'manual');
  assert.deepEqual(sample.peaks, [0.25, 0.5, 1]);
  assert.equal(catalogue.get('other').type, 'Drums');
  assert.deepEqual(catalogue.allSamples().map(s => s.id), ['sample', 'other']);
}

test('library.json migrates once into SQLite and is kept as library.pre-sqlite.json', async () => {
  const dir = await temporary();
  const raw = JSON.stringify(legacyLibrary(dir));
  await writeFile(path.join(dir, 'library.json'), raw);
  await writeFile(path.join(dir, 'library.backup.json'), raw);
  let { catalogue, recovery } = await openCatalogue(dir);
  assert.equal(recovery, null);
  assertLibraryKept(catalogue);
  assert.equal(catalogue.meta('migratedFrom'), 'library.json');
  catalogue.close();
  assert.equal(await readFile(path.join(dir, 'library.pre-sqlite.json'), 'utf8'), raw);
  assert.equal(await readFile(path.join(dir, 'library.pre-sqlite.backup.json'), 'utf8'), raw);
  assert.equal(await exists(path.join(dir, 'library.json')), false);
  assert.equal(await exists(path.join(dir, 'library.backup.json')), false);

  // A library.json that appears later is never imported over the database.
  await writeFile(path.join(dir, 'library.json'), JSON.stringify({ ...legacyLibrary(dir), favorites: [] }));
  ({ catalogue, recovery } = await openCatalogue(dir));
  assert.equal(recovery, null);
  assert.deepEqual(catalogue.favorites, ['sample']);
  catalogue.close();
});

test('an interrupted migration finishes renaming the JSON on the next start', async () => {
  const dir = await temporary();
  const raw = JSON.stringify(legacyLibrary(dir));
  await writeFile(path.join(dir, 'library.json'), raw);
  let { catalogue } = await openCatalogue(dir);
  catalogue.close();
  // Simulate a crash after the database was written but before the rename.
  await writeFile(path.join(dir, 'library.json'), raw);
  await unlink(path.join(dir, 'library.pre-sqlite.json'));
  ({ catalogue } = await openCatalogue(dir));
  assertLibraryKept(catalogue);
  catalogue.close();
  assert.equal(await readFile(path.join(dir, 'library.pre-sqlite.json'), 'utf8'), raw);
  assert.equal(await exists(path.join(dir, 'library.json')), false);
});

test('a damaged library.json is preserved byte-for-byte and its backup is migrated instead', async () => {
  const dir = await temporary();
  await writeFile(path.join(dir, 'library.json'), '{"samples": [');
  await writeFile(path.join(dir, 'library.backup.json'), JSON.stringify(legacyLibrary(dir)));
  const { catalogue, recovery } = await openCatalogue(dir);
  assert.match(recovery.message, /restored/);
  assert.equal(await readFile(path.join(dir, recovery.preserved[0]), 'utf8'), '{"samples": [');
  assertLibraryKept(catalogue);
  catalogue.close();
});

test('damaged JSON with no usable backup starts a fresh, writable catalogue', async () => {
  for (const [primary, backup] of [['{"samples":null}', null], ['primary damage', 'backup damage']]) {
    const dir = await temporary();
    await writeFile(path.join(dir, 'library.json'), primary);
    if (backup) await writeFile(path.join(dir, 'library.backup.json'), backup);
    const { catalogue, recovery } = await openCatalogue(dir);
    assert.match(recovery.message, /fresh collection/);
    assert.equal(recovery.preserved.length, backup ? 2 : 1);
    assert.equal(await readFile(path.join(dir, recovery.preserved[0]), 'utf8'), primary);
    assert.deepEqual(catalogue.allSamples(), []);
    catalogue.setFavorites([]);
    catalogue.close();
  }
});

test('invalid legacy workspaces are repaired during migration', async () => {
  const dir = await temporary();
  await writeFile(path.join(dir, 'library.json'), JSON.stringify({ workspace: { tracks: [{ type: ['Drums'], volume: 'bad' }], name: {}, sync: 'false' } }));
  const { catalogue, recovery } = await openCatalogue(dir);
  assert.equal(recovery, null);
  assert.equal(catalogue.workspace.tracks[0].type, 'Drums');
  assert.equal(catalogue.workspace.name, 'Untitled set');
  assert.equal(catalogue.workspace.sync, false);
  catalogue.close();
});

async function catalogueWithBackup() {
  const dir = await temporary();
  await writeFile(path.join(dir, 'library.json'), JSON.stringify(legacyLibrary(dir)));
  const { catalogue } = await openCatalogue(dir);
  catalogue.close();
  return dir;
}

test('a damaged SQLite catalogue is preserved and restored from the rolling backup', async () => {
  const dir = await catalogueWithBackup();
  const damaged = Buffer.from('SQLite format 3\0 but not really a database '.repeat(40));
  await writeFile(path.join(dir, catalogueFiles.database), damaged);
  let { catalogue, recovery } = await openCatalogue(dir);
  assert.match(recovery.message, /restored/);
  assert.deepEqual(await readFile(path.join(dir, recovery.preserved[0])), damaged);
  assertLibraryKept(catalogue);
  catalogue.close();

  await unlink(path.join(dir, catalogueFiles.database));
  ({ catalogue, recovery } = await openCatalogue(dir));
  assert.match(recovery.message, /restored/);
  assert.deepEqual(recovery.preserved, []);
  assertLibraryKept(catalogue);
  catalogue.close();
});

test('when the catalogue and its backup are both damaged, both survive and a fresh catalogue starts', async () => {
  const dir = await catalogueWithBackup();
  await writeFile(path.join(dir, catalogueFiles.database), 'primary damage '.repeat(100));
  await writeFile(path.join(dir, catalogueFiles.backup), 'backup damage '.repeat(100));
  const { catalogue, recovery } = await openCatalogue(dir);
  assert.match(recovery.message, /fresh collection/);
  assert.equal(recovery.preserved.length, 2);
  assert.equal((await readdir(dir)).filter(name => name.includes('.corrupt-')).length, 2);
  assert.deepEqual(catalogue.allSamples(), []);
  catalogue.setWorkspace({ tracks: [], tempo: 100 });
  catalogue.close();
  const reopened = await openCatalogue(dir);
  assert.equal(reopened.recovery, null);
  assert.equal(reopened.catalogue.workspace.tempo, 100);
  reopened.catalogue.close();
});

test('a catalogue from a newer Sift is refused and left untouched', async () => {
  const dir = await catalogueWithBackup();
  const file = path.join(dir, catalogueFiles.database);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 99');
  db.close();
  const before = await readFile(file);
  await assert.rejects(() => openCatalogue(dir), { code: 'SIFT_CATALOGUE_NEWER' });
  assert.deepEqual(await readFile(file), before);
});

test('stored metadata is refreshed once when the metadata rules change', async () => {
  const dir = await temporary();
  let { catalogue } = await openCatalogue(dir);
  catalogue.put({ id: 'a', path: '/x/Snare.wav', filename: 'Snare.wav', name: 'Snare', type: 'Other', overrides: {} });
  assert.equal(catalogue.refreshMetadata(), 0);
  catalogue.setMeta('metadataRules', 'older rules');
  catalogue.close();
  ({ catalogue } = await openCatalogue(dir));
  assert.equal(catalogue.get('a').type, 'Drums');
  assert.equal(catalogue.refreshMetadata(), 0);
  catalogue.close();
});

test('sample records round-trip with their waveform peaks', async () => {
  const { catalogue } = await openCatalogue(await temporary());
  const peaks = Array.from({ length: 160 }, (_, i) => i / 160);
  const sample = { id: 'a', path: '/x/a.wav', filename: 'a.wav', name: 'a', peaks, analysis: { status: 'done', version: 1, peaks, bpm: 120 } };
  catalogue.put(sample);
  const stored = catalogue.get('a');
  stored.peaks.forEach((value, i) => assert.ok(Math.abs(value - peaks[i]) < 1e-6));
  assert.equal(stored.analysis.bpm, 120);
  assert.equal(stored.analysis.peaks, undefined, 'peaks are stored once');
  assert.equal(catalogue.get('missing'), undefined);
  assert.deepEqual(catalogue.getMany(['a', 'missing', 'a']).map(s => s.id), ['a']);
  catalogue.close();
});

test('the name sort key matches localeCompare for sample-style names', () => {
  const names = ['dust_break', 'Dust break', 'dust-break', 'dust break', 'Dust_Break 2', 'dust(1)', 'dust1', 'Dust 10', '808 sub', '_intro', 'Café', 'cafe', 'Zebra', 'apple'];
  const expected = [...names].sort((a, b) => a.localeCompare(b));
  const actual = [...names].sort((a, b) => (nameKey(a) < nameKey(b) ? -1 : nameKey(a) > nameKey(b) ? 1 : caseKey(a) < caseKey(b) ? -1 : caseKey(a) > caseKey(b) ? 1 : 0));
  // Accents are a secondary difference that the key leaves to insertion order.
  const unaccented = list => list.filter(name => name !== 'Café' && name !== 'cafe');
  assert.deepEqual(unaccented(actual), unaccented(expected));
});

async function syntheticCatalogue(count = 3000) {
  const samples = syntheticSamples(count, { seed: 42 });
  const { catalogue } = await openCatalogue(await temporary());
  catalogue.putMany(samples);
  const favorites = samples.filter((_, i) => i % 7 === 0).map(s => s.id);
  catalogue.setFavorites(favorites);
  return { catalogue, samples, favorites };
}

test('sample queries match filteredSamples() for every filter, sort and source', async () => {
  const { catalogue, samples, favorites } = await syntheticCatalogue();
  const filters = [
    {},
    { source: 'demo' },
    { source: '/library/Two' },
    { source: '/library/None' },
    { view: 'gems' },
    { q: 'dust' },
    { q: '  KICK   break ' },
    { q: 'a min' },
    { q: 'pack' },
    { q: 'zzz-nothing' },
    { type: 'Bass' },
    { type: 'Vocal', sort: 'bpm' },
    { bpm: 'slow' },
    { bpm: 'mid', sort: 'duration' },
    { bpm: 'fast', sort: 'bpm' },
    { bpm: 'unknown' },
    { conflicts: true },
    { conflicts: true, view: 'gems', source: '/library/One' },
    { sort: 'bpm' },
    { sort: 'duration' },
    { source: 'demo', sort: 'duration', q: 'o' }
  ];
  for (const filter of filters) {
    const expected = referenceFilter(samples, favorites, filter).map(s => s.id);
    const result = catalogue.query({ ...filter, pageSize: 500, page: 0 });
    assert.equal(result.total, expected.length, JSON.stringify(filter));
    const all = [];
    for (let page = 0; page * 500 < Math.max(1, result.total); page++) all.push(...catalogue.query({ ...filter, pageSize: 500, page }).items.map(s => s.id));
    assert.deepEqual(all, expected, JSON.stringify(filter));
  }
  catalogue.close();
});

test('an empty catalogue lists demo samples for the default source, and pages clamp', async () => {
  const { catalogue } = await openCatalogue(await temporary());
  const samples = syntheticSamples(30, { demo: 30 });
  catalogue.putMany(samples);
  assert.equal(catalogue.query({}).total, 30);
  const last = catalogue.query({ pageSize: 20, page: 9 });
  assert.equal(last.page, 1);
  assert.equal(last.items.length, 10);
  assert.deepEqual(catalogue.query({ q: 'nothing matches this' }), { total: 0, page: 0, pageSize: 50, items: [] });
  catalogue.close();
});

test('counts, references and combination candidates come from the catalogue', async () => {
  const { catalogue, samples } = await syntheticCatalogue(600);
  catalogue.update('sample-20', sample => {
    sample.missing = true;
  });
  catalogue.update('sample-21', sample => {
    sample.invalid = 'Empty file (0 bytes).';
  });
  const counts = catalogue.counts();
  assert.equal(counts.total, 600);
  assert.equal(counts.demo, 12);
  assert.equal(counts.real, 588);
  assert.equal(counts.missing, 1);
  assert.equal(counts.invalid, 1);
  assert.equal(counts.conflicts, samples.filter(s => s.conflicts.bpm).length);
  assert.equal(Object.values(counts.byRoot).reduce((sum, n) => sum + n, 0), 588);
  const candidates = catalogue.combinationCandidates('');
  assert.equal(candidates.length, 586);
  assert.ok(!candidates.some(s => s.id === 'sample-20' || s.id === 'sample-21' || s.demo));
  assert.equal(catalogue.combinationCandidates('demo').length, 12);
  const tracks = ['Drums', 'Bass', 'Melodic', 'Texture'].map(type => ({ type, id: null }));
  const chosen = chooseCombination(tracks, candidates, { tempo: 100, sync: true, key: 'A min' }, null, () => 0.5);
  assert.equal(new Set(chosen.map(t => t.id)).size, 4);
  catalogue.setWorkspace({ tracks: [{ id: 'sample-30' }] });
  catalogue.addSet({ id: 'set', name: 'Set', tracks: [{ id: 'sample-31' }] });
  assert.ok(catalogue.referencedIds().has('sample-30'));
  assert.ok(catalogue.referencedIds().has('sample-31'));
  assert.ok(catalogue.referencedIds().has('sample-0'));
  assert.deepEqual(catalogue.setFavorites(['sample-1', 'unknown', 'sample-1', 'sample-2']), ['sample-1', 'sample-2']);
  catalogue.close();
});

test('beat grids round-trip in their own column and loops are marked for combinations', async () => {
  const { catalogue } = await openCatalogue(await temporary());
  const beats = [0.5, 1.0001, 1.5, 2.25];
  const base = { path: '/x/loop.wav', filename: 'loop.wav', name: 'loop', type: 'Drums', bpmSource: 'analysis', size: 1, mtime: 1 };
  catalogue.putMany([
    { ...base, id: 'loop', bpm: 120, duration: 8.01, beats },
    { ...base, id: 'phrase', path: '/x/phrase.wav', bpm: 120, duration: 7 },
    { ...base, id: 'guess', path: '/x/guess.wav', bpm: 120, duration: 8, bpmSource: 'filename-hint' }
  ]);
  assert.deepEqual(catalogue.get('loop').beats, beats);
  assert.equal(catalogue.get('phrase').beats, undefined);
  const row = catalogue.db.prepare("SELECT r.data FROM samples s JOIN sample_records r ON r.seq = s.seq WHERE s.id = 'loop'").get();
  assert.equal(JSON.parse(row.data).beats, undefined, 'beats are not duplicated in the record JSON');
  const loops = Object.fromEntries(catalogue.combinationCandidates('').map(sample => [sample.id, sample.loopBars]));
  assert.deepEqual(loops, { loop: 4, phrase: null, guess: null });
  assert.deepEqual(catalogue.sourceIds(''), ['loop', 'phrase', 'guess']);
  catalogue.update('phrase', sample => {
    sample.missing = true;
  });
  assert.deepEqual(catalogue.sourceIds(''), ['loop', 'guess']);
  catalogue.close();
});

test('a version 1 catalogue gains beat and loop columns and fills them once', async () => {
  const dir = await temporary();
  let { catalogue } = await openCatalogue(dir);
  catalogue.put({ id: 'loop', path: '/x/loop.wav', filename: 'loop.wav', name: 'loop', type: 'Bass', bpm: 90, bpmSource: 'analysis', duration: 32 / 3 });
  catalogue.close({ backup: false });
  // Recreate the version 1 layout: no loop_bars, no beats, no derived marker.
  const db = new DatabaseSync(path.join(dir, catalogueFiles.database));
  db.exec(`ALTER TABLE samples DROP COLUMN loop_bars;
    ALTER TABLE sample_records DROP COLUMN beats;
    DELETE FROM meta WHERE key = 'derivedColumns';
    PRAGMA user_version = 1;`);
  db.close();
  ({ catalogue } = await openCatalogue(dir));
  assert.equal(catalogue.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(catalogue.combinationCandidates('')[0].loopBars, 4);
  catalogue.update('loop', sample => {
    sample.beats = [0, 0.6667];
  });
  assert.deepEqual(catalogue.get('loop').beats, [0, 0.6667]);
  assert.equal(catalogue.refreshDerivedColumns(), 0, 'derived columns fill once');
  catalogue.close();
});
