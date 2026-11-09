import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the node:test suites. `--unit` leaves out the suites that need FFmpeg.
//
// When `npm run fetch:ffmpeg` has put the pinned FFmpeg in build/ffmpeg, the
// tests use it, so they exercise the same build that ships. SIFT_FFMPEG and
// SIFT_FFPROBE, when already set, win.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const audioSuites = ['dsp.test.mjs', 'server.test.mjs'];
const unitOnly = process.argv.includes('--unit');

function bundledToolEnvironment(env) {
  const directory = path.join(root, 'build', 'ffmpeg');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = path.join(directory, `ffmpeg${suffix}`);
  const ffprobe = path.join(directory, `ffprobe${suffix}`);
  if (env.SIFT_FFMPEG || env.SIFT_FFPROBE || !existsSync(ffmpeg) || !existsSync(ffprobe)) return env;
  const pathName = Object.keys(env).find(name => name.toLowerCase() === 'path') || 'PATH';
  return {
    ...env,
    SIFT_FFMPEG: ffmpeg,
    SIFT_FFPROBE: ffprobe,
    // Some fixtures are made by calling `ffmpeg` directly.
    [pathName]: `${directory}${path.delimiter}${env[pathName] || ''}`
  };
}

const names = (await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort();
const files = names.filter(name => !unitOnly || !audioSuites.includes(name)).map(name => `tests/${name}`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  env: unitOnly ? process.env : bundledToolEnvironment(process.env),
  stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
