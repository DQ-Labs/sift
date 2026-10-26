// Checks the Windows build in dist/.
//
//   npm run test:packaged -- --headless   CI: layout, bundled FFmpeg, update metadata, backend
//   npm run test:packaged                 desktop Windows: also full backend tests and GUI smoke tests
import assert from 'node:assert/strict';
import { access, readFile, readdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'win32', 'Run the packaged smoke test on Windows.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const { version } = pkg;
const unpacked = path.resolve('dist', 'win-unpacked');
const resources = path.join(unpacked, 'resources');
const root = path.join(resources, 'app');
const executable = path.join(unpacked, `${pkg.productName}.exe`);

async function checkLayout() {
  assert.equal((await readFile(executable)).toString('ascii', 0, 2), 'MZ');
  const required = ['server.mjs', 'desktop/main.cjs', 'desktop/runtime.cjs', 'desktop/updates.cjs', 'lib/analysis-worker.mjs', 'public/app.js', 'LICENSE', 'THIRD_PARTY.md', 'node_modules/essentia.js/LICENSE', 'node_modules/electron-updater/package.json'];
  for (const file of required) await access(path.join(root, file));
  const files = await readdir(root);
  for (const excluded of ['data', 'sounds', 'test-output', 'tests', 'build', '.git', '.github', '.env', 'CODE-REVIEW-REPORT.md']) {
    assert.ok(!files.includes(excluded), `${excluded} must not ship in the application.`);
  }
  const shipped = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(shipped.version, version);
  assert.equal(shipped.appId, pkg.build.appId);
  console.log('Package layout and identity passed.');
}

async function checkBundledFfmpeg() {
  const directory = path.join(resources, 'ffmpeg');
  for (const file of ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt', 'README.txt', 'SOURCE.txt']) await access(path.join(directory, file));
  const result = spawnSync(process.execPath, ['scripts/check-audio-tools.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, SIFT_FFMPEG: path.join(directory, 'ffmpeg.exe'), SIFT_FFPROBE: path.join(directory, 'ffprobe.exe') },
  });
  assert.equal(result.status, 0, 'The bundled FFmpeg must run and provide the rubberband filter.');
}

async function checkUpdateMetadata() {
  const updateConfig = await readFile(path.join(resources, 'app-update.yml'), 'utf8');
  assert.match(updateConfig, /provider: github/);
  assert.match(updateConfig, /owner: DQ-Labs/);
  assert.match(updateConfig, /repo: sift/);
  const latest = await readFile(path.resolve('dist', 'latest.yml'), 'utf8');
  assert.match(latest, new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(latest, new RegExp(`path: Sift-${version.replace(/\./g, '\\.')}-Setup-x64\\.exe`));
  await access(path.resolve('dist', `Sift-${version}-Setup-x64.exe.blockmap`));
  console.log('Update metadata (app-update.yml, latest.yml, blockmap) passed.');
}

await checkLayout();
await checkBundledFfmpeg();
await checkUpdateMetadata();

if (process.argv.includes('--headless')) {
  const { testPackagedBackend } = await import('./test-packaged-backend.mjs');
  await testPackagedBackend(executable, root);
  console.log('Headless Windows package checks passed. Full FFmpeg and desktop/portable GUI acceptance tests require a desktop Windows machine: npm run test:packaged.');
  process.exit(0);
}

// Run the full API/analysis/stretch/handoff workflow using the shipped Electron
// executable as Node, the packaged source and the bundled FFmpeg.
const bundled = path.join(resources, 'ffmpeg');
const backend = spawnSync(process.execPath, ['--test', 'tests/server.test.mjs'], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, SIFT_TEST_EXECUTABLE: executable, SIFT_TEST_ROOT: root, SIFT_FFMPEG: path.join(bundled, 'ffmpeg.exe'), SIFT_FFPROBE: path.join(bundled, 'ffprobe.exe') },
});
assert.equal(backend.status, 0, 'The packaged application failed its backend smoke test.');

for (const desktop of [executable, path.resolve('dist', `Sift-${version}-Portable-x64.exe`)]) {
  const data = await mkdtemp(path.join(os.tmpdir(), 'sift-desktop-smoke-'));
  const result = spawnSync(desktop, ['--sift-smoke-test', '--disable-gpu'], {
    windowsHide: true,
    stdio: 'inherit',
    timeout: 45000,
    env: { ...process.env, SIFT_DATA_DIR: data, PORT: '44319', SIFT_ANALYSIS_PAUSED: '1', SIFT_FFMPEG: '', SIFT_FFPROBE: '' },
  });
  assert.equal(result.status, 0, `${path.basename(desktop)} did not shut down cleanly: ${result.error?.message || ''}`);
  const status = JSON.parse(await readFile(path.join(data, 'desktop-smoke.json'), 'utf8'));
  assert.equal(status.rendererReady, true);
  assert.equal(status.dataDirectory, data);
  assert.equal(status.ffmpeg, 'bundled', 'The desktop must use its bundled FFmpeg.');
  await assert.rejects(() => fetch('http://127.0.0.1:44319/api/capabilities', { signal: AbortSignal.timeout(2000) }), /fetch failed|timeout/i, 'A packaged desktop left its backend running.');
  console.log(`${path.basename(desktop)}: renderer, preload, bundled FFmpeg, writable data and backend shutdown passed.`);
}
console.log('Packaged runtime, desktop, portable launcher, Essentia worker, FFmpeg processing and handoff smoke tests passed.');
