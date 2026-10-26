// Builds dist/Sift-<version>-Source.tar.gz from the committed tree plus the
// upstream sources the binaries need: the Essentia.js wrapper at its npm
// gitHead and the FFmpeg release tarball for the bundled FFmpeg build.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified } from './download.mjs';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Release tag ${process.env.GITHUB_REF_NAME} must match package.json version v${version}.`);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed.`);
}

async function fetchUnpinned(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

await mkdir('.source-work', { recursive: true });
await mkdir('dist', { recursive: true });
const staging = await mkdtemp(path.resolve('.source-work', 'build-'));
try {
  const working = path.join(staging, `Sift-${version}`);
  const upstreamDirectory = path.join(working, 'upstream');
  await mkdir(upstreamDirectory, { recursive: true });

  const trackedTar = path.join(staging, 'tracked-source.tar');
  run('git', ['archive', '--format=tar', `--output=${trackedTar}`, 'HEAD']);
  run('tar', ['-xf', trackedTar, '-C', working]);

  const upstream = JSON.parse(await readFile('UPSTREAM-SOURCES.json', 'utf8'));
  const essentia = upstream['essentia.js'];
  await fetchUnpinned(essentia.source, path.join(upstreamDirectory, `essentia.js-${essentia.revision}.tar.gz`));

  const ffmpeg = upstream.ffmpeg;
  const ffmpegName = path.basename(new URL(ffmpeg.source.url).pathname);
  // TODO(pin): copy the hash this prints from the first CI run into
  // UPSTREAM-SOURCES.json; allowUnpinned then stops applying.
  const ffmpegSource = await downloadVerified({ url: ffmpeg.source.url, sha256: ffmpeg.source.sha256, destination: path.join(upstreamDirectory, ffmpegName), allowUnpinned: true });

  await writeFile(path.join(upstreamDirectory, 'README.txt'), [
    `essentia.js-${essentia.revision}.tar.gz: Essentia.js wrapper sources at the npm package gitHead.`,
    `${ffmpegName}: FFmpeg ${ffmpeg.version} source for the bundled ${ffmpeg.build} binaries (${ffmpeg.source.revision}), SHA-256 ${ffmpegSource.sha256}.`,
    'UPSTREAM-SOURCES.json and THIRD_PARTY.md describe build provenance and its limitations.',
    '',
  ].join('\n'));

  run('tar', ['-czf', path.resolve('dist', `Sift-${version}-Source.tar.gz`), '-C', staging, `Sift-${version}`]);
  await copyFile('docs/STUDIO-SETUP.md', 'dist/STUDIO-SETUP.md');
  console.log('Created source archive and studio setup guide.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
