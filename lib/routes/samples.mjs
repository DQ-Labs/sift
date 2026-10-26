import { chooseCombination } from '../../public/harmony.js';
import { normalizeWorkspace, trackTypes } from '../../public/workspace.js';
import { effectiveMetadata } from '../metadata.mjs';
import { bpmRanges, sortOrders } from '../catalogue.mjs';
import { readJson, sendJson, streamFile, httpError } from '../http.mjs';

export const maxPageSize = 500;
export const maxBatchIds = 500;

function choice(params, name, allowed, fallback) {
  const value = params.get(name) || fallback;
  if (!allowed.includes(value)) throw httpError(`${name} must be one of: ${allowed.filter(Boolean).join(', ')}.`);
  return value;
}

function integer(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

// Query string for GET /api/samples, validated.
export function sampleQuery(params) {
  const q = params.get('q') || '';
  if (q.length > 500) throw httpError('Search text is too long.');
  const conflicts = params.get('conflicts') || '0';
  if (!['0', '1', 'true', 'false'].includes(conflicts)) throw httpError('conflicts must be 1 or 0.');
  return {
    source: params.get('source') || '',
    view: choice(params, 'view', ['all', 'gems'], 'all'),
    q,
    type: choice(params, 'type', ['', ...trackTypes], ''),
    bpm: choice(params, 'bpm', ['', ...Object.keys(bpmRanges)], ''),
    conflicts: conflicts === '1' || conflicts === 'true',
    sort: choice(params, 'sort', Object.keys(sortOrders), 'name'),
    page: integer(params, 'page', 0, 0, 10_000_000),
    pageSize: integer(params, 'pageSize', 50, 1, maxPageSize)
  };
}

const keyPattern = /^[A-G][#b]? (min|maj)$/;

function applyMetadataInput(sample, input) {
  if (input.reset) {
    sample.overrides = {};
    return;
  }
  if (Object.hasOwn(input, 'bpm') && input.bpm !== null && (!Number.isFinite(input.bpm) || input.bpm < 40 || input.bpm > 240)) {
    throw httpError('BPM must be 40–240, or blank for unknown.');
  }
  if (Object.hasOwn(input, 'key') && input.key !== null && (typeof input.key !== 'string' || !keyPattern.test(input.key))) {
    throw httpError('Choose a valid musical key.');
  }
  const overrides = { ...sample.overrides };
  for (const field of ['bpm', 'key']) if (Object.hasOwn(input, field)) overrides[field] = input[field];
  sample.overrides = overrides;
}

function combinationRequest(input) {
  const source = input.source ?? '';
  if (typeof source !== 'string') throw httpError('Choose a valid source.');
  const index = input.index ?? null;
  if (index !== null && !(Number.isInteger(index) && index >= 0 && index <= 3)) throw httpError('Choose a layer from 0 to 3 to reroll.');
  const variety = input.variety ?? null;
  if (variety !== null && !Number.isFinite(variety)) throw httpError('Variety must be a number.');
  const workspace = normalizeWorkspace({ tracks: input.tracks, tempo: input.tempo, sync: input.sync ?? true, key: input.key ?? null }, { strict: true });
  const settings = { tempo: workspace.tempo, sync: workspace.sync, key: workspace.key };
  if (variety !== null) settings.variety = variety;
  return { source, index, tracks: workspace.tracks, settings };
}

export function registerSampleRoutes(router, app) {
  const { catalogue } = app;

  router.get('/api/samples', ({ res, url }) => sendJson(res, catalogue.query(sampleQuery(url.searchParams))));

  router.get('/api/samples/:id', ({ res, params }) => {
    const sample = catalogue.get(params.id);
    if (!sample) return sendJson(res, { error: 'Sample not found.' }, 404);
    return sendJson(res, sample);
  });

  router.post('/api/samples/batch', async ({ req, res }) => {
    const input = await readJson(req);
    if (!Array.isArray(input?.ids) || input.ids.length > maxBatchIds || input.ids.some(id => typeof id !== 'string')) {
      throw httpError(`ids must be an array of up to ${maxBatchIds} sample IDs.`);
    }
    return sendJson(res, { items: catalogue.getMany(input.ids) });
  });

  router.post('/api/metadata', async ({ req, res }) => {
    const input = await readJson(req);
    const updated = catalogue.update(input?.id, sample => {
      applyMetadataInput(sample, input);
      Object.assign(sample, effectiveMetadata(sample));
    });
    if (!updated) return sendJson(res, { error: 'Sample not found.' }, 404);
    return sendJson(res, updated);
  });

  // Runs the workbench's chooseCombination() over the source's playable samples.
  router.post('/api/combination', async ({ req, res }) => {
    const { source, index, tracks, settings } = combinationRequest(await readJson(req));
    const candidates = catalogue.combinationCandidates(source);
    return sendJson(res, { tracks: chooseCombination(tracks, candidates, settings, index) });
  });

  router.add(['GET', 'HEAD'], '/audio/:id', async ({ req, res, params }) => {
    const filepath = catalogue.pathOf(params.id);
    if (!filepath) return sendJson(res, { error: 'Sample not found' }, 404);
    try {
      return await streamFile(req, res, filepath);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
        return sendJson(res, { error: 'This sample is missing. Reconnect its drive or rescan its folder.' }, 404);
      }
      throw error;
    }
  });
}
