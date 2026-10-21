import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const {version}=JSON.parse(await readFile('package.json','utf8'));
if(process.env.CI_COMMIT_TAG&&process.env.CI_COMMIT_TAG!==`v${version}`)throw new Error('Release tag must match package.json version.');
await mkdir('.source-work',{recursive:true});
const staging=await mkdtemp(path.resolve('.source-work','build-'));
const working=path.join(staging,`Sift-${version}`);await mkdir(working,{recursive:true});await mkdir('dist',{recursive:true});
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',windowsHide:true});if(r.status!==0)throw new Error(`${command} failed.`);}
const sourceTar=path.join(staging,'tracked-source.tar');
run('git',['archive','--format=tar',`--output=${sourceTar}`,'HEAD']);
run('tar',['-xf',sourceTar,'-C',working]);
const upstream=JSON.parse(await readFile('UPSTREAM-SOURCES.json','utf8'))['essentia.js'];
const response=await fetch(upstream.source,{signal:AbortSignal.timeout(120000)});
if(!response.ok)throw new Error(`Essentia.js source download failed (${response.status}).`);
await mkdir(path.join(working,'upstream'),{recursive:true});
await writeFile(path.join(working,'upstream',`essentia.js-${upstream.revision}.tar.gz`),Buffer.from(await response.arrayBuffer()));
await writeFile(path.join(working,'upstream','README.txt'),'Essentia.js wrapper sources match the npm package gitHead. Read UPSTREAM-SOURCES.json for upstream C++ build provenance and build instructions.\n');
run('tar',['-czf',path.resolve('dist',`Sift-${version}-Source.tar.gz`),'-C',path.dirname(working),path.basename(working)]);
await copyFile('docs/STUDIO-SETUP.md','dist/STUDIO-SETUP.md');
console.log('Created source archive and studio setup guide.');
