import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogClient, filterSamples, pageOf, queryString, catalogueCounts, sourceSamples } from '../public/catalog-client.js';

const sample = (id, extra = {}) => ({ id, name: id, filename: `${id}.wav`, folder: 'Pack', type: 'Bass', bpm: 100, key: 'A min', size: 1000, duration: 8, mtime: 1, root: 'D:\\Samples', ...extra });
const library = [
  sample('kick', { type: 'Drums', bpm: 80 }),
  sample('bass', { bpm: 130, conflicts: { bpm: { resolved: false } } }),
  sample('pad', { type: 'Texture', bpm: null, root: 'E:\\Pads' }),
  sample('demo-1', { demo: true, root: undefined })
];

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

// A fake transport that records routes and answers from a table of handlers.
function transport(handlers) {
  const calls = [];
  const request = async (route, body) => {
    calls.push(body === undefined ? route : [route, body]);
    for (const [pattern, handler] of handlers) {
      if (route.startsWith(pattern)) return handler(route, body);
    }
    throw notFound();
  };
  return { request, calls };
}

test('filters, sorts and pages exactly like the original collection', () => {
  assert.deepEqual(sourceSamples(library, null).map(s => s.id), ['kick', 'bass', 'pad']);
  assert.deepEqual(sourceSamples([library[3]], null).map(s => s.id), ['demo-1']);
  assert.deepEqual(sourceSamples(library, 'demo').map(s => s.id), ['demo-1']);
  assert.deepEqual(filterSamples(library, { source: 'E:\\Pads' }).map(s => s.id), ['pad']);
  assert.deepEqual(filterSamples(library, { bpm: 'slow' }).map(s => s.id), ['kick']);
  assert.deepEqual(filterSamples(library, { bpm: 'fast' }).map(s => s.id), ['bass']);
  assert.deepEqual(filterSamples(library, { bpm: 'unknown' }).map(s => s.id), ['pad']);
  assert.deepEqual(filterSamples(library, { conflicts: true }).map(s => s.id), ['bass']);
  assert.deepEqual(filterSamples(library, { view: 'gems' }, ['pad']).map(s => s.id), ['pad']);
  assert.deepEqual(filterSamples(library, { q: 'drums KICK' }).map(s => s.id), ['kick']);
  assert.deepEqual(filterSamples(library, { sort: 'bpm' }).map(s => s.id), ['kick', 'bass', 'pad']);
  const page = pageOf(Array.from({ length: 120 }, (_, n) => n), 9, 50);
  assert.deepEqual({ ...page, items: page.items.length }, { total: 120, page: 2, pageSize: 50, items: 20 });
  assert.equal(queryString({ source: null, q: ' hat ', conflicts: true, page: 3 }), 'source=&view=all&q=hat&conflicts=1&sort=name&page=3&pageSize=50');
  assert.deepEqual(catalogueCounts(library).byRoot, { 'D:\\Samples': 2, 'E:\\Pads': 1 });
});

test('older servers that ignore ?lite=1 keep working with local filtering and combinations', async () => {
  const { request, calls } = transport([['library', () => ({ samples: structuredClone(library), favorites: ['kick'], folders: [], sets: [] })]]);
  const client = new CatalogClient({ request, random: () => 0 });
  const data = await client.loadLibrary();
  assert.equal(client.mode, 'legacy');
  assert.equal(data.samples, undefined);
  assert.deepEqual({ real: data.counts.real, demo: data.counts.demo, conflicts: data.counts.conflicts }, { real: 3, demo: 1, conflicts: 1 });
  const page = await client.querySamples({ view: 'gems', favorites: ['kick'] });
  assert.deepEqual(page.items.map(s => s.id), ['kick']);
  assert.equal(await client.countConflicts(null), 1);
  const { tracks } = await client.combination({ source: null, tracks: [{ type: 'Texture', id: null }], tempo: 100, sync: true, key: null, variety: .5 });
  assert.equal(tracks[0].id, 'pad');
  assert.deepEqual(await client.sourceSampleIds('demo'), ['demo-1']);
  assert.deepEqual(calls, ['library?lite=1']);
});

