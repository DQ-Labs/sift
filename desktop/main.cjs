const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const { spawn } = require('node:child_process');
const { openSync, closeSync, realpathSync, lstatSync, mkdirSync, existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { desktopDataPath } = require('./runtime.cjs');
const { identity } = require('./identity.cjs');
const { resolveAudioTools, MISSING_TOOLS_MESSAGE } = require('./audio-tools.cjs');
const { DesktopSettings } = require('./settings.cjs');
const { createLogger } = require('./logger.cjs');
const { UpdateController, updateMode, launchCheckEnabled } = require('./updates.cjs');
const { aboutDetail, menuTemplate } = require('./menu.cjs');

const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 4317);
const base = `http://127.0.0.1:${port}`;
const data = desktopDataPath({ packaged: app.isPackaged, root, appData: app.getPath('appData') });
const smokeTest = app.isPackaged && process.argv.includes('--sift-smoke-test');

app.setName(identity.productName);
if (process.platform === 'win32') app.setAppUserModelId(identity.appId);
mkdirSync(path.join(data, 'desktop-profile'), { recursive: true });
app.setPath('userData', path.join(data, 'desktop-profile'));
app.commandLine.appendSwitch('force-renderer-accessibility');

const logger = createLogger(path.join(data, 'desktop.log'));
let win;
let store;
let serverChild;
let backendStopping = null;
let audioTools = null;
let updates;
const registered = new Map();

// --- Backend lifecycle ----------------------------------------------------

// Asks the packaged backend to flush and exit, killing it after five seconds.
function stopBackend() {
  if (!serverChild || serverChild.exitCode !== null) return Promise.resolve();
  if (backendStopping) return backendStopping;
  const child = serverChild;
  backendStopping = new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 5000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      serverChild = null;
      resolve();
    });
    if (child.connected) child.send({ type: 'sift:shutdown' }, error => { if (error) child.kill(); });
    else child.kill();
  });
  return backendStopping;
}

// A portable build extracts its code to a temporary directory. Stop its own
// backend before Electron exits so that code is not removed from under it.
app.on('before-quit', event => {
  if (!app.isPackaged || !serverChild || serverChild.exitCode !== null) return;
  event.preventDefault();
  stopBackend().then(() => app.quit());
});

// Points the server at a working FFmpeg/FFprobe through SIFT_FFMPEG and
// SIFT_FFPROBE, which the spawned server inherits.
function configureAudioTools() {
  const bundledDirectory = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg') : path.join(root, 'build', 'ffmpeg');
  audioTools = resolveAudioTools({ bundledDirectory });
  for (const rejected of audioTools.rejected) logger.warn(`Rejected ${rejected.tool} (${rejected.source}): ${rejected.path}`);
  if (audioTools.ffmpeg) process.env.SIFT_FFMPEG = audioTools.ffmpeg.path;
  if (audioTools.ffprobe) process.env.SIFT_FFPROBE = audioTools.ffprobe.path;
  logger.info(`FFmpeg: ${audioTools.ffmpeg?.path || 'missing'}; FFprobe: ${audioTools.ffprobe?.path || 'missing'}`);
  if (app.isPackaged && (!audioTools.ffmpeg || !audioTools.ffprobe)) throw new Error(MISSING_TOOLS_MESSAGE);
}

async function fetchCapabilities(timeout) {
  const response = await fetch(`${base}/api/capabilities`, { signal: AbortSignal.timeout(timeout) });
  return response.ok ? response.json() : {};
}

function startServer() {
  const out = openSync(path.join(data, 'sift.log'), 'a');
  const err = openSync(path.join(data, 'sift-error.log'), 'a');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SIFT_DATA_DIR: data };
  if (app.isPackaged) env.SIFT_DESKTOP_EXE = process.execPath;
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: app.isPackaged ? data : root,
    env,
    windowsHide: true,
    detached: !app.isPackaged,
    stdio: app.isPackaged ? ['ignore', out, err, 'ipc'] : ['ignore', out, err],
  });
  closeSync(out);
  closeSync(err);
  child.on('error', error => console.error('Sift server failed:', error.message));
  // A development desktop shares a server with the browser launcher, so it is
  // left running; a packaged desktop owns its server.
  if (app.isPackaged) serverChild = child;
  else child.unref();
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetchCapabilities(500)).handoff === 1) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function connectToServer() {
  let capabilities;
  try {
    capabilities = await fetchCapabilities(1500);
  } catch {
    startServer();
    if (!(await waitForServer())) throw new Error('Sift could not start. Check sift-error.log (Help → View logs).');
    return;
  }
  if (capabilities.handoff !== 1 || path.resolve(capabilities.dataDirectory || '') !== data) {
    throw new Error('Restart the local Sift server: the current instance uses a different version or catalogue.');
  }
}

// --- Help menu actions ----------------------------------------------------

function openDataFolder() {
  shell.openPath(data);
}

function viewLogs() {
  const log = path.join(data, 'sift.log');
  if (existsSync(log)) shell.showItemInFolder(log);
  else shell.openPath(data);
}

