import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const {version}=JSON.parse(await readFile('package.json','utf8'));
const {CI_COMMIT_TAG:tag,CI_API_V4_URL:api,CI_PROJECT_ID:project,CI_JOB_TOKEN:token,CI_PROJECT_URL:projectUrl}=process.env;
if(tag!==`v${version}`||!api||!project||!token)throw new Error('A matching version tag and GitLab CI job credentials are required to publish a release.');
const directory=path.resolve('dist'),files=(await readdir(directory)).filter(name=>/\.(exe|tar\.gz|md)$/.test(name)||name==='SHA256SUMS.txt').sort();
const manifest=await readFile(path.join(directory,'SHA256SUMS.txt'),'utf8');
for(const name of files.filter(name=>name!=='SHA256SUMS.txt')){
  const hash=createHash('sha256').update(await readFile(path.join(directory,name))).digest('hex');
  if(!manifest.split('\n').includes(`${hash}  ${name}`))throw new Error(`Checksum missing or wrong for ${name}.`);
}
const links=[];
for(const name of files){
  const url=`${api}/projects/${project}/packages/generic/sift/${version}/${encodeURIComponent(name)}`;
  const response=await fetch(url,{method:'PUT',headers:{'JOB-TOKEN':token},body:await readFile(path.join(directory,name)),signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`Upload of ${name} failed (${response.status}).`);
  links.push({name,url,direct_asset_path:`/${name}`,link_type:'package'});console.log(`Uploaded ${name}`);
}
const notes=`Windows x64 studio test build.\n\nChoose the Setup installer or Portable executable. Node.js is included. Install FFmpeg with Rubber Band separately (see STUDIO-SETUP.md). App data is stored in %APPDATA%/Sift. These are unsigned test builds.\n\nAGPL-3.0-only. Source archive, upstream provenance and SHA-256 checksums are attached. See THIRD_PARTY.md and UPSTREAM-SOURCES.json for dependencies. This release is a standalone Electron application; it is not a VST3 and does not provide native ASIO output.\n\nSource: ${projectUrl}/-/tree/${tag}`;
const response=await fetch(`${api}/projects/${project}/releases`,{method:'POST',headers:{'JOB-TOKEN':token,'Content-Type':'application/json'},body:JSON.stringify({name:`Sift ${version}`,tag_name:tag,description:notes,assets:{links}})});
if(!response.ok)throw new Error(`Release creation failed (${response.status}). Uploaded packages were retained for inspection.`);
console.log(`Published ${tag}.`);
