// A large catalogue for the browser tests, installed with Playwright routing
// on top of a real Sift server. It serves the demo collection plus synthetic
// samples that alias demo audio, and answers the catalogue routes itself with
// the same filtering rules as the server.
import { chooseCombination } from '../public/harmony.js';

const pageSize = 50;
const hasConflict = sample => Object.values(sample.conflicts || {}).some(conflict => !conflict.resolved);

// `source` is a folder root, 'demo', or empty for every real folder (or the
// demo collection when no folder has been added yet).
function sourceSamples(samples, source) {
  if (source === 'demo') return samples.filter(sample => sample.demo);
  if (source) return samples.filter(sample => sample.root === source);
  const real = samples.filter(sample => !sample.demo);
  return real.length ? real : samples;
}

function matchesTempo(sample, bpm) {
  if (!bpm) return true;
  if (bpm === 'unknown') return !sample.bpm;
  if (bpm === 'slow') return sample.bpm && sample.bpm < 90;
  if (bpm === 'mid') return sample.bpm >= 90 && sample.bpm <= 120;
  return sample.bpm > 120;
}

function searchText(sample) {
  return `${sample.name} ${sample.filename} ${sample.folder} ${sample.typeHint || ''} ${sample.key || ''} ${sample.type}`.toLowerCase();
}

const sorters = {
  bpm: (a, b) => (a.bpm || 999) - (b.bpm || 999),
  duration: (a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity),
  name: (a, b) => a.name.localeCompare(b.name)
};

// Same semantics as GET /api/samples (and filteredSamples() in the old app.js).
function filterSamples(samples, query = {}, favorites = []) {
  const words = (query.q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const gems = new Set(favorites);
  const matches = sample => {
    if (query.conflicts && !hasConflict(sample)) return false;
    if (query.view === 'gems' && !gems.has(sample.id)) return false;
    if (query.type && query.type !== sample.type) return false;
    if (!matchesTempo(sample, query.bpm)) return false;
    const text = searchText(sample);
    return words.every(word => text.includes(word));
  };
  return sourceSamples(samples, query.source).filter(matches).sort(sorters[query.sort] || sorters.name);
}

function pageOf(list, page = 0, size = pageSize) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  return { total: list.length, page: current, pageSize: size, items: list.slice(current * size, (current + 1) * size) };
}

function catalogueCounts(samples) {
  const counts = { total: samples.length, real: 0, demo: 0, conflicts: 0, byRoot: {}, analyzed: 0, analysisErrors: 0 };
  for (const sample of samples) {
    if (sample.demo) counts.demo++;
    else counts.real++;
    if (hasConflict(sample)) counts.conflicts++;
    if (sample.root) counts.byRoot[sample.root] = (counts.byRoot[sample.root] || 0) + 1;
    if (sample.analysis?.status === 'done') counts.analyzed++;
    if (sample.analysis?.status === 'error') counts.analysisErrors++;
  }
  return counts;
}


export async function installContractMock(page, base, { synthetic = 0, version = null } = {}) {
  const demo = (await (await fetch(`${base}/api/samples?source=demo&pageSize=500`)).json()).items;
  const alias = new Map();
  const samples = [...demo];
  const root = '/synthetic/pack';
  for (let n = 0; n < synthetic; n++) {
    const source = demo[n % demo.length];
    const id = `syn-${n}`;
    alias.set(id, source.id);
    samples.push({ ...source, id, demo: false, root, folder: 'Synthetic pack', name: `Pack ${String(n).padStart(5, '0')} ${source.name}`, filename: `pack-${n}.wav`, path: undefined });
  }
  const byId = new Map(samples.map(sample => [sample.id, sample]));
  const folders = synthetic ? [{ path: root, name: 'Synthetic pack' }] : [];
  const stats = { pages: 0, batches: 0, combinations: 0, largestResponse: 0 };
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
      return json(route, { ...current, folders: [...current.folders, ...folders], favorites, counts: catalogueCounts(samples) });
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
