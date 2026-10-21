const { app, BrowserWindow, ipcMain, nativeImage, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { openSync, realpathSync, lstatSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..'),port=Number(process.env.PORT||4317),base=`http://127.0.0.1:${port}`;
const data=process.env.SIFT_DATA_DIR||path.join(root,'data');
app.setName('Sift');mkdirSync(path.join(data,'desktop-profile'),{recursive:true});app.setPath('userData',path.join(data,'desktop-profile'));
app.commandLine.appendSwitch('force-renderer-accessibility');
let win,store;const registered=new Map();
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(async()=>{
    try{
      const { HandoffStore }=await import('../lib/handoff.mjs');store=new HandoffStore(path.join(data,'exports'));
      let ready=false;
      try{const response=await fetch(`${base}/api/capabilities`,{signal:AbortSignal.timeout(1500)});ready=response.ok&&(await response.json()).handoff===1;if(!ready)throw new Error('Restart the local Sift server to load handoff support.');}
      catch(error){if(error.message.startsWith('Restart'))throw error;
        const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,detached:true,stdio:['ignore',openSync(path.join(root,'sift.log'),'a'),openSync(path.join(root,'sift-error.log'),'a')]});child.unref();
        for(let n=0;n<80;n++){try{const r=await fetch(`${base}/api/capabilities`,{signal:AbortSignal.timeout(500)});if(r.ok&&(await r.json()).handoff===1){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
      }
      if(!ready)throw new Error('Sift could not start. Check sift-error.log.');
      win=new BrowserWindow({title:'Sift',width:1380,height:900,minWidth:720,minHeight:600,backgroundColor:'#171919',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==base)event.preventDefault();});
      win.webContents.session.setPermissionRequestHandler((contents,permission,callback)=>callback(false));
      win.once('ready-to-show',()=>{win.show();win.focus();});
      win.on('closed',()=>{win=null;registered.clear();});
      await win.loadURL(base);
      win.show();win.focus();
    }catch(error){dialog.showErrorBox('Sift desktop',error.message);app.quit();}
  });
  app.on('window-all-closed',()=>app.quit());
}
function trusted(event){return win&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&new URL(event.senderFrame.url).origin===base;}
ipcMain.handle('sift:prepare-drag',async(event,id)=>{
  if(!trusted(event))throw new Error('Untrusted drag request.');
  const batch=await store.ready(id),files=[];
  for(const file of batch.files)files.push({index:file.index,path:await store.file(id,file.name)});
  if(!trusted(event))throw new Error('Window changed.');
  registered.set(id,files);return {ready:true};
});
function dragIcon(){
  const size=48,bytes=Buffer.alloc(size*size*4);
  for(let y=4;y<44;y++)for(let x=4;x<44;x++){
    const bar=Math.abs(x-24)%8<3&&Math.abs(y-24)<(7+((x*3)%13));
    const i=(y*size+x)*4;bytes[i]=bar?135:30;bytes[i+1]=bar?184:35;bytes[i+2]=bar?217:30;bytes[i+3]=240;
  }
  return nativeImage.createFromBitmap(bytes,{width:size,height:size,scaleFactor:1});
}
ipcMain.on('sift:start-drag',(event,id,index)=>{
  if(!trusted(event))return;
  try{
    const batch=registered.get(id);if(!batch)throw new Error('Prepare this handoff before dragging.');
    if(index!=='all'&&(!Number.isInteger(index)||index<0||index>3))throw new Error('Invalid stem.');
    const selected=index==='all'?batch:batch.filter(file=>file.index===index);if(!selected.length)throw new Error('Unknown stem.');
    const directory=realpathSync(store.batchPath(id));
    const files=selected.map(file=>{if(lstatSync(file.path).isSymbolicLink()||path.dirname(realpathSync(file.path))!==directory)throw new Error('Invalid drag file.');return file.path;});
    event.sender.startDrag({files,icon:dragIcon()});
    console.log(`Sift native drag: ${files.length} WAV file(s)`);
  }catch(error){console.error('Sift drag failed:',error.message);}
});
