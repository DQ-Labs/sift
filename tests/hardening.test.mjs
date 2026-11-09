import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCatalogue, catalogueFiles } from '../lib/catalogue.mjs';
import { AnalysisQueue } from '../lib/analysis.mjs';
import { runMedia } from '../lib/media.mjs';
import { readJson } from '../lib/http.mjs';

const require = createRequire(import.meta.url);
const { rotateLog } = require('../desktop/logger.cjs');

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sift-hardening-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sample(id) {
  return {
    id, path: `/pack/${id}.wav`, filename: `${id}.wav`, name: id, folder: 'pack', root: '/pack',
    type: 'Drums', bpm: 120, duration: 2, size: 100, mtime: 1
  };
}

test('saving the workspace, gems or a set keeps the combination candidates; sample writes do not', async t => {
  const { catalogue } = await openCatalogue(await temporaryDirectory(t));
  catalogue.put(sample('one'));
  const candidates = catalogue.combinationCandidates('');
  catalogue.setWorkspace({ tracks: [], tempo: 100 });
  catalogue.setFavorites(['one']);
  catalogue.addSet({ id: 'set', name: 'Set', tracks: [] });
  assert.equal(catalogue.combinationCandidates(''), candidates, 'the cached list is reused');
  catalogue.put(sample('two'));
  assert.equal(catalogue.combinationCandidates('').length, 2);
  catalogue.close({ backup: false });
});

test('a background backup is a complete catalogue and runs only when something changed', async t => {
  const directory = await temporaryDirectory(t);
  const { catalogue } = await openCatalogue(directory);
  catalogue.put(sample('one'));
  catalogue.setWorkspace({ tracks: [], tempo: 100 });
  const both = await Promise.all([catalogue.backupIfChangedInBackground(), catalogue.backupIfChangedInBackground()]);
  assert.deepEqual(both, [true, true], 'overlapping calls share one backup');
  assert.equal(await catalogue.backupIfChangedInBackground(), false);
  catalogue.close({ backup: false });

  // Restoring from the backup alone brings the sample back.
  await rm(path.join(directory, catalogueFiles.database), { force: true });
  for (const suffix of ['-wal', '-shm']) await rm(path.join(directory, catalogueFiles.database + suffix), { force: true });
  const restored = await openCatalogue(directory);
  assert.equal(restored.catalogue.get('one').name, 'one');
  restored.catalogue.close({ backup: false });
});

test('a media tool that cannot start is flagged, and analysis leaves those samples unanalyzed', async () => {
  const failure = await runMedia('sift-no-such-tool', []).catch(error => error);
  assert.equal(failure.toolUnavailable, true);

  const records = new Map([['one', sample('one')]]);
  const queue = new AnalysisQueue({
    load: id => structuredClone(records.get(id)),
    commit: (id, apply) => apply(records.get(id)),
    paused: true,
    concurrency: 1,
    statFile: async () => ({ mtimeMs: 1, size: 100 }),
    decode: async () => {
      throw failure;
    },
    analyze: async () => ({})
  });
  queue.enqueue([records.get('one')]);
  queue.resume();
  while (queue.status().remaining) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(queue.status().skipped, 1);
  assert.equal(queue.status().failed, 0);
  assert.equal(records.get('one').analysis, undefined, 'nothing permanent is recorded');
  queue.close();
});

test('JSON bodies survive a multi-byte character split across chunks, and are limited by bytes', async () => {
  const bytes = Buffer.from(JSON.stringify({ name: 'Café Ørsted 🎛' }));
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  const request = chunks => Object.assign((async function* body() {
    yield* chunks;
  })(), { headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await readJson(request([bytes.subarray(0, split), bytes.subarray(split)])), { name: 'Café Ørsted 🎛' });
  await assert.rejects(() => readJson(request([Buffer.alloc(2_000_001, 0x20)])), { status: 413 });
});

test('a log over the size limit is rotated to .1; a small or missing one is left alone', async t => {
  const directory = await temporaryDirectory(t);
  const log = path.join(directory, 'sift.log');
  assert.equal(rotateLog(log, 10), false);
  await writeFile(log, 'short');
  assert.equal(rotateLog(log, 10), false);
  await writeFile(log, 'much longer than ten bytes');
  await writeFile(`${log}.1`, 'older');
  assert.equal(rotateLog(log, 10), true);
  assert.equal(await readFile(`${log}.1`, 'utf8'), 'much longer than ten bytes');
  await assert.rejects(() => stat(log), { code: 'ENOENT' });
});
