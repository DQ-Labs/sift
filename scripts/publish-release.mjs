// Publishes dist/ as a GitHub release for the pushed v<version> tag.
//
//   node scripts/publish-release.mjs --check-tag   only verify the tag
//   node scripts/publish-release.mjs               verify assets and publish
//
// Runs in .github/workflows/release.yml with GH_TOKEN set to the workflow token.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './download.mjs';
import { CHECKSUM_FILE, isPrereleaseVersion, releaseAssetNames } from './release-files.mjs';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF_TYPE !== 'tag' || tag !== `v${version}`) {
  throw new Error(`Push a tag that matches package.json: expected v${version}, got ${tag || 'no tag'}.`);
}
if (process.argv.includes('--check-tag')) {
  console.log(`Tag ${tag} matches package.json.`);
  process.exit(0);
}

const directory = path.resolve('dist');
const assets = releaseAssetNames(version);
const manifest = (await readFile(path.join(directory, CHECKSUM_FILE), 'utf8')).split('\n');
for (const name of assets) {
  const line = `${await sha256File(path.join(directory, name))}  ${name}`;
  if (!manifest.includes(line)) throw new Error(`Checksum missing or wrong for ${name}.`);
}

const repository = process.env.GITHUB_REPOSITORY;
const notes = [
  `Windows x64 build of Sift ${version}. Choose **Sift-${version}-Setup-x64.exe** (installs per user, updates itself) or the **Portable** EXE (notifies about updates). FFmpeg with Rubber Band and Node.js are included. Builds are unsigned: Windows SmartScreen may ask you to confirm the first launch.`,
  '',
  `Your library, gems, sets and exports live in \`%APPDATA%\\Sift\` and survive updates. Setup and studio checks: [STUDIO-SETUP.md](https://github.com/${repository}/blob/${tag}/docs/STUDIO-SETUP.md). Verify downloads against ${CHECKSUM_FILE}.`,
  '',
  `AGPL-3.0-only. Bundled FFmpeg is GPLv3; the source archive includes Sift's source plus the Essentia.js and FFmpeg sources. See THIRD_PARTY.md and UPSTREAM-SOURCES.json.`,
  '',
].join('\n');
const notesFile = path.join(directory, 'release-notes.md');
await writeFile(notesFile, notes);

const args = [
  'release', 'create', tag,
  ...assets.map(name => path.join(directory, name)),
  path.join(directory, CHECKSUM_FILE),
  '--title', `Sift ${version}`,
  '--notes-file', notesFile,
  '--generate-notes',
  '--verify-tag',
];
if (isPrereleaseVersion(version)) args.push('--prerelease');
const result = spawnSync('gh', args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`gh release create failed (${result.status}).`);
console.log(`Published ${tag}.`);
