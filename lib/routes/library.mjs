import { randomUUID } from 'node:crypto';
import { normalizeWorkspace } from '../../public/workspace.js';
import { readJson, sendJson, httpError } from '../http.mjs';

const maxSetName = 100;
const setNotFound = () => httpError('That set no longer exists.', 404);

// The same comparison the workbench uses before it overwrites a set by name.
function sameSetName(a, b) {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

function activity(app) {
  return { scan: app.scanner.status, analysis: app.analysis.status() };
}

export function registerLibraryRoutes(router, app) {
  const { catalogue } = app;

  // Everything about the library except its samples, which the collection
  // pages through /api/samples.
  router.get('/api/library', ({ res }) => {
    return sendJson(res, {
      folders: catalogue.folders,
      favorites: catalogue.favorites,
      sets: catalogue.sets,
      workspace: catalogue.workspace,
      recovery: app.recovery,
      ...activity(app),
      counts: catalogue.counts()
    });
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
    if (input.replaces !== undefined && typeof input.replaces !== 'string') throw httpError('replaces must be a set id.');
    const set = {
      ...normalizeWorkspace(input, { strict: true }),
      name: input.name.trim(),
      id: randomUUID(),
      created: new Date().toISOString()
    };
    const replaced = catalogue.addSet(set, input.replaces);
    return sendJson(res, replaced ? { ...set, replaced: input.replaces } : set);
  });

  router.post('/api/sets/:id/rename', async ({ req, res, params }) => {
    const input = await readJson(req);
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > maxSetName) throw httpError(`A set name needs 1 to ${maxSetName} characters.`);
    // Saving a set under an existing name replaces it, so names stay distinct.
    const clash = catalogue.sets.find(set => set.id !== params.id && sameSetName(set.name, name));
    if (clash) throw httpError('Another set already has that name.', 409);
    const set = catalogue.renameSet(params.id, name);
    if (!set) throw setNotFound();
    return sendJson(res, set);
  });

  router.post('/api/sets/:id/delete', async ({ req, res, params }) => {
    await readJson(req);
    if (!catalogue.removeSet(params.id)) throw setNotFound();
    return sendJson(res, { ok: true });
  });
}