async function showAbout() {
  const message = `${identity.productName} ${identity.version}`;
  const detail = aboutDetail({ identity, versions: process.versions, audioTools, dataDirectory: data, updateMode: updates.mode });
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: `About ${identity.productName}`,
    message,
    detail,
    buttons: ['OK', 'Copy details', 'Open data folder'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) clipboard.writeText(`${message}\n${detail}`);
  if (response === 2) openDataFolder();
}

function installMenu(settings) {
  const template = menuTemplate({
    identity,
    updateMode: updates.mode,
    checkOnLaunch: settings.get('checkForUpdates'),
    actions: {
      about: showAbout,
      openDataFolder,
      viewLogs,
      checkForUpdates: () => updates.check({ manual: true }),
      setCheckOnLaunch: checked => settings.set('checkForUpdates', checked),
      openReleases: () => shell.openExternal(identity.releasesUrl),
      reportIssue: () => shell.openExternal(identity.newIssueUrl),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Window ---------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    show: false,
    title: identity.productName,
    width: 1380,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#171919',
    // Packaged builds take the icon from the executable.
    icon: app.isPackaged ? undefined : path.join(root, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== base) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  win.once('ready-to-show', () => {
    if (!smokeTest) {
      win.show();
      win.focus();
    }
  });
  win.on('closed', () => {
    win = null;
    registered.clear();
  });
}

async function runSmokeTest() {
  const ready = await win.webContents.executeJavaScript(`new Promise(resolve=>{const started=Date.now();const check=()=>{if(document.querySelectorAll('#tracks [data-track]').length===4&&window.siftDesktop?.prepareDrag)resolve(true);else if(Date.now()-started>10000)resolve(false);else setTimeout(check,100);};check();})`);
  if (!ready) throw new Error('Packaged desktop renderer or preload did not initialize.');
  writeFileSync(path.join(data, 'desktop-smoke.json'), JSON.stringify({ rendererReady: true, dataDirectory: data, ffmpeg: audioTools?.ffmpeg?.source || null }));
}

async function start() {
  const settings = new DesktopSettings(data);
  updates = new UpdateController({
    identity,
    mode: updateMode({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    settings,
    logger,
    dialog,
    shell,
    getWindow: () => win,
    beforeInstall: stopBackend,
  });
  logger.info(`Starting ${identity.productName} ${identity.version} (${updates.mode})`);

  configureAudioTools();
  const { HandoffStore } = await import('../lib/handoff.mjs');
  store = new HandoffStore(path.join(data, 'exports'));
  await connectToServer();

  installMenu(settings);
  createWindow();
  await win.loadURL(base);
  if (smokeTest) {
    await runSmokeTest();
    app.quit();
    return;
  }
  win.show();
  win.focus();

  if (launchCheckEnabled({ mode: updates.mode, settings, smokeTest })) {
    setTimeout(() => updates.check({ manual: false }), 5000).unref();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(async () => {
    try {
      await start();
    } catch (error) {
      logger.error(error);
      if (smokeTest) {
        console.error(error.message);
        process.exitCode = 1;
      } else {
        dialog.showErrorBox('Sift', error.message);
      }
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
}

// --- Native stem drag -----------------------------------------------------

function trusted(event) {
  return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && new URL(event.senderFrame.url).origin === base;
}

ipcMain.handle('sift:prepare-drag', async (event, id) => {
  if (!trusted(event)) throw new Error('Untrusted drag request.');
  const batch = await store.ready(id);
  const files = [];
  for (const file of batch.files) files.push({ index: file.index, path: await store.file(id, file.name) });
  if (!trusted(event)) throw new Error('Window changed.');
  registered.set(id, files);
  return { ready: true };
});

function dragIcon() {
  const size = 48;
  const bytes = Buffer.alloc(size * size * 4);
  for (let y = 4; y < 44; y++) {
    for (let x = 4; x < 44; x++) {
      const bar = Math.abs(x - 24) % 8 < 3 && Math.abs(y - 24) < 7 + ((x * 3) % 13);
      const i = (y * size + x) * 4;
      bytes[i] = bar ? 135 : 30;
      bytes[i + 1] = bar ? 184 : 35;
      bytes[i + 2] = bar ? 217 : 30;
      bytes[i + 3] = 240;
    }
  }
  return nativeImage.createFromBitmap(bytes, { width: size, height: size, scaleFactor: 1 });
}

ipcMain.on('sift:start-drag', (event, id, index) => {
  if (!trusted(event)) return;
  try {
    const batch = registered.get(id);
    if (!batch) throw new Error('Prepare this handoff before dragging.');
    if (index !== 'all' && (!Number.isInteger(index) || index < 0 || index > 3)) throw new Error('Invalid stem.');
    const selected = index === 'all' ? batch : batch.filter(file => file.index === index);
    if (!selected.length) throw new Error('Unknown stem.');
    const directory = realpathSync(store.batchPath(id));
    const files = selected.map(file => {
      if (lstatSync(file.path).isSymbolicLink() || path.dirname(realpathSync(file.path)) !== directory) throw new Error('Invalid drag file.');
      return file.path;
    });
    event.sender.startDrag({ files, icon: dragIcon() });
    console.log(`Sift native drag: ${files.length} WAV file(s)`);
  } catch (error) {
    console.error('Sift drag failed:', error.message);
  }
});
