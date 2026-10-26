import path from 'node:path';
import { parseKey, renderPlan } from '../../public/harmony.js';
import { readJson, sendJson, streamFile, httpError } from '../http.mjs';

const renderedName = /^[a-f0-9]{64}\.wav$/;

export function registerMediaRoutes(router, app) {
  const { catalogue, stretchCache } = app;

  // Renders a tempo- and key-matched copy through Rubber Band, cached on disk.
  router.post('/api/stretch', async ({ req, res }) => {
    const input = await readJson(req);
    const sample = catalogue.get(input.id);
    if (!sample) return sendJson(res, { error: 'Sample not found.' }, 404);
    if (!Number.isFinite(input.tempo) || input.tempo < 40 || input.tempo > 240) throw httpError('Session tempo must be 40–240 BPM.');
    const sync = input.sync ?? true;
    const key = input.key ?? null;
    if (typeof sync !== 'boolean' || (key !== null && !parseKey(key))) throw httpError('Choose valid tempo sync and session key settings.');
    const plan = renderPlan(sample, { tempo: input.tempo, sync, key });
    const file = await stretchCache.render(sample, input.tempo, { sync, key });
    return sendJson(res, {
      url: `/rendered/${path.basename(file)}`,
      sourceBpm: sample.bpm,
      targetBpm: sync && sample.bpm ? input.tempo : sample.bpm,
      ...plan
    });
  });

  router.add(['GET', 'HEAD'], '/rendered/:file', async ({ req, res, params }) => {
    if (!renderedName.test(params.file)) return sendJson(res, { error: 'Not found' }, 404);
    return streamFile(req, res, path.join(app.dataDir, 'stretch-cache', params.file));
  });
}
