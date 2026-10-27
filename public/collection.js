// The collection: sources, the paged sample list, gems, saved sets and views.
import { api } from './api.js';
import { pageSize } from './catalog-client.js';
import { normalizeWorkspace } from './workspace.js';
import { $, icon, escape, colors, toast, formatTime, metadataSource, displayName, plural } from './ui.js';
import { state, catalog, sampleById } from './state.js';
import { audition, drawAll, preview, updatePreviewControls } from './player.js';
import { addSelected, loadSet } from './workbench.js';

const viewLabels = { discover: 'Discover', library: 'All samples', gems: 'Saved gems', sets: 'Saved sets' };

// ---- Sources --------------------------------------------------------------

function sourceButton({ source, label, count, iconName, active, title = '' }) {
  return `<button class="source-item ${active ? 'active' : ''}" data-source="${escape(source)}" title="${escape(title)}">${icon(iconName)}<span class="source-name">${escape(label)}</span><small>${count.toLocaleString()}</small></button>`;
}

export function renderSources() {
  const { real, demo, total, byRoot } = state.counts;
  const buttons = [];
  if (real) buttons.push(sourceButton({ source: '', label: 'All folders', count: real, iconName: 'library', active: !state.source }));
  for (const folder of state.folders) {
    buttons.push(sourceButton({ source: folder.path, label: folder.name, count: byRoot?.[folder.path] || 0, iconName: 'folder', active: state.source === folder.path, title: folder.path }));
  }
  buttons.push(sourceButton({ source: 'demo', label: 'Sift demo collection', count: demo, iconName: 'folder', active: state.source === 'demo' || !real }));
  $('#sources').innerHTML = buttons.join('');
  $('#sampleCount').textContent = (real || total).toLocaleString();
  $('#gemCount').textContent = state.favorites.length.toLocaleString();
  $('#setCount').textContent = state.sets.length;
}

export async function updateConflictCount() {
  let conflicts;
  try {
    conflicts = await catalog.countConflicts(state.source);
  } catch {
    return;
  }
  $('#reviewConflicts').textContent = `Metadata conflicts (${conflicts})`;
  $('#toolsConflicts').textContent = conflicts ? `${conflicts} metadata conflicts` : '';
}

// ---- Sample rows ----------------------------------------------------------

export function currentQuery() {
  return {
    source: state.source,
    view: state.view === 'gems' ? 'gems' : 'all',
    q: state.query,
    type: state.type,
    bpm: state.bpm,
    conflicts: state.conflictsOnly,
    sort: state.sort,
    page: state.page,
    pageSize,
    favorites: state.favorites
  };
}

let rowsToken = 0;

// Fetches the current page from the catalogue, then renders it.
export async function loadRows() {
  const token = ++rowsToken;
  try {
    let result = await catalog.querySamples(currentQuery());
    // A page can empty out, e.g. after removing the last gem on it.
    if (!result.items.length && result.total > 0 && result.page > 0) {
      state.page = Math.ceil(result.total / pageSize) - 1;
      result = await catalog.querySamples(currentQuery());
    }
    if (token !== rowsToken) return;
    state.pageItems = result.items;
    state.total = result.total;
    state.page = result.page;
  } catch (error) {
    if (token === rowsToken) toast(`Could not load samples: ${error.message}`);
    return;
  }
  renderRows();
}

function tempoCell(sample) {
  const prefix = sample.bpmSource === 'analysis' ? '≈' : sample.bpmSource === 'filename-hint' ? '?' : '';
  return `<span class="mono" title="Tempo source: ${escape(metadataSource(sample.bpmSource))}">${prefix}${sample.bpm || '—'}${conflictMarker(sample, 'bpm')}</span>`;
}

function keyCell(sample) {
  const short = sample.key?.replace(' min', 'm').replace(' maj', '');
  return `<span class="mono row-key" title="Key source: ${escape(sample.keySource || 'unknown')}">${escape(short || '—')}${conflictMarker(sample, 'key')}</span>`;
}

function conflictMarker(sample, field) {
  const conflict = sample.conflicts?.[field];
  if (!conflict || conflict.resolved) return '';
  const label = field === 'bpm' ? 'Tempo' : 'Key';
  return ` <span class="conflict-marker" title="Filename: ${escape(conflict.label)}; audio: ${escape(conflict.estimate)}. Review in Sample details." aria-label="${label} conflict">!</span>`;
}

