import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { storeZip } from './handoff.mjs';
import { makeRedactor } from './logs.mjs';
import { appInfo } from './system.mjs';

const readme = `Sift diagnostics report

This archive helps explain a problem with Sift. It contains app and runtime
versions, the FFmpeg check, catalogue and analysis counts, source folder
names, the last 500 log lines and recent errors.

It never contains audio or full paths: paths in logs and
errors are replaced with <path>, <data>, <home> or <folder:name>.
`;

async function isDirectory(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function fileSize(filename) {
  try {
    return (await stat(filename)).size;
  } catch {
    return null;
  }
}

function withoutCurrent(status) {
  const { current, ...rest } = status;
  return { ...rest, current: current ? '<hidden>' : null };
}

function sqliteVersion(catalogue) {
  try {
    return catalogue.db.prepare('SELECT sqlite_version() AS version').get().version;
  } catch {
    return null;
  }
}

// Builds the ZIP served by GET /api/diagnostics.
export async function buildDiagnostics(app) {
  const { catalogue, analysis, scanner, logs, mediaTools } = app;
  const folders = catalogue.folders;
  const redact = makeRedactor({ folders, dataDirectory: path.resolve(app.dataDir), appDirectory: app.here });
  const counts = catalogue.counts();
  const folderName = root => folders.find(folder => folder.path === root)?.name || path.basename(root) || root;
  const byRoot = {};
  for (const [root, total] of Object.entries(counts.byRoot)) byRoot[folderName(root)] = (byRoot[folderName(root)] || 0) + total;
  const sources = [];
  for (const folder of folders) {
    sources.push({ name: folder.name, samples: counts.byRoot[folder.path] || 0, available: await isDirectory(folder.path) });
  }
  const tools = await mediaTools.get(15000);
  const capabilities = await app.capabilities();
  const report = {
    generatedAt: new Date().toISOString(),
    app: appInfo,
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron || null,
      v8: process.versions.v8,
      sqlite: sqliteVersion(catalogue),
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpus: os.availableParallelism(),
      totalMemoryMB: Math.round(os.totalmem() / 2 ** 20),
      freeMemoryMB: Math.round(os.freemem() / 2 ** 20),
      uptimeSeconds: Math.round(process.uptime())
    },
    capabilities: { ...capabilities, dataDirectory: '<data>' },
    ffmpeg: tools ? { found: tools.found, rubberband: tools.rubberband, version: tools.version, ffprobe: tools.ffprobe } : { pending: true },
    catalogue: {
      counts: { ...counts, byRoot },
      sources,
      gems: catalogue.favorites.length,
      sets: catalogue.sets.length,
      databaseBytes: await fileSize(catalogue.file),
      backupBytes: await fileSize(catalogue.backupFile()),
      migratedFrom: catalogue.meta('migratedFrom') || null,
      migratedAt: catalogue.meta('migratedAt') || null,
      recovery: app.recovery ? { message: app.recovery.message, preserved: app.recovery.preserved.length } : null
    },
    analysis: withoutCurrent(analysis.status()),
    scan: { ...withoutCurrent(scanner.status), error: scanner.status.error ? redact(scanner.status.error) : null },
    settings: Object.keys(process.env).filter(name => name.startsWith('SIFT_')).sort()
  };
  const errors = {
    log: logs.errors.map(entry => ({ ...entry, text: redact(entry.text) })),
    analysis: catalogue.recentAnalysisErrors(50).map(entry => ({ ...entry, error: redact(entry.error) }))
  };
  const logText = logs.lines.map(entry => `${entry.at} ${entry.level.toUpperCase()} ${redact(entry.text)}`).join('\n');
  const toolText = tools
    ? `$ ffmpeg -version\n${redact(tools.output.version)}\n\n$ ffmpeg -h filter=rubberband\n${redact(tools.output.rubberband)}\n\n$ ffprobe -version\n${redact(tools.output.ffprobe)}\n`
    : 'The FFmpeg check had not finished.\n';
  return storeZip([
    { name: 'README.txt', bytes: Buffer.from(readme) },
    { name: 'diagnostics.json', bytes: Buffer.from(JSON.stringify(report, null, 2)) },
    { name: 'errors.json', bytes: Buffer.from(JSON.stringify(errors, null, 2)) },
    { name: 'ffmpeg.txt', bytes: Buffer.from(toolText) },
    { name: 'log.txt', bytes: Buffer.from(logText ? `${logText}\n` : '') }
  ]);
}
