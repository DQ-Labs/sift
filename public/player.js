// Audio: decoding, prepared four-bar cycles, sample preview and the mix transport.
import { api } from './api.js';
import { pitchPlan, renderPlan } from './harmony.js';
import { defaultTiming, makeCycle, createCycleSource, sessionFrames, cyclePosition } from './timing.js';
import { audibleTracks } from './export-audio.js';
import { $, icon, colors, toast, formatTime, metadataSource, displayName } from './ui.js';
import { state, sampleById, currentSettings } from './state.js';
import { renderRows } from './collection.js';
import { commitTransportControls } from './workbench.js';

const maxWorkbenchBytes = 100 * 1024 * 1024;
const maxDecodedBytes = 128 * 1024 * 1024;
const bufferCacheBytes = 160 * 1024 * 1024;
const bufferCacheEntries = 12;
const preparedLimit = 16;

let context;
export function audioContext() {
  context ||= new AudioContext();
  return context;
}

export function waveform(buffer) {
  const data = buffer.getChannelData(0);
  const result = Array(160).fill(0);
  const step = Math.max(1, Math.floor(data.length / 60000));
  for (let i = 0; i < data.length; i += step) {
    const bin = Math.min(159, Math.floor(i / data.length * 160));
    result[bin] = Math.max(result[bin], Math.abs(data[i]));
  }
  return result;
}

// ---- Decoding -------------------------------------------------------------

const buffers = new Map();
const loading = new Map();
const bufferBytes = buffer => buffer.length * buffer.numberOfChannels * 4;

function trimBufferCache(keep) {
  let bytes = [...buffers.values()].reduce((total, buffer) => total + bufferBytes(buffer), 0);
  for (const [key, buffer] of buffers) {
    if ((buffers.size <= bufferCacheEntries && bytes <= bufferCacheBytes) || key === keep) break;
    bytes -= bufferBytes(buffer);
    buffers.delete(key);
  }
}

async function fetchAndDecode(sample, render, cacheKey) {
  const response = await fetch(render?.url || `/audio/${sample.id}`);
  if (!response.ok) throw new Error(`${sample.name} is unavailable. Check that its drive is connected.`);
  let buffer;
  try {
    buffer = await audioContext().decodeAudioData(await response.arrayBuffer());
  } catch {
    throw new Error(`Cannot decode ${sample.filename}. Try a PCM WAV or supported MP3/FLAC file.`);
  }
  if (bufferBytes(buffer) > maxDecodedBytes) throw new Error('This recording is too long for the workbench. Audition it or use a shorter excerpt.');
  if (!render) {
    sample.peaks = waveform(buffer);
    sample.duration = buffer.duration;
    sample.rate = buffer.sampleRate;
    sample.channels = buffer.numberOfChannels;
  }
  buffers.set(cacheKey, buffer);
  trimBufferCache(cacheKey);
  return buffer;
}

export async function decode(sample, render = null) {
  const cacheKey = render?.url || `${sample.id}:${sample.mtime || ''}`;
  if (buffers.has(cacheKey)) {
    // Re-insert to mark it most recently used.
    const buffer = buffers.get(cacheKey);
    buffers.delete(cacheKey);
    buffers.set(cacheKey, buffer);
    return buffer;
  }
  if (loading.has(cacheKey)) return loading.get(cacheKey);
  if (sample.size > maxWorkbenchBytes) throw new Error('This file is over 100 MB. You can audition it, but choose a shorter file for the workbench.');
  const promise = fetchAndDecode(sample, render, cacheKey);
  loading.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    loading.delete(cacheKey);
  }
}

// priority is 'now' for a layer someone is waiting to hear and 'prefetch'
// for background renders; the server starts 'now' renders first.
const stretchRequest = (sample, settings, priority) => ({ id: sample.id, ...settings, priority });

async function playbackBuffer(sample, settings, priority = 'now') {
  if (!renderPlan(sample, settings).processed) return decode(sample);
  const render = await api('stretch', stretchRequest(sample, settings, priority));
  return decode(sample, render);
}

