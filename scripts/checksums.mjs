// Writes dist/SHA256SUMS.txt for every release asset.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256File } from './download.mjs';
import { CHECKSUM_FILE, releaseAssetNames } from './release-files.mjs';

const directory = path.resolve('dist');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const lines = [];
for (const name of releaseAssetNames(version)) {
  lines.push(`${await sha256File(path.join(directory, name))}  ${name}`);
}
await writeFile(path.join(directory, CHECKSUM_FILE), lines.join('\n') + '\n');
console.log(`Checksummed ${lines.length} release assets.`);
