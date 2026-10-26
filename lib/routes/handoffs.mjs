import { spawn } from 'node:child_process';
import { maxStemBytes } from '../handoff.mjs';
import { readJson, readBytes, sendJson, streamFile, httpError } from '../http.mjs';

// The workspace's sample records, for the handoff manifest.
function workspaceSamples(catalogue, input) {
  const tracks = Array.isArray(input?.workspace?.tracks) ? input.workspace.tracks : [];
  const ids = tracks.map(track => track?.id).filter(id => typeof id === 'string');
  return catalogue.getMany(ids);
}

function openInExplorer(folder) {
  const opened = spawn('explorer.exe', [folder], { windowsHide: true, stdio: 'ignore' });
  opened.on('error', error => console.error('Could not open export folder:', error.message));
  opened.unref();
}

export function registerHandoffRoutes(router, app) {
  const { catalogue, handoffs } = app;

  router.post('/api/handoffs', async ({ req, res }) => {
    const input = await readJson(req);
    return sendJson(res, await handoffs.create(input, workspaceSamples(catalogue, input)), 201);
  });

  router.post('/api/handoffs/cleanup', async ({ req, res }) => {
    await readJson(req);
    return sendJson(res, await handoffs.pruneAbandoned());
  });

  router.get('/api/handoffs/:id', async ({ res, params }) => {
    return sendJson(res, { ...await handoffs.ready(params.id), folder: handoffs.batchPath(params.id) });
  });

  router.post('/api/handoffs/:id/finish', async ({ req, res, params }) => {
    await readJson(req);
    return sendJson(res, { ...await handoffs.finish(params.id), folder: handoffs.batchPath(params.id) });
  });

  router.post('/api/handoffs/:id/open', async ({ req, res, params }) => {
    await readJson(req);
    await handoffs.ready(params.id);
    if (process.platform !== 'win32') throw httpError('Use the desktop launcher to open the export folder on this platform.');
    openInExplorer(handoffs.batchPath(params.id));
    return sendJson(res, { ok: true });
  });

  router.add('PUT', '/api/handoffs/:id/stems/:index', async ({ req, res, params }) => {
    if (!/^[0-3]$/.test(params.index)) return sendJson(res, { error: 'Not found' }, 404);
    if (!req.headers['content-type']?.startsWith('audio/wav')) return sendJson(res, { error: 'WAV audio required.' }, 415);
    const bytes = await readBytes(req, maxStemBytes, 'Stem is too large.');
    return sendJson(res, await handoffs.upload(params.id, Number(params.index), bytes));
  });

  router.add(['GET', 'HEAD'], '/api/handoffs/:id/files/:name', async ({ req, res, params }) => {
    const file = await handoffs.file(params.id, params.name);
    return streamFile(req, res, file, {
      'Content-Disposition': `attachment; filename="${params.name}"`,
      'Content-Type': params.name.endsWith('.zip') ? 'application/zip' : 'audio/wav'
    });
  });
}
