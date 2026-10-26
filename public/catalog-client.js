// Catalogue access for the front end.
//
// With the query API (GET /api/library?lite=1, /api/samples, /api/samples/:id,
// POST /api/samples/batch, POST /api/combination) the browser only keeps the
// samples it is showing or using, in a bounded cache. Older servers ignore
// ?lite=1 and send every sample; the client then keeps that array and filters
// and combines locally, exactly as the original single-file app did.
import { chooseCombination } from './harmony.js';

export const pageSize = 50;
const batchLimit = 500;
const reanalyzeLimit = 50000;

export const hasConflict = sample => Object.values(sample.conflicts || {}).some(conflict => !conflict.resolved);

// `source` is a folder root, 'demo', or empty for every real folder (or the
// demo collection when no folder has been added yet).
export function sourceSamples(samples, source) {
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
export function filterSamples(samples, query = {}, favorites = []) {
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

export function pageOf(list, page = 0, size = pageSize) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const current = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  return { total: list.length, page: current, pageSize: size, items: list.slice(current * size, (current + 1) * size) };
}

export function catalogueCounts(samples) {
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

export function queryString(query) {
  const params = new URLSearchParams();
  params.set('source', query.source || '');
  params.set('view', query.view === 'gems' ? 'gems' : 'all');
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.type) params.set('type', query.type);
  if (query.bpm) params.set('bpm', query.bpm);
  if (query.conflicts) params.set('conflicts', '1');
  params.set('sort', query.sort || 'name');
  params.set('page', String(query.page || 0));
  params.set('pageSize', String(query.pageSize || pageSize));
  return params.toString();
}

// Waveforms and decoded durations are measured in the browser. Keep them when
// the server sends a fresh copy of an unchanged file.
function carryDecodedAudio(previous, next) {
  if (!previous || previous.mtime !== next.mtime) return;
  if (previous.peaks && !next.peaks) next.peaks = previous.peaks;
  for (const field of ['duration', 'rate', 'channels']) {
    if (next[field] == null && previous[field] != null) next[field] = previous[field];
  }
}

const isMissingRoute = error => error?.status === 404;

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, n) => items.slice(n * size, (n + 1) * size));

export class CatalogClient {
  // request(route, body?) resolves to parsed JSON or rejects with `status`.
  constructor({ request, random = Math.random, cacheLimit = 3000 } = {}) {
    this.request = request;
    this.random = random;
    this.cacheLimit = cacheLimit;
    this.mode = null; // 'remote' (query API) or 'legacy' (full array)
    this.samples = []; // Legacy mode only.
    this.cache = new Map();
    this.pinned = () => [];
  }

  get remote() {
    return this.mode === 'remote';
  }

  // Ids that must stay cached (workbench layers, selection, visible rows).
  pin(callback) {
    this.pinned = callback;
  }

  sampleById(id) {
    return id ? this.cache.get(id) : undefined;
  }

  remember(sample) {
    const previous = this.cache.get(sample.id);
    carryDecodedAudio(previous, sample);
    this.cache.delete(sample.id);
    this.cache.set(sample.id, sample);
    return sample;
  }

  forget(id) {
    this.cache.delete(id);
  }

  // Map iteration order is insertion order, so the oldest entries go first.
  prune() {
    if (!this.remote || this.cache.size <= this.cacheLimit) return;
    const keep = new Set(this.pinned());
    for (const id of [...this.cache.keys()]) {
      if (this.cache.size <= this.cacheLimit) break;
      if (!keep.has(id)) this.cache.delete(id);
    }
  }

  async loadLibrary() {
    if (this.mode !== 'legacy') {
      let lite = null;
      try {
        lite = await this.request('library?lite=1');
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
      }
      // Servers without the query API ignore ?lite=1 and include samples.
      if (lite && Array.isArray(lite.samples)) return this.adoptLegacy(lite);
      if (lite?.counts) {
        if (this.mode === null) await this.detectQueryApi();
        if (this.remote) return lite;
      }
    }
    return this.adoptLegacy(await this.request('library'));
  }

  async detectQueryApi() {
    try {
      await this.request(`samples?${queryString({ pageSize: 1 })}`);
      this.mode = 'remote';
    } catch (error) {
      if (!isMissingRoute(error)) throw error;
      this.mode = 'legacy';
    }
  }

