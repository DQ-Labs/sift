const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const TOOLS = [
  { key: 'ffmpeg', name: 'ffmpeg', variable: 'SIFT_FFMPEG' },
  { key: 'ffprobe', name: 'ffprobe', variable: 'SIFT_FFPROBE' },
];

// Candidate executables in priority order: the copy bundled with Sift, then
// SIFT_FFMPEG / SIFT_FFPROBE, then WinGet's user links, then PATH.
function toolCandidates({ name, variable, bundledDirectory, env = process.env, platform = process.platform, exists = existsSync }) {
  const file = platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  if (bundledDirectory) {
    const bundled = path.join(bundledDirectory, file);
    if (exists(bundled)) candidates.push({ source: 'bundled', path: bundled });
  }
  if (env[variable]) candidates.push({ source: 'environment', path: env[variable] });
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const winget = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', file);
    if (exists(winget)) candidates.push({ source: 'winget', path: winget });
  }
  candidates.push({ source: 'path', path: name });
  return candidates;
}

function run(executable, args) {
  const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  return { ok: result.status === 0, output: `${result.stdout || ''}\n${result.stderr || ''}`, error: result.error };
}

function versionFrom(output) {
  const match = /^\S+ version (\S+)/m.exec(output);
  return match ? match[1] : null;
}

// Returns the version string when the executable works, otherwise null. FFmpeg
// must also provide the rubberband filter, which tempo and key matching need.
function verifyTool(key, executable, runner = run) {
  const version = runner(executable, ['-hide_banner', '-version']);
  if (!version.ok) return null;
  if (key === 'ffmpeg') {
    const filter = runner(executable, ['-hide_banner', '-h', 'filter=rubberband']);
    if (!filter.ok || !/^Filter rubberband/m.test(filter.output)) return null;
  }
  return versionFrom(version.output) || 'unknown';
}

// Picks the first working candidate for each tool. A broken or filter-less
// bundled copy falls through to the next option instead of blocking startup.
function resolveAudioTools({ bundledDirectory, env = process.env, platform = process.platform, exists = existsSync, verify = verifyTool }) {
  const resolved = {};
  const rejected = [];
  for (const tool of TOOLS) {
    resolved[tool.key] = null;
    for (const candidate of toolCandidates({ ...tool, bundledDirectory, env, platform, exists })) {
      const version = verify(tool.key, candidate.path);
      if (version) {
        resolved[tool.key] = { ...candidate, version };
        break;
      }
      rejected.push({ tool: tool.key, ...candidate });
    }
  }
  return { ...resolved, rejected };
}

const MISSING_TOOLS_MESSAGE = [
  'Sift could not find a working FFmpeg with the Rubber Band filter.',
  '',
  'The FFmpeg bundled with Sift is missing or failed to run. Reinstall Sift, or install FFmpeg yourself:',
  '',
  'winget install --id Gyan.FFmpeg.Essentials --exact',
  '',
  'You can also set SIFT_FFMPEG and SIFT_FFPROBE to the full paths of working executables.',
].join('\n');

module.exports = { toolCandidates, verifyTool, resolveAudioTools, versionFrom, MISSING_TOOLS_MESSAGE };
