// The four-layer workbench: layers, rerolls, session controls, sets and export.
import { api } from './api.js';
import { pitchPlan, clampVariety } from './harmony.js';
import { defaultTiming } from './timing.js';
import { mixScale, encodeWav } from './export-audio.js';
import { $, icon, escape, colors, toast, saveFile, displayName } from './ui.js';
import { state, catalog, sampleById, currentSettings, snapshot, applyWorkspace } from './state.js';
import { candidateContext, findSetByName, layerForSample, timestampedSetName, varietyLabel } from './workbench-model.js';
import {
  drawAll, isMixActive, playMix, prepareCycle, preparedFor, renderExportLayers,
  restartMixIfActive, restartMixSoon, stopMix, updateGains, warmTracks
} from './player.js';
import { renderSets, renderSources, setView } from './collection.js';
import { updateHandoffStatus } from './handoff.js';
import { openMetadata } from './details.js';
import { openTiming } from './timing-dialog.js';
import { confirmAction } from './dialogs.js';

const clampTempo = value => Math.max(40, Math.min(240, Number(value) || 92));

// ---- Persistence ----------------------------------------------------------

let saveTimer;

export function saveWorkspace() {
  updateHandoffStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('workspace', snapshot()).catch(error => toast(`Could not save workspace: ${error.message}`));
  }, 300);
}

export const cancelPendingSave = () => clearTimeout(saveTimer);

// Reads the transport inputs, in case a value was typed but not yet committed.
export function commitTransportControls({ save = true } = {}) {
  state.tempo = clampTempo($('#tempo').value);
  state.sync = $('#sync').checked;
  state.key = $('#sessionKey').value || null;
  if (save) saveWorkspace();
}

// ---- Rendering ------------------------------------------------------------

function trackMeta(sample) {
  if (!sample) return 'Choose from the collection';
  const hint = sample.bpmSource === 'filename-hint' ? '?' : '';
  return `${hint}${sample.bpm || '—'} BPM · ${escape(sample.key || 'Unpitched / unknown')}`;
}

function trackRow(track, index) {
  const sample = sampleById(track.id);
  const number = index + 1;
  const name = sample ? displayName(sample) : 'Add a sample';
  const lockLabel = track.locked ? 'Unlock' : 'Lock';
  const rerollTitle = track.locked ? 'Unlock this layer to reroll' : `Find another ${escape(track.type.toLowerCase())} sample (key ${number})`;
  return `<div class="track ${track.mute ? 'muted-track' : ''}" style="--track-color:${colors[track.type] || colors.Other}" data-track="${index}">
    <div class="track-title"><span class="track-number">0${number}</span><div class="track-text">
      <div class="track-type">${escape(track.type.toUpperCase())}</div>
      <button class="track-name" data-action="name" aria-label="Full name and details for layer ${number}: ${escape(name)}" title="${escape(sample?.filename || 'Choose a sample from the collection')}" ${sample ? '' : 'disabled'}>${escape(name)}</button>
      <div class="track-meta">${trackMeta(sample)}</div>
    </div></div>
    <div class="wave-area"><canvas data-track-wave="${index}" aria-label="${escape(track.type)} four-bar timeline"></canvas><div class="playhead"></div><div class="track-timing"></div></div>
    <div class="track-controls">
      <input type="range" class="level" min="0" max="1" step="0.01" value="${track.volume}" aria-label="Layer ${number} volume" title="Volume ${Math.round(track.volume * 100)}%">
      <button class="icon-button letter-button ${track.mute ? 'active' : ''}" data-action="mute" aria-label="Mute layer ${number}" aria-pressed="${track.mute}" title="Mute">M</button>
      <button class="icon-button letter-button ${track.solo ? 'active' : ''}" data-action="solo" aria-label="Solo layer ${number}" aria-pressed="${track.solo}" title="Solo">S</button>
      <button class="icon-button ${track.locked ? 'locked' : ''}" data-action="lock" aria-label="${lockLabel} layer ${number}" aria-pressed="${track.locked}" title="${lockLabel} sample">${icon(track.locked ? 'lock' : 'unlock')}</button>
      <button class="icon-button" data-action="timing" aria-label="Timing layer ${number}" title="Set start offset and repeat" ${sample ? '' : 'disabled'}>${icon('timing')}</button>
    </div>
    <button class="layer-reroll ${track.locked ? 'is-locked' : ''}" data-action="reroll" aria-label="Reroll layer ${number}" title="${rerollTitle}" ${track.locked ? 'disabled' : ''}>${icon(track.locked ? 'lock' : 'shuffle')}<span>${track.locked ? 'Locked' : 'Reroll'}</span></button>
  </div>`;
}

