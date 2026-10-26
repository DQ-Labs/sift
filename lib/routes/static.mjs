import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { sendJson, streamFile } from '../http.mjs';

// One plain file name directly inside public/: no folders, no dot files.
const publicName = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:html|js|css|svg)$/;

export function publicFile(publicDirectory, name) {
  if (!publicName.test(name)) return null;
  return path.join(publicDirectory, name);
}

// Serves the front end. Any .html/.js/.css/.svg file directly in public/ is
// available, so new front-end modules need no server change.
export function registerStaticRoutes(router, app) {
  const directory = path.join(app.here, 'public');

  async function serve(req, res, name) {
    const file = publicFile(directory, name);
    if (!file) return sendJson(res, { error: 'Not found' }, 404);
    let info;
    try {
      info = await lstat(file);
    } catch {
      return sendJson(res, { error: 'Not found' }, 404);
    }
    if (!info.isFile()) return sendJson(res, { error: 'Not found' }, 404);
    return streamFile(req, res, file);
  }

  router.add(['GET', 'HEAD'], '/', ({ req, res }) => serve(req, res, 'index.html'));
  router.add(['GET', 'HEAD'], '/:file', ({ req, res, params }) => serve(req, res, params.file));
}
