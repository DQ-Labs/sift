// Browser-side stand-in for the W2 query API (SIFT_PLAN.md "API contract"),
// installed with Playwright routing on top of a real Sift server. It serves
// the demo collection plus synthetic samples that alias demo audio, so the
// front end can be exercised against a large catalogue before W2 lands.
import { chooseCombination } from '../public/harmony.js';
import { catalogueCounts, filterSamples, pageOf, sourceSamples } from '../public/catalog-client.js';

export async function installContractMock(page, base, { synthetic = 0, version = null } = {}) {
  const full = await (await fetch(`${base}/api/library`)).json();
  const alias = new Map();
  const samples = [...full.samples];
  const root = '/synthetic/pack';
  for (let n = 0; n < synthetic; n++) {
    const source = full.samples[n % full.samples.length];
    const id = `syn-${n}`;
    alias.set(id, source.id);
    samples.push({ ...source, id, demo: false, root, folder: 'Synthetic pack', name: `Pack ${String(n).padStart(5, '0')} ${source.name}`, filename: `pack-${n}.wav`, path: undefined });
  }
  const byId = new Map(samples.map(sample => [sample.id, sample]));
  const folders = synthetic ? [{ path: root, name: 'Synthetic pack' }] : [];
  const stats = { fullLibrary: 0, pages: 0, batches: 0, combinations: 0, largestResponse: 0 };
  let favorites = [];
  const realId = id => alias.get(id) || id;

  const json = (route, body, status = 200) => {
    const text = JSON.stringify(body);
    stats.largestResponse = Math.max(stats.largestResponse, text.length);
    return route.fulfill({ status, contentType: 'application/json', body: text });
  };
  const withRealIds = (route, rewrite) => route.continue({ postData: JSON.stringify(rewrite(route.request().postDataJSON())) });

  await page.route(url => url.href.startsWith(base), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === '/api/library' && method === 'GET') {
      const current = await (await fetch(`${base}/api/library`)).json();
      if (url.searchParams.get('lite') !== '1') {
        stats.fullLibrary++;
        return json(route, { ...current, samples, folders: [...current.folders, ...folders], favorites });
      }
      const { samples: _omitted, ...rest } = current;
      return json(route, { ...rest, folders: [...current.folders, ...folders], favorites, counts: catalogueCounts(samples) });
    }
    if (path === '/api/samples' && method === 'GET') {
      stats.pages++;
      const query = Object.fromEntries(url.searchParams);
      const list = filterSamples(samples, { ...query, conflicts: query.conflicts === '1' }, favorites);
      return json(route, pageOf(list, Number(query.page), Math.min(500, Number(query.pageSize) || 50)));
    }
    if (path === '/api/samples/batch' && method === 'POST') {
      stats.batches++;
      const { ids } = request.postDataJSON();
      return json(route, { items: ids.map(id => byId.get(id)).filter(Boolean) });
    }
    if (path.startsWith('/api/samples/') && method === 'GET') {
      const sample = byId.get(decodeURIComponent(path.slice('/api/samples/'.length)));
      return sample ? json(route, sample) : json(route, { error: 'Sample not found' }, 404);
    }
    if (path === '/api/combination' && method === 'POST') {
      stats.combinations++;
      const { source, tracks, tempo, sync, key, variety, index = null } = request.postDataJSON();
      return json(route, { tracks: chooseCombination(tracks, sourceSamples(samples, source), { tempo, sync, key, variety }, index) });
    }
    if (path === '/api/favorites' && method === 'POST') {
      favorites = request.postDataJSON().ids.filter(id => byId.has(id));
      return json(route, { ok: true });
    }
    if (path === '/api/capabilities' && version) {
      const current = await (await fetch(`${base}/api/capabilities`)).json();
      return json(route, { ...current, version, ffmpeg: { found: true, rubberband: true, version: 'test build' } });
    }
    if (path === '/api/diagnostics' && version) {
      return route.fulfill({ status: 200, contentType: 'application/zip', headers: { 'Content-Disposition': 'attachment; filename="sift-diagnostics-test.zip"' }, body: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary') });
    }
    // Synthetic samples play their demo originals.
    if (path.startsWith('/audio/syn-')) return route.continue({ url: `${base}/audio/${realId(path.slice('/audio/'.length))}` });
    if (path === '/api/stretch' && method === 'POST') return withRealIds(route, body => ({ ...body, id: realId(body.id) }));
    if (path === '/api/handoffs' && method === 'POST') {
      return withRealIds(route, body => ({ ...body, workspace: { ...body.workspace, tracks: body.workspace.tracks.map(track => ({ ...track, id: track.id && realId(track.id) })) } }));
    }
    return route.continue();
  });
  return stats;
}