function pitchText(plan) {
  if (plan.status === 'original') return 'Original pitch';
  if (plan.status === 'drums') return 'Drums · pitch unchanged';
  if (plan.status === 'unknown') return 'Key unknown · pitch unchanged';
  const shift = plan.semitones ? ` · ${plan.semitones > 0 ? '+' : ''}${plan.semitones} st` : ' · no shift';
  return `${plan.outputKey}${shift}${plan.status === 'relative' ? ' · relative key' : ''}`;
}

function addPitchDetails() {
  document.querySelectorAll('[data-track]').forEach((element, index) => {
    const sample = sampleById(state.tracks[index].id);
    if (!sample) return;
    const detail = document.createElement('div');
    detail.className = 'track-match';
    detail.textContent = pitchText(pitchPlan(sample, state.key));
    detail.title = 'Source key stays unchanged in your library. Session transposition preserves major/minor character; relative keys share a scale.';
    element.querySelector('.track-type').append(detail);
  });
}

export function renderHarmonyStatus() {
  const samples = state.tracks.map(track => sampleById(track.id)).filter(Boolean);
  const notes = [state.key ? `${state.key} · relative major/minor allowed` : 'Original keys · choose a key to match pitched layers'];
  const unknownKeys = samples.filter(sample => pitchPlan(sample, state.key).status === 'unknown').length;
  const unknownTempos = state.sync ? samples.filter(sample => !sample.bpm).length : 0;
  if (unknownKeys) notes.push(`${unknownKeys} unknown ${unknownKeys === 1 ? 'key' : 'keys'}: pitch unchanged`);
  if (unknownTempos) notes.push(`${unknownTempos} unknown BPM: speed unchanged`);
  $('#harmonyStatus').textContent = notes.join(' · ');
}

function renderVariety() {
  const label = varietyLabel(state.variety);
  $('#variety').value = String(state.variety);
  $('#variety').setAttribute('aria-valuetext', label);
  $('#varietyValue').textContent = label;
}

export function renderTracks() {
  $('#tracks').innerHTML = state.tracks.map(trackRow).join('');
  $('#setLabel').textContent = state.setName;
  $('#tempo').value = state.tempo;
  $('#sync').checked = state.sync;
  $('#sessionKey').value = state.key || '';
  renderVariety();
  addPitchDetails();
  renderHarmonyStatus();
  $('#workbenchHint').textContent = state.tracks.some(track => track.id)
    ? 'Clock: set first downbeat and repeat. Locks keep sample choices.'
    : 'Start with New batch, or add samples from the collection.';
  requestAnimationFrame(drawAll);
  warmTracks();
  schedulePrefetch();
}

function refreshWorkbenchAudio() {
  warmTracks();
  drawAll();
  schedulePrefetch();
}

// ---- Rerolls and prefetching ----------------------------------------------
// After the audible layers are ready, Sift picks each unlocked layer's next
// reroll in the background and renders it. A reroll then swaps in audio that
// is already prepared, so playback restarts immediately.

const candidates = new Map();
let prefetchTimer;
let prefetchToken = 0;
let rollToken = 0;

function combinationRequest(index = null) {
  return { source: state.source, tracks: state.tracks, ...currentSettings(), variety: state.variety, index };
}

function contextFor(index) {
  return candidateContext({ source: state.source, settings: currentSettings(), variety: state.variety, tracks: state.tracks }, index);
}

// Applies the chosen samples to the current layers. Levels, mute, solo and
// locks come from the live state in case they changed while choosing.
function mergeChoices(current, chosen) {
  return current.map((track, i) => {
    const pick = chosen[i];
    if (!pick || track.locked || pick.id === track.id) return track;
    return { ...track, id: pick.id, type: pick.type, timing: pick.timing ?? defaultTiming() };
  });
}

function takeCandidate(index) {
  const candidate = candidates.get(index);
  candidates.delete(index);
  if (!candidate || candidate.context !== contextFor(index) || !sampleById(candidate.pick.id)) return null;
  return state.tracks.map((track, i) => i === index ? candidate.pick : track);
}

function candidateTrack(index, pick) {
  return { ...state.tracks[index], id: pick.id, type: pick.type, timing: pick.timing ?? defaultTiming() };
}

