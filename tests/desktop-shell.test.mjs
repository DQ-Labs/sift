import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toolCandidates, resolveAudioTools, verifyTool, versionFrom } = require('../desktop/audio-tools.cjs');
const { parseVersion, compareVersions, pickNewerRelease, releaseNotesText, updateMode, launchCheckEnabled, UpdateController } = require('../desktop/updates.cjs');
const { aboutDetail, menuTemplate } = require('../desktop/menu.cjs');
const { identity, createIdentity, parseGitHubRepository } = require('../desktop/identity.cjs');
const { DesktopSettings } = require('../desktop/settings.cjs');

const winEnv = { LOCALAPPDATA: 'C:\\Users\\studio\\AppData\\Local' };

test('audio tools prefer the bundled copy, then SIFT_* variables, then WinGet, then PATH', () => {
  const everything = () => true;
  const candidates = toolCandidates({ name: 'ffmpeg', variable: 'SIFT_FFMPEG', bundledDirectory: 'C:\\Sift\\resources\\ffmpeg', env: { ...winEnv, SIFT_FFMPEG: 'D:\\tools\\ffmpeg.exe' }, platform: 'win32', exists: everything });
  assert.deepEqual(candidates.map(candidate => candidate.source), ['bundled', 'environment', 'winget', 'path']);
  assert.equal(candidates[0].path, path.join('C:\\Sift\\resources\\ffmpeg', 'ffmpeg.exe'));
  assert.equal(candidates[1].path, 'D:\\tools\\ffmpeg.exe');
  assert.equal(candidates[2].path, path.join(winEnv.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
  assert.equal(candidates[3].path, 'ffmpeg');

  const nothing = toolCandidates({ name: 'ffprobe', variable: 'SIFT_FFPROBE', bundledDirectory: 'C:\\Sift\\resources\\ffmpeg', env: winEnv, platform: 'win32', exists: () => false });
  assert.deepEqual(nothing.map(candidate => candidate.source), ['path']);
  const linux = toolCandidates({ name: 'ffmpeg', variable: 'SIFT_FFMPEG', bundledDirectory: '/opt/sift/ffmpeg', env: winEnv, platform: 'linux', exists: everything });
  assert.deepEqual(linux.map(candidate => candidate.source), ['bundled', 'path']);
  assert.equal(linux[0].path, path.join('/opt/sift/ffmpeg', 'ffmpeg'));
});

test('a broken bundled FFmpeg falls through to the next working candidate', () => {
  const bundled = path.join('C:\\Sift\\resources\\ffmpeg', 'ffmpeg.exe');
  const result = resolveAudioTools({
    bundledDirectory: 'C:\\Sift\\resources\\ffmpeg',
    env: { ...winEnv, SIFT_FFMPEG: 'D:\\ffmpeg.exe' },
    platform: 'win32',
    exists: file => file.startsWith('C:\\Sift'),
    verify: (key, executable) => (executable === bundled ? null : `${key}-ok`),
  });
  assert.equal(result.ffmpeg.source, 'environment');
  assert.equal(result.ffmpeg.path, 'D:\\ffmpeg.exe');
  assert.equal(result.ffprobe.source, 'bundled');
  assert.deepEqual(result.rejected.map(item => `${item.tool}:${item.source}`), ['ffmpeg:bundled']);

  const none = resolveAudioTools({ bundledDirectory: null, env: {}, platform: 'win32', exists: () => false, verify: () => null });
  assert.equal(none.ffmpeg, null);
  assert.equal(none.ffprobe, null);
});

test('FFmpeg verification requires the rubberband filter', () => {
  const runner = filterOutput => (executable, args) => (args.includes('-version')
    ? { ok: true, output: `${executable} version 8.1.2-essentials_build-www.gyan.dev Copyright` }
    : { ok: true, output: filterOutput });
  assert.equal(verifyTool('ffmpeg', 'ffmpeg', runner('Filter rubberband\n  Apply time-stretching')), '8.1.2-essentials_build-www.gyan.dev');
  assert.equal(verifyTool('ffmpeg', 'ffmpeg', runner("Unknown filter 'rubberband'.")), null);
  assert.equal(verifyTool('ffprobe', 'ffprobe', runner('')), '8.1.2-essentials_build-www.gyan.dev');
  assert.equal(verifyTool('ffprobe', 'ffprobe', () => ({ ok: false, output: '' })), null);
  assert.equal(versionFrom('ffprobe version 6.1.1-3ubuntu5 Copyright (c) 2007-2023'), '6.1.1-3ubuntu5');
});

test('versions order like semver, prereleases included', () => {
  const ordered = ['0.3.0-alpha.6', '0.4.0-alpha.1', '0.4.0-alpha.2', '0.4.0-alpha.10', '0.4.0-beta.1', '0.4.0-rc.1', '0.4.0', '0.4.1', '1.0.0'];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1, `${ordered[index - 1]} < ${ordered[index]}`);
    assert.equal(compareVersions(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(compareVersions('v0.4.0-alpha.1', '0.4.0-alpha.1'), 0);
  assert.equal(parseVersion('not-a-version'), null);
  assert.throws(() => compareVersions('0.4', '0.4.0'));
});

test('portable update check offers the newest suitable release', () => {
  const releases = [
    { tag_name: 'v0.5.0-alpha.1', prerelease: true, draft: false, html_url: 'https://github.com/DQ-Labs/sift/releases/tag/v0.5.0-alpha.1', body: 'alpha notes' },
    { tag_name: 'v0.4.0', prerelease: false, draft: false, html_url: 'https://github.com/DQ-Labs/sift/releases/tag/v0.4.0', body: 'stable notes' },
    { tag_name: 'v0.6.0', prerelease: false, draft: true, html_url: 'draft' },
    { tag_name: 'nightly', prerelease: true, draft: false },
  ];
  assert.deepEqual(pickNewerRelease(releases, '0.4.0-alpha.1'), { version: '0.5.0-alpha.1', url: 'https://github.com/DQ-Labs/sift/releases/tag/v0.5.0-alpha.1', notes: 'alpha notes' });
  assert.equal(pickNewerRelease(releases, '0.4.0'), null, 'stable builds are not offered prereleases');
  assert.equal(pickNewerRelease(releases, '0.3.9').version, '0.4.0');
  assert.equal(pickNewerRelease(releases, '0.5.0-alpha.1'), null);
  assert.equal(pickNewerRelease({ message: 'rate limited' }, '0.4.0'), null);
});

test('release notes become short plain text', () => {
  const html = '<h2>What&#39;s new</h2><ul><li>Bundled FFmpeg</li><li>Auto&nbsp;update &amp; About</li></ul><p>Thanks</p>';
  assert.equal(releaseNotesText(html), "What's new\n\n• Bundled FFmpeg\n• Auto update & About\n\nThanks");
  assert.equal(releaseNotesText([{ version: '1', note: '<p>One</p>' }, { version: '2', note: 'Two' }]), 'One\n\nTwo');
  assert.equal(releaseNotesText(null), '');
  const long = releaseNotesText('word '.repeat(400), 50);
  assert.ok(long.length <= 52 && long.endsWith('…'));
});

test('update mode distinguishes installer, portable and development builds', () => {
  const resourcesPath = path.join('C:', 'Sift', 'resources');
  const hasUpdateConfig = file => file === path.join(resourcesPath, 'app-update.yml');
  assert.equal(updateMode({ packaged: false, env: {}, resourcesPath, exists: hasUpdateConfig }), 'development');
  assert.equal(updateMode({ packaged: true, env: {}, resourcesPath, exists: hasUpdateConfig }), 'installer');
  assert.equal(updateMode({ packaged: true, env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Sift.exe' }, resourcesPath, exists: hasUpdateConfig }), 'portable');
  assert.equal(updateMode({ packaged: true, env: {}, resourcesPath, exists: () => false }), 'portable');

  const settings = values => ({ get: name => values[name] });
  assert.equal(launchCheckEnabled({ mode: 'installer', settings: settings({ checkForUpdates: true }), env: {} }), true);
  assert.equal(launchCheckEnabled({ mode: 'installer', settings: settings({ checkForUpdates: false }), env: {} }), false);
  assert.equal(launchCheckEnabled({ mode: 'portable', settings: settings({ checkForUpdates: true }), env: { SIFT_DISABLE_UPDATE_CHECK: '1' } }), false);
  assert.equal(launchCheckEnabled({ mode: 'installer', settings: settings({ checkForUpdates: true }), env: {}, smokeTest: true }), false);
  assert.equal(launchCheckEnabled({ mode: 'development', settings: settings({ checkForUpdates: true }), env: {} }), false);
});

function fakeDialogs(responses) {
  const shown = [];
  return {
    shown,
    dialog: {
      showMessageBox: async (...args) => {
        const options = args.at(-1);
        shown.push(options);
        return { response: responses.shift() ?? 0 };
      },
    },
  };
}

function memorySettings(values = {}) {
  return { values, get: name => values[name], set: (name, value) => { values[name] = value; } };
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

test('installer updates download and install only after the user agrees', async () => {
  const calls = [];
  const autoUpdater = {
    on() {},
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.4.0-alpha.2', releaseNotes: '<p>Faster rerolls</p>' } }),
    downloadUpdate: async () => calls.push('download'),
    quitAndInstall: (silent, runAfter) => calls.push(`install:${silent}:${runAfter}`),
  };
  const { dialog, shown } = fakeDialogs([0, 0]);
  const controller = new UpdateController({
    identity, mode: 'installer', settings: memorySettings(), logger: quietLogger, dialog, shell: {}, getWindow: () => null,
    beforeInstall: async () => calls.push('stop-backend'), loadAutoUpdater: () => autoUpdater,
  });
  await controller.check({ manual: false });
  assert.deepEqual(calls, ['download', 'stop-backend', 'install:false:true']);
  assert.equal(autoUpdater.autoDownload, false);
  assert.match(shown[0].message, /0\.4\.0-alpha\.2 is available/);
  assert.match(shown[0].detail, /Faster rerolls/);
  assert.match(shown[1].message, /ready to install/);
});

test('a skipped version is not offered again on launch but is on a manual check', async () => {
  const settings = memorySettings();
  const autoUpdater = {
    on() {},
    checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: '0.4.0-alpha.2' } }),
    downloadUpdate: async () => assert.fail('must not download'),
  };
  const { dialog, shown } = fakeDialogs([2, 1]);
  const controller = new UpdateController({ identity, mode: 'installer', settings, logger: quietLogger, dialog, shell: {}, getWindow: () => null, beforeInstall: async () => {}, loadAutoUpdater: () => autoUpdater });
  await controller.check({ manual: false });
  assert.equal(settings.values.skippedVersion, '0.4.0-alpha.2');
  await controller.check({ manual: false });
  assert.equal(shown.length, 1);
  await controller.check({ manual: true });
  assert.equal(shown.length, 2);
});

test('portable builds only link to the release page', async () => {
  const opened = [];
  const fetchImpl = async url => {
    assert.equal(url, identity.releasesApiUrl);
    return { ok: true, json: async () => [{ tag_name: 'v9.0.0', html_url: `${identity.releasesUrl}/tag/v9.0.0`, body: '**Big** release' }] };
  };
  const { dialog, shown } = fakeDialogs([0]);
  const controller = new UpdateController({ identity, mode: 'portable', settings: memorySettings(), logger: quietLogger, dialog, shell: { openExternal: async url => opened.push(url) }, getWindow: () => null, beforeInstall: async () => {}, fetchImpl });
  await controller.check({ manual: true });
  assert.deepEqual(opened, [`${identity.releasesUrl}/tag/v9.0.0`]);
  assert.match(shown[0].detail, /portable build does not update itself/);

  const offsite = async () => ({ ok: true, json: async () => [{ tag_name: 'v9.0.0', html_url: 'https://example.com/evil' }] });
  const second = new UpdateController({ identity, mode: 'portable', settings: memorySettings(), logger: quietLogger, dialog: fakeDialogs([0]).dialog, shell: { openExternal: async url => opened.push(url) }, getWindow: () => null, beforeInstall: async () => {}, fetchImpl: offsite });
  await second.check({ manual: true });
  assert.equal(opened.at(-1), identity.releasesUrl);
});

test('failed and up-to-date checks only speak up when asked', async () => {
  const failing = async () => ({ ok: false, status: 403, statusText: 'rate limit exceeded' });
  const launch = fakeDialogs([]);
  const controller = new UpdateController({ identity, mode: 'portable', settings: memorySettings(), logger: quietLogger, dialog: launch.dialog, shell: {}, getWindow: () => null, beforeInstall: async () => {}, fetchImpl: failing });
  await controller.check({ manual: false });
  assert.equal(launch.shown.length, 0);
  const manual = fakeDialogs([]);
  controller.dialog = manual.dialog;
  await controller.check({ manual: true });
  assert.match(manual.shown[0].detail, /403/);

  const current = async () => ({ ok: true, json: async () => [{ tag_name: `v${identity.version}` }] });
  const upToDate = fakeDialogs([]);
  const latest = new UpdateController({ identity, mode: 'development', settings: memorySettings(), logger: quietLogger, dialog: upToDate.dialog, shell: {}, getWindow: () => null, beforeInstall: async () => {}, fetchImpl: current });
  await latest.check({ manual: true });
  assert.match(upToDate.shown[0].message, /latest version/);
});

test('identity comes from package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(identity.appId, 'com.dqlabs.sift');
  assert.equal(identity.appId, pkg.build.appId, 'build.appId and the runtime appId must match');
  assert.equal(identity.productName, pkg.build.productName);
  assert.equal(identity.version, pkg.version);
  assert.equal(identity.publisher, 'DQ Labs');
  assert.equal(identity.repositoryUrl, 'https://github.com/DQ-Labs/sift');
  assert.equal(identity.newIssueUrl, 'https://github.com/DQ-Labs/sift/issues/new/choose');
  assert.deepEqual(parseGitHubRepository('git@github.com:DQ-Labs/sift.git'), { owner: 'DQ-Labs', repo: 'sift' });
  assert.throws(() => parseGitHubRepository('https://gitlab.com/JF2B/sift.git'), /not a GitHub URL/);
  assert.equal(createIdentity({ ...pkg, author: 'Someone' }).publisher, 'Someone');
});

test('About lists versions, FFmpeg source, licence and data folder; Help has the required items', () => {
  const detail = aboutDetail({
    identity,
    versions: { electron: '44.9.2', chrome: '150.0', node: '24.22.0' },
    audioTools: { ffmpeg: { source: 'bundled', version: '8.1.2-essentials_build-www.gyan.dev' }, ffprobe: null },
    dataDirectory: 'C:\\Users\\studio\\AppData\\Roaming\\Sift',
    updateMode: 'installer',
  });
  for (const expected of [`Version ${identity.version}`, 'Electron 44.9.2', 'Node.js 24.22.0', 'FFmpeg 8.1.2-essentials_build-www.gyan.dev (bundled with Sift)', 'FFprobe not found', 'AGPL-3.0-only', 'Data folder: C:\\Users\\studio\\AppData\\Roaming\\Sift']) {
    assert.ok(detail.includes(expected), `About should include ${expected}`);
  }

  const actions = new Proxy({}, { get: () => () => {} });
  const help = mode => menuTemplate({ identity, actions, updateMode: mode, checkOnLaunch: true }).find(menu => menu.label === 'Help').submenu;
  const labels = help('installer').map(item => item.label).filter(Boolean);
  for (const expected of ['About Sift', 'Open data folder', 'View logs', 'Check for updates…', 'Check for updates on launch']) assert.ok(labels.includes(expected), expected);
  assert.equal(help('installer').find(item => item.type === 'checkbox').checked, true);
  assert.ok(!help('development').some(item => item.type === 'checkbox'));
  const template = menuTemplate({ identity, actions, updateMode: 'portable', checkOnLaunch: false });
  assert.ok(template.some(menu => menu.role === 'editMenu'), 'clipboard shortcuts need the Edit menu');
});

test('desktop settings persist and survive a damaged file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sift-settings-'));
  const settings = new DesktopSettings(directory);
  assert.equal(settings.get('checkForUpdates'), true);
  settings.set('checkForUpdates', false);
  assert.equal(new DesktopSettings(directory).get('checkForUpdates'), false);
  await writeFile(path.join(directory, 'desktop-settings.json'), '{broken');
  assert.equal(new DesktopSettings(directory).get('checkForUpdates'), true);
});
