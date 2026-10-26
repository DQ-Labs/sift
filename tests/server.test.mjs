import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rename, utimes, lstat, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { makeDemo } from '../lib/audio.mjs';
import { encodeWav } from '../public/export-audio.js';
import { readStoredZip } from './fixtures.mjs';

const root = process.env.SIFT_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Some containers have no IPv6 loopback; the server then listens on IPv4 only.
const ipv6Loopback = await new Promise(resolve => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen({ port: 0, host: '::1', ipv6Only: true }, () => probe.close(() => resolve(true)));
});

async function startServer(t, { port, dataDir }) {
  const executable = process.env.SIFT_TEST_EXECUTABLE || process.execPath;
  const env = { ...process.env, PORT: String(port), SIFT_DATA_DIR: dataDir, SIFT_ANALYSIS_PAUSED: '1' };
  if (process.env.SIFT_TEST_EXECUTABLE) env.ELECTRON_RUN_AS_NODE = '1';
  const proc = spawn(executable, [path.join(root, 'server.mjs')], { cwd: path.dirname(dataDir), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  t.after(() => proc.kill());
  let output = '';
  proc.stdout.on('data', chunk => {
    output += chunk;
  });
  let startupError = '';
  proc.stderr.on('data', chunk => {
    startupError += chunk;
  });
  const deadline = Date.now() + 10000;
  while (!/Sift is running/.test(output)) {
    // Startup must be silent on stderr: launchers treat it as a failure.
    assert.equal(startupError, '', 'stderr during startup');
    assert.equal(proc.exitCode, null, `server exited during startup: ${output}`);
    assert.ok(Date.now() < deadline, 'server startup timeout');
    await pause(20);
  }
  const base = `http://127.0.0.1:${port}`;
  const post = (route, value) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const getJson = async route => (await fetch(base + route)).json();
  const stop = async () => {
    const stopped = once(proc, 'exit');
    proc.send({ type: 'sift:shutdown' });
    assert.equal((await stopped)[0], 0);
  };
  return { proc, base, get: route => fetch(base + route), getJson, post, stop };
}

// Sends a raw request path that fetch() would otherwise normalize.
function rawStatus(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath, headers }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
}

async function waitForScan(server) {
  for (let i = 0; i < 200; i++) {
    if (!(await server.getJson('/api/scan')).running) return;
    await pause(20);
  }
  assert.fail('Scan did not complete');
}

test('local server indexes, streams and persists without exposing arbitrary files', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'sift-test-'));
  const dataDir = path.join(data, 'data');
  const port = 44317;
  let server = await startServer(t, { port, dataDir });
  const { base, get, getJson, post } = server;
  let response = await get('/api/library');
  assert.equal(response.status, 200);
  let library = await response.json();
  assert.equal(library.samples.length, 12);
  const libraryStatus = await getJson('/api/library/status');
  assert.equal(libraryStatus.scan.running, false);
  assert.equal(libraryStatus.analysis.total, 12);
  assert.equal(libraryStatus.analysis.remaining, 12);
  assert.equal(libraryStatus.samples, undefined);
  const id = library.samples[0].id;

  // Loopback names and the page's own origin only.
  assert.equal((await fetch(`http://localhost:${port}/api/library`)).status, 200);
  if (ipv6Loopback) {
    assert.equal((await fetch(`http://[::1]:${port}/api/library`, { headers: { Origin: `http://[::1]:${port}` } })).status, 200);
    assert.equal((await fetch(`http://[::1]:${port}/api/library`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  } else {
    t.diagnostic('IPv6 loopback unavailable here; [::1] requests not checked.');
  }
  assert.equal((await fetch(`${base}/api/library`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal(await rawStatus(port, '/api/library', { Host: 'attacker.example' }), 403);

  // Audio streams with ranges; nothing outside the catalogue and public/ is served.
  response = await fetch(`${base}/audio/${id}`, { headers: { Range: 'bytes=0-43' } });
  assert.equal(response.status, 206);
  const header = Buffer.from(await response.arrayBuffer());
  assert.equal(header.length, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  response = await fetch(`${base}/audio/${id}`, { headers: { Range: 'bytes=-8' } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 8);
  assert.equal((await fetch(`${base}/audio/${id}`, { headers: { Range: 'bytes=999999999-' } })).status, 416);
  assert.equal((await get('/audio/not-indexed')).status, 404);
  for (const hidden of ['/server.mjs', '/data/library.json', '/library.sqlite', '/package.json', '/lib/catalogue.mjs']) {
    assert.equal((await get(hidden)).status, 404, hidden);
  }
  for (const traversal of ['/..%2Fserver.mjs', '/%2e%2e/server.mjs', '/..%5Cserver.mjs', '/public/app.js', '/.gitignore']) {
    assert.equal(await rawStatus(port, traversal), 404, traversal);
  }
  assert.equal((await fetch(`${base}/api/scan`, { method: 'POST', body: '{}' })).status, 415);

  // Scanning a folder.
  const samples = path.join(data, 'My samples');
  await mkdir(path.join(samples, 'nested'), { recursive: true });
  await writeFile(path.join(samples, 'nested', 'dust_drums_110bpm.wav'), makeDemo('Drums', 1, 110).buffer);
  await writeFile(path.join(samples, 'ignore.txt'), 'not audio');
  response = await post('/api/scan', { path: samples });
  assert.equal(response.status, 202);
  await waitForScan(server);
  library = await getJson('/api/library');
  assert.equal(library.samples.length, 13);
  const imported = library.samples.find(s => !s.demo);
  assert.equal(imported.bpm, 110);
  assert.equal(imported.type, 'Drums');
  assert.ok(imported.duration > 8);

  // Gems, sets and the workspace.
  assert.equal((await post('/api/favorites', { ids: [imported.id, 'fake', imported.id] })).status, 200);
  assert.equal((await post('/api/sets', { name: 'First find', tempo: 110, key: 'Bb min', sync: true, tracks: [{ id: imported.id, volume: 0.5 }] })).status, 200);
  assert.equal((await post('/api/workspace', { tempo: 110, key: 'C maj', tracks: [{ id: imported.id, timing: { offset: 0.125, repeat: 'bar' } }] })).status, 200);
  let saved = await getJson('/api/library?lite=1');
  assert.deepEqual(saved.favorites, [imported.id]);
  assert.equal(saved.sets[0].name, 'First find');
  assert.equal(saved.workspace.tempo, 110);
  assert.equal(saved.sets[0].key, 'A# min');
  assert.equal(saved.workspace.key, 'C maj');

  // Overwriting a set by name replaces it rather than keeping both.
  const firstSetId = saved.sets[0].id;
  const overwrite = await post('/api/sets', { name: 'First find', tempo: 100, replaces: firstSetId, tracks: [{ id: imported.id }] });
  assert.equal(overwrite.status, 200);
  assert.equal((await overwrite.json()).replaced, firstSetId);
  assert.equal((await post('/api/sets', { name: 'Bad', replaces: 7, tracks: [] })).status, 400);
  saved = await getJson('/api/library?lite=1');
  assert.deepEqual(saved.sets.filter(set => set.name === 'First find').map(set => set.tempo), [100]);
  assert.deepEqual(saved.workspace.tracks[0].timing, { offset: 0.125, repeat: 'bar', start: 'beat' });
  assert.deepEqual(saved.sets[0].tracks[0].timing, { offset: null, repeat: 'auto', start: 'beat' });

  // The front end, including any module added to public/ later.
  response = await get('/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="workspace"/);
  response = await get('/app.js');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/javascript');
  assert.match(await response.text(), /from '\.\/workbench\.js'/);
  for (const file of ['/harmony.js', '/timing.js', '/library-activity.js', '/export-audio.js', '/workbench.js', '/catalog-client.js', '/styles.css', '/favicon.svg', '/index.html']) {
    assert.equal((await get(file)).status, 200, file);
  }
  response = await get('/workspace.js');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /export function normalizeWorkspace/);
  assert.equal((await get('/not-yet-written.js')).status, 404);

  // Metadata corrections.
  response = await post('/api/metadata', { id: imported.id, bpm: 55, key: null });
  assert.equal(response.status, 200);
  let updated = await response.json();
  assert.equal(updated.bpmSource, 'manual');
  assert.equal(updated.bpm, 55);
  assert.equal((await post('/api/metadata', { id: imported.id, bpm: 999, key: null })).status, 400);
  updated = await (await post('/api/metadata', { id: imported.id, key: 'C maj' })).json();
  assert.equal(updated.bpm, 55);
  assert.equal(updated.key, 'C maj');
  updated = await (await post('/api/metadata', { id: imported.id, bpm: null })).json();
  assert.equal(updated.bpm, null);
  assert.equal(updated.key, 'C maj');
  updated = await (await post('/api/metadata', { id: imported.id, bpm: 55 })).json();
  assert.equal(updated.bpm, 55);
  assert.equal(updated.key, 'C maj');
  assert.equal((await post('/api/metadata', { id: imported.id, bpm: 999, key: 'A min' })).status, 400);
  assert.equal((await getJson(`/api/samples/${imported.id}`)).key, 'C maj');
  assert.equal((await post('/api/metadata', { id: 'unknown', bpm: 100 })).status, 404);
  updated = await (await post('/api/metadata', { id: imported.id, key: null })).json();
  assert.equal(updated.bpm, 55);
  assert.equal(updated.key, null);

  // Analysis keeps manual values.
  assert.equal((await post('/api/analysis', { action: 'reanalyze', ids: [imported.id] })).status, 200);
  const deadline = Date.now() + 45000;
  while (true) {
    updated = await getJson(`/api/samples/${imported.id}`);
    if (updated.analysis?.status === 'done') break;
    assert.ok(Date.now() < deadline, 'Analysis did not complete');
    await pause(100);
  }
  assert.equal(updated.bpm, 55);
  assert.equal(updated.bpmSource, 'manual');
  assert.ok(Math.abs(updated.analysis.bpm - 110) < 2);
  updated = await (await post('/api/metadata', { id: imported.id, reset: true })).json();
  assert.equal(updated.bpmSource, 'filename');
  assert.equal(updated.bpm, 110);

  // Tempo and key rendering.
  response = await post('/api/stretch', { id: imported.id, tempo: 140 });
  assert.equal(response.status, 200);
  const rendered = await response.json();
  assert.match(rendered.url, /^\/rendered\/[a-f0-9]{64}\.wav$/);
  response = await get(rendered.url);
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
  assert.equal((await post('/api/stretch', { id: imported.id, tempo: 0 })).status, 400);
  response = await post('/api/stretch', { id: imported.id, tempo: 120, key: 'A min' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).semitones, 0);
  const tonal = library.samples.find(s => s.type === 'Melodic' && s.demo);
  assert.equal((await post('/api/metadata', { id: tonal.id, bpm: null })).status, 200);
  response = await post('/api/stretch', { id: tonal.id, tempo: 120, key: 'B min' });
  assert.equal(response.status, 200);
  const pitchOnly = await response.json();
  assert.equal(pitchOnly.rate, 1);
  assert.equal(pitchOnly.semitones, 2);
  assert.equal(pitchOnly.outputKey, 'B min');
  assert.equal(pitchOnly.tempoUnknown, true);
  response = await post('/api/stretch', { id: tonal.id, tempo: 120, key: 'B min', sync: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).url, pitchOnly.url);
  for (const settings of [{ key: 'invalid' }, { key: {} }, { sync: 'false' }]) {
    assert.equal((await post('/api/stretch', { id: tonal.id, tempo: 120, ...settings })).status, 400);
  }
  assert.equal((await get('/rendered/library.json')).status, 404);

  // Capabilities.
  const capabilities = await getJson('/api/capabilities');
  assert.equal(capabilities.handoff, 1);
  assert.equal(capabilities.version, packageVersion);
  assert.equal(capabilities.dataDirectory, path.resolve(dataDir));
  assert.equal(capabilities.ffmpeg.found, true);
  assert.equal(capabilities.ffmpeg.rubberband, true);
  assert.equal(typeof capabilities.ffmpeg.version, 'string');

  // Stem handoff.
  response = await post('/api/handoffs', { workspace: { tracks: [{ id: tonal.id, type: 'Melodic' }], tempo: 120, key: 'B min', sync: true } });
  assert.equal(response.status, 201);
  const handoff = await response.json();
  const stem = Buffer.from(encodeWav([new Float32Array(handoff.frames).fill(0.1), new Float32Array(handoff.frames).fill(-0.1)]));
  assert.equal((await get(`/api/handoffs/${handoff.id}`)).status, 400);
  const putStem = (index, headers = {}) => fetch(`${base}/api/handoffs/${handoff.id}/stems/${index}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav', ...headers }, body: stem });
  assert.equal((await putStem(0, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await putStem(4)).status, 404);
  assert.equal((await putStem(0)).status, 200);
  response = await post(`/api/handoffs/${handoff.id}/finish`, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  response = await get(`/api/handoffs/${handoff.id}/files/${encodeURIComponent(handoff.files[0].name)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), stem);
  response = await get(`/api/handoffs/${handoff.id}/files/Stems.zip`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(Buffer.from(await response.arrayBuffer()).readUInt32LE(0), 0x04034b50);
  assert.equal((await putStem(0)).status, 400);
  const abandoned = path.join(dataDir, 'exports', randomUUID());
  await mkdir(abandoned);
  await writeFile(path.join(abandoned, 'session.json'), '{}');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(path.join(abandoned, 'session.json'), old, old);
  await utimes(abandoned, old, old);
  response = await post('/api/handoffs/cleanup', {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 1 });
  await assert.rejects(() => lstat(abandoned), { code: 'ENOENT' });
  response = await get(`/api/handoffs/${handoff.id}/files/Stems.zip`);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal((await post('/api/handoffs', { workspace: { tracks: [{ id: 'missing' }] } })).status, 400);

  // Invalid workspaces and sets never replace the saved workspace.
  const workspaceBefore = (await getJson('/api/library')).workspace;
  for (const timing of [null, { offset: -1 }, { offset: 3601 }, { offset: '1' }, { repeat: 'forever' }]) {
    assert.equal((await post('/api/workspace', { tracks: [{ id: imported.id, timing }] })).status, 400);
    assert.deepEqual((await getJson('/api/library')).workspace, workspaceBefore);
    assert.equal((await post('/api/sets', { name: 'Invalid timing', tracks: [{ id: imported.id, timing }] })).status, 400);
  }
  for (const invalid of [null, { tracks: [{ type: ['Drums'] }] }, { tracks: [], tempo: 999 }, { tracks: [], sync: 'false' }, { tracks: [], key: 'invalid' }, { tracks: [], key: {} }, { tracks: [], name: {} }]) {
    assert.equal((await post('/api/workspace', invalid)).status, 400);
    assert.deepEqual((await getJson('/api/library')).workspace, workspaceBefore);
  }
  assert.equal((await post('/api/sets', { name: 'Invalid', tracks: [{ type: ['Drums'] }] })).status, 400);

  // Missing files, cleanup and offline sources.
  const orphanPath = path.join(samples, 'orphan.wav');
  await writeFile(orphanPath, makeDemo('Bass', 0).buffer);
  const rescan = async () => {
    assert.equal((await post('/api/scan', { path: samples })).status, 202);
    await waitForScan(server);
  };
  await rescan();
  library = await getJson('/api/library');
  const orphan = library.samples.find(s => s.filename === 'orphan.wav');
  await unlink(orphanPath);
  await unlink(imported.path);
  await rescan();
  assert.equal((await getJson(`/api/samples/${imported.id}`)).missing, true);
  assert.equal((await get(`/audio/${imported.id}`)).status, 404);
  response = await post('/api/library/cleanup', {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removed, 1);
  assert.equal((await get(`/api/samples/${orphan.id}`)).status, 404);
  library = await getJson('/api/library');
  assert.ok(library.samples.some(s => s.id === imported.id));
  assert.deepEqual(library.favorites, [imported.id]);
  assert.equal(library.sets[0].tracks[0].id, imported.id);
  assert.equal(library.workspace.tracks[0].id, imported.id);
  await rename(samples, `${samples}-offline`);
  const offline = await (await post('/api/library/cleanup', {})).json();
  assert.equal(offline.removed, 0);
  assert.equal(offline.unavailableRoots, 1);
  await rename(`${samples}-offline`, samples);
  await writeFile(imported.path, makeDemo('Drums', 1, 110).buffer);
  await rescan();
  assert.ok(!(await getJson(`/api/samples/${imported.id}`)).missing);

  // Pause and resume.
  assert.equal((await post('/api/analysis', { action: 'pause' })).status, 200);
  while ((await getJson('/api/analysis')).running) {
    assert.ok(Date.now() < deadline, 'Analysis did not pause');
    await pause(30);
  }
  assert.equal((await getJson('/api/analysis')).paused, true);
  assert.equal((await post('/api/analysis', { action: 'shuffle' })).status, 400);
  response = await post('/api/analysis', { action: 'resume' });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.saveError, null);
  assert.equal(status.paused, false);
  await post('/api/analysis', { action: 'pause' });

  // Everything survives a restart.
  await server.stop();
  assert.ok(await access(path.join(dataDir, 'library.sqlite')).then(() => true));
  assert.ok(await access(path.join(dataDir, 'library.backup.sqlite')).then(() => true), 'clean shutdown refreshes the backup');
  server = await startServer(t, { port, dataDir });
  saved = await server.getJson('/api/library?lite=1');
  assert.deepEqual(saved.favorites, [imported.id]);
  assert.equal(saved.sets[0].name, 'First find');
  assert.equal(saved.workspace.key, 'C maj');
  assert.equal(saved.analysis.paused, true);
  assert.equal(saved.counts.total, 13);
  await server.stop();
});

test('the catalogue query API pages, filters, hydrates and combines on the server', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'sift-api-'));
  const server = await startServer(t, { port: 44320, dataDir: path.join(data, 'data') });
  const { get, getJson, post } = server;
  const samples = path.join(data, 'Pack');
  await mkdir(samples);
  await writeFile(path.join(samples, 'kick_loop_128bpm.wav'), makeDemo('Drums', 0, 128).buffer);
  await writeFile(path.join(samples, 'sub_bass_70bpm_Amin.wav'), makeDemo('Bass', 0, 70).buffer);
  await writeFile(path.join(samples, 'empty.wav'), Buffer.alloc(0));
  assert.equal((await post('/api/scan', { path: samples })).status, 202);
  await waitForScan(server);

  const lite = await getJson('/api/library?lite=1');
  assert.equal(lite.samples, undefined);
  for (const key of ['folders', 'favorites', 'sets', 'workspace', 'recovery', 'scan', 'analysis', 'counts']) assert.ok(Object.hasOwn(lite, key), key);
  assert.equal(lite.counts.total, 15);
  assert.equal(lite.counts.real, 3);
  assert.equal(lite.counts.demo, 12);
  assert.equal(lite.counts.invalid, 1);
  assert.deepEqual(lite.counts.byRoot, { [lite.folders[0].path]: 3 });
  assert.equal(lite.scan.invalid, 1);

  let page = await getJson('/api/samples');
  assert.deepEqual(Object.keys(page).sort(), ['items', 'page', 'pageSize', 'total']);
  assert.equal(page.total, 3);
  assert.equal(page.pageSize, 50);
  assert.deepEqual(page.items.map(s => s.filename), ['empty.wav', 'kick_loop_128bpm.wav', 'sub_bass_70bpm_Amin.wav']);
  page = await getJson('/api/samples?source=demo&pageSize=5&page=2&sort=name');
  assert.equal(page.total, 12);
  assert.equal(page.page, 2);
  assert.equal(page.items.length, 2);
  page = await getJson('/api/samples?source=demo&type=Bass&q=round');
  assert.deepEqual(page.items.map(s => s.name), ['Round sub']);
  page = await getJson(`/api/samples?source=${encodeURIComponent(lite.folders[0].path)}&bpm=fast`);
  assert.deepEqual(page.items.map(s => s.bpm), [128]);
  page = await getJson('/api/samples?bpm=slow&sort=bpm');
  assert.deepEqual(page.items.map(s => s.bpm), [70]);
  page = await getJson('/api/samples?view=gems');
  assert.equal(page.total, 0);
  const kick = (await getJson('/api/samples?q=kick')).items[0];
  await post('/api/favorites', { ids: [kick.id] });
  assert.deepEqual((await getJson('/api/samples?view=gems')).items.map(s => s.id), [kick.id]);
  assert.equal((await get('/api/samples?sort=random')).status, 400);
  assert.equal((await get('/api/samples?pageSize=501')).status, 400);

  assert.equal((await getJson(`/api/samples/${kick.id}`)).filename, 'kick_loop_128bpm.wav');
  assert.equal((await get('/api/samples/unknown')).status, 404);
  const demo = await getJson('/api/samples?source=demo&pageSize=12');
  let response = await post('/api/samples/batch', { ids: [kick.id, 'unknown', demo.items[3].id, kick.id] });
  assert.deepEqual((await response.json()).items.map(s => s.id), [kick.id, demo.items[3].id]);
  assert.equal((await post('/api/samples/batch', { ids: Array.from({ length: 501 }, (_, i) => `id-${i}`) })).status, 400);
  assert.equal((await post('/api/samples/batch', { ids: 'nope' })).status, 400);

  // Combinations come from the requested source's playable samples.
  const tracks = ['Drums', 'Bass', 'Melodic', 'Texture'].map(type => ({ type }));
  response = await post('/api/combination', { source: 'demo', tracks, tempo: 92, sync: true, key: 'A min', variety: 0.5 });
  assert.equal(response.status, 200);
  const combination = (await response.json()).tracks;
  assert.equal(combination.length, 4);
  const demoById = new Map(demo.items.map(sample => [sample.id, sample]));
  combination.forEach((track, i) => assert.equal(demoById.get(track.id)?.type, tracks[i].type));
  const locked = combination.map((track, i) => ({ ...track, locked: i === 0 }));
  response = await post('/api/combination', { source: 'demo', tracks: locked, tempo: 92, sync: true, key: 'A min', index: 2 });
  const rerolled = (await response.json()).tracks;
  assert.equal(rerolled[0].id, combination[0].id);
  assert.equal(rerolled[1].id, combination[1].id);
  assert.notEqual(rerolled[2].id, combination[2].id);
  assert.equal(rerolled[3].id, combination[3].id);
  response = await post('/api/combination', { source: '', tracks, tempo: 128 });
  const real = (await response.json()).tracks;
  assert.ok(real.every(track => !demoById.has(track.id)));
  const empty = (await getJson('/api/samples?q=empty')).items[0];
  assert.ok(!real.some(track => track.id === empty.id), 'invalid files are never combined');
  for (const invalid of [{ tracks, index: 7 }, { tracks, variety: 'wild' }, { tracks: 'none' }, { tracks, source: 3 }, { tracks, tempo: 999 }]) {
    assert.equal((await post('/api/combination', invalid)).status, 400, JSON.stringify(invalid));
  }

  // Diagnostics download.
  response = await get('/api/diagnostics');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /attachment; filename="sift-diagnostics-.*\.zip"/);
  const entries = readStoredZip(Buffer.from(await response.arrayBuffer()));
  const report = JSON.parse(entries.get('diagnostics.json'));
  assert.equal(report.app.version, packageVersion);
  assert.equal(report.catalogue.counts.total, 15);
  assert.equal(report.ffmpeg.rubberband, true);
  const everything = [...entries.values()].map(bytes => bytes.toString('utf8')).join('\n');
  assert.ok(!everything.includes(samples), 'no source paths');
  assert.ok(!everything.includes(data), 'no data paths');
  await server.stop();
});

test('an existing library.json is migrated on first start and kept as library.pre-sqlite.json', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'sift-migrate-'));
  const dataDir = path.join(data, 'data');
  const samples = path.join(data, 'Old pack');
  await mkdir(samples, { recursive: true });
  await mkdir(dataDir);
  const file = path.join(samples, 'warm_keys_90bpm_Cmaj.wav');
  await writeFile(file, makeDemo('Melodic', 0, 90).buffer);
  const legacy = {
    samples: [{ id: 'legacy-id', path: file, filename: 'warm_keys_90bpm_Cmaj.wav', name: 'warm_keys_90bpm_Cmaj', root: samples, folder: 'Old pack', overrides: { bpm: 91 } }],
    folders: [{ path: samples, name: 'Old pack' }],
    favorites: ['legacy-id'],
    sets: [{ id: 'set-1', name: 'Kept set', tracks: [{ id: 'legacy-id' }], tempo: 91 }],
    workspace: { tracks: [{ id: 'legacy-id' }], tempo: 91, key: 'C maj', sync: true }
  };
  const raw = JSON.stringify(legacy);
  await writeFile(path.join(dataDir, 'library.json'), raw);
  let server = await startServer(t, { port: 44321, dataDir });
  let lite = await server.getJson('/api/library?lite=1');
  assert.deepEqual(lite.favorites, ['legacy-id']);
  assert.equal(lite.sets[0].name, 'Kept set');
  assert.equal(lite.workspace.key, 'C maj');
  const sample = await server.getJson('/api/samples/legacy-id');
  assert.equal(sample.bpm, 91);
  assert.equal(sample.type, 'Melodic');
  assert.equal((await server.get('/audio/legacy-id')).status, 200);
  assert.equal(await readFile(path.join(dataDir, 'library.pre-sqlite.json'), 'utf8'), raw);
  await assert.rejects(() => access(path.join(dataDir, 'library.json')));
  await server.stop();
  server = await startServer(t, { port: 44321, dataDir });
  lite = await server.getJson('/api/library?lite=1');
  assert.deepEqual(lite.favorites, ['legacy-id']);
  assert.equal(lite.counts.total, 13);
  await server.stop();
});