test('a lite library without the samples route falls back to the full library', async () => {
  const { request, calls } = transport([
    ['library?lite=1', () => ({ counts: { total: 4 }, favorites: [], folders: [], sets: [] })],
    ['library', () => ({ samples: structuredClone(library), favorites: [], folders: [], sets: [] })]
  ]);
  const client = new CatalogClient({ request });
  await client.loadLibrary();
  assert.equal(client.mode, 'legacy');
  assert.equal(client.samples.length, 4);
  assert.deepEqual(calls, ['library?lite=1', 'samples?source=&view=all&sort=name&page=0&pageSize=1', 'library']);
});

test('the query API keeps only a bounded cache and preserves decoded waveforms', async () => {
  const many = Array.from({ length: 200 }, (_, n) => sample(`s${n}`));
  const byId = new Map(many.map(s => [s.id, s]));
  const { request, calls } = transport([
    ['library?lite=1', () => ({ counts: { total: 200, real: 200, demo: 0, conflicts: 0, byRoot: {} }, favorites: [], folders: [], sets: [] })],
    ['samples/batch', (_, { ids }) => ({ items: ids.filter(id => byId.has(id)).map(id => ({ ...byId.get(id) })) })],
    ['samples/', route => {
      const found = byId.get(decodeURIComponent(route.slice(8)));
      if (!found) throw notFound();
      return { ...found };
    }],
    ['samples?', route => {
      const params = new URLSearchParams(route.slice(8));
      return pageOf(many.map(s => ({ ...s })), Number(params.get('page')), Number(params.get('pageSize')));
    }],
    ['combination', (_, body) => ({ tracks: body.tracks.map(track => ({ ...track, id: 's7' })) })]
  ]);
  const client = new CatalogClient({ request, cacheLimit: 60 });
  client.pin(() => ['s0']);
  const data = await client.loadLibrary();
  assert.equal(client.mode, 'remote');
  assert.equal(data.counts.total, 200);
  const first = await client.querySamples({ page: 0 });
  first.items[0].peaks = [1, 2, 3];
  assert.equal(first.total, 200);
  for (let page = 1; page < 4; page++) await client.querySamples({ page });
  assert.equal(client.samples.length, 0);
  assert.ok(client.cache.size <= 60, `cache holds ${client.cache.size}`);
  assert.ok(client.sampleById('s0'), 'pinned samples survive pruning');
  await client.hydrate(['s0', 'missing'], { refresh: true });
  assert.deepEqual(client.sampleById('s0').peaks, [1, 2, 3], 'waveform survives a refetch of the same file');
  assert.equal(await client.getSample('nope'), null);
  const { tracks } = await client.combination({ source: '', tracks: [{ type: 'Bass', id: null }], tempo: 100, sync: true, key: null, variety: 1, index: 0 });
  assert.equal(tracks[0].id, 's7');
  assert.ok(client.sampleById('s7'), 'combination results are hydrated');
  const combinationCall = calls.find(call => Array.isArray(call) && call[0] === 'combination');
  assert.deepEqual(Object.keys(combinationCall[1]).sort(), ['index', 'key', 'source', 'sync', 'tempo', 'tracks', 'variety']);
  assert.equal(calls.some(call => call === 'library'), false, 'never downloads the full library');
});

test('random picks avoid the current sample and batch hydration falls back to single lookups', async () => {
  const items = [sample('a'), sample('zz')];
  const { request } = transport([
    ['library?lite=1', () => ({ counts: { total: 2 }, favorites: [], folders: [], sets: [] })],
    ['samples?', route => {
      const params = new URLSearchParams(route.slice(8));
      return pageOf(items.map(s => ({ ...s })), Number(params.get('page')), Number(params.get('pageSize')));
    }],
    ['samples/zz', () => ({ ...items[1] })]
  ]);
  const client = new CatalogClient({ request, random: () => 0 });
  await client.loadLibrary();
  assert.equal((await client.randomSample({}, 'a')).id, 'zz');
  client.forget('zz');
  await client.hydrate(['zz']);
  assert.ok(client.sampleById('zz'));
});