// ---- Waveforms ------------------------------------------------------------

export function drawWave(canvas, peaks, color, progress = -1) {
  if (!canvas) return;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  if (!peaks?.length) {
    ctx.strokeStyle = '#353b46';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    return;
  }
  const max = Math.max(.02, ...peaks);
  const count = Math.min(peaks.length, Math.floor(width / 3));
  for (let i = 0; i < count; i++) {
    const value = peaks[Math.floor(i / count * peaks.length)] / max;
    const bar = Math.max(1, value * (height - 4));
    ctx.fillStyle = progress >= 0 && i / count > progress ? '#3a404b' : color;
    ctx.fillRect(i * width / count, (height - bar) / 2, Math.max(1, width / count - 1.5), bar);
  }
}

export function drawAll() {
  document.querySelectorAll('canvas[data-sample]').forEach(canvas => {
    const sample = sampleById(canvas.dataset.sample);
    drawWave(canvas, sample?.peaks, colors[sample?.type] || colors.Other);
  });
  document.querySelectorAll('canvas[data-track-wave]').forEach(canvas => {
    const track = state.tracks[Number(canvas.dataset.trackWave)];
    drawWave(canvas, preparedFor(track)?.peaks, colors[track?.type] || colors.Other);
  });
  drawPreviewWave();
}

function drawPreviewWave() {
  const sample = sampleById(state.selected);
  const progress = preview.duration ? preview.currentTime / preview.duration : -1;
  drawWave($('#previewWave'), sample?.peaks, colors[sample?.type] || colors.Other, progress);
}

// ---- Prepared cycles ------------------------------------------------------
// Each entry is one layer rendered into the shared four-bar cycle, keyed by
// everything that changes its audio. Keying by content rather than layer
// index lets a prefetched reroll candidate be reused once it is swapped in.

const prepared = new Map();

export function trackSignature(track, sample, settings) {
  const timing = { ...defaultTiming(), ...track.timing };
  // Only the first beats shape the fitted grid (see beatGrid in timing.js).
  const beats = sample.beats?.slice(0, 18) || null;
  return JSON.stringify([track.id, sample.mtime, sample.bpm, sample.key, sample.type, sample.bpmSource, sample.conflicts?.bpm, beats, timing, settings]);
}

export async function cycleForTrack(track, settings, { priority = 'now' } = {}) {
  const current = sampleById(track.id);
  if (!current) return null;
  const sample = { ...current };
  const buffer = await playbackBuffer(sample, settings, priority);
  return { ...makeCycle(audioContext(), buffer, sample, track, settings), sample };
}

export function preparedFor(track, settings = currentSettings()) {
  const sample = sampleById(track?.id);
  if (!sample) return null;
  return prepared.get(trackSignature(track, sample, settings)) || null;
}

function rememberPrepared(entry) {
  prepared.delete(entry.signature);
  prepared.set(entry.signature, entry);
  while (prepared.size > preparedLimit) prepared.delete(prepared.keys().next().value);
}

// Asks the server to move a background render to the front of its queue.
// The original request still delivers the result; this one only re-ranks it.
function promote(entry, sample, settings) {
  entry.priority = 'now';
  if (entry.ready || !renderPlan(sample, settings).processed) return;
  api('stretch', stretchRequest(sample, settings, 'now')).catch(() => {});
}

// Starts (or reuses) rendering a layer. Returns the cache entry, or null when
// the layer has no sample. A 'now' request for a layer still rendering as a
// prefetch promotes that render.
export function prepareCycle(track, settings = currentSettings(), { priority = 'now' } = {}) {
  const sample = sampleById(track?.id);
  if (!sample) return null;
  const signature = trackSignature(track, sample, settings);
  const existing = prepared.get(signature);
  if (existing && !existing.error) {
    if (priority === 'now' && existing.priority === 'prefetch') promote(existing, sample, settings);
    rememberPrepared(existing);
    return existing;
  }
  const entry = { signature, peaks: null, ready: false, priority };
  entry.promise = cycleForTrack(structuredClone(track), settings, { priority }).then(result => {
    Object.assign(entry, result, { peaks: waveform(result.buffer), ready: true });
    return result;
  }).catch(error => {
    entry.error = error.message;
    throw error;
  });
  rememberPrepared(entry);
  return entry;
}

