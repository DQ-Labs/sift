// Catalogue access for the front end.
//
// The browser never holds the whole library. It asks the server for a page
// at a time (GET /api/samples), for single samples and batches, and for
// combinations (POST /api/combination), and keeps only the samples it is
// showing or using in a bounded cache.

export const pageSize = 50;
const batchLimit = 500;

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

const isNotFound = error => error?.status === 404;

function chunks(items, size) {
  const groups = [];
  for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
  return groups;
}

export class CatalogClient {
  // request(route, body?) resolves to parsed JSON or rejects with `status`.
  constructor({ request, random = Math.random, cacheLimit = 3000 } = {}) {
    this.request = request;
    this.random = random;
    this.cacheLimit = cacheLimit;
    this.cache = new Map();
    this.pinned = () => [];
  }

  // Ids that must stay cached (workbench layers, selection, visible rows).
  pin(callback) {
    this.pinned = callback;
  }

  sampleById(id) {
    return id ? this.cache.get(id) : undefined;
  }

  remember(sample) {
    carryDecodedAudio(this.cache.get(sample.id), sample);
    // Re-inserting moves the sample to the young end of the cache.
    this.cache.delete(sample.id);
    this.cache.set(sample.id, sample);
    return sample;
  }

  forget(id) {
    this.cache.delete(id);
  }

  // Map iteration order is insertion order, so the oldest entries go first.
  prune() {
    if (this.cache.size <= this.cacheLimit) return;
    const keep = new Set(this.pinned());
    for (const id of [...this.cache.keys()]) {
      if (this.cache.size <= this.cacheLimit) break;
      if (!keep.has(id)) this.cache.delete(id);
    }
  }

  // Folders, gems, sets, workspace, activity and counts. No samples.
  loadLibrary() {
    return this.request('library');
  }

  async querySamples(query) {
    const result = await this.request(`samples?${queryString(query)}`);
    result.items = result.items.map(sample => this.remember(sample));
    this.prune();
    return result;
  }

  // Returns the sample, or null when the catalogue no longer has it.
  async getSample(id) {
    if (!id) return null;
    try {
      return this.remember(await this.request(`samples/${encodeURIComponent(id)}`));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.forget(id);
      return null;
    }
  }

  // Makes sure these ids are cached. `refresh` refetches ones already cached,
  // for example after analysis changed their tempo or key.
  async hydrate(ids, { refresh = false } = {}) {
    const wanted = [...new Set(ids.filter(Boolean))].filter(id => refresh || !this.cache.has(id));
    for (const group of chunks(wanted, batchLimit)) {
      const { items } = await this.request('samples/batch', { ids: group });
      for (const sample of items) this.remember(sample);
      // Ids the server did not return are gone from the catalogue.
      const returned = new Set(items.map(sample => sample.id));
      for (const id of group) {
        if (!returned.has(id)) this.forget(id);
      }
    }
    this.prune();
  }

  async combination({ source, tracks, tempo, sync, key, variety, index = null }) {
    const body = { source: source || '', tracks, tempo, sync, key, variety };
    if (index !== null) body.index = index;
    const result = await this.request('combination', body);
    await this.hydrate(result.tracks.map(track => track.id));
    return result;
  }

  // One random matching sample, avoiding `excludeId` when there is a choice.
  async randomSample(query, excludeId) {
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
    const { total } = await this.querySamples({ source, conflicts: true, page: 0, pageSize: 1 });
    return total;
  }

  // Applies a server-confirmed sample update (metadata corrections).
  update(sample) {
    return this.remember(sample);
  }
}
