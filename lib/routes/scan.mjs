import { realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readJson, sendJson, httpError } from '../http.mjs';

const pickerScript = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$picker = New-Object System.Windows.Forms.FolderBrowserDialog',
  "$picker.Description = 'Choose a sample folder or drive for Sift'",
  '$picker.ShowNewFolderButton = $false',
  "if ($picker.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($picker.SelectedPath) }"
].join('; ');

function pickFolder() {
  return new Promise((resolve, reject) => {
    const picker = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', pickerScript], { windowsHide: true });
    let output = '';
    picker.stdout.on('data', chunk => {
      output += chunk.toString();
    });
    picker.on('error', reject);
    picker.on('close', code => {
      if (code) reject(new Error('Folder picker could not open. Paste the path instead.'));
      else resolve(output.trim());
    });
  });
}

// `D:` names the current directory on that drive; a source means its root.
export function sourcePath(value, { platform = process.platform } = {}) {
  if (platform === 'win32' && /^[A-Za-z]:$/.test(value)) return `${value}\\`;
  return value;
}

export function registerScanRoutes(router, app) {
  const { scanner } = app;
  const busy = () => httpError('A library scan or cleanup is already running', 409);

  router.get('/api/scan', ({ res }) => sendJson(res, scanner.status));

  router.post('/api/scan', async ({ req, res }) => {
    if (scanner.busy) throw busy();
    const input = await readJson(req);
    const requested = typeof input.path === 'string' ? sourcePath(input.path.trim()) : '';
    if (!requested || !path.isAbsolute(requested)) throw httpError('Enter an absolute folder path.');
    const root = await realpath(requested);
    if (!(await stat(root)).isDirectory()) throw httpError('Choose a folder.');
    if (scanner.busy) throw busy();
    void scanner.scan(root);
    return sendJson(res, { started: true }, 202);
  });

  router.post('/api/cancel-scan', async ({ req, res }) => {
    await readJson(req);
    return sendJson(res, scanner.cancel());
  });

  router.post('/api/pick-folder', async ({ req, res }) => {
    await readJson(req);
    if (process.platform !== 'win32') throw httpError('Paste a folder path instead.');
    return sendJson(res, { path: await pickFolder() });
  });
}
