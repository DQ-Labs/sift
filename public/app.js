import { normalizeWorkspace } from './workspace.js';
import { chooseCombination, noteNames, pitchPlan, renderPlan } from './harmony.js';
import { defaultTiming, makeCycle, createCycleSource, sessionFrames, cyclePosition, audibleStart } from './timing.js';
import { audibleTracks, mixScale, encodeWav } from './export-audio.js';
import { libraryActivity } from './library-activity.js';
const $ = selector => document.querySelector(selector);
const icons = {
  down:'<path d="m5 9 7 7 7-7"/>', settings:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  timing:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  play:'<path d="m6 3 13 9-13 9z"/>', stop:'<rect x="5" y="5" width="14" height="14" rx="1"/>', pause:'<path d="M8 5v14M16 5v14"/>',
  compass:'<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/>', library:'<path d="M4 4v16M9 4v16M14 4v16M18 4l3 16"/>',
  gem:'<path d="m3 8 4-5h10l4 5-9 13zM3 8h18M8 8l4 13 4-13M7 3l1 5 4-5 4 5 1-5"/>', layers:'<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', folder:'<path d="M3 7V4h6l3 3h9v13H3z"/>', 'folder-plus':'<path d="M3 7V4h6l3 3h9v13H3zM8 14h8M12 10v8"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>', bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>', download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  shuffle:'<path d="M3 5h3c5 0 7 14 12 14h3m-4-4 4 4-4 4M3 19h3c2 0 4-3 6-7M14 7c1-1 3-2 4-2h3m-4-4 4 4-4 4"/>',
  repeat:'<path d="M4 8h15l-4-4M20 16H5l4 4M20 8v4M4 16v-4"/>', lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  unlock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0M12 14v3"/>', search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  left:'<path d="m14 5-7 7 7 7"/>', right:'<path d="m10 5 7 7-7 7"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>', shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const metadataSource = source => source === 'filename-hint' ? 'unverified filename number' : source || 'unknown';
const colors = { Drums:'#c8ad85', Bass:'#a1b39a', Melodic:'#a1b7c0', Texture:'#b1a1bc', Vocal:'#c4a3a0', Other:'#a1aaa0' };
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const state = { samples:[], favorites:[], folders:[], sets:[], source:null, view:'discover', collectionOpen:false, query:'', type:'', bpm:'', sort:'name', page:0, conflictsOnly:false, selected:null, tracks:[], tempo:92, sync:true, key:'A min', setName:'Untitled set',analysis:null,scan:null };
const sampleById = id => state.samples.find(s => s.id === id);
let context, mixNodes = [], mixPlaying = false, mixStarting = false, mixToken = 0, mixStart = 0, mixCycleDuration = 0, saveTimer, toastTimer, previewToken = 0;
const buffers = new Map(), loading = new Map();
const preparedTracks = new Map();
const preview = new Audio(); preview.preload = 'metadata'; preview.volume = .75;
const api = async (route, data) => {
  const response = await fetch(`/api/${route}`, data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
};
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4300); }
const formatTime = value => Number.isFinite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2,'0')}` : '—';
function audioContext() { context ||= new AudioContext(); return context; }
function waveform(buffer) {
  const data = buffer.getChannelData(0), result = Array(160).fill(0), step = Math.max(1, Math.floor(data.length / 60000));
  for (let i = 0; i < data.length; i += step) { const bin = Math.min(159,Math.floor(i / data.length * 160)); result[bin] = Math.max(result[bin],Math.abs(data[i])); }
  return result;
}
async function decode(sample,render=null) {
  const cacheKey=render?.url || `${sample.id}:${sample.mtime || ''}`;
  if (buffers.has(cacheKey)) { const buffer = buffers.get(cacheKey); buffers.delete(cacheKey); buffers.set(cacheKey,buffer); return buffer; }
  if (loading.has(cacheKey)) return loading.get(cacheKey);
  if (sample.size > 100 * 1024 * 1024) throw new Error('This file is over 100 MB. You can audition it, but choose a shorter file for the workbench.');
  const promise = (async () => {
    const response = await fetch(render?.url || `/audio/${sample.id}`); if (!response.ok) throw new Error(`${sample.name} is unavailable. Check that its drive is connected.`);
    let buffer; try { buffer = await audioContext().decodeAudioData(await response.arrayBuffer()); } catch { throw new Error(`Cannot decode ${sample.filename}. Try a PCM WAV or supported MP3/FLAC file.`); }
    if (buffer.length * buffer.numberOfChannels * 4 > 128 * 1024 * 1024) throw new Error('This recording is too long for the workbench. Audition it or use a shorter excerpt.');
    if(!render){sample.peaks = waveform(buffer); sample.duration = buffer.duration; sample.rate = buffer.sampleRate; sample.channels = buffer.numberOfChannels;}
    buffers.set(cacheKey,buffer);
    let bytes = [...buffers.values()].reduce((n,b) => n + b.length*b.numberOfChannels*4,0);
    for (const [id,b] of buffers) { if ((buffers.size <= 12 && bytes <= 160*1024*1024) || id === cacheKey) break; bytes -= b.length*b.numberOfChannels*4; buffers.delete(id); }
    return buffer;
  })();
  loading.set(cacheKey,promise); try { return await promise; } finally { loading.delete(cacheKey); }
}
async function playbackBuffer(sample,{tempo=state.tempo,sync=state.sync,key=state.key}={}) {
  if(!renderPlan(sample,{tempo,sync,key}).processed)return decode(sample);
  const render=await api('stretch',{id:sample.id,tempo,sync,key});return decode(sample,render);
}
function drawWave(canvas, peaks, color, progress = -1) {
  if (!canvas) return;
  const w = Math.max(1,canvas.clientWidth), h = Math.max(1,canvas.clientHeight), dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,w,h);
  if (!peaks?.length) { ctx.strokeStyle = '#52634d'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke(); return; }
  const max = Math.max(.02,...peaks), count = Math.min(peaks.length,Math.floor(w/3));
  for (let i = 0; i < count; i++) { const value = peaks[Math.floor(i/count*peaks.length)] / max; const bar = Math.max(1,value*(h-4)); ctx.fillStyle = progress >= 0 && i/count > progress ? '#485641' : color; ctx.fillRect(i*w/count,(h-bar)/2,Math.max(1,w/count-1.5),bar); }
}
function drawAll() {
  document.querySelectorAll('canvas[data-sample]').forEach(canvas => { const s = sampleById(canvas.dataset.sample); drawWave(canvas,s?.peaks,colors[s?.type] || '#7f9177'); });
  document.querySelectorAll('canvas[data-track-wave]').forEach(canvas=>{
    const index=+canvas.dataset.trackWave,track=state.tracks[index],s=sampleById(track?.id),prepared=preparedTracks.get(index);
    const current=s&&prepared?.signature===trackSignature(track,s,currentSettings());
    drawWave(canvas,current?prepared.peaks:null,colors[track?.type]||colors.Other);
  });
  const selected = sampleById(state.selected); drawWave($('#previewWave'),selected?.peaks,'#b8c99d',preview.duration ? preview.currentTime/preview.duration : -1);
}
function sourceSamples() {
  if (state.source === 'demo') return state.samples.filter(s => s.demo);
  if (state.source) return state.samples.filter(s => s.root === state.source);
  const real = state.samples.filter(s => !s.demo); return real.length ? real : state.samples;
}
const hasConflict = sample => Object.values(sample.conflicts || {}).some(c => !c.resolved);
function conflictMarker(sample,field){const c=sample.conflicts?.[field];return c&&!c.resolved?` <span class="conflict-marker" title="Filename: ${escape(c.label)}; audio: ${escape(c.estimate)}. Review in Sample details." aria-label="${field==='bpm'?'Tempo':'Key'} conflict">!</span>`:'';}
function filteredSamples() {
  const words = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return sourceSamples().filter(s => (!state.conflictsOnly || hasConflict(s)) && (state.view !== 'gems' || state.favorites.includes(s.id)) && (!state.type || state.type === s.type) && words.every(word => `${s.name} ${s.filename} ${s.folder} ${s.typeHint || ''} ${s.key || ''} ${s.type}`.toLowerCase().includes(word)) && (!state.bpm || (state.bpm === 'unknown' ? !s.bpm : state.bpm === 'slow' ? s.bpm && s.bpm < 90 : state.bpm === 'mid' ? s.bpm >= 90 && s.bpm <= 120 : s.bpm > 120))).sort((a,b) => state.sort === 'bpm' ? (a.bpm || 999)-(b.bpm || 999) : state.sort === 'duration' ? (a.duration ?? Infinity)-(b.duration ?? Infinity) : a.name.localeCompare(b.name));
}
function renderSources() {
  const real = state.samples.filter(s => !s.demo).length;
  $('#sources').innerHTML = `${real ? `<button class="source-item ${!state.source?'active':''}" data-source="">${icon('library')}<span class="source-name">All folders</span><small>${real.toLocaleString()}</small></button>` : ''}${state.folders.map(folder => `<button class="source-item ${state.source === folder.path?'active':''}" data-source="${escape(folder.path)}" title="${escape(folder.path)}">${icon('folder')}<span class="source-name">${escape(folder.name)}</span><small>${state.samples.filter(s => s.root === folder.path).length}</small></button>`).join('')}<button class="source-item ${state.source==='demo'||!real?'active':''}" data-source="demo">${icon('folder')}<span class="source-name">Sift demo collection</span><small>12</small></button>`;
  $('#sampleCount').textContent = (real || state.samples.length).toLocaleString(); $('#gemCount').textContent = state.favorites.length.toLocaleString(); $('#setCount').textContent = state.sets.length;
}
function renderRows() {
  const conflicts=sourceSamples().filter(hasConflict).length;$('#reviewConflicts').textContent=`Metadata conflicts (${conflicts})`;$('#reviewConflicts').setAttribute('aria-pressed',String(state.conflictsOnly));
  $('#toolsConflicts').textContent=conflicts?`${conflicts} metadata conflicts`:'';
  const list = filteredSamples(), pages = Math.max(1,Math.ceil(list.length/50)); state.page = Math.max(0,Math.min(state.page,pages-1));
  $('#resultCount').textContent = `${list.length.toLocaleString()} sample${list.length===1?'':'s'}`;
  $('#pageNumber').textContent = `${state.page+1} / ${pages}`; $('#previousPage').disabled = state.page === 0; $('#nextPage').disabled = state.page === pages-1;
  updateCollectionUI();
  $('#sampleRows').innerHTML = list.slice(state.page*50,(state.page+1)*50).map(s => `<div class="sample-row ${state.selected===s.id?'selected':''}" data-id="${s.id}" tabindex="0" role="button" aria-label="Audition ${escape(s.name)}"><button class="icon-button row-play" aria-label="${state.selected===s.id&&!preview.paused?'Stop':'Play'} ${escape(s.name)}">${icon(state.selected===s.id&&!preview.paused?'pause':'play')}</button><div class="sample-name"><div class="row-title" title="${escape(s.filename)}">${escape(s.name.replaceAll('_',' '))}</div><div class="row-source">${escape(s.folder)}${s.missing?' · MISSING FILE':''}${s.demo?' · synthesized demo':''}</div></div><canvas class="row-wave" data-sample="${s.id}" aria-label="${s.peaks?'Waveform':'Audition to load waveform'}"></canvas><span class="tag" title="Type from ${escape(s.typeSource || 'filename')}: ${escape(s.typeHint || s.filename)}" style="--tag-color:${colors[s.type]}">${escape(s.type)}</span><span class="mono" title="Tempo source: ${escape(metadataSource(s.bpmSource))}">${s.bpmSource==='analysis'?'≈':s.bpmSource==='filename-hint'?'?':''}${s.bpm || '—'}${conflictMarker(s,'bpm')}</span><span class="mono row-key" title="Key source: ${escape(s.keySource || 'unknown')}">${escape(s.key?.replace(' min','m').replace(' maj','') || '—')}${conflictMarker(s,'key')}</span><span class="mono row-duration">${formatTime(s.duration)}</span><button class="icon-button favorite ${state.favorites.includes(s.id)?'active':''}" aria-label="${state.favorites.includes(s.id)?'Unsave':'Save'} ${escape(s.name)} as gem" aria-pressed="${state.favorites.includes(s.id)}">${icon('gem')}</button></div>`).join('') || `<div class="empty"><h3>${state.view==='gems'?'Nothing saved here yet.':'No samples in this view.'}</h3><p>${state.view==='gems'?'Tap the diamond beside a sound to keep it close.':'Try a different search, sound type or source folder.'}</p></div>`;
  requestAnimationFrame(drawAll);
}
function renderTracks() {
  $('#tracks').innerHTML = state.tracks.map((track,i) => {
    const sample=sampleById(track.id),number=i+1,name=sample?.name.replaceAll('_',' ')||'Add a sample';
    return `<div class="track ${track.mute?'muted-track':''}" style="--track-color:${colors[track.type]||colors.Other}" data-track="${i}">
      <div class="track-title"><span class="track-number">0${number}</span><div class="track-text">
        <div class="track-type">${escape(track.type.toUpperCase())}</div>
        <button class="track-name" data-action="name" aria-label="Full name and details for layer ${number}: ${escape(name)}" title="${escape(sample?.filename||'Choose a sample from the collection')}" ${sample?'':'disabled'}>${escape(name)}</button>
        <div class="track-meta">${sample?`${sample.bpmSource==='filename-hint'?'?':''}${sample.bpm||'—'} BPM · ${escape(sample.key||'Unpitched / unknown')}`:'Choose from the collection'}</div>
      </div></div>
      <div class="wave-area"><canvas data-track-wave="${i}" aria-label="${escape(track.type)} four-bar timeline"></canvas><div class="playhead"></div><div class="track-timing"></div></div>
      <div class="track-controls">
        <input type="range" class="level" min="0" max="1" step="0.01" value="${track.volume}" aria-label="Layer ${number} volume" title="Volume ${Math.round(track.volume*100)}%">
        <button class="icon-button letter-button ${track.mute?'active':''}" data-action="mute" aria-label="Mute layer ${number}" aria-pressed="${track.mute}" title="Mute">M</button>
        <button class="icon-button letter-button ${track.solo?'active':''}" data-action="solo" aria-label="Solo layer ${number}" aria-pressed="${track.solo}" title="Solo">S</button>
        <button class="icon-button ${track.locked?'locked':''}" data-action="lock" aria-label="${track.locked?'Unlock':'Lock'} layer ${number}" aria-pressed="${track.locked}" title="${track.locked?'Unlock':'Lock'} sample">${icon(track.locked?'lock':'unlock')}</button>
        <button class="icon-button" data-action="timing" aria-label="Timing layer ${number}" title="Set start offset and repeat" ${sample?'':'disabled'}>${icon('timing')}</button>
      </div>
      <button class="layer-reroll ${track.locked?'is-locked':''}" data-action="reroll" aria-label="Reroll layer ${number}" title="${track.locked?'Unlock this layer to reroll':`Find another ${escape(track.type.toLowerCase())} sample`}" ${track.locked?'disabled':''}>${icon(track.locked?'lock':'shuffle')}<span>${track.locked?'Locked':'Reroll'}</span></button>
    </div>`;
  }).join('');
  $('#setLabel').textContent = state.setName; $('#tempo').value = state.tempo; $('#sync').checked = state.sync; $('#sessionKey').value = state.key || '';
  document.querySelectorAll('[data-track]').forEach((el,i)=>{
    const sample=sampleById(state.tracks[i].id);if(!sample)return;
    const plan=pitchPlan(sample,state.key),detail=document.createElement('div');detail.className='track-match';
    detail.textContent=plan.status==='original'?'Original pitch':plan.status==='drums'?'Drums · pitch unchanged':plan.status==='unknown'?'Key unknown · pitch unchanged':`${plan.outputKey}${plan.semitones?` · ${plan.semitones>0?'+':''}${plan.semitones} st`:' · no shift'}${plan.status==='relative'?' · relative key':''}`;
    detail.title='Source key stays unchanged in your library. Session transposition preserves major/minor character; relative keys share a scale.';
    el.querySelector('.track-type').append(detail);
  });
  renderHarmonyStatus();
  $('#workbenchHint').textContent = state.tracks.some(t => t.id) ? 'Clock: set first downbeat and repeat. Locks keep sample choices.' : 'Start with Find a combination, or add samples from the collection.';
  requestAnimationFrame(drawAll);
  warmTracks();
}
function renderHarmonyStatus(){
  const samples=state.tracks.map(t=>sampleById(t.id)).filter(Boolean),notes=[];
  if(state.key)notes.push(`${state.key} · relative major/minor allowed`);else notes.push('Original keys · choose a key to match pitched layers');
  const unknownKeys=samples.filter(s=>pitchPlan(s,state.key).status==='unknown').length;
  const unknownTempos=state.sync?samples.filter(s=>!s.bpm).length:0;
  if(unknownKeys)notes.push(`${unknownKeys} unknown ${unknownKeys===1?'key':'keys'}: pitch unchanged`);
  if(unknownTempos)notes.push(`${unknownTempos} unknown BPM: speed unchanged`);
  $('#harmonyStatus').textContent=notes.join(' · ');
}
function renderSets() {
  $('#savedSets').innerHTML = state.sets.map(set => `<article class="saved-set"><span class="set-icon">${icon('layers')}</span><div><h3>${escape(set.name)}</h3><p>${set.tempo || 92} BPM · ${escape(set.key || 'Original keys')} · ${set.tracks.filter(t=>t.id).length} layers · ${new Date(set.created).toLocaleDateString()}<br>${set.tracks.map(t => escape(sampleById(t.id)?.name || 'Empty')).join(' / ')}</p></div><button class="button" data-load-set="${set.id}">Open set ${icon('right')}</button></article>`).join('') || '<div class="empty"><h3>Good combinations deserve a second listen.</h3><p>Save a set from the workbench and find it here.</p></div>';
}
function setView(view) {
  state.view = view; state.page = 0;
  document.querySelector('.app').dataset.view=view;
  const labels = {discover:'Discover',library:'All samples',gems:'Saved gems',sets:'Saved sets'};
  $('#breadcrumbView').textContent = labels[view];
  $('#workspace').hidden = view !== 'discover'; $('#librarySection').hidden = view === 'sets'; $('#setsSection').hidden = view !== 'sets';
  $('#libraryTitle').textContent = view === 'gems' ? 'Your shortlist' : 'The collection';
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active',button.dataset.view === view)); renderRows(); renderSets();
}
function updateCollectionUI(){
  const discover=state.view==='discover',expanded=!discover||state.collectionOpen;
  $('#collectionBody').hidden=!expanded;$('#toggleCollection').hidden=!discover;
  $('#toggleCollection').setAttribute('aria-expanded',String(expanded));
  $('#toggleCollection').innerHTML=`${expanded?'Hide collection':'Browse collection'}${icon('down')}`;
  $('#collectionHint').hidden=!discover||expanded;
  $('#librarySection').classList.toggle('collection-collapsed',!expanded);
}
$('#toggleCollection').onclick=()=>{state.collectionOpen=!state.collectionOpen;updateCollectionUI();requestAnimationFrame(drawAll);};
function focusCollectionSearch(){
  if(state.view==='sets')setView('library');
  if(state.view==='discover'){state.collectionOpen=true;updateCollectionUI();}
  $('#search').focus();requestAnimationFrame(drawAll);
}
function snapshot() { return {tracks:state.tracks,tempo:state.tempo,sync:state.sync,key:state.key,name:state.setName}; }
function saveWorkspace() { updateHandoffStatus();clearTimeout(saveTimer); saveTimer = setTimeout(() => api('workspace',snapshot()).catch(e => toast(`Could not save workspace: ${e.message}`)),300); }
function normalizeTracks(tracks) { return normalizeWorkspace({tracks}).tracks; }
function pick(pool, previous) { const choices = pool.filter(s => s.id !== previous); return (choices.length?choices:pool)[Math.floor(Math.random()*(choices.length || pool.length))]; }
async function reroll(index = null) {
  const next=chooseCombination(state.tracks,sourceSamples(),{tempo:state.tempo,sync:state.sync,key:state.key},index);
  const changed=next.some((track,i)=>track.id!==state.tracks[i].id);
  if (!changed) { toast(state.tracks.every(t=>t.locked)?'Unlock a layer to explore new combinations.':'No other matching samples in this source.'); return; }
  state.tracks=next;
  state.setName = 'Untitled set'; const wasPlaying = mixPlaying || mixStarting; stopMix(); renderTracks(); saveWorkspace();
  if(index!==null)document.querySelector(`[data-track="${index}"] [data-action="reroll"]`)?.focus({preventScroll:true});
  if (wasPlaying) await playMix(); else warmTracks();
}
function currentSettings(){return {tempo:state.tempo,sync:state.sync,key:state.key};}
function trackSignature(track,sample,settings){return JSON.stringify([track.id,sample.mtime,sample.bpm,sample.key,sample.type,sample.bpmSource,sample.conflicts?.bpm,track.timing||defaultTiming(),settings]);}
async function cycleForTrack(track,settings){
  const current=sampleById(track.id);if(!current)return null;const sample={...current};
  const buffer=await playbackBuffer(sample,settings);
  return {...makeCycle(audioContext(),buffer,sample,track,settings),sample};
}
function updateTrackTiming(index,entry){
  const track=state.tracks[index],sample=sampleById(track?.id);
  if(!sample||entry.signature!==trackSignature(track,sample,currentSettings()))return;
  const el=document.querySelector(`[data-track="${index}"] .track-timing`);if(!el)return;
  el.textContent=entry.error?'Timing unavailable':entry.plan?entry.plan.label:'Preparing timeline…';
  el.title=entry.error||[entry.plan?.offset?`Starts at ${entry.plan.offset.toFixed(2)} source seconds`:'Starts at file beginning',entry.plan?.automatic?'First sound selected by skipping leading silence; musical downbeat not detected':'Exact manual start',...(entry.plan?.warnings||[]),'Use Timing to place the first downbeat by ear.'].join('. ');
  el.classList.toggle('timing-warning',!!entry.error||!!entry.plan?.warnings.length);
  if(entry.plan?.warnings.length)el.textContent+=' · check BPM';
}
function prepareTrack(track,index,settings=currentSettings()){
  const sample=sampleById(track.id);if(!sample)return Promise.resolve(null);
  const signature=trackSignature(track,sample,settings),existing=preparedTracks.get(index);
  if(existing?.signature===signature&&!existing.error){updateTrackTiming(index,existing);return existing.promise;}
  const entry={signature};preparedTracks.set(index,entry);
  entry.promise=cycleForTrack(structuredClone(track),settings).then(result=>{
    Object.assign(entry,result,{peaks:waveform(result.buffer)});updateTrackTiming(index,entry);drawAll();return result;
  }).catch(error=>{entry.error=error.message;updateTrackTiming(index,entry);throw error;});
  updateTrackTiming(index,entry);return entry.promise;
}
function warmTracks(){state.tracks.forEach((track,index)=>{if(track.id)prepareTrack(track,index).catch(()=>{});else preparedTracks.delete(index);});}
function stopMix() { clearTimeout(tempoTimer); mixToken++; mixStarting = false; mixPlaying = false; mixNodes.forEach(n => { try { n.source.stop(); n.source.disconnect(); n.gain.disconnect(); } catch {} }); mixNodes=[]; $('#playMix').innerHTML=icon('play'); $('#playMix').setAttribute('aria-label','Play mix'); $('#workspace').classList.remove('playing'); $('#transportStatus').textContent='READY TO EXPLORE'; $('#transportTime').textContent='00:00.0'; $('#transportPosition').textContent='Bar 1 · Beat 1';document.querySelectorAll('.playhead').forEach(el=>el.style.left='0%'); }
function effectiveVolume(track) { return track.mute || (state.tracks.some(t=>t.solo) && !track.solo) ? 0 : track.volume; }
function updateGains() { mixNodes.forEach(({gain,index}) => gain.gain.setTargetAtTime(effectiveVolume(state.tracks[index])*.6,context.currentTime,.015)); }
async function playMix() {
  if (mixPlaying || mixStarting) { stopMix(); return; }
  // Read the committed controls at the action boundary as well as on input.
  state.tempo=Math.max(40,Math.min(240,Number($('#tempo').value)||92));state.sync=$('#sync').checked;state.key=$('#sessionKey').value||null;saveWorkspace();
  if (!state.tracks.some(t=>t.id)) { toast('Add a sample to the workbench first.'); return; }
  preview.pause(); updatePreviewControls(); const ctx = audioContext(); const token = ++mixToken;
  mixStarting = true; $('#transportStatus').textContent = state.sync||state.key?'PREPARING TEMPO / KEY':'LOADING SAMPLES'; $('#playMix').innerHTML = icon('stop'); $('#playMix').setAttribute('aria-label','Stop mix');
  try {
    await ctx.resume();if(token!==mixToken)return;
    const tempo=state.tempo,sync=state.sync,key=state.key;
    const ready = await Promise.all(state.tracks.map(async (track,index) => { const prepared=await prepareTrack(track,index,{tempo,sync,key});return prepared?{...prepared,index}:null; }));
    if (token !== mixToken) return;
    if(!ready.some(Boolean))throw new Error('These samples are unavailable. Reconnect their drive or choose another combination.');
    mixStart = ctx.currentTime + .06;
    mixCycleDuration=ready.find(Boolean).buffer.duration;
    mixNodes = ready.filter(Boolean).map(({buffer,sample,index}) => {
      const source = createCycleSource(ctx,buffer), gain = ctx.createGain(); gain.gain.value=effectiveVolume(state.tracks[index])*.6; source.connect(gain).connect(ctx.destination); source.start(mixStart); return {source,gain,index,duration:buffer.duration,rate:1};
    });
    mixStarting=false; mixPlaying=true; $('#workspace').classList.add('playing'); $('#transportStatus').textContent=key?`${sync?'TEMPO + KEY':'KEY SYNC'} · ${key.toUpperCase()}`:sync?'TEMPO SYNC · PITCH PRESERVED':'ORIGINAL SPEED · LOOPING';
    const notices=[];
    if(sync&&ready.some(item=>item&&!item.sample.bpm))notices.push('Unknown BPM: original speed.');
    if(key&&ready.some(item=>item&&pitchPlan(item.sample,key).status==='unknown'))notices.push('Unknown key: original pitch.');
    if(notices.length)toast(notices.join(' ')+' Set source metadata in Sample details.');drawAll();
  } catch(e) { if (token !== mixToken) return; stopMix(); toast(e.message); }
}
function animation() {
  if (mixPlaying) {
    const elapsed = Math.max(0,context.currentTime-mixStart), clock=cyclePosition(elapsed,Math.round(mixCycleDuration*context.sampleRate),context.sampleRate), position=clock.seconds;
    $('#transportTime').textContent = `${String(Math.floor(position/60)).padStart(2,'0')}:${String(Math.floor(position%60)).padStart(2,'0')}.${Math.floor(position*10)%10}`;
    $('#transportPosition').textContent=`Bar ${clock.bar} · Beat ${clock.beat}`;
    mixNodes.forEach(node => { const el = document.querySelector(`[data-track="${node.index}"] .playhead`); if (el) el.style.left=`${clock.fraction*100}%`; });
  }
  if (!preview.paused && state.selected) { const s = sampleById(state.selected); drawWave($('#previewWave'),s?.peaks,'#b8c99d',preview.currentTime/preview.duration); $('#previewTime').textContent = `${formatTime(preview.currentTime)} / ${formatTime(preview.duration)}`; }
  requestAnimationFrame(animation);
}
function updatePreviewControls() {
  $('#previewPlay').innerHTML = icon(preview.paused?'play':'pause'); $('#previewPlay').setAttribute('aria-label',preview.paused?'Play selected sample':'Pause selected sample');
  $('#previewFavorite').classList.toggle('active',state.favorites.includes(state.selected)); $('#previewFavorite').setAttribute('aria-pressed',String(state.favorites.includes(state.selected)));
  document.querySelectorAll('.row-play').forEach(button => { const selected=button.closest('[data-id]').dataset.id===state.selected; button.innerHTML=icon(selected&&!preview.paused?'pause':'play'); });
}
async function audition(id) {
  if (state.selected === id && !preview.paused) { preview.pause(); updatePreviewControls(); return; }
  stopMix(); const s=sampleById(id); if(!s)return;
  const token=++previewToken; if (state.selected !== id) { preview.src=`/audio/${id}`; state.selected=id; }
  $('#previewName').textContent=s.name.replaceAll('_',' '); $('#previewDetail').textContent=`${s.folder} · ${s.bpm?`${s.bpm} BPM (${metadataSource(s.bpmSource)})`:'Tempo unknown'} · ${s.key || 'Key unknown'}`; $('#previewTime').textContent=`0:00 / ${formatTime(s.duration)}`; $('#addToBench').disabled=false;$('#sampleDetails').disabled=false;
  renderRows();
  try { await preview.play(); if(token===previewToken) updatePreviewControls(); } catch { if(token===previewToken)toast('Cannot play this file. It may be missing or use an unsupported codec.'); }
  if (s.size <= 100*1024*1024 && !s.peaks) decode(s).then(()=>{if(token===previewToken){drawAll();renderRows();}}).catch(()=>{}); else drawAll();
}
async function favorite(id) {
  if (!id) return;
  const before=[...state.favorites]; state.favorites=state.favorites.includes(id)?state.favorites.filter(x=>x!==id):[...state.favorites,id]; renderRows(); renderSources(); updatePreviewControls();
  try { await api('favorites',{ids:state.favorites}); } catch(e) {state.favorites=before;renderRows();renderSources();toast(`Could not save gem: ${e.message}`);}
}
async function addSelected() {
  const sample=sampleById(state.selected); if(!sample)return;
  if(sample.size>100*1024*1024){toast('Choose a sample under 100 MB for the workbench.');return;}
  let index=state.tracks.findIndex(t=>!t.locked&&!t.id); if(index<0)index=state.tracks.findIndex(t=>!t.locked&&t.type===sample.type); if(index<0)index=state.tracks.findIndex(t=>!t.locked);
  if(index<0){toast('All layers are locked. Unlock one to add this sample.');return;}
  stopMix(); state.tracks[index].id=sample.id; state.tracks[index].type=sample.type; state.tracks[index].timing=defaultTiming(); state.setName='Untitled set'; renderTracks();saveWorkspace();setView('discover');warmTracks();toast(`Added to layer ${index+1}.`);
}
function exportSnapshot(){
  state.tempo=Math.max(40,Math.min(240,Number($('#tempo').value)||92));state.sync=$('#sync').checked;state.key=$('#sessionKey').value||null;
  return structuredClone(snapshot());
}
async function renderExportLayers(workspace,includeAll=false,onProgress=()=>{}){
  const selected=audibleTracks(workspace.tracks,includeAll);if(!selected.length)throw new Error('No audible layers. Unmute a layer or include all loaded layers.');
  const settings={tempo:workspace.tempo,sync:workspace.sync,key:workspace.key},layers=[];
  for(const {track,index} of selected){
    onProgress(`Rendering layer ${index+1}…`);
    const prepared=await cycleForTrack(track,settings);if(!prepared)throw new Error(`Layer ${index+1} is unavailable.`);
    const offline=new OfflineAudioContext(2,sessionFrames(workspace.tempo,44100),44100),source=createCycleSource(offline,prepared.buffer);
    source.connect(offline.destination);source.start(0);
    const rendered=await offline.startRendering();layers.push({index,gain:track.volume*.6,channels:[rendered.getChannelData(0),rendered.getChannelData(1)]});
  }
  return layers;
}
function downloadBytes(bytes,name){
  const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function exportMix(){
  const button=$('#exportMix');button.disabled=true;button.innerHTML=icon('download')+' Rendering…';
  try{
    const workspace=exportSnapshot(),layers=await renderExportLayers(workspace),length=layers[0].channels[0].length,channels=[new Float32Array(length),new Float32Array(length)];
    for(const layer of layers)for(let c=0;c<2;c++)for(let i=0;i<length;i++)channels[c][i]+=layer.channels[c][i]*layer.gain;
    downloadBytes(encodeWav(channels,{scale:mixScale(layers)}),`Sift-${workspace.name.replace(/[^a-z0-9 -]/gi,'')}-${workspace.tempo}bpm.wav`);
    toast('Exported 4 bars · stereo WAV · 44.1 kHz / 16-bit.');
  }catch(error){toast(error.message);}finally{button.disabled=false;button.innerHTML=icon('download')+'Export mix';}
}
let handoffBatch=null,handoffSignature=null,handoffNative=false,handoffPreparing=false;
function currentHandoffSignature(){return JSON.stringify([snapshot(),$('#handoffIncludeAll').checked,state.tracks.map(t=>{const sample=sampleById(t.id);return sample?[sample.id,sample.mtime,sample.bpm,sample.key,sample.type]:null;})]);}
function updateHandoffStatus(){
  if(!handoffBatch||handoffPreparing)return;
  const stale=handoffSignature!==currentHandoffSignature();$('#handoffSnapshot').textContent=stale?'Workbench changed. These files are the earlier snapshot; prepare again to update.':'Prepared snapshot · matches this workbench';
  $('#handoffSnapshot').classList.toggle('stale',stale);
}
$('#handoffButton').onclick=async()=>{
  $('#handoffError').textContent='';$('#handoffDialog').showModal();updateHandoffStatus();
  $('#handoffMode').textContent=window.siftDesktop?'Desktop mode · prepare WAVs, then drag into the FL Studio Playlist.':'Browser mode · prepare WAVs, then use Open folder and drag them into the FL Studio Playlist.';
  $('#openDesktop').hidden=!!window.siftDesktop;
  try{const capabilities=await api('capabilities');$('#openDesktop').disabled=!capabilities.desktopAvailable;}catch{$('#handoffError').textContent='Restart the local Sift server to enable stem handoff.';}
};
$('#handoffIncludeAll').onchange=updateHandoffStatus;
$('#prepareHandoff').onclick=async()=>{
  const button=$('#prepareHandoff');button.disabled=true;handoffPreparing=true;$('#handoffError').textContent='';$('#handoffResults').hidden=true;
  try{
    const workspace=exportSnapshot(),includeAll=$('#handoffIncludeAll').checked,signature=currentHandoffSignature();
    const layers=await renderExportLayers(workspace,includeAll,message=>$('#handoffProgress').textContent=message);
    const scale=mixScale(layers),batch=await api('handoffs',{workspace,includeAll,masterScale:scale});
    for(const layer of layers){
      $('#handoffProgress').textContent=`Saving layer ${layer.index+1}…`;
      const response=await fetch(`/api/handoffs/${batch.id}/stems/${layer.index}`,{method:'PUT',headers:{'Content-Type':'audio/wav'},body:encodeWav(layer.channels,{gain:layer.gain,scale})});
      if(!response.ok)throw new Error((await response.json()).error||'Could not save a stem.');
    }
    const ready=await api(`handoffs/${batch.id}/finish`,{});handoffNative=false;
    if(window.siftDesktop){try{await window.siftDesktop.prepareDrag(ready.id);handoffNative=true;}catch{$('#handoffError').textContent='Desktop dragging could not prepare. Downloads and Open folder are still available.';}}
    handoffBatch=ready;handoffSignature=signature;renderHandoff();$('#handoffProgress').textContent='';
    button.textContent='Prepare new snapshot';
  }catch(error){$('#handoffError').textContent=error.message;$('#handoffProgress').textContent='';if(handoffBatch)$('#handoffResults').hidden=false;}
  finally{button.disabled=false;handoffPreparing=false;updateHandoffStatus();}
};
function renderHandoff(){
  const batch=handoffBatch;$('#handoffResults').hidden=false;
  $('#handoffSummary').textContent=`${batch.name} · ${batch.tempo} BPM · ${batch.key||'Original keys'} · 4 bars · stereo WAV / 44.1 kHz / 16-bit`;
  $('#handoffFolder').textContent=batch.folder;
  $('#handoffFiles').innerHTML=batch.files.map(file=>`<div class="handoff-file"><div><strong>${escape(file.type)}</strong><span>${escape(file.name)}</span></div><a class="button small" href="/api/handoffs/${batch.id}/files/${encodeURIComponent(file.name)}" download="${escape(file.name)}">${icon('download')}WAV</a>${handoffNative?`<button class="stem-drag" draggable="true" data-drag-index="${file.index}" aria-label="Drag layer ${file.index+1} to FL Studio">${icon('layers')}Drag stem</button>`:''}</div>`).join('');
  $('#downloadStemZip').href=`/api/handoffs/${batch.id}/files/Stems.zip`;
  $('#dragAllStems').hidden=!handoffNative;$('#dragAllStems').draggable=handoffNative;
  $('#handoffDragHint').textContent=handoffNative?'Drag one stem, or drag all stems together. Drop at the same bar in the Playlist.':'Use Open folder to drag the real WAV files, or open desktop Sift for direct dragging.';
}
$('#handoffFiles').addEventListener('dragstart',event=>{
  const button=event.target.closest('[data-drag-index]');if(!button||!handoffNative)return;event.preventDefault();window.siftDesktop.startDrag(handoffBatch.id,+button.dataset.dragIndex);
});
$('#dragAllStems').ondragstart=event=>{event.preventDefault();if(handoffNative&&handoffBatch)window.siftDesktop.startDrag(handoffBatch.id,'all');};
$('#handoffFiles').onclick=event=>{if(event.target.closest('[data-drag-index]'))toast('Click and hold, then drag this stem into FL Studio.');};
$('#dragAllStems').onclick=()=>toast('Click and hold, then drag the stems into FL Studio.');
$('#openHandoffFolder').onclick=async()=>{try{await api(`handoffs/${handoffBatch.id}/open`,{});}catch(error){$('#handoffError').textContent=error.message;}};
$('#openDesktop').onclick=async()=>{try{await api('desktop/open',{});toast('Opening desktop Sift. Prepare stems there for direct dragging.');}catch(error){$('#handoffError').textContent=error.message;}};
function refreshPreviewMetadata(){const s=sampleById(state.selected);if(s)$('#previewDetail').textContent=`${s.folder} · ${s.bpm?`${s.bpm} BPM (${metadataSource(s.bpmSource)})`:'Tempo unknown'} · ${s.key || 'Key unknown'}`;}
async function refreshLibrary() { const data=await api('library');state.samples=data.samples;state.favorites=data.favorites;state.folders=data.folders;state.sets=data.sets;state.analysis=data.analysis;state.scan=data.scan;libraryStatusUnavailable=false;$('#recoveryNotice').hidden=!data.recovery;$('#recoveryNotice').textContent=data.recovery?`${data.recovery.message} Preserved files: ${data.recovery.preserved.join(', ')||'none'}`:'';renderSources();renderRows();renderSets();renderAnalysis();refreshPreviewMetadata();return data; }

$('#cleanupExports').onclick=async()=>{
  const button=$('#cleanupExports');button.disabled=true;
  $('#exportCleanupResult').textContent='Cleaning up unfinished exports…';
  try{
    const {removed}=await api('handoffs/cleanup',{});
    $('#exportCleanupResult').textContent=`${removed} unfinished export${removed===1?'':'s'} removed. Completed handoffs were kept.`;
  }catch(error){$('#exportCleanupResult').textContent=`Cleanup failed: ${error.message}`;}
  finally{button.disabled=false;}
};
$('#cleanupLibrary').onclick=async()=>{
  const button=$('#cleanupLibrary');button.disabled=true;
  try{
    const result=await api('library/cleanup',{});await refreshLibrary();
    if(state.selected&&!sampleById(state.selected)){preview.pause();state.selected=null;$('#previewName').textContent='Select a sample to listen';$('#previewDetail').textContent='Click a row · audition in its original pitch and tempo';$('#addToBench').disabled=true;$('#sampleDetails').disabled=true;updatePreviewControls();}
    toast(`${result.removed} missing entries removed.${result.missing?` ${result.missing} kept for gems, sets or the workbench.`:''}${result.unavailableRoots?` ${result.unavailableRoots} unavailable source folders skipped; reconnect their drives.`:''}`);
  }catch(e){toast(e.message);}finally{button.disabled=false;}
};
let libraryStatusUnavailable=false;
function renderLibraryActivity() {
  const activity=libraryActivity(state.scan,state.analysis,libraryStatusUnavailable),panel=$('#libraryActivity'),progress=$('#libraryActivityProgress'),button=$('#libraryActivityAction');
  panel.hidden=!activity.visible;panel.classList.toggle('busy',activity.busy);
  $('#scanState').classList.toggle('processing',activity.busy);$('#scanState').innerHTML=`<i></i> ${escape(activity.label)}`;
  if(!activity.visible)return;
  if($('#libraryActivityTitle').textContent!==activity.title)$('#libraryActivityTitle').textContent=activity.title;
  $('#libraryActivityDetail').textContent=activity.detail;
  $('#libraryActivityCurrent').textContent=activity.current||'';$('#libraryActivityCurrent').title=activity.current||'';
  progress.hidden=!activity.busy&&!activity.progress;
  if(activity.progress){progress.max=Math.max(1,activity.progress.max);progress.value=activity.progress.value;progress.setAttribute('aria-valuetext',`${activity.progress.value} of ${activity.progress.max} samples processed`);}else{progress.removeAttribute('value');progress.removeAttribute('aria-valuetext');}
  button.hidden=!activity.action;button.dataset.action=activity.action||'';button.textContent=activity.actionLabel||'';
}
$('#libraryActivityAction').onclick=async()=>{
  const button=$('#libraryActivityAction'),action=button.dataset.action;button.disabled=true;
  try{if(action==='cancel')state.scan=await api('cancel-scan',{});else state.analysis=await api('analysis',{action});renderAnalysis();}
  catch(error){toast(error.message);}finally{button.disabled=false;}
};
$('#navigation').addEventListener('click',e=>{const button=e.target.closest('[data-view]');if(button)setView(button.dataset.view);});
$('#sources').addEventListener('click',e=>{const button=e.target.closest('[data-source]');if(button){state.source=button.dataset.source||null;state.page=0;renderSources();renderRows();}});
for(const id of ['addFolder','sidebarAdd'])$('#'+id).onclick=()=>{$('#folderError').textContent='';$('#folderDialog').showModal();};
$('#aboutButton').onclick=()=>$('#aboutDialog').showModal();
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$('#'+button.dataset.close).close());
$('#folderForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('#folderError').textContent='';try{await api('scan',{path:$('#folderPath').value.trim()});state.scan={running:true,count:0};libraryStatusUnavailable=false;state.source=null;$('#folderDialog').close();renderLibraryActivity();void pollAnalysis();}catch(error){$('#folderError').textContent=error.message;}finally{button.disabled=false;}};
$('#browseFolder').onclick=async()=>{const button=$('#browseFolder');button.disabled=true;button.textContent='Choose folder…';try{const result=await api('pick-folder',{});if(result.path)$('#folderPath').value=result.path;}catch(e){$('#folderError').textContent=e.message;}finally{button.disabled=false;button.textContent='Browse…';}};
$('#search').oninput=e=>{state.query=e.target.value;state.page=0;renderRows();};
for(const [id,prop]of [['typeFilter','type'],['bpmFilter','bpm'],['sort','sort']])$('#'+id).onchange=e=>{state[prop]=e.target.value;state.page=0;renderRows();};
$('#previousPage').onclick=()=>{state.page--;renderRows();};$('#nextPage').onclick=()=>{state.page++;renderRows();};
$('#sampleRows').onclick=e=>{const row=e.target.closest('[data-id]');if(!row)return;e.target.closest('.favorite')?favorite(row.dataset.id):audition(row.dataset.id);};
$('#sampleRows').onkeydown=e=>{if(e.target.classList.contains('sample-row')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();audition(e.target.dataset.id);}};
$('#sampleRows').ondblclick=e=>{const row=e.target.closest('[data-id]');if(row&&!e.target.closest('.favorite')){state.selected=row.dataset.id;addSelected();}};
$('#surprise').onclick=()=>{const s=pick(filteredSamples(),state.selected);if(s)audition(s.id);else toast('No samples match these filters.');};
$('#previewPlay').onclick=()=>{if(state.selected)audition(state.selected);else toast('Select a sample from the collection.');};$('#previewFavorite').onclick=()=>favorite(state.selected);$('#addToBench').onclick=addSelected;
preview.onended=()=>{updatePreviewControls();drawAll();};preview.onloadedmetadata=()=>{$('#previewTime').textContent=`${formatTime(preview.currentTime)} / ${formatTime(preview.duration)}`;};preview.onerror=()=>{updatePreviewControls();toast('This audio file is unavailable or unsupported by the browser.');};
$('#playMix').onclick=playMix;$('#shuffle').onclick=()=>reroll();$('#exportMix').onclick=exportMix;
$('#tracks').onclick=async e=>{const button=e.target.closest('[data-action]');if(!button)return;const index=+button.closest('[data-track]').dataset.track,track=state.tracks[index];if(button.dataset.action==='reroll')return reroll(index);if(button.dataset.action==='timing')return openTiming(index);if(button.dataset.action==='name')return openMetadata(track.id);const key=button.dataset.action==='lock'?'locked':button.dataset.action;track[key]=!track[key];renderTracks();updateGains();saveWorkspace();};
$('#tracks').oninput=e=>{if(e.target.classList.contains('level')){const i=+e.target.closest('[data-track]').dataset.track;state.tracks[i].volume=+e.target.value;e.target.title=`Volume ${Math.round(+e.target.value*100)}%`;updateGains();saveWorkspace();}};
let tempoTimer;
$('#tempo').oninput=e=>{const value=Number(e.target.value);if(value>=40&&value<=240){state.tempo=value;saveWorkspace();clearTimeout(tempoTimer);if(mixPlaying||mixStarting)tempoTimer=setTimeout(()=>{stopMix();playMix();},350);}};
$('#tempo').onchange=async e=>{clearTimeout(tempoTimer);state.tempo=Math.max(40,Math.min(240,Number(e.target.value)||92));e.target.value=state.tempo;saveWorkspace();warmTracks();drawAll();if(mixPlaying||mixStarting){stopMix();await playMix();}};
$('#sync').onchange=async e=>{state.sync=e.target.checked;saveWorkspace();renderHarmonyStatus();warmTracks();drawAll();if(mixPlaying||mixStarting){stopMix();await playMix();}};
$('#sessionKey').onchange=async e=>{const wasPlaying=mixPlaying||mixStarting;stopMix();state.key=e.target.value||null;renderTracks();saveWorkspace();if(wasPlaying)await playMix();};
let timingIndex=null,timingSampleId=null,timingPreviewNode=null,timingPreviewToken=0;
function stopTimingPreview(){timingPreviewToken++;if(timingPreviewNode){try{timingPreviewNode.stop();}catch{}timingPreviewNode.disconnect();timingPreviewNode=null;}$('#timingPreview').textContent='Preview start';}
function openTiming(index){
  const track=state.tracks[index],sample=sampleById(track.id);if(!sample)return;
  stopMix();preview.pause();updatePreviewControls();stopTimingPreview();timingIndex=index;timingSampleId=sample.id;
  const timing=track.timing||defaultTiming();$('#timingTitle').textContent=`Layer ${index+1} timing`;$('#timingTitle').title=sample.filename;
  $('#timingOffset').value=timing.offset ?? '';$('#timingRepeat').value=timing.repeat;$('#timingError').textContent='';$('#timingDialog').showModal();
}
$('#timingDialog').addEventListener('close',stopTimingPreview);
$('#resetTiming').onclick=()=>{stopTimingPreview();$('#timingOffset').value='';$('#timingRepeat').value='auto';$('#timingError').textContent='';};
$('#timingOffset').oninput=stopTimingPreview;
$('#timingPreview').onclick=async()=>{
  if(timingPreviewNode){stopTimingPreview();return;}
  stopTimingPreview();const token=timingPreviewToken;
  try{
    const entered=$('#timingOffset').value,sample=sampleById(timingSampleId);let offset=entered===''?null:Number(entered);
    if(!sample||(offset!==null&&(!Number.isFinite(offset)||offset<0)))throw new Error('Choose a valid start offset.');
    const ctx=audioContext();await ctx.resume();const buffer=await decode(sample);
    offset ??= audibleStart(buffer)/buffer.sampleRate;
    if(token!==timingPreviewToken||!$('#timingDialog').open)return;
    if(offset>=buffer.duration)throw new Error('Start offset is past the end of this sample.');
    const source=ctx.createBufferSource();source.buffer=buffer;source.connect(ctx.destination);timingPreviewNode=source;
    source.onended=()=>{source.disconnect();if(timingPreviewNode===source){timingPreviewNode=null;$('#timingPreview').textContent='Preview start';}};
    source.start(0,offset,Math.min(8,buffer.duration-offset));$('#timingPreview').textContent='Stop preview';$('#timingError').textContent='';
  }catch(error){$('#timingError').textContent=error.message;}
};
$('#timingForm').onsubmit=async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true;stopTimingPreview();
  const index=timingIndex,id=timingSampleId;
  try{
    const track=state.tracks[index];if(track?.id!==id)throw new Error('This layer changed. Reopen its timing controls.');
    const timing={offset:$('#timingOffset').value===''?null:Number($('#timingOffset').value),repeat:$('#timingRepeat').value};
    await cycleForTrack({...track,timing},currentSettings());
    if(!$('#timingDialog').open||state.tracks[index]?.id!==id)return;
    clearTimeout(saveTimer);
    const workspace=snapshot();workspace.tracks=state.tracks.map((layer,i)=>i===index?{...layer,timing}:layer);
    await api('workspace',workspace);
    if(state.tracks[index]?.id!==id)return;
    state.tracks[index].timing=timing;renderTracks();$('#timingDialog').close();toast('Timing saved for playback and export.');
  }catch(error){$('#timingError').textContent=error.message;}finally{button.disabled=false;}
};
$('#saveSet').onclick=()=>{if(!state.tracks.some(t=>t.id)){toast('Add a sample first.');return;}$('#setName').value=state.setName==='Untitled set'?'':state.setName;$('#saveDialog').showModal();};
$('#saveForm').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const name=$('#setName').value.trim();if(!name)return;const set=await api('sets',{...snapshot(),name});state.sets.unshift(set);state.setName=name;renderTracks();renderSources();renderSets();saveWorkspace();$('#saveDialog').close();toast('Set saved on this machine.');}catch(error){toast(error.message);}finally{button.disabled=false;}};
$('#savedSets').onclick=e=>{const button=e.target.closest('[data-load-set]');if(!button)return;const set=state.sets.find(s=>s.id===button.dataset.loadSet);if(!set)return;stopMix();const workspace=normalizeWorkspace(set);state.tracks=workspace.tracks;state.tempo=workspace.tempo;state.sync=workspace.sync;state.key=workspace.key;state.setName=set.name;renderTracks();setView('discover');saveWorkspace();warmTracks();};
function renderAnalysis(){
  renderLibraryActivity();
  const status=state.analysis;if(!status)return;
  $('#analysisSaveNotice').hidden=!status.saveError;
  // Avoid repeatedly announcing the same alert on every status poll.
  if($('#analysisSaveError').textContent!==(status.saveError||''))$('#analysisSaveError').textContent=status.saveError||'';
  const done=state.samples.filter(s=>s.analysis?.status==='done').length,errors=state.samples.filter(s=>s.analysis?.status==='error').length;
  $('#toolsStatus').textContent=status.saveError?'Save needs attention':status.paused?'Analysis paused':status.running?'Analyzing…':`${done.toLocaleString()} analyzed${errors?` · ${errors} failed`:''}`;
  $('#analysisSummary').textContent=status.saveError?'Analysis paused: could not save results.':status.paused?`Analysis paused · ${status.pending} queued${status.running?' · finishing current sound':''}`:status.running?`Analyzing ${status.current} · ${status.pending} queued`:`${done.toLocaleString()} analyzed${errors?` · ${errors} failed — retry below`:''} · local audio analysis`;
  $('#analysisSummary').title=status.saveError || 'Tempo and key are estimates. Open Sample details to inspect or correct them.';
  $('#analysisPause').textContent=status.paused?'Resume analysis':'Pause analysis';
  $('#analysisPause').disabled=!status.paused&&!status.running&&!status.pending;
}
let analysisPolling=false;
async function pollAnalysis(){
  if(analysisPolling)return;analysisPolling=true;
  try{const latest=await api('library/status'),previous=state.analysis?.revision,scanFinished=state.scan?.running&&!latest.scan.running;state.analysis=latest.analysis;state.scan=latest.scan;libraryStatusUnavailable=false;
    if(latest.analysis.revision!==previous||scanFinished){await refreshLibrary();if(!mixPlaying&&!mixStarting&&!document.activeElement?.matches('.level,#tempo'))renderTracks();}else renderAnalysis();
    if(scanFinished)toast(latest.scan.error?`Scan failed: ${latest.scan.error}`:`${latest.scan.cancelled?'Stopped. ':''}${latest.scan.count.toLocaleString()} samples indexed${latest.scan.skipped?` · ${latest.scan.skipped} unreadable items skipped`:''}.${latest.analysis.remaining?' Audio analysis continues in the background.':''}`);
  }catch{ libraryStatusUnavailable=true;renderLibraryActivity();$('#analysisSummary').textContent='Analysis service unavailable — check that Sift is running.'; }
  finally{analysisPolling=false;}
}
$('#analysisPause').onclick=async()=>{try{state.analysis=await api('analysis',{action:state.analysis?.paused?'resume':'pause'});renderAnalysis();}catch(e){toast(e.message);}};
$('#retryAnalysisSave').onclick=async()=>{
  const button=$('#retryAnalysisSave');button.disabled=true;button.textContent='Retrying save…';
  try{state.analysis=await api('analysis',{action:'resume'});renderAnalysis();toast('Analysis results saved. Analysis resumed.');}
  catch(error){$('#analysisSaveError').textContent=error.message;}
  finally{button.disabled=false;button.textContent='Retry save and resume';}
};
$('#analyzeSource').onclick=async()=>{try{state.analysis=await api('analysis',{action:'reanalyze',ids:sourceSamples().map(s=>s.id)});renderAnalysis();toast('Source queued for audio analysis. Your corrections are preserved.');}catch(e){toast(e.message);}};
const keyNames=noteNames;
for(const root of keyNames)for(const scale of ['maj','min']){const option=document.createElement('option');option.value=`${root} ${scale}`;option.textContent=option.value;$('#sessionKey').append(option);}
for(const root of keyNames)for(const scale of ['maj','min']){const option=document.createElement('option');option.value=`${root} ${scale}`;option.textContent=option.value;$('#sampleKey').append(option);}
let metadataId;
function openMetadata(id=state.selected){
  const sample=sampleById(id);if(!sample)return;metadataId=sample.id;
  $('#metadataTitle').textContent=sample.name;$('#metadataFile').textContent=`${sample.filename}\n${sample.path||sample.folder}`;$('#sampleBpm').value=sample.bpm??'';
  if(sample.key&&!Array.from($('#sampleKey').options).some(o=>o.value===sample.key)){const option=document.createElement('option');option.value=sample.key;option.textContent=sample.key;$('#sampleKey').append(option);}
  $('#sampleKey').value=sample.key||'';$('#metadataError').textContent='';
  const a=sample.analysis;
  $('#analysisEvidence').innerHTML=`<p>Sound type: <strong>${escape(sample.type)}</strong> · ${escape(sample.typeSource||'unknown')}${sample.typeHint?`: ${escape(sample.typeHint)}`:''}</p><p>Filename labels: <strong>${sample.labels?.bpm?`${sample.labels.bpm} BPM${sample.labels.bpmExplicit?'':' (number hint)'}`:'tempo unknown'}</strong> · <strong>${escape(sample.labels?.key||'key unknown')}</strong></p><p>Current tempo: <strong>${escape(metadataSource(sample.bpmSource))}</strong> · key: <strong>${escape(sample.keySource||'unknown')}</strong></p>`+(a?.status==='done'?`<p>Audio estimate: <strong>${a.bpm?`${a.bpm} BPM`:'tempo unknown'}</strong> · <strong>${escape(a.key||'key unknown')}</strong></p><p>Beat confidence: ${Number(a.bpmConfidence||0).toFixed(2)} · key strength: ${Number(a.keyStrength||0).toFixed(2)}<br>Examined ${a.analyzedSeconds.toFixed(1)} seconds${sample.duration>a.analyzedSeconds+1?' (opening excerpt)':''}. These scores are algorithm measures, not probabilities.</p><p>${(a.warnings||[]).map(escape).join('<br>')}</p>`:a?.status==='error'?`<p class="error">${escape(a.error)}</p>`:'<p>Audio analysis is pending. Explicit filename labels are kept; analysis fills missing values.</p>');
  $('#metadataDraft').textContent='';
  $('#metadataConflicts').innerHTML=Object.entries(sample.conflicts||{}).map(([field,c])=>`<div class="metadata-conflict"><strong>${field==='bpm'?'Tempo':'Key'} disagreement${c.resolved?' · manually resolved':''}</strong><p>Filename: ${escape(c.label)}${field==='bpm'?' BPM':''} · Audio: ${escape(c.estimate)}${field==='bpm'?' BPM':''}${c.kind==='relative-key'?' · relative major/minor':c.kind==='half-double'?' · half/double tempo':''}</p><p>${c.resolved?'Your correction is in use.':'The filename label is kept. Choose a value below or enter your own.'}</p><div><button type="button" class="button small" data-metadata-field="${field}" data-metadata-value="label">Use filename ${field==='bpm'?'BPM':'key'}</button><button type="button" class="button small" data-metadata-field="${field}" data-metadata-value="estimate">Use audio ${field==='bpm'?'BPM':'key'}</button></div></div>`).join('');
  $('#metadataDialog').showModal();
}
$('#sampleDetails').onclick=()=>openMetadata();
$('#reviewConflicts').onclick=()=>{state.conflictsOnly=!state.conflictsOnly;state.page=0;renderRows();};
$('#metadataConflicts').onclick=e=>{
  const button=e.target.closest('[data-metadata-field]');if(!button)return;
  const sample=sampleById(metadataId),field=button.dataset.metadataField;
  const value=sample.conflicts[field][button.dataset.metadataValue];
  $('#'+(field==='bpm'?'sampleBpm':'sampleKey')).value=value;
  $('#metadataError').textContent='';$('#metadataDraft').textContent='Choice ready. Save corrections to apply it.';
};
for(const [id,multiplier]of [['halfBpm',.5],['doubleBpm',2]])$('#'+id).onclick=()=>{const bpm=Number($('#sampleBpm').value)*multiplier;if(bpm>=40&&bpm<=240)$('#sampleBpm').value=Math.round(bpm*10)/10;else $('#metadataError').textContent='Source BPM must stay between 40 and 240.';};
async function applyMetadata(input){
  const updated=await api('metadata',{id:metadataId,...input});const index=state.samples.findIndex(s=>s.id===updated.id);state.samples[index]=updated;
  if(state.tracks.some(t=>t.id===updated.id)&&(mixPlaying||mixStarting))stopMix();
  renderTracks();renderRows();refreshPreviewMetadata();$('#metadataDialog').close();toast(input.reset?'Label priority restored; manual corrections cleared.':'Corrections saved. Press play to hear the updated sync.');
}
$('#metadataForm').onsubmit=async e=>{e.preventDefault();try{await applyMetadata({bpm:$('#sampleBpm').value===''?null:Number($('#sampleBpm').value),key:$('#sampleKey').value||null});}catch(error){$('#metadataError').textContent=error.message;}};
$('#resetMetadata').onclick=async()=>{try{await applyMetadata({reset:true});}catch(e){$('#metadataError').textContent=e.message;}};
$('#reanalyzeSample').onclick=async()=>{try{state.analysis=await api('analysis',{action:'reanalyze',ids:[metadataId]});renderAnalysis();$('#metadataDialog').close();toast('Sample queued. Corrections will be kept.');}catch(e){$('#metadataError').textContent=e.message;}};
setInterval(pollAnalysis,2000);
document.addEventListener('keydown',e=>{if(e.target.closest('input,select,textarea')||document.querySelector('dialog[open]'))return;if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();focusCollectionSearch();return;}if(e.target.closest('button'))return;if(e.key===' '){e.preventDefault();playMix();}else if(e.key.toLowerCase()==='r'&&!e.ctrlKey&&!e.metaKey){e.preventDefault();reroll();}else if(['ArrowDown','ArrowUp'].includes(e.key)){const list=filteredSamples();const i=list.findIndex(s=>s.id===state.selected),next=list[Math.max(0,Math.min(list.length-1,i+(e.key==='ArrowDown'?1:-1)))];if(next){e.preventDefault();state.page=Math.floor(list.indexOf(next)/50);audition(next.id);}}});
window.addEventListener('resize',drawAll);
async function init(){try{const data=await refreshLibrary(),workspace=normalizeWorkspace(data.workspace);state.tracks=workspace.tracks;state.tempo=workspace.tempo;state.sync=workspace.sync;state.key=workspace.key;state.setName=workspace.name;renderTracks();renderRows();warmTracks();requestAnimationFrame(animation);}catch(e){toast(`Could not connect to Sift: ${e.message}`);libraryStatusUnavailable=true;renderLibraryActivity();}}
init();
