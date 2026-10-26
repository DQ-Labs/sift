// Drives the real front end in headless Chromium against a real Sift server:
// once as-is (older full-library API) and once with the query API contract
// mocked on top. Skipped when Playwright or its Chromium is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installContractMock } from './ui-contract-mock.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Optional: CI and Windows runs do not install Playwright.
}

async function launchBrowser() {
  try {
    return await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  } catch {
    return null;
  }
}

async function startServer(t, port) {
  const data = await mkdtemp(path.join(os.tmpdir(), 'sift-ui-'));
  const proc = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: data,
    env: { ...process.env, PORT: String(port), SIFT_DATA_DIR: path.join(data, 'data'), SIFT_ANALYSIS_PAUSED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(async () => {
    // The server saves on shutdown; let it finish before removing its data.
    if (proc.exitCode === null) {
      proc.kill();
      await once(proc, 'exit');
    }
    await rm(data, { recursive: true, force: true });
  });
  await once(proc.stdout, 'data');
  return `http://127.0.0.1:${port}`;
}

async function openApp(browser, base, setup = async () => {}) {
  const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const result = await setup(page);
  await page.goto(base);
  await page.waitForFunction(() => document.querySelectorAll('#tracks [data-track]').length === 4);
  return { page, errors, result };
}

// Makes the real server look like one from before the query API: ?lite=1 is
// ignored, the query routes and diagnostics are missing, and capabilities
// carry no version.
async function installLegacyServer(page, base) {
  const missing = ['/api/samples', '/api/combination', '/api/diagnostics'];
  await page.route(url => url.href.startsWith(base), async route => {
    const url = new URL(route.request().url());
    if (missing.some(prefix => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
    }
    if (url.pathname === '/api/library' && url.searchParams.has('lite')) return route.continue({ url: `${base}/api/library` });
    if (url.pathname === '/api/capabilities') {
      const response = await route.fetch();
      const { version, ...rest } = await response.json();
      return route.fulfill({ response, json: rest });
    }
    return route.continue();
  });
}

const trackNames = page => page.$$eval('.track-name', elements => elements.map(element => element.textContent));
const catalogState = page => page.evaluate(async () => {
  const { catalog, state } = await import('/state.js');
  return { mode: catalog.mode, held: catalog.samples.length, cached: catalog.cache.size, variety: state.variety };
});
const isPlaying = page => page.waitForFunction(() => document.querySelector('#workspace').classList.contains('playing'), null, { timeout: 30000 });

async function newBatchAndPlay(page) {
  await page.click('#shuffle');
  await page.waitForFunction(() => [...document.querySelectorAll('.track-name')].every(element => element.textContent !== 'Add a sample'));
  await page.click('#playMix');
  await isPlaying(page);
}

// Waits until the prefetched candidate for a layer has been rendered.
async function rerollWhenPrefetched(page, index) {
  // waitForFunction does not await async predicates, so poll in the page.
  await page.evaluate(async layer => {
    const { candidateReady } = await import('/workbench.js');
    const started = Date.now();
    while (!candidateReady(layer)) {
      if (Date.now() - started > 30000) throw new Error('The reroll candidate was not prefetched');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, index);
  const before = (await trackNames(page))[index];
  const started = Date.now();
  await page.click(`[data-track="${index}"] [data-action="reroll"]`);
  await isPlaying(page);
  const elapsed = Date.now() - started;
  const after = (await trackNames(page))[index];
  assert.notEqual(after, before, `reroll changes layer ${index + 1}`);
  return elapsed;
}

async function exportAndHandoff(page) {
  const setsBefore = Number(await page.textContent('#setCount'));
  const download = page.waitForEvent('download');
  await page.click('#exportMix');
  assert.match((await download).suggestedFilename(), /^Sift-.*bpm\.wav$/);
  await page.waitForFunction(count => Number(document.querySelector('#setCount').textContent) === count, setsBefore + 1);
  await page.click('#handoffButton');
  assert.equal(await page.textContent('#handoffDialog h2'), 'Send to DAW');
  assert.match(await page.textContent('#handoffDialog .daw-notes'), /FL Studio/);
  await page.click('#prepareHandoff');
  await page.waitForSelector('#handoffResults:not([hidden])', { timeout: 30000 });
  assert.equal(await page.$$eval('.handoff-file', files => files.length), 4);
  await page.waitForFunction(count => Number(document.querySelector('#setCount').textContent) === count, setsBefore + 2);
  await page.click('[data-close="handoffDialog"]');
  await page.click('[data-view="sets"]');
  const names = await page.$$eval('.saved-set h3', elements => elements.map(element => element.textContent));
  assert.match(names[0], /^Stems · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(names[1], /^Mix export · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  await page.click('[data-view="discover"]');
}

test('front end against a server without the query API', { skip: !chromium && 'Playwright is not installed' }, async t => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('Chromium is not available');
  t.after(() => browser.close());
  const base = await startServer(t, 44331);
  const { page, errors } = await openApp(browser, base, page => installLegacyServer(page, base));

  assert.deepEqual(await catalogState(page).then(({ mode, held }) => ({ mode, held })), { mode: 'legacy', held: 12 });
  assert.equal(await page.$eval('#versionLabel', element => element.hidden), true, 'no version without /api/capabilities.version');

  await newBatchAndPlay(page);
  const elapsed = await rerollWhenPrefetched(page, 1);
  assert.ok(elapsed < 1500, `prefetched reroll restarted in ${elapsed} ms`);
  await page.click('#playMix');

  // Off the demo tempo every layer is stretched: background renders ask for
  // prefetch priority and audible layers for 'now'.
  const priorities = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/stretch')) priorities.push(request.postDataJSON().priority);
  });
  await page.fill('#tempo', '100');
  await page.press('#tempo', 'Enter');
  await page.click('#playMix');
  await isPlaying(page);
  await rerollWhenPrefetched(page, 2);
  await page.click('#playMix');
  assert.ok(priorities.includes('now') && priorities.includes('prefetch'), `priorities sent: ${priorities.join(', ')}`);
  assert.ok(priorities.every(priority => priority === 'now' || priority === 'prefetch'));

  // The timing dialog offers first beat (default) or first sound.
  await page.click('[data-track="0"] [data-action="timing"]');
  assert.equal(await page.$eval('#timingStartMode', element => element.value), 'beat');
  await page.selectOption('#timingStartMode', 'sound');
  await page.click('#timingForm [type=submit]');
  await page.waitForFunction(() => !document.querySelector('#timingDialog').open);
  const timed = await (await fetch(`${base}/api/library`)).json();
  assert.deepEqual(timed.workspace.tracks[0].timing, { offset: null, repeat: 'auto', start: 'sound' });

  // Variety persists in the workspace.
  await page.$eval('#variety', element => {
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.textContent('#varietyValue'), 'Safe');
  await page.waitForTimeout(500);
  const saved = await (await fetch(`${base}/api/library`)).json();
  assert.equal(saved.workspace.variety, 0);

  await exportAndHandoff(page);

  // Collection, search and keyboard navigation.
  await page.click('#toggleCollection');
  assert.equal(await page.textContent('#resultCount'), '12 samples');
  await page.fill('#search', 'drum');
  await page.waitForFunction(() => document.querySelectorAll('.sample-row').length < 12);
  await page.fill('#search', '');
  await page.waitForFunction(() => document.querySelectorAll('.sample-row').length === 12);
  await page.click('.sample-row .row-play');
  const first = await page.textContent('#previewName');
  await page.click('main', { position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(name => document.querySelector('#previewName').textContent !== name, first);

  // Overwriting a set asks first; cancelling keeps the dialog open.
  await page.click('#saveSet');
  await page.fill('#setName', 'Keeper');
  await page.click('#saveForm [type=submit]');
  await page.waitForFunction(() => !document.querySelector('#saveDialog').open);
  await page.click('#saveSet');
  await page.fill('#setName', 'keeper');
  await page.click('#saveForm [type=submit]');
  await page.waitForSelector('#confirmDialog[open]');
  await page.click('#confirmCancel');
  assert.equal(await page.$eval('#saveDialog', dialog => dialog.open), true);
  await page.click('#saveForm [type=submit]');
  await page.click('#confirmAccept');
  await page.waitForFunction(() => !document.querySelector('#saveDialog').open);

  // Destructive library tools confirm first.
  await page.click('#libraryTools summary');
  for (const id of ['#cleanupLibrary', '#cleanupExports']) {
    await page.click(id);
    await page.waitForSelector('#confirmDialog[open]');
    await page.click('#confirmCancel');
  }
  assert.equal(await page.textContent('#exportCleanupResult'), '');
  await page.click('#cleanupExports');
  await page.click('#confirmAccept');
  await page.waitForFunction(() => /removed/.test(document.querySelector('#exportCleanupResult').textContent));

  await page.click('#aboutButton');
  await page.waitForSelector('#aboutDialog[open]');
  await page.waitForTimeout(300);
  assert.equal(await page.$eval('#diagnosticsBlock', element => element.hidden), true, 'no diagnostics button when the route is missing');
  assert.deepEqual(errors, []);
});

test('front end against the query API contract with a large catalogue', { skip: !chromium && 'Playwright is not installed' }, async t => {
  const browser = await launchBrowser();
  if (!browser) return t.skip('Chromium is not available');
  t.after(() => browser.close());
  const base = await startServer(t, 44332);
  const { page, errors, result: stats } = await openApp(browser, base, page => installContractMock(page, base, { synthetic: 20000, version: '0.4.0-alpha.1' }));

  const initial = await catalogState(page);
  assert.equal(initial.mode, 'remote');
  assert.equal(initial.held, 0, 'no full sample array in the browser');
  assert.equal(stats.fullLibrary, 0, 'GET /api/library without ?lite=1 is never used');
  await page.waitForFunction(() => !document.querySelector('#versionLabel').hidden);
  assert.equal(await page.textContent('#versionLabel'), 'SIFT / 0.4.0-alpha.1');
  assert.equal(await page.textContent('#sampleCount'), '20,000');

  await page.click('#toggleCollection');
  await page.waitForFunction(() => document.querySelector('#resultCount').textContent === '20,000 samples');
  assert.equal(await page.textContent('#pageNumber'), '1 / 400');
  await page.click('#nextPage');
  await page.waitForFunction(() => document.querySelector('#pageNumber').textContent === '2 / 400');
  assert.match(await page.textContent('.sample-row .row-title'), /^Pack 00050 /);
  await page.fill('#search', '01999');
  await page.waitForFunction(() => document.querySelector('#resultCount').textContent === '1 sample');
  await page.fill('#search', '');
  await page.waitForFunction(() => document.querySelector('#resultCount').textContent === '20,000 samples');

  // Gems are stored server-side and listed through the same paged query.
  await page.click('.sample-row .favorite');
  await page.click('[data-view="gems"]');
  await page.waitForFunction(() => document.querySelector('#resultCount').textContent === '1 sample');
  await page.click('[data-view="discover"]');

  await newBatchAndPlay(page);
  const names = await trackNames(page);
  assert.ok(names.every(name => name.startsWith('Pack ')), 'combination came from the server-side source');
  const elapsed = await rerollWhenPrefetched(page, 2);
  assert.ok(elapsed < 1500, `prefetched reroll restarted in ${elapsed} ms`);
  await page.click('#playMix');

  // Off the demo tempo every layer is stretched: background renders ask for
  // prefetch priority and audible layers for 'now'.
  const priorities = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/stretch')) priorities.push(request.postDataJSON().priority);
  });
  await page.fill('#tempo', '100');
  await page.press('#tempo', 'Enter');
  await page.click('#playMix');
  await isPlaying(page);
  await rerollWhenPrefetched(page, 2);
  await page.click('#playMix');
  assert.ok(priorities.includes('now') && priorities.includes('prefetch'), `priorities sent: ${priorities.join(', ')}`);
  assert.ok(priorities.every(priority => priority === 'now' || priority === 'prefetch'));

  // The timing dialog offers first beat (default) or first sound.
  await page.click('[data-track="0"] [data-action="timing"]');
  assert.equal(await page.$eval('#timingStartMode', element => element.value), 'beat');
  await page.selectOption('#timingStartMode', 'sound');
  await page.click('#timingForm [type=submit]');
  await page.waitForFunction(() => !document.querySelector('#timingDialog').open);
  const timed = await (await fetch(`${base}/api/library`)).json();
  assert.deepEqual(timed.workspace.tracks[0].timing, { offset: null, repeat: 'auto', start: 'sound' });
  assert.ok(stats.combinations >= 2);

  await exportAndHandoff(page);

  await page.click('#aboutButton');
  await page.waitForSelector('#aboutDialog[open]');
  await page.waitForFunction(() => !document.querySelector('#diagnosticsBlock').hidden);
  const download = page.waitForEvent('download');
  await page.click('#saveDiagnostics');
  assert.equal((await download).suggestedFilename(), 'sift-diagnostics-test.zip');

  const final = await catalogState(page);
  assert.equal(final.held, 0);
  assert.ok(final.cached < 200, `browser cache holds ${final.cached} samples`);
  assert.equal(stats.fullLibrary, 0);
  assert.ok(stats.largestResponse < 200000, `largest catalogue response was ${stats.largestResponse} bytes`);
  assert.deepEqual(errors, []);
});
