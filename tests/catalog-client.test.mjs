import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogClient, queryString } from '../public/catalog-client.js';

const sample = (id, extra = {}) => ({ id, name: id, filename: `${id}.wav`, folder: 'Pack', type: 'Bass', bpm: 100, key: 'A min', size: 1000, duration: 8, mtime: 1, root: 'D:\\Samples', ...extra });

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

// Answers GET samples?… with one page of `items`, as the server would.
function pageHandler(items) {
  return route => {
    const params = new URLSearchParams(route.slice('samples?'.length));
    const size = Number(params.get('pageSize'));
    const page = Number(params.get('page'));
    return { total: items.length, page, pageSize: size, items: items.slice(page * size, (page + 1) * size).map(item => ({ ...item })) };
  };
}

const libraryHandler = counts => () => ({ counts, favorites: [], folders: [], sets: [] });

test('queries are sent as the samples route expects them', () => {
  assert.equal(queryString({ source: null, q: ' hat ', conflicts: true, page: 3 }), 'source=&view=all&q=hat&conflicts=1&sort=name&page=3&pageSize=50');
  assert.equal(queryString({ source: 'D:\\Samples', view: 'gems', type: 'Drums', bpm: 'slow', sort: 'bpm', pageSize: 20 }), 'source=D%3A%5CSamples&view=gems&type=Drums&bpm=slow&sort=bpm&page=0&pageSize=20');
});

test('the client keeps only a bounded cache and preserves decoded waveforms', async () => {
  const many = Array.from({ length: 200 }, (_, n) => sample(`s${n}`));
  const byId = new Map(many.map(s => [s.id, s]));
  const { request, calls } = transport([
    ['library', libraryHandler({ total: 200, real: 200, demo: 0, conflicts: 0, byRoot: {} })],
    ['samples/batch', (_, { ids }) => ({ items: ids.filter(id => byId.has(id)).map(id => ({ ...byId.get(id) })) })],
    ['samples/', route => {
      const found = byId.get(decodeURIComponent(route.slice('samples/'.length)));
      if (!found) throw notFound();
      return { ...found };
    }],
    ['samples?', pageHandler(many)],
    ['combination', (_, body) => ({ tracks: body.tracks.map(track => ({ ...track, id: 's7' })) })]
  ]);
  const client = new CatalogClient({ request, cacheLimit: 60 });
  client.pin(() => ['s0']);
  const data = await client.loadLibrary();
  assert.equal(data.counts.total, 200);
  assert.equal(data.samples, undefined);
  const first = await client.querySamples({ page: 0 });
  first.items[0].peaks = [1, 2, 3];
  assert.equal(first.total, 200);
  for (let page = 1; page < 4; page++) await client.querySamples({ page });
  assert.ok(client.cache.size <= 60, `cache holds ${client.cache.size}`);
  assert.ok(client.sampleById('s0'), 'pinned samples survive pruning');
  await client.hydrate(['s0', 'missing'], { refresh: true });
  assert.deepEqual(client.sampleById('s0').peaks, [1, 2, 3], 'waveform survives a refetch of the same file');
  assert.equal(client.sampleById('missing'), undefined);
  assert.equal(await client.getSample('nope'), null);
  const { tracks } = await client.combination({ source: '', tracks: [{ type: 'Bass', id: null }], tempo: 100, sync: true, key: null, variety: 1, index: 0 });
  assert.equal(tracks[0].id, 's7');
  assert.ok(client.sampleById('s7'), 'combination results are hydrated');
  const combinationCall = calls.find(call => Array.isArray(call) && call[0] === 'combination');
  assert.deepEqual(Object.keys(combinationCall[1]).sort(), ['index', 'key', 'source', 'sync', 'tempo', 'tracks', 'variety']);
  assert.equal(calls[0], 'library');
});

test('samples that have left the catalogue are dropped from the cache', async () => {
  const { request } = transport([
    ['samples/batch', () => ({ items: [sample('kept')] })],
    ['samples?', pageHandler([sample('kept'), sample('gone')])]
  ]);
  const client = new CatalogClient({ request });
  await client.querySamples({});
  assert.ok(client.sampleById('gone'));
  await client.hydrate(['kept', 'gone'], { refresh: true });
  assert.ok(client.sampleById('kept'));
  assert.equal(client.sampleById('gone'), undefined);
  assert.equal(await client.getSample('gone'), null);
});

test('random picks avoid the current sample, and conflicts are counted without loading them', async () => {
  const items = [sample('a'), sample('zz')];
  const { request, calls } = transport([['samples?', pageHandler(items)]]);
  const client = new CatalogClient({ request, random: () => 0 });
  assert.equal((await client.randomSample({}, 'a')).id, 'zz');
  assert.equal((await client.randomSample({}, 'zz')).id, 'a');
  calls.length = 0;
  assert.equal(await client.countConflicts('D:\\Samples'), 2);
  assert.deepEqual(calls, ['samples?source=D%3A%5CSamples&view=all&conflicts=1&sort=name&page=0&pageSize=1']);
});

test('a failing request is reported, never papered over', async () => {
  const failure = Object.assign(new Error('Sift hit an unexpected error.'), { status: 500 });
  const { request } = transport([['samples', () => { throw failure; }], ['combination', () => { throw notFound(); }]]);
  const client = new CatalogClient({ request });
  await assert.rejects(() => client.querySamples({}), failure);
  await assert.rejects(() => client.hydrate(['a']), failure);
  await assert.rejects(() => client.getSample('a'), failure);
  await assert.rejects(() => client.combination({ source: '', tracks: [] }), { status: 404 });
});
