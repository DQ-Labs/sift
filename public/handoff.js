// "Send to DAW": render four-bar WAV stems, save them locally, then download,
// open the folder, or drag them out of desktop Sift into the DAW.
import { api, putWav } from './api.js';
import { mixScale, encodeWav } from './export-audio.js';
import { $, icon, escape, toast } from './ui.js';
import { state, sampleById, snapshot } from './state.js';
import { renderExportLayers } from './player.js';
import { autoSaveSet, exportSnapshot } from './workbench.js';

let handoffBatch = null;
let handoffSignature = null;
let handoffNative = false;
let handoffPreparing = false;

// Variety only affects future rerolls, so it never makes stems stale.
function currentHandoffSignature() {
  const { variety, ...workspace } = snapshot();
  const samples = state.tracks.map(track => {
    const sample = sampleById(track.id);
    return sample ? [sample.id, sample.mtime, sample.bpm, sample.key, sample.type] : null;
  });
  return JSON.stringify([workspace, $('#handoffIncludeAll').checked, samples]);
}

export function updateHandoffStatus() {
  if (!handoffBatch || handoffPreparing) return;
  const stale = handoffSignature !== currentHandoffSignature();
  $('#handoffSnapshot').textContent = stale
    ? 'Workbench changed. These files are the earlier snapshot; prepare again to update.'
    : 'Prepared snapshot · matches this workbench';
  $('#handoffSnapshot').classList.toggle('stale', stale);
}

async function openHandoff() {
  $('#handoffError').textContent = '';
  $('#handoffDialog').showModal();
  updateHandoffStatus();
  $('#handoffMode').textContent = window.siftDesktop
    ? 'Desktop mode · prepare WAV stems, then drag them straight into your DAW.'
    : 'Browser mode · prepare WAV stems, then download them or use Open folder and drag the files into your DAW.';
  $('#openDesktop').hidden = !!window.siftDesktop;
  try {
    const capabilities = await api('capabilities');
    $('#openDesktop').disabled = !capabilities.desktopAvailable;
  } catch {
    $('#handoffError').textContent = 'Restart the local Sift server to enable stem handoff.';
  }
}

async function saveStems(layers, workspace, includeAll) {
  const scale = mixScale(layers);
  const batch = await api('handoffs', { workspace, includeAll, masterScale: scale });
  for (const layer of layers) {
    $('#handoffProgress').textContent = `Saving layer ${layer.index + 1}…`;
    await putWav(`handoffs/${batch.id}/stems/${layer.index}`, encodeWav(layer.channels, { gain: layer.gain, scale }));
  }
  return api(`handoffs/${batch.id}/finish`, {});
}

async function prepareNativeDrag(batch) {
  handoffNative = false;
  if (!window.siftDesktop) return;
  try {
    await window.siftDesktop.prepareDrag(batch.id);
    handoffNative = true;
  } catch {
    $('#handoffError').textContent = 'Desktop dragging could not prepare. Downloads and Open folder are still available.';
  }
}

async function prepareHandoff() {
  const button = $('#prepareHandoff');
  button.disabled = true;
  handoffPreparing = true;
  $('#handoffError').textContent = '';
  $('#handoffResults').hidden = true;
  try {
    const workspace = exportSnapshot();
    const includeAll = $('#handoffIncludeAll').checked;
    const signature = currentHandoffSignature();
    const layers = await renderExportLayers(workspace, includeAll, message => { $('#handoffProgress').textContent = message; });
    const ready = await saveStems(layers, workspace, includeAll);
    await prepareNativeDrag(ready);
    handoffBatch = ready;
    handoffSignature = signature;
    renderHandoff();
    $('#handoffProgress').textContent = '';
    button.textContent = 'Prepare new snapshot';
    const set = await autoSaveSet(workspace, 'Stems');
    if (set) $('#handoffProgress').textContent = `Saved as set “${set.name}”.`;
  } catch (error) {
    $('#handoffError').textContent = error.message;
    $('#handoffProgress').textContent = '';
    if (handoffBatch) $('#handoffResults').hidden = false;
  } finally {
    button.disabled = false;
    handoffPreparing = false;
    updateHandoffStatus();
  }
}

function handoffFile(batch, file) {
  const href = `/api/handoffs/${batch.id}/files/${encodeURIComponent(file.name)}`;
  const drag = handoffNative
    ? `<button class="stem-drag" draggable="true" data-drag-index="${file.index}" aria-label="Drag layer ${file.index + 1} to your DAW">${icon('layers')}Drag stem</button>`
    : '';
  return `<div class="handoff-file"><div><strong>${escape(file.type)}</strong><span>${escape(file.name)}</span></div><a class="button small" href="${href}" download="${escape(file.name)}">${icon('download')}WAV</a>${drag}</div>`;
}

function renderHandoff() {
  const batch = handoffBatch;
  $('#handoffResults').hidden = false;
  $('#handoffSummary').textContent = `${batch.name} · ${batch.tempo} BPM · ${batch.key || 'Original keys'} · 4 bars · stereo WAV / 44.1 kHz / 16-bit`;
  $('#handoffFolder').textContent = batch.folder;
  $('#handoffFiles').innerHTML = batch.files.map(file => handoffFile(batch, file)).join('');
  $('#downloadStemZip').href = `/api/handoffs/${batch.id}/files/Stems.zip`;
  $('#dragAllStems').hidden = !handoffNative;
  $('#dragAllStems').draggable = handoffNative;
  $('#handoffDragHint').textContent = handoffNative
    ? 'Drag one stem, or drag all stems together. Drop them at the same bar in your DAW.'
    : 'Use Open folder to drag the real WAV files, or open desktop Sift for direct dragging.';
}

export function initHandoff() {
  $('#handoffButton').onclick = openHandoff;
  $('#handoffIncludeAll').onchange = updateHandoffStatus;
  $('#prepareHandoff').onclick = prepareHandoff;
  $('#handoffFiles').addEventListener('dragstart', event => {
    const button = event.target.closest('[data-drag-index]');
    if (!button || !handoffNative) return;
    event.preventDefault();
    window.siftDesktop.startDrag(handoffBatch.id, Number(button.dataset.dragIndex));
  });
  $('#dragAllStems').ondragstart = event => {
    event.preventDefault();
    if (handoffNative && handoffBatch) window.siftDesktop.startDrag(handoffBatch.id, 'all');
  };
  $('#handoffFiles').onclick = event => {
    if (event.target.closest('[data-drag-index]')) toast('Click and hold, then drag this stem into your DAW.');
  };
  $('#dragAllStems').onclick = () => toast('Click and hold, then drag the stems into your DAW.');
  $('#openHandoffFolder').onclick = async () => {
    try {
      await api(`handoffs/${handoffBatch.id}/open`, {});
    } catch (error) {
      $('#handoffError').textContent = error.message;
    }
  };
  $('#openDesktop').onclick = async () => {
    try {
      await api('desktop/open', {});
      toast('Opening desktop Sift. Prepare stems there for direct dragging.');
    } catch (error) {
      $('#handoffError').textContent = error.message;
    }
  };
}