  adoptLegacy(data) {
    const { samples = [], ...rest } = data;
    this.mode = 'legacy';
    const fresh = new Map();
    for (const sample of samples) {
      carryDecodedAudio(this.cache.get(sample.id), sample);
      fresh.set(sample.id, sample);
    }
    this.cache = fresh;
    this.samples = samples;
    return { ...rest, counts: catalogueCounts(samples) };
  }

  // A route that disappears mid-session (or a half-finished server) falls back
  // to the full library rather than leaving the UI broken.
  async switchToLegacy() {
    this.mode = 'legacy';
    await this.loadLibrary();
  }

  async querySamples(query) {
    if (this.remote) {
      try {
        const result = await this.request(`samples?${queryString(query)}`);
        result.items = result.items.map(sample => this.remember(sample));
        this.prune();
        return result;
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
        await this.switchToLegacy();
      }
    }
    const list = filterSamples(this.samples, query, query.favorites);
    return pageOf(list, query.page, query.pageSize || pageSize);
  }

  // Returns the sample, or null when the catalogue no longer has it.
  async getSample(id) {
    if (!id) return null;
    if (!this.remote) return this.sampleById(id) || null;
    try {
      return this.remember(await this.request(`samples/${encodeURIComponent(id)}`));
    } catch (error) {
      if (!isMissingRoute(error)) throw error;
      this.forget(id);
      return null;
    }
  }

  // Makes sure these ids are cached. `refresh` refetches ones already cached,
  // for example after analysis changed their tempo or key.
  async hydrate(ids, { refresh = false } = {}) {
    if (!this.remote) return;
    const wanted = [...new Set(ids.filter(Boolean))].filter(id => refresh || !this.cache.has(id));
    for (const group of chunks(wanted, batchLimit)) {
      try {
        const { items } = await this.request('samples/batch', { ids: group });
        for (const sample of items) this.remember(sample);
        // Ids the server did not return are gone from the catalogue.
        const returned = new Set(items.map(sample => sample.id));
        for (const id of group) if (!returned.has(id)) this.forget(id);
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
        await Promise.all(group.map(id => this.getSample(id)));
      }
    }
    this.prune();
  }

  async combination({ source, tracks, tempo, sync, key, variety, index = null }) {
    if (this.remote) {
      try {
        const body = { source: source || '', tracks, tempo, sync, key, variety };
        if (index !== null) body.index = index;
        const result = await this.request('combination', body);
        await this.hydrate(result.tracks.map(track => track.id));
        return result;
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
        await this.switchToLegacy();
      }
    }
    const pool = sourceSamples(this.samples, source);
    return { tracks: chooseCombination(tracks, pool, { tempo, sync, key, variety }, index, this.random) };
  }

  // One random matching sample, avoiding `excludeId` when there is a choice.
  async randomSample(query, excludeId) {
    if (!this.remote) {
      const list = filterSamples(this.samples, query, query.favorites);
      const choices = list.filter(sample => sample.id !== excludeId);
      const pool = choices.length ? choices : list;
      return pool[Math.floor(this.random() * pool.length)] || null;
    }
    const { total } = await this.querySamples({ ...query, page: 0, pageSize: 1 });
    if (!total) return null;
    let position = Math.floor(this.random() * total);
    let { items } = await this.querySamples({ ...query, page: position, pageSize: 1 });
    if (items[0]?.id === excludeId && total > 1) {
      position = (position + 1) % total;
      ({ items } = await this.querySamples({ ...query, page: position, pageSize: 1 }));
    }
    return items[0] || null;
  }

  async countConflicts(source) {
    if (!this.remote) return sourceSamples(this.samples, source).filter(hasConflict).length;
    const { total } = await this.querySamples({ source, conflicts: true, page: 0, pageSize: 1 });
    return total;
  }

  // Ids for "Analyze this source". The analysis endpoint accepts up to 50,000.
  async sourceSampleIds(source) {
    if (!this.remote) return sourceSamples(this.samples, source).slice(0, reanalyzeLimit).map(sample => sample.id);
    const ids = [];
    for (let page = 0; ids.length < reanalyzeLimit; page++) {
      const result = await this.request(`samples?${queryString({ source, page, pageSize: batchLimit })}`);
      ids.push(...result.items.map(sample => sample.id));
      if (!result.items.length || ids.length >= result.total) break;
    }
    return ids.slice(0, reanalyzeLimit);
  }

  // Applies a server-confirmed sample update (metadata corrections).
  update(sample) {
    if (!this.remote) {
      const index = this.samples.findIndex(existing => existing.id === sample.id);
      if (index >= 0) this.samples[index] = sample;
    }
    return this.remember(sample);
  }
}
