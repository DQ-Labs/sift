import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCatalogue } from '../lib/catalogue.mjs';
import { buildDiagnostics } from '../lib/diagnostics.mjs';
import { LogBuffer } from '../lib/logs.mjs';
import { appInfo } from '../lib/system.mjs';
import { readStoredZip } from './fixtures.mjs';

test('diagnostics contain versions, counts, logs and errors but no audio or sample paths', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'sift-diagnostics-'));
  const root = path.join(os.tmpdir(), 'Private Studio', 'Secret Pack');
  const samplePath = path.join(root, 'Unreleased', 'vocal_take_3.wav');
  const { catalogue } = await openCatalogue(dataDir);
  catalogue.addFolder({ path: root, name: 'Secret Pack' });
  catalogue.putMany([
    { id: 'a', path: samplePath, filename: 'vocal_take_3.wav', name: 'vocal_take_3', root, folder: 'Secret Pack', type: 'Vocal', peaks: [0.1, 0.2] },
    { id: 'b', path: path.join(root, 'broken.wav'), filename: 'broken.wav', name: 'broken', root, folder: 'Secret Pack', type: 'Other',
      analysis: { status: 'error', version: 1, error: `Audio processing failed: ${path.join(root, 'broken.wav')}: Invalid data found`, analyzedAt: '2026-10-26T00:00:00.000Z' } }
  ]);
  const logs = new LogBuffer(500);
  for (let i = 0; i < 620; i++) logs.add('log', `line ${i}`);
  logs.add('error', `Request failed: ENOENT: no such file or directory, open '${samplePath}'`);
  const app = {
    here: path.resolve('.'),
    dataDir,
    recovery: null,
    catalogue,
    logs,
    analysis: { status: () => ({ running: true, current: 'vocal_take_3', pending: 4, processed: 1, total: 5 }) },
    scanner: { status: { running: false, current: null, error: null, count: 2 } },
    mediaTools: { get: async () => ({ found: true, rubberband: true, version: '7.1', ffprobe: { found: true, version: '7.1' }, output: { version: 'ffmpeg version 7.1', rubberband: 'Filter rubberband', ffprobe: 'ffprobe version 7.1' } }) },
    capabilities: async () => ({ handoff: 1, version: appInfo.version, dataDirectory: dataDir, ffmpeg: { found: true, rubberband: true, version: '7.1' } })
  };
  const entries = readStoredZip(await buildDiagnostics(app));
  assert.deepEqual([...entries.keys()].sort(), ['README.txt', 'diagnostics.json', 'errors.json', 'ffmpeg.txt', 'log.txt']);
  const everything = [...entries.values()].map(bytes => bytes.toString('utf8')).join('\n');
  for (const secret of [samplePath, root, dataDir, 'Unreleased', 'Private Studio']) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  assert.ok(!everything.includes('RIFF'));

  const report = JSON.parse(entries.get('diagnostics.json'));
  assert.equal(report.app.version, appInfo.version);
  assert.equal(report.runtime.node, process.versions.node);
  assert.ok(report.runtime.sqlite);
  assert.deepEqual(report.ffmpeg, { found: true, rubberband: true, version: '7.1', ffprobe: { found: true, version: '7.1' } });
  assert.equal(report.catalogue.counts.total, 2);
  assert.deepEqual(report.catalogue.counts.byRoot, { 'Secret Pack': 2 });
  assert.deepEqual(report.catalogue.sources, [{ name: 'Secret Pack', samples: 2, available: false }]);
  assert.equal(report.analysis.current, '<hidden>');
  assert.equal(report.capabilities.dataDirectory, '<data>');

  const lines = entries.get('log.txt').toString().trim().split('\n');
  assert.equal(lines.length, 500);
  assert.match(lines.at(-1), /ERROR Request failed: .*<folder:Secret Pack>/);
  const errors = JSON.parse(entries.get('errors.json'));
  assert.equal(errors.log.length, 1);
  assert.match(errors.analysis[0].error, /^Audio processing failed: <folder:Secret Pack>: Invalid data found$/);
  assert.match(entries.get('ffmpeg.txt').toString(), /Filter rubberband/);
  catalogue.close();
});