const startDescriptions = {
  beat: 'Snapped to the first beat of the analysed beat grid',
  sound: 'First sound selected by skipping leading silence',
  manual: 'Exact manual start'
};

function timingTitle(entry) {
  if (entry.error) return entry.error;
  const plan = entry.plan;
  return [
    plan?.offset ? `Starts at ${plan.offset.toFixed(2)} source seconds` : 'Starts at file beginning',
    startDescriptions[plan?.start] || startDescriptions.sound,
    ...(plan?.warnings || []),
    'Beats are not downbeats: use Timing to place bar 1 by ear.'
  ].join('. ');
}

function updateTrackTiming(index, entry) {
  const track = state.tracks[index];
  const sample = sampleById(track?.id);
  if (!sample || entry.signature !== trackSignature(track, sample, currentSettings())) return;
  const element = document.querySelector(`[data-track="${index}"] .track-timing`);
  if (!element) return;
  const warnings = entry.plan?.warnings.length;
  element.textContent = entry.error ? 'Timing unavailable' : entry.plan ? entry.plan.label : 'Preparing timeline…';
  if (warnings) element.textContent += ' · check BPM';
  element.title = timingTitle(entry);
  element.classList.toggle('timing-warning', !!entry.error || !!warnings);
}

export function prepareTrack(track, index, settings = currentSettings()) {
  const entry = prepareCycle(track, settings);
  if (!entry) return Promise.resolve(null);
  updateTrackTiming(index, entry);
  entry.promise.then(() => {
    updateTrackTiming(index, entry);
    drawAll();
  }, () => updateTrackTiming(index, entry));
  return entry.promise;
}

export function warmTracks() {
  return Promise.allSettled(state.tracks.map((track, index) => prepareTrack(track, index)));
}

// ---- Sample preview -------------------------------------------------------

export const preview = new Audio();
preview.preload = 'metadata';
preview.volume = .75;
let previewToken = 0;

function previewDetail(sample) {
  const tempo = sample.bpm ? `${sample.bpm} BPM (${metadataSource(sample.bpmSource)})` : 'Tempo unknown';
  return `${sample.folder} · ${tempo} · ${sample.key || 'Key unknown'}`;
}

export function refreshPreviewMetadata() {
  const sample = sampleById(state.selected);
  if (sample) $('#previewDetail').textContent = previewDetail(sample);
}

export function updatePreviewControls() {
  const playing = !preview.paused;
  const gem = state.favorites.includes(state.selected);
  $('#previewPlay').innerHTML = icon(playing ? 'pause' : 'play');
  $('#previewPlay').setAttribute('aria-label', playing ? 'Pause selected sample' : 'Play selected sample');
  $('#previewFavorite').classList.toggle('active', gem);
  $('#previewFavorite').setAttribute('aria-pressed', String(gem));
  document.querySelectorAll('.row-play').forEach(button => {
    const selected = button.closest('[data-id]').dataset.id === state.selected;
    button.innerHTML = icon(selected && playing ? 'pause' : 'play');
  });
}

export function clearSelection() {
  preview.pause();
  preview.removeAttribute('src');
  state.selected = null;
  $('#previewName').textContent = 'Select a sample to listen';
  $('#previewDetail').textContent = 'Click any row to audition it';
  $('#previewTime').textContent = '— / —';
  $('#addToBench').disabled = true;
  $('#sampleDetails').disabled = true;
  updatePreviewControls();
  drawPreviewWave();
}

