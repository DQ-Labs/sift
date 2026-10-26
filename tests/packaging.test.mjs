import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { releaseAssetNames, isPrereleaseVersion, assertReleaseVersion } from '../scripts/release-files.mjs';

const require = createRequire(import.meta.url);
const { encodeIco, readIcoDirectory } = require('../scripts/ico.cjs');
const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const upstream = JSON.parse(await read('UPSTREAM-SOURCES.json'));

test('package.json carries the app identity and GitHub update feed', () => {
  assert.equal(pkg.version, '0.4.0-alpha.1');
  assert.equal(pkg.build.appId, 'com.dqlabs.sift');
  assert.equal(pkg.appId, pkg.build.appId);
  assert.equal(pkg.productName, 'Sift');
  assert.equal(pkg.build.productName, pkg.productName);
  assert.equal(pkg.author.name, 'DQ Labs');
  assert.equal(pkg.repository.url, 'https://github.com/DQ-Labs/sift.git');
  assert.equal(pkg.license, 'AGPL-3.0-only');
  assert.deepEqual(pkg.build.publish, [{ provider: 'github' }]);
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater must ship as a runtime dependency');
  assert.ok(!JSON.stringify(pkg).includes('gitlab'), 'no GitLab references remain');
});

test('the bundled FFmpeg is pinned and shipped as an extra resource', () => {
  const pin = upstream.ffmpeg.windows;
  assert.match(pin.url, /^https:\/\/github\.com\/GyanD\/codexffmpeg\/releases\/download\/[\d.]+\/ffmpeg-[\d.]+-essentials_build\.zip$/);
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(upstream.ffmpeg.bundled, true);
  assert.deepEqual(Object.values(pin.files).sort(), ['LICENSE.txt', 'README.txt', 'ffmpeg.exe', 'ffprobe.exe']);
  const resource = pkg.build.extraResources.find(entry => entry.to === 'ffmpeg');
  assert.equal(resource.from, 'build/ffmpeg');
  for (const file of [...Object.values(pin.files), 'SOURCE.txt']) assert.ok(resource.filter.includes(file), `${file} must be packaged`);
  assert.match(pkg.scripts['dist:win'], /fetch-ffmpeg\.mjs && electron-builder/);
});

test('the committed icon is a valid multi-size Windows icon', async () => {
  const icon = await readFile(new URL('../build/icon.ico', import.meta.url));
  const entries = readIcoDirectory(icon);
  const sizes = entries.map(entry => entry.size);
  for (const size of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(size), `icon needs ${size} px`);
  assert.equal(entries.find(entry => entry.size === 256).format, 'png');
  assert.ok(entries.filter(entry => entry.size < 256).every(entry => entry.format === 'dib' && entry.bitCount === 32));
});

test('the icon encoder writes DIB rows bottom-up in BGRA with a mask', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 1, 2, 3, 4]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const ico = encodeIco([{ size: 256, png }, { size: 2, rgba }]);
  const [small, large] = readIcoDirectory(ico);
  assert.equal(small.size, 2);
  assert.equal(large.size, 256);
  assert.deepEqual(ico.subarray(large.offset, large.offset + large.length), png);
  const dib = ico.subarray(small.offset, small.offset + small.length);
  assert.equal(dib.readInt32LE(8), 4, 'double height');
  // Bottom row (third and fourth pixels) comes first, as BGRA.
  assert.deepEqual([...dib.subarray(40, 48)], [255, 0, 0, 0, 3, 2, 1, 4]);
  assert.deepEqual([...dib.subarray(48, 56)], [0, 0, 255, 255, 0, 255, 0, 128]);
  assert.equal(dib.length, 40 + 16 + 8);
  assert.throws(() => encodeIco([{ size: 300, rgba }]), /Invalid icon size/);
});

test('release assets include the updater metadata and both executables', () => {
  assert.deepEqual(releaseAssetNames('0.4.0-alpha.1'), [
    'STUDIO-SETUP.md',
    'Sift-0.4.0-alpha.1-Portable-x64.exe',
    'Sift-0.4.0-alpha.1-Setup-x64.exe',
    'Sift-0.4.0-alpha.1-Setup-x64.exe.blockmap',
    'Sift-0.4.0-alpha.1-Source.tar.gz',
    'latest.yml',
  ]);
  assert.equal(isPrereleaseVersion('0.4.0-alpha.1'), true);
  assert.equal(isPrereleaseVersion('0.4.0'), false);
  assert.throws(() => assertReleaseVersion('0.4.0; rm -rf /'), /Invalid release version/);
  for (const [name, target] of [['nsis', 'Setup'], ['portable', 'Portable']]) {
    assert.equal(pkg.build[name].artifactName, `Sift-\${version}-${target}-\${arch}.\${ext}`);
  }
});

test('GitHub workflows build, test and publish without GitLab', async () => {
  const ci = await read('.github/workflows/ci.yml');
  for (const step of ['apt-get install -y --no-install-recommends ffmpeg', 'npm ci --ignore-scripts', 'npm test', 'npm run test:unit', 'npm run fetch:ffmpeg', 'npm run dist:win', 'npm run test:packaged -- --headless', 'workflow_call']) {
    assert.ok(ci.includes(step), `ci.yml should run ${step}`);
  }
  const release = await read('.github/workflows/release.yml');
  assert.match(release, /tags: \['v\*'\]/);
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(release, /contents: write/);
  await assert.rejects(() => read('.gitlab-ci.yml'), { code: 'ENOENT' });
});
