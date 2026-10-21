import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Audio integration is covered by npm test on Linux and by the local Windows
// acceptance tests. The hosted Windows server lacks desktop multimedia DLLs.
const files=(await readdir('tests')).filter(name=>name.endsWith('.test.mjs')&&!['dsp.test.mjs','server.test.mjs'].includes(name));
const result=spawnSync(process.execPath,['--test',...files.map(name=>`tests/${name}`)],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