export async function audition(id) {
  if (state.selected === id && !preview.paused) {
    preview.pause();
    updatePreviewControls();
    return;
  }
  stopMix();
  const sample = sampleById(id);
  if (!sample) return;
  const token = ++previewToken;
  if (state.selected !== id) {
    preview.src = `/audio/${id}`;
    state.selected = id;
  }
  $('#previewName').textContent = displayName(sample);
  $('#previewDetail').textContent = previewDetail(sample);
  $('#previewTime').textContent = `0:00 / ${formatTime(sample.duration)}`;
  $('#addToBench').disabled = false;
  $('#sampleDetails').disabled = false;
  renderRows();
  try {
    await preview.play();
    if (token === previewToken) updatePreviewControls();
  } catch {
    if (token === previewToken) toast('Cannot play this file. It may be missing or use an unsupported codec.');
  }
  if (sample.size <= maxWorkbenchBytes && !sample.peaks) {
    decode(sample).then(() => {
      if (token !== previewToken) return;
      drawAll();
      renderRows();
    }).catch(() => {});
  } else {
    drawAll();
  }
}

function bindPreview() {
  preview.onended = () => {
    updatePreviewControls();
    drawAll();
  };
  preview.onloadedmetadata = () => {
    $('#previewTime').textContent = `${formatTime(preview.currentTime)} / ${formatTime(preview.duration)}`;
  };
  preview.onerror = () => {
    if (!preview.getAttribute('src')) return;
    updatePreviewControls();
    toast('This audio file is unavailable or unsupported by the browser.');
  };
}

// ---- Mix transport --------------------------------------------------------

let mixNodes = [];
let mixPlaying = false;
let mixStarting = false;
let mixToken = 0;
let mixStart = 0;
let mixCycleDuration = 0;
let restartTimer;

export const isMixActive = () => mixPlaying || mixStarting;

export function effectiveVolume(track) {
  const soloing = state.tracks.some(layer => layer.solo);
  return track.mute || (soloing && !track.solo) ? 0 : track.volume;
}

export function updateGains() {
  for (const { gain, index } of mixNodes) {
    gain.gain.setTargetAtTime(effectiveVolume(state.tracks[index]) * .6, context.currentTime, .015);
  }
}

function setTransportIdle() {
  $('#playMix').innerHTML = icon('play');
  $('#playMix').setAttribute('aria-label', 'Play mix');
  $('#workspace').classList.remove('playing');
  $('#transportStatus').textContent = 'READY TO EXPLORE';
  $('#transportTime').textContent = '00:00.0';
  $('#transportPosition').textContent = 'Bar 1 · Beat 1';
  document.querySelectorAll('.playhead').forEach(element => { element.style.left = '0%'; });
}

export function stopMix() {
  clearTimeout(restartTimer);
  mixToken++;
  mixStarting = false;
  mixPlaying = false;
  for (const node of mixNodes) {
    try {
      node.source.stop();
      node.source.disconnect();
      node.gain.disconnect();
    } catch {
      // Already stopped.
    }
  }
  mixNodes = [];
  setTransportIdle();
}

// Restarts a playing mix after the user stops typing a new tempo.
export function restartMixSoon(delay = 350) {
  clearTimeout(restartTimer);
  if (!isMixActive()) return;
  restartTimer = setTimeout(() => {
    stopMix();
    playMix();
  }, delay);
}

export async function restartMixIfActive() {
  if (!isMixActive()) return;
  stopMix();
  await playMix();
}

function playingStatus({ sync, key }) {
  if (key) return `${sync ? 'TEMPO + KEY' : 'KEY SYNC'} · ${key.toUpperCase()}`;
  return sync ? 'TEMPO SYNC · PITCH PRESERVED' : 'ORIGINAL SPEED · LOOPING';
}

function metadataNotices(ready, { sync, key }) {
  const notices = [];
  if (sync && ready.some(item => !item.sample.bpm)) notices.push('Unknown BPM: original speed.');
  if (key && ready.some(item => pitchPlan(item.sample, key).status === 'unknown')) notices.push('Unknown key: original pitch.');
  return notices;
}

