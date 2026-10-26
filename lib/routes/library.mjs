import { randomUUID } from 'node:crypto';
import { normalizeWorkspace } from '../../public/workspace.js';
import { readJson, sendJson, httpError } from '../http.mjs';

function activity(app) {
  return { scan: app.scanner.status, analysis: app.analysis.status() };
}

export function registerLibraryRoutes(router, app) {
  const { catalogue } = app;

  // `lite=1` omits the sample array; the collection pages through /api/samples.
  router.get('/api/library', ({ res, url }) => {
    if (url.searchParams.get('lite') === '1') {
      return sendJson(res, {
        folders: catalogue.folders,
        favorites: catalogue.favorites,
        sets: catalogue.sets,
        workspace: catalogue.workspace,
        recovery: app.recovery,
        ...activity(app),
        counts: catalogue.counts()
      });
    }
    return sendJson(res, { ...catalogue.snapshot(), recovery: app.recovery, ...activity(app) });
  });

  router.get('/api/library/status', ({ res }) => sendJson(res, activity(app)));

  router.post('/api/library/cleanup', async ({ req, res }) => {
    await readJson(req);
    return sendJson(res, await app.scanner.cleanup());
  });

  router.post('/api/favorites', async ({ req, res }) => {
    const input = await readJson(req);
    if (!Array.isArray(input.ids)) throw httpError('ids must be an array');
    catalogue.setFavorites(input.ids);
    return sendJson(res, { ok: true });
  });

  router.post('/api/workspace', async ({ req, res }) => {
    const workspace = normalizeWorkspace(await readJson(req), { strict: true });
    catalogue.setWorkspace(workspace);
    return sendJson(res, { ok: true });
  });

  router.post('/api/sets', async ({ req, res }) => {
    const input = await readJson(req);
    if (typeof input?.name !== 'string' || !input.name.trim()) throw httpError('A set needs a name and tracks.');
    const set = {
      ...normalizeWorkspace(input, { strict: true }),
      name: input.name.trim(),
      id: randomUUID(),
      created: new Date().toISOString()
    };
    return sendJson(res, catalogue.addSet(set));
  });
}
