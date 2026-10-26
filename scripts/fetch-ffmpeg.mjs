// Downloads the pinned Windows FFmpeg build named in UPSTREAM-SOURCES.json,
// verifies its SHA-256 and places ffmpeg.exe, ffprobe.exe and the build's
// licence under build/ffmpeg, which electron-builder ships as resources/ffmpeg.
//
//   node scripts/fetch-ffmpeg.mjs [--force]
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified } from './download.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'build', 'ffmpeg');
const downloadDirectory = path.join(root, 'build', 'downloads');
const stampFile = path.join(outputDirectory, '.archive-sha256');

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function alreadyFetched(pin) {
  try {
    if ((await readFile(stampFile, 'utf8')).trim() !== pin.sha256) return false;
  } catch {
    return false;
  }
  for (const name of Object.values(pin.files)) {
    if (!(await exists(path.join(outputDirectory, name)))) return false;
  }
  return true;
}

function extract(archive, directory, members) {
  // Windows 10+ ships bsdtar, which reads zip archives. Name it explicitly so
  // a GNU tar from Git for Windows on PATH can't shadow it.
  const result = process.platform === 'win32'
    ? spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', directory, ...members], { stdio: 'inherit' })
    : spawnSync('unzip', ['-q', '-o', archive, ...members, '-d', directory], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Extracting ${path.basename(archive)} failed (${result.status}).`);
}

function sourceNotice(ffmpeg) {
  return [
    `FFmpeg ${ffmpeg.build}`,
    `Built by ${ffmpeg.builder}`,
    `Licence: ${ffmpeg.license}`,
    '',
    `Binary archive: ${ffmpeg.windows.url}`,
    `Archive SHA-256: ${ffmpeg.windows.sha256}`,
    `FFmpeg source: ${ffmpeg.source.url}`,
    `FFmpeg revision: ${ffmpeg.source.revision}`,
    '',
    ffmpeg.externalLibraries,
    'The Sift source archive attached to each GitHub release includes the FFmpeg source tarball.',
    'See THIRD_PARTY.md and UPSTREAM-SOURCES.json in the Sift repository: https://github.com/DQ-Labs/sift',
    '',
  ].join('\r\n');
}

async function main() {
  const { ffmpeg } = JSON.parse(await readFile(path.join(root, 'UPSTREAM-SOURCES.json'), 'utf8'));
  const pin = ffmpeg.windows;
  if (!process.argv.includes('--force') && (await alreadyFetched(pin))) {
    console.log(`FFmpeg ${ffmpeg.version} is already in build/ffmpeg.`);
    return;
  }

  const archive = path.join(downloadDirectory, path.basename(new URL(pin.url).pathname));
  console.log(`Fetching ${pin.url}`);
  await downloadVerified({ url: pin.url, sha256: pin.sha256, destination: archive });

  const scratch = await mkdtemp(path.join(downloadDirectory, 'extract-'));
  try {
    const members = Object.keys(pin.files).map(name => `${pin.archiveRoot}/${name}`);
    extract(archive, scratch, members);
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });
    for (const [from, to] of Object.entries(pin.files)) {
      await copyFile(path.join(scratch, pin.archiveRoot, from), path.join(outputDirectory, to));
    }
    await writeFile(path.join(outputDirectory, 'SOURCE.txt'), sourceNotice(ffmpeg));
    await writeFile(stampFile, pin.sha256 + '\n');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`FFmpeg ${ffmpeg.version} placed in build/ffmpeg.`);
}

await main();