function startSources(ctx, ready) {
  mixStart = ctx.currentTime + .06;
  mixCycleDuration = ready[0].buffer.duration;
  mixNodes = ready.map(({ buffer, index }) => {
    const source = createCycleSource(ctx, buffer);
    const gain = ctx.createGain();
    gain.gain.value = effectiveVolume(state.tracks[index]) * .6;
    source.connect(gain).connect(ctx.destination);
    source.start(mixStart);
    return { source, gain, index };
  });
}

export async function playMix() {
  if (isMixActive()) {
    stopMix();
    return;
  }
  commitTransportControls();
  if (!state.tracks.some(track => track.id)) {
    toast('Add a sample to the workbench first.');
    return;
  }
  preview.pause();
  updatePreviewControls();
  const ctx = audioContext();
  const token = ++mixToken;
  mixStarting = true;
  $('#transportStatus').textContent = state.sync || state.key ? 'PREPARING TEMPO / KEY' : 'LOADING SAMPLES';
  $('#playMix').innerHTML = icon('stop');
  $('#playMix').setAttribute('aria-label', 'Stop mix');
  try {
    await ctx.resume();
    if (token !== mixToken) return;
    const settings = currentSettings();
    const results = await Promise.all(state.tracks.map(async (track, index) => {
      const cycle = await prepareTrack(track, index, settings);
      return cycle ? { ...cycle, index } : null;
    }));
    if (token !== mixToken) return;
    const ready = results.filter(Boolean);
    if (!ready.length) throw new Error('These samples are unavailable. Reconnect their drive or choose another combination.');
    startSources(ctx, ready);
    mixStarting = false;
    mixPlaying = true;
    $('#workspace').classList.add('playing');
    $('#transportStatus').textContent = playingStatus(settings);
    const notices = metadataNotices(ready, settings);
    if (notices.length) toast(`${notices.join(' ')} Set source metadata in Sample details.`);
    drawAll();
  } catch (error) {
    if (token !== mixToken) return;
    stopMix();
    toast(error.message);
  }
}

function clockText(seconds) {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0');
  const whole = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${minutes}:${whole}.${Math.floor(seconds * 10) % 10}`;
}

function animation() {
  if (mixPlaying) {
    const elapsed = Math.max(0, context.currentTime - mixStart);
    const clock = cyclePosition(elapsed, Math.round(mixCycleDuration * context.sampleRate), context.sampleRate);
    $('#transportTime').textContent = clockText(clock.seconds);
    $('#transportPosition').textContent = `Bar ${clock.bar} · Beat ${clock.beat}`;
    for (const node of mixNodes) {
      const playhead = document.querySelector(`[data-track="${node.index}"] .playhead`);
      if (playhead) playhead.style.left = `${clock.fraction * 100}%`;
    }
  }
  if (!preview.paused && state.selected) {
    drawPreviewWave();
    $('#previewTime').textContent = `${formatTime(preview.currentTime)} / ${formatTime(preview.duration)}`;
  }
  requestAnimationFrame(animation);
}

// ---- Offline rendering for export and handoff ------------------------------

export async function renderExportLayers(workspace, includeAll = false, onProgress = () => {}) {
  const selected = audibleTracks(workspace.tracks, includeAll);
  if (!selected.length) throw new Error('No audible layers. Unmute a layer or include all loaded layers.');
  const settings = { tempo: workspace.tempo, sync: workspace.sync, key: workspace.key };
  const layers = [];
  for (const { track, index } of selected) {
    onProgress(`Rendering layer ${index + 1}…`);
    const cycle = await cycleForTrack(track, settings);
    if (!cycle) throw new Error(`Layer ${index + 1} is unavailable.`);
    const offline = new OfflineAudioContext(2, sessionFrames(workspace.tempo, 44100), 44100);
    const source = createCycleSource(offline, cycle.buffer);
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    layers.push({ index, gain: track.volume * .6, channels: [rendered.getChannelData(0), rendered.getChannelData(1)] });
  }
  return layers;
}

export function initPlayer() {
  bindPreview();
  $('#playMix').onclick = playMix;
  window.addEventListener('resize', drawAll);
  requestAnimationFrame(animation);
}
