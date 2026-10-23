// Run with Node; the child uses the same Chromium audio engine as Sift desktop.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {env,stdio:'inherit',windowsHide:true,timeout:60000});
  if(result.error)throw result.error;
  process.exit(result.status===0?0:1);
}

const {app,BrowserWindow} = require('electron');
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'sift-playback-'));
app.setPath('userData',directory);
let scan={running:false,count:0},analysis={running:false,paused:false,pending:0,processed:0,total:0,remaining:0,revision:0};
const publicDir=path.resolve(__dirname,'../public');
const server=require('node:http').createServer((req,res)=>{
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/api/library/status')return json({scan,analysis});
  if(req.url==='/api/library')return json({samples:[],favorites:[],folders:[],sets:[],workspace:{},scan,analysis});
  if(req.url==='/api/analysis'){
    let input='';req.on('data',chunk=>input+=chunk);req.on('end',()=>{analysis.paused=JSON.parse(input).action==='pause';json(analysis);});return;
  }
  if(req.url==='/api/workspace')return json({});
  const filename=req.url==='/'?'index.html':req.url.slice(1);
  if(!['index.html','app.js','workspace.js','timing.js','harmony.js','export-audio.js','library-activity.js','styles.css','favicon.svg'].includes(filename)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.svg')?'image/svg+xml':'text/html');
  res.end(fs.readFileSync(path.join(publicDir,filename)));
});
app.whenReady().then(async()=>{
  let win,code=0;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    win=new BrowserWindow({show:false,width:1380,height:1000,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    const run=script=>win.webContents.executeJavaScript(script);
    const waitFor=condition=>run(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(${condition})resolve(true);else if(Date.now()-start>6000)reject(new Error('Renderer did not reach expected state'));else setTimeout(check,30);};check();})`);
    await waitFor("document.querySelectorAll('#tracks [data-track]').length===4");
    const inspect=()=>run(`({visible:!document.querySelector('#libraryActivity').hidden,title:document.querySelector('#libraryActivityTitle').textContent,detail:document.querySelector('#libraryActivityDetail').textContent,action:document.querySelector('#libraryActivityAction').textContent,value:document.querySelector('#libraryActivityProgress').value,max:document.querySelector('#libraryActivityProgress').max,indeterminate:!document.querySelector('#libraryActivityProgress').hasAttribute('value'),status:document.querySelector('#scanState').textContent,collectionHidden:document.querySelector('#collectionBody').hidden})`);
    assert.equal((await inspect()).visible,false);
    scan={running:true,count:12000,current:'My sample pack/Drums'};
    await waitFor("document.querySelector('#libraryActivityTitle').textContent.includes('Indexing')");
    let ui=await inspect();assert.equal(ui.visible,true);assert.equal(ui.indeterminate,true);assert.equal(ui.collectionHidden,true);
    scan={running:false,count:12000};analysis={running:true,paused:false,pending:2999,remaining:3000,processed:9000,total:12000,failed:0,current:'Dusty drum loop.wav',revision:1};
    await waitFor("document.querySelector('#libraryActivityTitle').textContent.includes('Analyzing')");
    ui=await inspect();assert.equal(ui.value,9000);assert.equal(ui.max,12000);assert.match(ui.detail,/3,000 remaining/);assert.match(ui.status,/Processing/);
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const screenshot=path.resolve('test-output/library-processing.png');fs.mkdirSync(path.dirname(screenshot),{recursive:true});fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
    win.setContentSize(720,900);
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true,'Progress panel must fit the narrow desktop layout');
    fs.writeFileSync(path.resolve('test-output/library-processing-narrow.png'),(await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('#libraryActivityAction').click()");
    await waitFor("document.querySelector('#libraryActivityAction').textContent==='Resume analysis'");
    assert.equal(analysis.paused,true);
    await run("document.querySelector('#libraryActivityAction').click()");
    await waitFor("document.querySelector('#libraryActivityAction').textContent==='Pause analysis'");
    assert.equal(analysis.paused,false);
    analysis={...analysis,running:false,pending:0,remaining:0,processed:12000,revision:2};
    await waitFor("document.querySelector('#libraryActivity').hidden");
    assert.equal((await inspect()).status.trim(),'Library ready');
    console.log('Library activity: indexing, analysis, pause/resume and completion passed.');

    const checks=await run(`(async()=>{
      const {makeCycle,createCycleSource}=await import('/timing.js');let checks=0,worstError=0;
      for(const rate of [22050,44100,48000])for(const tempo of [40,92,97,110,120,123.45,240])for(const repeat of ['auto','bar']){
        const length=Math.round(16*60/tempo*rate),ctx=new OfflineAudioContext(2,length*4,rate);
        const original=ctx.createBuffer(2,rate*2,rate);
        for(let c=0;c<2;c++){const data=original.getChannelData(c);for(let i=0;i<data.length;i++)data[i]=.25*Math.sin(2*Math.PI*(c?660:440)*i/rate);}
        const {buffer}=makeCycle(ctx,original,{bpm:tempo,type:'Melodic'},{timing:{offset:.125,repeat}},{tempo,sync:true,key:null});
        const node=createCycleSource(ctx,buffer);node.connect(ctx.destination);node.start(0);
        const output=await ctx.startRendering();
        for(let c=0;c<2;c++){
          const data=output.getChannelData(c);let energy=0;for(let i=0;i<length;i++)energy+=data[i]*data[i];
          if(Math.sqrt(energy/length)<.02)throw new Error('Test signal must be audible');
          for(let cycle=1;cycle<4;cycle++)for(let i=0;i<length;i++)worstError=Math.max(worstError,Math.abs(data[cycle*length+i]-data[i]));
        }
        // Starting the same prepared buffer again must work after acquisition.
        const replay=new OfflineAudioContext(2,length*3,rate),source=createCycleSource(replay,buffer);
        source.connect(replay.destination);source.start(0);const again=await replay.startRendering();
        for(let c=0;c<2;c++){const reference=output.getChannelData(c),data=again.getChannelData(c);for(let i=0;i<data.length;i++)worstError=Math.max(worstError,Math.abs(data[i]-reference[i]));}
        checks++;
      }
      return {checks,worstError};
    })()`);
    assert.ok(checks.worstError<1e-6,`Repeated cycles changed PCM by ${checks.worstError}`);
    assert.deepEqual(errors,[]);
    console.log(`${checks.checks} stereo loop/replay cases passed at 22.05/44.1/48 kHz, including 92 and 110 BPM; worst PCM difference ${checks.worstError}.`);
    console.log(`Progress panel screenshot: ${screenshot}`);
  }catch(error){console.error(error?.stack||String(error));code=1;}
  finally{win?.destroy();server.close();app.exit(code);}
});