function sampleRow(sample) {
  const selected = state.selected === sample.id;
  const playing = selected && !preview.paused;
  const gem = state.favorites.includes(sample.id);
  const invalid = sample.invalid ? ` · <span title="${escape(sample.invalid)}">UNUSABLE FILE</span>` : '';
  const notes = `${sample.missing ? ' · MISSING FILE' : ''}${invalid}${sample.demo ? ' · synthesized demo' : ''}`;
  return `<div class="sample-row ${selected ? 'selected' : ''}" data-id="${escape(sample.id)}" tabindex="0" role="button" aria-label="Audition ${escape(sample.name)}">
    <button class="icon-button row-play" aria-label="${playing ? 'Stop' : 'Play'} ${escape(sample.name)}">${icon(playing ? 'pause' : 'play')}</button>
    <div class="sample-name"><div class="row-title" title="${escape(sample.filename)}">${escape(displayName(sample))}</div><div class="row-source">${escape(sample.folder)}${notes}</div></div>
    <canvas class="row-wave" data-sample="${escape(sample.id)}" aria-label="${sample.peaks ? 'Waveform' : 'Audition to load waveform'}"></canvas>
    <span class="tag" title="Type from ${escape(sample.typeSource || 'filename')}: ${escape(sample.typeHint || sample.filename)}" style="--tag-color:${colors[sample.type]}">${escape(sample.type)}</span>
    ${tempoCell(sample)}
    ${keyCell(sample)}
    <span class="mono row-duration">${formatTime(sample.duration)}</span>
    <button class="icon-button favorite ${gem ? 'active' : ''}" aria-label="${gem ? 'Unsave' : 'Save'} ${escape(sample.name)} as gem" aria-pressed="${gem}">${icon('gem')}</button>
  </div>`;
}

function emptyRows() {
  if (state.view === 'gems') return '<div class="empty"><h3>Nothing saved here yet.</h3><p>Tap the diamond beside a sound to keep it close.</p></div>';
  return '<div class="empty"><h3>No samples in this view.</h3><p>Try a different search, sound type or source folder.</p></div>';
}

// Renders the page already in state; use loadRows() to refetch.
export function renderRows() {
  const pages = Math.max(1, Math.ceil(state.total / pageSize));
  $('#reviewConflicts').setAttribute('aria-pressed', String(state.conflictsOnly));
  $('#resultCount').textContent = plural(state.total, 'sample');
  $('#pageNumber').textContent = `${state.page + 1} / ${pages}`;
  $('#previousPage').disabled = state.page === 0;
  $('#nextPage').disabled = state.page >= pages - 1;
  updateCollectionUI();
  $('#sampleRows').innerHTML = state.pageItems.map(sampleRow).join('') || emptyRows();
  requestAnimationFrame(drawAll);
}

// Moves the audition selection through the list, crossing page boundaries.
export async function stepSelection(delta) {
  const index = state.pageItems.findIndex(sample => sample.id === state.selected);
  let target = index < 0 ? 0 : index + delta;
  if (target >= state.pageItems.length && (state.page + 1) * pageSize < state.total) {
    state.page++;
    await loadRows();
    target = 0;
  } else if (target < 0 && state.page > 0) {
    state.page--;
    await loadRows();
    target = state.pageItems.length - 1;
  }
  target = Math.max(0, Math.min(state.pageItems.length - 1, target));
  const next = state.pageItems[target];
  if (next) await audition(next.id);
}

// ---- Gems -----------------------------------------------------------------

export async function favorite(id) {
  if (!id) return;
  const before = [...state.favorites];
  state.favorites = state.favorites.includes(id) ? state.favorites.filter(x => x !== id) : [...state.favorites, id];
  const refresh = () => {
    renderSources();
    updatePreviewControls();
    if (state.view === 'gems') loadRows();
    else renderRows();
  };
  refresh();
  try {
    await api('favorites', { ids: state.favorites });
  } catch (error) {
    state.favorites = before;
    refresh();
    toast(`Could not save gem: ${error.message}`);
  }
}

// ---- Saved sets -----------------------------------------------------------

function setCard(set) {
  const layers = set.tracks.filter(track => track.id).length;
  const names = set.tracks.map(track => escape(sampleById(track.id)?.name || 'Empty')).join(' / ');
  const date = new Date(set.created).toLocaleDateString();
  return `<article class="saved-set"><span class="set-icon">${icon('layers')}</span><div><h3>${escape(set.name)}</h3><p>${set.tempo || 92} BPM · ${escape(set.key || 'Original keys')} · ${layers} layers · ${date}<br>${names}</p></div><button class="button" data-load-set="${escape(set.id)}">Open set ${icon('right')}</button></article>`;
}