test('sound routes: render priority, CAF audition, reanalysis by source and HEAD diagnostics', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'sift-sound-'));
  const server = await startServer(t, { port: 44322, dataDir: path.join(data, 'data') });
  const { base, get, getJson, post } = server;
  const samples = path.join(data, 'Pack');
  await mkdir(samples);
  const wav = path.join(data, 'source.wav');
  await writeFile(wav, makeDemo('Melodic', 0, 100).buffer);
  const { execFile } = await import('node:child_process');
  const ffmpeg = process.env.SIFT_FFMPEG || 'ffmpeg';
  await new Promise((resolve, reject) => execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'pcm_s16be', '-f', 'caf', path.join(samples, 'keys_100bpm_Amin.caf')], error => (error ? reject(error) : resolve())));
  assert.equal((await post('/api/scan', { path: samples })).status, 202);
  await waitForScan(server);
  const { items } = await getJson(`/api/samples?source=${encodeURIComponent(samples)}`);
  assert.equal(items.length, 1);
  const caf = items[0];

  // Chromium cannot decode CAF, so /audio serves a WAV copy, with ranges.
  let response = await get(`/audio/${caf.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  const copy = Buffer.from(await response.arrayBuffer());
  assert.equal(copy.toString('ascii', 0, 4), 'RIFF');
  response = await fetch(`${base}/audio/${caf.id}`, { headers: { Range: 'bytes=0-11' } });
  assert.equal(response.status, 206);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('ascii', 8, 12), 'WAVE');
  assert.equal((await fetch(`${base}/audio/${caf.id}`, { method: 'HEAD' })).status, 200);

  // Renders take a priority; prefetches and audible requests share a file.
  const [background, audible] = await Promise.all([
    post('/api/stretch', { id: caf.id, tempo: 120, priority: 'prefetch' }).then(r => r.json()),
    post('/api/stretch', { id: caf.id, tempo: 120, priority: 'now' }).then(r => r.json())
  ]);
  assert.match(background.url, /^\/rendered\/[a-f0-9]{64}\.wav$/);
  assert.equal(audible.url, background.url);
  assert.equal((await post('/api/stretch', { id: caf.id, tempo: 120, priority: 'whenever' })).status, 400);

  // Reanalysis by source.
  response = await post('/api/analysis', { action: 'reanalyze', source: samples });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).total >= 1);
  assert.equal((await post('/api/analysis', { action: 'reanalyze', source: samples, ids: [caf.id] })).status, 400);
  assert.equal((await post('/api/analysis', { action: 'reanalyze', source: 5 })).status, 400);
  await post('/api/analysis', { action: 'pause' });

  response = await fetch(`${base}/api/diagnostics`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  await server.stop();
});
