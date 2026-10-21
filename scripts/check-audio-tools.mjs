import { spawnSync } from 'node:child_process';

for(const [name,command,args,expected]of [
  ['FFmpeg',process.env.SIFT_FFMPEG||'ffmpeg',['-hide_banner','-h','filter=rubberband'],/^Filter rubberband/m],
  ['FFprobe',process.env.SIFT_FFPROBE||'ffprobe',['-version'],/^ffprobe version/m]
]){
  const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:20000});
  const output=(result.stdout||'')+'\n'+(result.stderr||'');
  if(result.status!==0||!expected.test(output))throw new Error(`${name} check failed: executable=${command}; status=${result.status}; error=${result.error?.message||'none'}; output=${output.slice(0,8000)}`);
  console.log(`${name} verified: ${output.split(/\r?\n/)[0]}`);
}
