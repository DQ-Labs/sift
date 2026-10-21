import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseAssetNames } from './release-files.mjs';

const directory=path.resolve('dist');
const {version}=JSON.parse(await readFile('package.json','utf8'));
const files=releaseAssetNames(version);
const lines=[];
for(const name of files)lines.push(`${createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex')}  ${name}`);
await writeFile(path.join(directory,'SHA256SUMS.txt'),lines.join('\n')+'\n');
console.log(`Checksummed ${files.length} release assets.`);
