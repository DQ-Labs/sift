import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, cp, open, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCatalogue } from '../lib/catalogue.mjs';
import { Scanner, skipDirectory, invalidReasons } from '../lib/scanner.mjs';
import { ANALYSIS_VERSION } from '../lib/analysis.mjs';
import { makeDemo } from '../lib/audio.mjs';

const temporary = prefix => mkdtemp(path.join(os.tmpdir(), prefix));

function recordingAnalysis() {
  return {
    enqueued: [],
    enqueue(samples) {
      this.enqueued.push(samples.map(sample => sample.id));
    }
  };
}

async function writeTree(root, files) {
  for (const [relative, bytes] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

const byFilename = catalogue => new Map(catalogue.allSamples().map(sample => [sample.filename, sample]));

// Marks every valid sample as analyzed, as the analysis queue would.
function analyzeAll(catalogue) {
  for (const id of catalogue.pendingAnalysisIds(ANALYSIS_VERSION)) {
    catalogue.update(id, sample => {
      sample.analysis = { status: 'done', version: ANALYSIS_VERSION, bpm: 101, key: null, analyzedAt: 'first run', mtime: sample.mtime, size: sample.size };
      sample.peaks = [0.5, 0.25];
    });
  }
}

test('system folders are skipped at a drive root; tool folders anywhere', () => {
  for (const name of ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information']) {
    assert.equal(skipDirectory(name, 'D:\\', path.win32), true, name);
    assert.equal(skipDirectory(name, 'D:\\Samples', path.win32), false, name);
  }
  for (const name of ['AppData', 'node_modules', '.git']) {
    assert.equal(skipDirectory(name, 'C:\\Users\\me', path.win32), true, name);
    assert.equal(skipDirectory(name, 'D:\\', path.win32), true, name);
  }
  assert.equal(skipDirectory('Samples', 'D:\\', path.win32), false);
  assert.equal(skipDirectory('Windows', '/', path.posix), true);
});

// An in-memory Windows drive for scanner tests.
function fakeDrive(files) {
  const nodes = new Map([['D:\\', { directory: true }]]);
  let inode = 1;
  for (const [relative, size] of Object.entries(files)) {
    const parts = relative.split('\\');
    for (let i = 1; i < parts.length; i++) nodes.set(path.win32.join('D:\\', ...parts.slice(0, i)), { directory: true });
    nodes.set(path.win32.join('D:\\', relative), { directory: false, size, ino: inode++ });
  }
  const missing = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
  const children = directory => [...nodes.keys()].filter(key => key !== directory && path.win32.dirname(key) === directory);
  return {
    async readdir(directory) {
      if (!nodes.get(directory)?.directory) throw missing();
      return children(directory).map(key => {
        const node = nodes.get(key);
        return { name: path.win32.basename(key), isDirectory: () => node.directory, isFile: () => !node.directory, isSymbolicLink: () => false };
      });
    },
    async stat(target) {
      const node = nodes.get(target);
      if (!node) throw missing();
      return { size: node.size ?? 0, mtimeMs: 1000, dev: 7, ino: node.ino ?? 0, isDirectory: () => node.directory, isFile: () => !node.directory };
    },
    async open(target) {
      if (!nodes.has(target)) throw missing();
      return { close: async () => {} };
    }
  };
}

test('a whole drive can be a source without indexing Windows, programs or app data', async () => {
  const { catalogue } = await openCatalogue(await temporary('sift-drive-'));
  const fs = fakeDrive({
    'Windows\\Media\\chimes.flac': 10,
    'Program Files\\Image-Line\\FL Studio\\pack.flac': 10,
    'Program Files (x86)\\Vendor\\demo.flac': 10,
    'ProgramData\\cache.flac': 10,
    '$Recycle.Bin\\deleted.flac': 10,
    'System Volume Information\\x.flac': 10,
    'Users\\me\\AppData\\Local\\Temp\\render.flac': 10,
    'Users\\me\\Music\\Windows\\keep-nested-windows.flac': 10,
    'Projects\\beat\\node_modules\\pkg\\click.flac': 10,
    'Samples\\Drums\\kick.flac': 10,
    'Samples\\Field\\rain.caf': 10
  });
  const analysis = recordingAnalysis();
  const scanner = new Scanner({ catalogue, analysis, fs, platform: 'win32', pathApi: path.win32 });
  await scanner.scan('D:\\');
  assert.equal(scanner.status.error, null);
  assert.deepEqual(catalogue.allSamples().map(sample => sample.filename).sort(), ['keep-nested-windows.flac', 'kick.flac', 'rain.caf']);
  assert.deepEqual(catalogue.folders, [{ path: 'D:\\', name: 'D:\\' }]);
  assert.equal(scanner.status.count, 3);
  assert.equal(analysis.enqueued.at(-1).length, 3);
  catalogue.close();
});

test('scans index .caf, keep empty and unreadable files as invalid, and never queue them', async () => {
  const root = await temporary('sift-scan-');
  const wav = makeDemo('Drums', 0, 120).buffer;
  await writeTree(root, {
    'kick_120bpm.wav': wav,
    'pads/air.caf': Buffer.from('caff audio placeholder'),
    'empty.wav': Buffer.alloc(0),
    'locked.flac': Buffer.from('locked'),
    'notes.txt': 'not audio'
  });
  const { catalogue } = await openCatalogue(await temporary('sift-scan-data-'));
  const analysis = recordingAnalysis();
  const fs = {
    readdir: (await import('node:fs/promises')).readdir,
    stat: (await import('node:fs/promises')).stat,
    async open(file, flags) {
      if (file.endsWith('locked.flac')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return open(file, flags);
    }
  };
  const scanner = new Scanner({ catalogue, analysis, fs });
  await scanner.scan(root);
  const samples = byFilename(catalogue);
  assert.deepEqual([...samples.keys()].sort(), ['air.caf', 'empty.wav', 'kick_120bpm.wav', 'locked.flac']);
  assert.equal(samples.get('empty.wav').invalid, invalidReasons.empty);
  assert.equal(samples.get('locked.flac').invalid, invalidReasons.unreadable);
  assert.equal(samples.get('kick_120bpm.wav').invalid, undefined);
  assert.ok(samples.get('kick_120bpm.wav').duration > 7);
  assert.equal(scanner.status.invalid, 2);
  const queued = analysis.enqueued.at(-1);
  assert.deepEqual(queued.sort(), [samples.get('air.caf').id, samples.get('kick_120bpm.wav').id].sort());
  assert.equal(catalogue.counts().invalid, 2);
  assert.ok(!catalogue.combinationCandidates('').some(sample => sample.id === samples.get('empty.wav').id));

  // Once fixed, an invalid file is checked again on the next scan.
  await writeFile(path.join(root, 'empty.wav'), wav);
  await scanner.scan(root);
  assert.equal(byFilename(catalogue).get('empty.wav').invalid, undefined);
  assert.ok(catalogue.pendingAnalysisIds(ANALYSIS_VERSION).includes(samples.get('empty.wav').id));
  catalogue.close();
});

test('unchanged files are never re-analyzed after a restart, a disconnect or a new drive letter', async () => {
  const parent = await temporary('sift-reconnect-');
  const root = path.join(parent, 'E');
  await writeTree(root, { 'Pack/keys_90bpm_Amin.wav': makeDemo('Melodic', 0, 90).buffer, 'Pack/sub.wav': makeDemo('Bass', 1).buffer });
  const dataDir = await temporary('sift-reconnect-data-');
  let { catalogue } = await openCatalogue(dataDir);
  await new Scanner({ catalogue, analysis: recordingAnalysis() }).scan(root);
  analyzeAll(catalogue);
  assert.deepEqual(catalogue.pendingAnalysisIds(ANALYSIS_VERSION), []);
  catalogue.close();

  // Restart, then rescan the same folder.
  ({ catalogue } = await openCatalogue(dataDir));
  let scanner = new Scanner({ catalogue, analysis: recordingAnalysis() });
  await scanner.scan(root);
  assert.deepEqual(catalogue.pendingAnalysisIds(ANALYSIS_VERSION), []);
  assert.ok(catalogue.allSamples().every(sample => sample.analysis.analyzedAt === 'first run'));

  // The drive disconnects: nothing is marked missing or queued.
  await rename(root, `${root}-offline`);
  const offline = await scanner.checkMissing();
  assert.equal(offline.unavailableRoots, 1);
  assert.equal(catalogue.counts().missing, 0);
  await rename(`${root}-offline`, root);
  await scanner.scan(root);
  assert.deepEqual(catalogue.pendingAnalysisIds(ANALYSIS_VERSION), []);

  // The same drive returns under another letter: same names, sizes and times.
  const moved = path.join(parent, 'F');
  await cp(root, moved, { recursive: true, preserveTimestamps: true });
  await scanner.scan(moved);
  const copies = catalogue.allSamples().filter(sample => sample.root === moved);
  assert.equal(copies.length, 2);
  assert.ok(copies.every(sample => sample.analysis?.analyzedAt === 'first run'));
  assert.ok(copies.every(sample => sample.peaks?.length === 2));
  assert.deepEqual(catalogue.pendingAnalysisIds(ANALYSIS_VERSION), []);

  // A file that really changed is analyzed again.
  const changed = path.join(root, 'Pack', 'sub.wav');
  await writeFile(changed, makeDemo('Bass', 2).buffer);
  await utimes(changed, new Date(), new Date(Date.now() + 5000));
  await scanner.scan(root);
  const pending = catalogue.pendingAnalysisIds(ANALYSIS_VERSION).map(id => catalogue.get(id).path);
  assert.deepEqual(pending, [changed]);
  catalogue.close();
});

test('missing files are flagged, restored on reconnect, and pruned only when unreferenced', async () => {
  const root = await temporary('sift-missing-');
  await writeTree(root, { 'a.wav': makeDemo('Drums', 0).buffer, 'b.wav': makeDemo('Bass', 0).buffer, 'c.wav': makeDemo('Melodic', 0).buffer });
  const { catalogue } = await openCatalogue(await temporary('sift-missing-data-'));
  const scanner = new Scanner({ catalogue, analysis: recordingAnalysis() });
  await scanner.scan(root);
  const ids = byFilename(catalogue);
  catalogue.setFavorites([ids.get('b.wav').id]);
  await rename(path.join(root, 'a.wav'), path.join(root, 'a.moved'));
  await rename(path.join(root, 'b.wav'), path.join(root, 'b.moved'));
  await scanner.scan(root);
  assert.equal(catalogue.get(ids.get('a.wav').id).missing, true);
  assert.equal(catalogue.get(ids.get('b.wav').id).missing, true);
  await rename(path.join(root, 'b.moved'), path.join(root, 'b.wav'));
  await scanner.checkMissing({ root });
  assert.equal(catalogue.get(ids.get('b.wav').id).missing, undefined);
  await rename(path.join(root, 'b.wav'), path.join(root, 'b.moved'));
  const result = await scanner.cleanup();
  assert.deepEqual(result, { removed: 1, missing: 1, unavailableRoots: 0 });
  assert.equal(catalogue.get(ids.get('a.wav').id), undefined);
  assert.equal(catalogue.get(ids.get('b.wav').id).missing, true, 'gems keep their sample');
  assert.ok(catalogue.get(ids.get('c.wav').id));
  catalogue.close();
});

test('corrections made while a scan runs are kept', async () => {
  const root = await temporary('sift-edit-');
  await writeTree(root, { 'loop.wav': makeDemo('Drums', 0).buffer });
  const { catalogue } = await openCatalogue(await temporary('sift-edit-data-'));
  const scanner = new Scanner({ catalogue, analysis: recordingAnalysis() });
  await scanner.scan(root);
  const id = catalogue.allSamples()[0].id;
  await writeFile(path.join(root, 'loop.wav'), makeDemo('Drums', 1).buffer);
  const pending = new Map();
  const index = { identify: async () => ({ id, old: catalogue.fileRecords()[0] }), remember() {} };
  await scanner.indexFile({ filepath: path.join(root, 'loop.wav'), filename: 'loop.wav', root, index, pending, status: { invalid: 0 } });
  catalogue.update(id, sample => {
    sample.overrides = { bpm: 77 };
  });
  scanner.flush(pending);
  assert.equal(catalogue.get(id).bpm, 77);
  assert.deepEqual(catalogue.get(id).overrides, { bpm: 77 });
  catalogue.close();
});
