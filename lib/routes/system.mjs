import { existsSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { appInfo } from '../system.mjs';
import { buildDiagnostics } from '../diagnostics.mjs';
import { readJson, sendJson, sendBytes, httpError } from '../http.mjs';

export function desktopExecutable(app) {
  return process.env.SIFT_DESKTOP_EXE || path.join(app.here, 'node_modules', 'electron', 'dist', 'electron.exe');
}

export async function capabilities(app) {
  const executable = desktopExecutable(app);
  return {
    handoff: 1,
    version: appInfo.version,
    dataDirectory: path.resolve(app.dataDir),
    openFolder: process.platform === 'win32',
    desktopAvailable: process.platform === 'win32' && existsSync(executable),
    ffmpeg: await app.mediaTools.summary()
  };
}

function launchDesktop(app) {
  const executable = desktopExecutable(app);
  const out = openSync(path.join(app.dataDir, 'desktop.log'), 'a');
  const err = openSync(path.join(app.dataDir, 'desktop-error.log'), 'a');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const custom = !!process.env.SIFT_DESKTOP_EXE;
  const child = spawn(executable, custom ? [] : [path.join(app.here, 'desktop', 'main.cjs')], {
    cwd: custom ? app.dataDir : app.here,
    env,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', out, err]
  });
  closeSync(out);
  closeSync(err);
  child.on('error', error => console.error('Desktop launch failed:', error.message));
  child.unref();
}

function diagnosticsName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `sift-diagnostics-${stamp}.zip`;
}

export function registerSystemRoutes(router, app) {
  router.get('/api/capabilities', async ({ res }) => sendJson(res, await capabilities(app)));

  router.post('/api/desktop/open', async ({ req, res }) => {
    await readJson(req);
    if (process.platform !== 'win32' || !existsSync(desktopExecutable(app))) throw httpError('Install the desktop runtime with npm ci first.');
    launchDesktop(app);
    return sendJson(res, { ok: true }, 202);
  });

  router.get('/api/diagnostics', async ({ res }) => {
    const archive = await buildDiagnostics(app);
    return sendBytes(res, archive, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${diagnosticsName()}"`
    });
  });
}
