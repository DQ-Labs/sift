import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory=path.resolve('dist');
const files=(await readdir(directory)).filter(name=>/\.(exe|tar\.gz|md)$/.test(name)).sort();
if(!files.some(name=>name.includes('-Setup-'))||!files.some(name=>name.includes('-Portable-'))||!files.some(name=>name.includes('-Source.')))throw new Error('Installer, portable build and source archive are required before publishing checksums.');
const lines=[];
for(const name of files)lines.push(`${createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex')}  ${name}`);
await writeFile(path.join(directory,'SHA256SUMS.txt'),lines.join('\n')+'\n');
console.log(`Checksummed ${files.length} release assets.`);