// True when layer `index` has a valid next pick whose audio is rendered.
export function candidateReady(index) {
  const candidate = candidates.get(index);
  if (!candidate || candidate.context !== contextFor(index)) return false;
  return !!preparedFor(candidateTrack(index, candidate.pick))?.ready;
}

export function schedulePrefetch() {
  clearTimeout(prefetchTimer);
  prefetchToken++;
  prefetchTimer = setTimeout(prefetchCandidates, 700);
}

async function prefetchCandidates() {
  const token = ++prefetchToken;
  // An empty workbench starts with New batch, so there is nothing to prefetch.
  if (!state.tracks.some(track => track.id)) return;
  await warmTracks();
  for (let index = 0; index < state.tracks.length; index++) {
    if (token !== prefetchToken) return;
    const track = state.tracks[index];
    const context = contextFor(index);
    if (track.locked) {
      candidates.delete(index);
      continue;
    }
    if (candidates.get(index)?.context === context) continue;
    candidates.delete(index);
    let chosen;
    try {
      ({ tracks: chosen } = await catalog.combination(combinationRequest(index)));
    } catch {
      continue;
    }
    if (token !== prefetchToken) return;
    const pick = chosen[index];
    if (!pick?.id || pick.id === track.id) continue;
    candidates.set(index, { context, pick });
    // One render at a time, so the prefetch never crowds out audible layers.
    const entry = prepareCycle(candidateTrack(index, pick));
    if (entry) await entry.promise.catch(() => {});
  }
}

// index === null replaces every unlocked layer ("New batch").
export async function reroll(index = null) {
  const token = ++rollToken;
  let chosen = index === null ? null : takeCandidate(index);
  if (!chosen) {
    try {
      ({ tracks: chosen } = await catalog.combination(combinationRequest(index)));
    } catch (error) {
      toast(`Could not find a combination: ${error.message}`);
      return;
    }
  }
  if (token !== rollToken) return;
  const next = mergeChoices(state.tracks, chosen);
  if (!next.some((track, i) => track.id !== state.tracks[i].id)) {
    toast(state.tracks.every(track => track.locked) ? 'Unlock a layer to explore new combinations.' : 'No other matching samples in this source.');
    return;
  }
  state.tracks = next;
  state.setName = 'Untitled set';
  const wasPlaying = isMixActive();
  stopMix();
  renderTracks();
  saveWorkspace();
  if (index !== null) document.querySelector(`[data-track="${index}"] [data-action="reroll"]`)?.focus({ preventScroll: true });
  if (wasPlaying) await playMix();
}

export const newBatch = () => reroll(null);

// ---- Adding and loading ---------------------------------------------------

export function addSelected() {
  const sample = sampleById(state.selected);
  if (!sample) return;
  if (sample.size > 100 * 1024 * 1024) {
    toast('Choose a sample under 100 MB for the workbench.');
    return;
  }
  const index = layerForSample(state.tracks, sample);
  if (index < 0) {
    toast('All layers are locked. Unlock one to add this sample.');
    return;
  }
  stopMix();
  Object.assign(state.tracks[index], { id: sample.id, type: sample.type, timing: defaultTiming() });
  state.setName = 'Untitled set';
  renderTracks();
  saveWorkspace();
  setView('discover');
  toast(`Added to layer ${index + 1}.`);
}

export async function loadSet(set, workspace) {
  stopMix();
  await catalog.hydrate(workspace.tracks.map(track => track.id)).catch(() => {});
  // Variety is an exploring preference, so opening a set keeps the current one.
  applyWorkspace(workspace);
  state.setName = set.name;
  renderTracks();
  setView('discover');
  saveWorkspace();
}

// ---- Sets -----------------------------------------------------------------

function addSet(set, replacedId = null) {
  state.sets = [set, ...state.sets.filter(existing => existing.id !== set.id && existing.id !== replacedId)];
  renderSources();
  renderSets();
}

// Anything exported is also kept as a set named after the moment it was made.
export async function autoSaveSet(workspace, kind) {
  try {
    const set = await api('sets', { ...workspace, name: timestampedSetName(new Date(), kind) });
    addSet(set);
    return set;
  } catch (error) {
    toast(`Exported, but the automatic set could not be saved: ${error.message}`);
    return null;
  }
}

async function confirmOverwrite(existing) {
  return confirmAction({
    title: 'Replace this set?',
    message: `A set called “${existing.name}” already exists. Saving replaces it with the current workbench.`,
    confirmLabel: 'Replace set'
  });
}

