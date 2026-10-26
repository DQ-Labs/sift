import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ffmpeg, ffprobe } from './media.mjs';

function readPackage() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
}

const packageJson = readPackage();
export const appInfo = {
  name: packageJson.build?.productName || 'Sift',
  version: packageJson.version || null,
  license: packageJson.license || null
};

// Runs a short command and collects its output. Never rejects.
export function runCommand(command, args, { timeout = 15000, maxOutput = 65536 } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ found: false, code: null, stdout, stderr, error: error.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(0, maxOutput);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(0, maxOutput);
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ found: error.code !== 'ENOENT' && error.code !== 'EACCES', code: null, stdout, stderr, error: error.message });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ found: true, code, stdout, stderr, error: null });
    });
  });
}

const versionOf = (name, output) => new RegExp(`^${name} version (\\S+)`, 'm').exec(output)?.[1] || null;

// FFmpeg and FFprobe presence, versions and the Rubber Band filter.
export async function checkMediaTools({ ffmpegPath = ffmpeg, ffprobePath = ffprobe, run = runCommand } = {}) {
  const versionRun = await run(ffmpegPath, ['-hide_banner', '-version']);
  const found = versionRun.found && versionRun.code === 0;
  const filterRun = found ? await run(ffmpegPath, ['-hide_banner', '-h', 'filter=rubberband']) : null;
  const probeRun = await run(ffprobePath, ['-hide_banner', '-version']);
  const probeFound = probeRun.found && probeRun.code === 0;
  return {
    found,
    rubberband: found && filterRun.code === 0 && /^Filter rubberband/m.test(filterRun.stdout),
    version: found ? versionOf('ffmpeg', versionRun.stdout) : null,
    ffprobe: { found: probeFound, version: probeFound ? versionOf('ffprobe', probeRun.stdout) : null },
    output: {
      version: versionRun.stdout || versionRun.stderr || versionRun.error || '',
      rubberband: filterRun ? filterRun.stdout || filterRun.stderr || filterRun.error || '' : 'Not checked: FFmpeg was not found.',
      ffprobe: probeRun.stdout || probeRun.stderr || probeRun.error || ''
    }
  };
}

// Checks the media tools once in the background and shares the answer.
export class MediaToolStatus {
  constructor(check = checkMediaTools) {
    this.check = check;
    this.result = null;
    this.promise = null;
  }

  start() {
    this.promise ||= this.check().then(result => {
      this.result = result;
      return result;
    });
    return this.promise;
  }

  // The finished check, or null if it is still running after waitMs.
  async get(waitMs = 1000) {
    const pending = this.start();
    if (this.result) return this.result;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), waitMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // The capabilities shape: null fields while the check is unfinished.
  async summary(waitMs) {
    const result = await this.get(waitMs);
    if (!result) return { found: null, rubberband: null, version: null };
    return { found: result.found, rubberband: result.rubberband, version: result.version };
  }
}