export function renderSets() {
  $('#savedSets').innerHTML = state.sets.map(setCard).join('') || '<div class="empty"><h3>Good combinations deserve a second listen.</h3><p>Save a set from the workbench, or export one, and find it here.</p></div>';
}

// ---- Views ----------------------------------------------------------------

export function updateCollectionUI() {
  const discover = state.view === 'discover';
  const expanded = !discover || state.collectionOpen;
  $('#collectionBody').hidden = !expanded;
  $('#toggleCollection').hidden = !discover;
  $('#toggleCollection').setAttribute('aria-expanded', String(expanded));
  $('#toggleCollection').innerHTML = `${expanded ? 'Hide collection' : 'Browse collection'}${icon('down')}`;
  $('#librarySection').classList.toggle('collection-collapsed', !expanded);
}

export function setView(view) {
  state.view = view;
  state.page = 0;
  document.querySelector('.app').dataset.view = view;
  $('#breadcrumbView').textContent = viewLabels[view];
  $('#workspace').hidden = view !== 'discover';
  $('#librarySection').hidden = view === 'sets';
  $('#setsSection').hidden = view !== 'sets';
  $('#libraryTitle').textContent = view === 'gems' ? 'Your shortlist' : 'The collection';
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  renderSets();
  renderRows();
  loadRows();
}

export function focusCollectionSearch() {
  if (state.view === 'sets') setView('library');
  if (state.view === 'discover') {
    state.collectionOpen = true;
    updateCollectionUI();
  }
  $('#search').focus();
  requestAnimationFrame(drawAll);
}

async function surprise() {
  try {
    const sample = await catalog.randomSample(currentQuery(), state.selected);
    if (sample) audition(sample.id);
    else toast('No samples match these filters.');
  } catch (error) {
    toast(error.message);
  }
}

// ---- Events ---------------------------------------------------------------

function resetPageAndLoad() {
  state.page = 0;
  loadRows();
}

let searchTimer;

export function initCollection() {
  $('#navigation').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) setView(button.dataset.view);
  });
  $('#sources').addEventListener('click', event => {
    const button = event.target.closest('[data-source]');
    if (!button) return;
    state.source = button.dataset.source || null;
    renderSources();
    resetPageAndLoad();
    updateConflictCount();
  });
  $('#toggleCollection').onclick = () => {
    state.collectionOpen = !state.collectionOpen;
    updateCollectionUI();
    requestAnimationFrame(drawAll);
  };
  // The query API is fast, but there is no need to ask for every keystroke.
  $('#search').oninput = event => {
    state.query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(resetPageAndLoad, catalog.remote ? 150 : 0);
  };
  for (const [id, property] of [['typeFilter', 'type'], ['bpmFilter', 'bpm'], ['sort', 'sort']]) {
    $(`#${id}`).onchange = event => {
      state[property] = event.target.value;
      resetPageAndLoad();
    };
  }
  $('#reviewConflicts').onclick = () => {
    state.conflictsOnly = !state.conflictsOnly;
    resetPageAndLoad();
  };
  $('#previousPage').onclick = () => {
    state.page--;
    loadRows();
  };
  $('#nextPage').onclick = () => {
    state.page++;
    loadRows();
  };
  $('#sampleRows').onclick = event => {
    const row = event.target.closest('[data-id]');
    if (!row) return;
    if (event.target.closest('.favorite')) favorite(row.dataset.id);
    else audition(row.dataset.id);
  };
  $('#sampleRows').onkeydown = event => {
    if (!event.target.classList.contains('sample-row') || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    audition(event.target.dataset.id);
  };
  $('#sampleRows').ondblclick = event => {
    const row = event.target.closest('[data-id]');
    if (!row || event.target.closest('.favorite')) return;
    state.selected = row.dataset.id;
    addSelected();
  };
  $('#surprise').onclick = surprise;
  $('#savedSets').onclick = event => {
    const button = event.target.closest('[data-load-set]');
    const set = button && state.sets.find(candidate => candidate.id === button.dataset.loadSet);
    if (set) loadSet(set, normalizeWorkspace(set));
  };
}
