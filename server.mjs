import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogBuffer } from './lib/logs.mjs';
import { openCatalogue } from './lib/catalogue.mjs';
import { seedDemoCollection } from './lib/demo.mjs';
import { AnalysisQueue, ANALYSIS_VERSION } from './lib/analysis.mjs';
import { Scanner } from './lib/scanner.mjs';
import { StretchCache } from './lib/media.mjs';
import { HandoffStore } from './lib/handoff.mjs';
import { MediaToolStatus } from './lib/system.mjs';
import { listenLoopback } from './lib/loopback.mjs';
import { Router } from './lib/router.mjs';
import { checkLocalRequest, sendJson } from './lib/http.mjs';
import { registerSystemRoutes, capabilities } from './lib/routes/system.mjs';
import { registerLibraryRoutes } from './lib/routes/library.mjs';
import { registerSampleRoutes } from './lib/routes/samples.mjs';
import { registerAnalysisRoutes } from './lib/routes/analysis.mjs';
import { registerScanRoutes } from './lib/routes/scan.mjs';
import { registerMediaRoutes } from './lib/routes/media.mjs';
import { registerHandoffRoutes } from './lib/routes/handoffs.mjs';
import { registerStaticRoutes } from './lib/routes/static.mjs';

// Captured first so diagnostics include startup messages.
const logs = new LogBuffer(500).capture();

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SIFT_DATA_DIR || path.join(here, 'data');
const port = Number(process.env.PORT || 4317);

await mkdir(dataDir, { recursive: true });
const { catalogue, recovery } = await openCatalogue(dataDir);
if (recovery) console.warn(`${recovery.message} ${recovery.preserved.join(', ')}`);
await seedDemoCollection(catalogue, path.join(dataDir, 'demo'));

const mediaTools = new MediaToolStatus();
void mediaTools.start();
const analysis = new AnalysisQueue({
  load: id => catalogue.get(id),
  commit: (id, apply) => catalogue.update(id, apply),
  paused: catalogue.analysisPaused || process.env.SIFT_ANALYSIS_PAUSED === '1'
});
const app = {
  here,
  dataDir,
  port,
  recovery,
  logs,
  catalogue,
  analysis,
  mediaTools,
  scanner: new Scanner({ catalogue, analysis }),
  stretchCache: new StretchCache(path.join(dataDir, 'stretch-cache')),
  handoffs: new HandoffStore(path.join(dataDir, 'exports')),
  capabilities: () => capabilities(app)
};

// Order matters only where patterns overlap; the static route goes last.
const router = new Router();
for (const register of [
  registerSystemRoutes,
  registerLibraryRoutes,
  registerSampleRoutes,
  registerAnalysisRoutes,
  registerScanRoutes,
  registerMediaRoutes,
  registerHandoffRoutes,
  registerStaticRoutes
]) register(router, app);

const unavailableMessage = 'File or folder is unavailable. Reconnect the drive or check the path.';

function sendError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!error.status && !(error instanceof SyntaxError)) console.error(`Request failed: ${error.message}`);
  sendJson(res, { error: error.code === 'ENOENT' ? unavailableMessage : error.message }, error.status || 400);
}

async function handleRequest(req, res) {
  try {
    if (!checkLocalRequest(req, res, port)) return;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = router.match(req.method, url.pathname);
    if (!route) return sendJson(res, { error: 'Not found' }, 404);
    await route.handler({ req, res, url, params: route.params });
  } catch (error) {
    sendError(res, error);
  }
}

analysis.enqueue(catalogue.pendingAnalysisIds(ANALYSIS_VERSION).map(id => ({ id })));
catalogue.startBackups();

let servers;
try {
  servers = await listenLoopback(handleRequest, port);
} catch (error) {
  analysis.close();
  catalogue.close({ backup: false });
  throw error;
}
console.log(`Sift is running at http://127.0.0.1:${port}`);
for (const server of servers) {
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  analysis.close();
  for (const server of servers) server.close();
  try {
    catalogue.close();
  } catch (error) {
    console.error(`Could not close the catalogue cleanly: ${error.message}`);
  } finally {
    process.exit(0);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
if (process.send) {
  process.on('message', message => {
    if (message?.type === 'sift:shutdown') shutdown();
  });
}