async function saveSet(event) {
  event.preventDefault();
  const name = $('#setName').value.trim();
  if (!name) return;
  const existing = findSetByName(state.sets, name);
  if (existing && !(await confirmOverwrite(existing))) return;
  const button = event.submitter || $('#saveForm [type="submit"]');
  button.disabled = true;
  try {
    const body = { ...snapshot(), name };
    // `replaces` asks the server to swap out the earlier set; servers that
    // predate it keep both, and say so by returning a set without `replaced`.
    if (existing) body.replaces = existing.id;
    const set = await api('sets', body);
    const replaced = existing && (set.replaced === existing.id || set.id === existing.id);
    addSet(set, replaced ? existing.id : null);
    state.setName = name;
    renderTracks();
    saveWorkspace();
    $('#saveDialog').close();
    toast(existing && !replaced ? 'Set saved. This Sift version also keeps the earlier set with that name.' : 'Set saved on this machine.');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

// ---- Export ---------------------------------------------------------------

export function exportSnapshot() {
  commitTransportControls({ save: false });
  return structuredClone(snapshot());
}

function mixDown(layers) {
  const length = layers[0].channels[0].length;
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (const layer of layers) {
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < length; i++) channels[c][i] += layer.channels[c][i] * layer.gain;
    }
  }
  return channels;
}

async function exportMix() {
  const button = $('#exportMix');
  button.disabled = true;
  button.innerHTML = `${icon('download')} Rendering…`;
  try {
    const workspace = exportSnapshot();
    const layers = await renderExportLayers(workspace);
    const bytes = encodeWav(mixDown(layers), { scale: mixScale(layers) });
    const name = `Sift-${workspace.name.replace(/[^a-z0-9 -]/gi, '')}-${workspace.tempo}bpm.wav`;
    saveFile(new Blob([bytes], { type: 'audio/wav' }), name);
    const set = await autoSaveSet(workspace, 'Mix export');
    toast(`Exported 4 bars · stereo WAV · 44.1 kHz / 16-bit.${set ? ` Saved as “${set.name}”.` : ''}`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = `${icon('download')}Export mix`;
  }
}

// ---- Events ---------------------------------------------------------------

function onTrackClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const index = Number(button.closest('[data-track]').dataset.track);
  const track = state.tracks[index];
  const action = button.dataset.action;
  if (action === 'reroll') return reroll(index);
  if (action === 'timing') return openTiming(index);
  if (action === 'name') return openMetadata(track.id);
  const flag = action === 'lock' ? 'locked' : action;
  track[flag] = !track[flag];
  renderTracks();
  updateGains();
  saveWorkspace();
}

function onTrackInput(event) {
  if (!event.target.classList.contains('level')) return;
  const index = Number(event.target.closest('[data-track]').dataset.track);
  state.tracks[index].volume = Number(event.target.value);
  event.target.title = `Volume ${Math.round(Number(event.target.value) * 100)}%`;
  updateGains();
  saveWorkspace();
}

function bindSessionControls() {
  $('#tempo').oninput = event => {
    const value = Number(event.target.value);
    if (value < 40 || value > 240) return;
    state.tempo = value;
    saveWorkspace();
    restartMixSoon();
  };
  $('#tempo').onchange = async event => {
    state.tempo = clampTempo(event.target.value);
    event.target.value = state.tempo;
    saveWorkspace();
    refreshWorkbenchAudio();
    await restartMixIfActive();
  };
  $('#sync').onchange = async event => {
    state.sync = event.target.checked;
    saveWorkspace();
    renderHarmonyStatus();
    refreshWorkbenchAudio();
    await restartMixIfActive();
  };
  $('#sessionKey').onchange = async event => {
    const wasPlaying = isMixActive();
    stopMix();
    state.key = event.target.value || null;
    renderTracks();
    saveWorkspace();
    if (wasPlaying) await playMix();
  };
  $('#variety').oninput = event => {
    state.variety = clampVariety(Number(event.target.value));
    renderVariety();
    saveWorkspace();
    schedulePrefetch();
  };
}

export function initWorkbench() {
  $('#tracks').onclick = onTrackClick;
  $('#tracks').oninput = onTrackInput;
  $('#shuffle').onclick = () => newBatch();
  $('#exportMix').onclick = exportMix;
  $('#addToBench').onclick = addSelected;
  $('#saveSet').onclick = () => {
    if (!state.tracks.some(track => track.id)) {
      toast('Add a sample first.');
      return;
    }
    $('#setName').value = state.setName === 'Untitled set' ? '' : state.setName;
    $('#saveDialog').showModal();
  };
  $('#saveForm').onsubmit = saveSet;
  bindSessionControls();
}
