import { createReadStream, existsSync, openSync, closeSync } from 'node:fs';
import { mkdir, writeFile, stat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { extensions, tagsFromName, wavInfo, makeDemo } from './lib/audio.mjs';
import { AnalysisQueue, effectiveMetadata } from './lib/analysis.mjs';
import { StretchCache } from './lib/media.mjs';
import { refreshSampleMetadata } from './lib/metadata.mjs';
import { openLibrary, checkMissingSamples } from './lib/library.mjs';
import { normalizeWorkspace } from './public/workspace.js';
import { parseKey, renderPlan } from './public/harmony.js';
import { SampleIndex } from './lib/sample-index.mjs';
import { listenLoopback } from './lib/loopback.mjs';
import { HandoffStore, maxStemBytes } from './lib/handoff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SIFT_DATA_DIR || path.join(here, 'data');
const port = Number(process.env.PORT || 4317);
await mkdir(dataDir, { recursive: true });
const { db, recovery, persist } = await openLibrary(dataDir);
if (recovery) console.warn(`${recovery.message} ${recovery.preserved.join(', ')}`);
const demoIndex = new SampleIndex(db.samples);
const demoDir = path.join(dataDir, 'demo');
await mkdir(demoDir, { recursive: true });
const demoNames = { Drums: ['Dust break', 'Loose pocket', 'Midnight hats'], Bass: ['Round sub', 'Low current', 'Warm foundation'], Melodic: ['After hours keys', 'Glass arpeggio', 'Faded chords'], Texture: ['Tape atmosphere', 'Soft focus', 'Room tone'] };
for (const [type, names] of Object.entries(demoNames)) {
  for (let variant = 0; variant < names.length; variant++) {
    const filename = `${names[variant].replaceAll(' ', '_')}_92bpm${type === 'Drums' ? '' : '_Amin'}.wav`;
    const filepath = path.join(demoDir, filename), { id } = await demoIndex.identify(filepath);
    if (!db.samples.some(s => s.id === id)) {
      const demo = makeDemo(type, variant); await writeFile(filepath, demo.buffer);
      db.samples.push({ id, path: filepath, filename, name: names[variant], type, bpm: 92, key: type === 'Drums' ? null : 'A min', duration: demo.duration, rate: 22050, channels: 1, bits: 16, size: demo.buffer.length, peaks: demo.peaks, folder: 'Sift demo collection', demo: true });
      demoIndex.remember(db.samples.at(-1));
    }
  }
}
for(const sample of db.samples) refreshSampleMetadata(sample);
await persist();
let scan = { running: false, count: 0, skipped: 0, error: null, cancelled: false, phase: null, current: null };
let cleaning = false;
for(const sample of db.samples) Object.assign(sample,effectiveMetadata(sample));
const analysis = new AnalysisQueue({samples:()=>db.samples,persist,paused:db.analysisPaused || process.env.SIFT_ANALYSIS_PAUSED==='1'});
const stretchCache = new StretchCache(path.join(dataDir,'stretch-cache'));
const handoffs = new HandoffStore(path.join(dataDir,'exports'));
analysis.enqueue(db.samples);

async function scanFolder(root) {
  scan = { running: true, count: 0, skipped: 0, error: null, cancelled: false, phase: 'indexing', current: path.basename(root) || root };
  try {
    const stack = [root], index = new SampleIndex(db.samples);
    while (stack.length && !scan.cancelled) {
      const dir = stack.pop(); let entries; scan.current = path.relative(root, dir) || path.basename(root) || root;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { scan.skipped++; continue; }
      for (const entry of entries) {
        if (scan.cancelled) break;
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const filepath = path.join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(filepath); continue; }
        if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const info = await stat(filepath), { id, old } = await index.identify(filepath, info);
          if (!old || old.path !== filepath || old.mtime !== info.mtimeMs || old.size !== info.size) {
            const wav = /\.wav(e)?$/i.test(entry.name) ? await wavInfo(filepath, info.size) : null;
            const sample = { id, path: filepath, filename: entry.name, ...tagsFromName(entry.name), duration: wav?.duration ?? null, rate: wav?.rate ?? null, channels: wav?.channels ?? null, bits: wav?.bits ?? null, size: info.size, mtime: info.mtimeMs, folder: path.basename(root), root, demo: false, overrides: old?.overrides || {} };
            refreshSampleMetadata(sample);
            if (old) db.samples[db.samples.indexOf(old)] = sample; else db.samples.push(sample);
            index.remember(sample);
          } else { if (old.missing && old.analysis?.status === 'error') delete old.analysis; delete old.missing; refreshSampleMetadata(old); }
          scan.count++;
        } catch { scan.skipped++; }
      }
    }
    if (!db.folders.some(f => f.path === root)) db.folders.push({ path: root, name: path.basename(root) || root });
    scan.phase = 'saving';
    if (!scan.cancelled) await checkMissingSamples(db.samples.filter(s => s.root === root));
    await persist();
  } catch (e) { scan.error = e.message; }
  finally { scan.running = false; scan.current = null; analysis.enqueue(db.samples); }
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff' };
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON required'), { status: 415 });
  let result = ''; for await (const chunk of req) { result += chunk; if (result.length > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 }); }
  return JSON.parse(result || '{}');
}
async function streamFile(req, res, filename, extraHeaders={}) {
  const info = await stat(filename); let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    status = 206;
  }
  const headers = { 'Content-Type': mime[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': Math.max(0, end - start + 1), 'Cache-Control': 'no-cache' };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(status, {...headers,...extraHeaders});
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(filename, { start, end }); stream.on('error', () => res.destroy()); req.on('close', () => stream.destroy()); stream.pipe(res);
}
const handleRequest = async (req, res) => {
  try {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!allowedHosts.has(req.headers.host)) return json(res, { error: 'Local access only' }, 403);
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(req.headers.origin)) return json(res, { error: 'Origin denied' }, 403);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const desktopExecutable=process.env.SIFT_DESKTOP_EXE||path.join(here,'node_modules','electron','dist','electron.exe');
    if(url.pathname==='/api/capabilities'&&req.method==='GET')return json(res,{handoff:1,dataDirectory:path.resolve(dataDir),openFolder:process.platform==='win32',desktopAvailable:process.platform==='win32'&&existsSync(desktopExecutable)});
    if(url.pathname==='/api/desktop/open'&&req.method==='POST'){
      await body(req);if(process.platform!=='win32'||!existsSync(desktopExecutable))return json(res,{error:'Install the desktop runtime with npm ci first.'},400);
      const out=openSync(path.join(dataDir,'desktop.log'),'a'),err=openSync(path.join(dataDir,'desktop-error.log'),'a');
      const desktopEnv={...process.env};delete desktopEnv.ELECTRON_RUN_AS_NODE;
      const child=spawn(desktopExecutable,process.env.SIFT_DESKTOP_EXE?[]:[path.join(here,'desktop','main.cjs')],{cwd:process.env.SIFT_DESKTOP_EXE?dataDir:here,env:desktopEnv,windowsHide:true,detached:true,stdio:['ignore',out,err]});closeSync(out);closeSync(err);child.on('error',error=>console.error('Desktop launch failed:',error.message));child.unref();return json(res,{ok:true},202);
    }
    if(url.pathname==='/api/handoffs'&&req.method==='POST')return json(res,await handoffs.create(await body(req),db.samples),201);
    if(url.pathname==='/api/handoffs/cleanup'&&req.method==='POST'){
      await body(req);return json(res,await handoffs.pruneAbandoned());
    }
    const handoffRoute=/^\/api\/handoffs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if(handoffRoute){
      const [,id,action]=handoffRoute;
      if(!action&&req.method==='GET')return json(res,{...await handoffs.ready(id),folder:handoffs.batchPath(id)});
      if(action==='finish'&&req.method==='POST'){await body(req);return json(res,{...await handoffs.finish(id),folder:handoffs.batchPath(id)});}
      if(action==='open'&&req.method==='POST'){
        await body(req);await handoffs.ready(id);
        if(process.platform!=='win32')return json(res,{error:'Use the desktop launcher to open the export folder on this platform.'},400);
        const opened=spawn('explorer.exe',[handoffs.batchPath(id)],{windowsHide:true,stdio:'ignore'});opened.on('error',error=>console.error('Could not open export folder:',error.message));opened.unref();return json(res,{ok:true});
      }
      const stem=/^stems\/([0-3])$/.exec(action||'');
      if(stem&&req.method==='PUT'){
        if(!req.headers['content-type']?.startsWith('audio/wav'))return json(res,{error:'WAV audio required.'},415);
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxStemBytes)throw Object.assign(new Error('Stem is too large.'),{status:413});chunks.push(chunk);}
        return json(res,await handoffs.upload(id,+stem[1],Buffer.concat(chunks)));
      }
      if(action?.startsWith('files/')&&['GET','HEAD'].includes(req.method)){
        const name=decodeURIComponent(action.slice(6)),file=await handoffs.file(id,name);
        return await streamFile(req,res,file,{'Content-Disposition':`attachment; filename="${name}"`,'Content-Type':name.endsWith('.zip')?'application/zip':'audio/wav'});
      }
    }
    if (url.pathname === '/api/library' && req.method === 'GET') return json(res, { ...db, recovery, scan, analysis:analysis.status() });
    if (url.pathname === '/api/library/status' && req.method === 'GET') return json(res, { scan, analysis:analysis.status() });
    if (url.pathname === '/api/library/cleanup' && req.method === 'POST') {
      await body(req);
      if (scan.running || cleaning) return json(res, { error: 'Wait for the current library scan or cleanup to finish.' }, 409);
      cleaning = true;
      try {
        const result = await checkMissingSamples(db.samples);
        // Re-read references after filesystem checks, so concurrent saves are protected.
        const referenced = new Set([...db.favorites, ...(db.workspace?.tracks || []).map(t => t.id), ...db.sets.flatMap(s => s.tracks.map(t => t.id))]);
        const missingIds = new Set(result.missingIds), before = db.samples.length;
        db.samples = db.samples.filter(s => !missingIds.has(s.id) || referenced.has(s.id));
        const removed = before - db.samples.length;
        await persist(); analysis.enqueue(db.samples.filter(s => !s.missing));
        return json(res, { removed, missing: result.missing - removed, unavailableRoots: result.unavailableRoots });
      } finally { cleaning = false; }
    }
    if (url.pathname === '/api/analysis' && req.method === 'GET') return json(res, analysis.status());
    if (url.pathname === '/api/analysis' && req.method === 'POST') {
      const input=await body(req);
      if(input.action==='pause'){db.analysisPaused=true;analysis.pause();await analysis.save();}
      else if(input.action==='resume'){db.analysisPaused=false;await analysis.save();analysis.resume();}
      else if(input.action==='reanalyze'){
        if(!Array.isArray(input.ids)||input.ids.length>50000)return json(res,{error:'Choose sample IDs to analyze.'},400);
        const ids=new Set(input.ids);
        db.analysisPaused=false;await analysis.save();
        analysis.enqueue(db.samples.filter(s=>ids.has(s.id)),{force:true});analysis.resume();
      }else return json(res,{error:'Unknown analysis action.'},400);
      return json(res,analysis.status());
    }
    if (url.pathname === '/api/metadata' && req.method === 'POST') {
      const input=await body(req),sample=db.samples.find(s=>s.id===input?.id);
      if(!sample)return json(res,{error:'Sample not found.'},404);
      if(input.reset) sample.overrides={};
      else {
        if(Object.hasOwn(input,'bpm')&&input.bpm!==null&&(!Number.isFinite(input.bpm)||input.bpm<40||input.bpm>240))return json(res,{error:'BPM must be 40–240, or blank for unknown.'},400);
        if(Object.hasOwn(input,'key')&&input.key!==null&&(typeof input.key!=='string'||! /^[A-G][#b]? (min|maj)$/.test(input.key)))return json(res,{error:'Choose a valid musical key.'},400);
        const overrides={...sample.overrides};
        for(const field of ['bpm','key'])if(Object.hasOwn(input,field))overrides[field]=input[field];
        sample.overrides=overrides;
      }
      Object.assign(sample,effectiveMetadata(sample));await persist();return json(res,sample);
    }
    if (url.pathname === '/api/stretch' && req.method === 'POST') {
      const input=await body(req),sample=db.samples.find(s=>s.id===input.id);
      if(!sample)return json(res,{error:'Sample not found.'},404);
      if(!Number.isFinite(input.tempo)||input.tempo<40||input.tempo>240)return json(res,{error:'Session tempo must be 40–240 BPM.'},400);
      const sync=input.sync ?? true,key=input.key ?? null;
      if(typeof sync!=='boolean'||(key!==null&&!parseKey(key)))return json(res,{error:'Choose valid tempo sync and session key settings.'},400);
      const source={...sample},plan=renderPlan(source,{tempo:input.tempo,sync,key});
      const file=await stretchCache.render(source,input.tempo,{sync,key});
      return json(res,{url:`/rendered/${path.basename(file)}`,sourceBpm:source.bpm,targetBpm:sync&&source.bpm?input.tempo:source.bpm,...plan});
    }
    if(url.pathname.startsWith('/rendered/')&&['GET','HEAD'].includes(req.method)) {
      const filename=url.pathname.slice(10);if(!/^[a-f0-9]{64}\.wav$/.test(filename))return json(res,{error:'Not found'},404);
      return await streamFile(req,res,path.join(dataDir,'stretch-cache',filename));
    }
    if (url.pathname === '/api/scan' && req.method === 'GET') return json(res, scan);
    if (url.pathname === '/api/scan' && req.method === 'POST') {
      if (scan.running || cleaning) return json(res, { error: 'A library scan or cleanup is already running' }, 409);
      const input = await body(req); if (!input.path || typeof input.path !== 'string' || !path.isAbsolute(input.path)) return json(res, { error: 'Enter an absolute folder path.' }, 400);
      const root = await realpath(input.path); if (!(await stat(root)).isDirectory()) return json(res, { error: 'Choose a folder.' }, 400);
      if (scan.running || cleaning) return json(res, { error: 'A library scan or cleanup is already running' }, 409);
      void scanFolder(root); return json(res, { started: true }, 202);
    }
    if (url.pathname === '/api/cancel-scan' && req.method === 'POST') { await body(req); scan.cancelled = true; return json(res, scan); }
    if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
      await body(req); if (process.platform !== 'win32') return json(res, { error: 'Paste a folder path instead.' }, 400);
      const selected = await new Promise((resolve, reject) => {
        const proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Choose a sample folder for Sift'; $picker.ShowNewFolderButton = $false; if ($picker.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($picker.SelectedPath) }"], { windowsHide: true });
        let output = ''; proc.stdout.on('data', d => output += d.toString()); proc.on('error', reject); proc.on('close', code => code ? reject(new Error('Folder picker could not open. Paste the path instead.')) : resolve(output.trim()));
      }); return json(res, { path: selected });
    }
    if (url.pathname === '/api/favorites' && req.method === 'POST') {
      const input = await body(req); const valid = new Set(db.samples.map(s => s.id));
      if (!Array.isArray(input.ids)) return json(res, { error: 'ids must be an array' }, 400);
      db.favorites = [...new Set(input.ids.filter(id => valid.has(id)))]; await persist(); return json(res, { ok: true });
    }
    if (url.pathname === '/api/workspace' && req.method === 'POST') { const input = await body(req); db.workspace = normalizeWorkspace(input, { strict: true }); await persist(); return json(res, { ok: true }); }
    if (url.pathname === '/api/sets' && req.method === 'POST') {
      const input = await body(req); if (typeof input?.name !== 'string' || !input.name.trim()) return json(res, { error: 'A set needs a name and tracks.' }, 400);
      const set = { ...normalizeWorkspace(input, { strict: true }), name: input.name.trim(), id: crypto.randomUUID(), created: new Date().toISOString() }; db.sets.unshift(set); await persist(); return json(res, set);
    }
    if (url.pathname.startsWith('/audio/') && ['GET', 'HEAD'].includes(req.method)) {
      const sample = db.samples.find(s => s.id === url.pathname.slice(7)); if (!sample) return json(res, { error: 'Sample not found' }, 404);
      try { return await streamFile(req, res, sample.path); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return json(res, { error: 'This sample is missing. Reconnect its drive or rescan its folder.' }, 404); throw error; }
    }
    if (['GET', 'HEAD'].includes(req.method)) {
      const files = { '/': 'index.html', '/app.js': 'app.js', '/workspace.js': 'workspace.js', '/harmony.js': 'harmony.js', '/timing.js': 'timing.js', '/library-activity.js':'library-activity.js', '/export-audio.js':'export-audio.js', '/api.js':'api.js', '/ui.js':'ui.js', '/state.js':'state.js', '/catalog-client.js':'catalog-client.js', '/workbench-model.js':'workbench-model.js', '/player.js':'player.js', '/workbench.js':'workbench.js', '/timing-dialog.js':'timing-dialog.js', '/collection.js':'collection.js', '/details.js':'details.js', '/handoff.js':'handoff.js', '/library-status.js':'library-status.js', '/help.js':'help.js', '/dialogs.js':'dialogs.js', '/shortcuts.js':'shortcuts.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
      if (files[url.pathname]) return await streamFile(req, res, path.join(here, 'public', files[url.pathname]));
    }
    json(res, { error: 'Not found' }, 404);
  } catch (e) { if (!res.headersSent) json(res, { error: e.code === 'ENOENT' ? 'File or folder is unavailable. Reconnect the drive or check the path.' : e.message }, e.status || 400); else res.destroy(); }
};
let servers;
try { servers = await listenLoopback(handleRequest, port); } catch (error) { analysis.close(); throw error; }
console.log(`Sift is running at http://127.0.0.1:${port}`);
for (const server of servers) server.on('error', e => { console.error(e.message); process.exitCode = 1; });
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;analysis.close();for(const server of servers)server.close();try{await persist();}finally{process.exit(0);}}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,shutdown);
if(process.send)process.on('message',message=>{if(message?.type==='sift:shutdown')void shutdown();});
