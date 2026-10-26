// Sample details: analysis evidence, metadata conflicts and BPM/key corrections.
import { api } from './api.js';
import { $, escape, toast, metadataSource } from './ui.js';
import { state, catalog, sampleById } from './state.js';
import { isMixActive, refreshPreviewMetadata, stopMix } from './player.js';
import { renderRows, updateConflictCount } from './collection.js';
import { renderTracks } from './workbench.js';
import { renderAnalysis } from './library-status.js';

let metadataId = null;

function filenameLabels(sample) {
  const labels = sample.labels || {};
  const tempo = labels.bpm ? `${labels.bpm} BPM${labels.bpmExplicit ? '' : ' (number hint)'}` : 'tempo unknown';
  return `<p>Filename labels: <strong>${tempo}</strong> · <strong>${escape(labels.key || 'key unknown')}</strong></p>`;
}

function audioEvidence(sample) {
  const analysis = sample.analysis;
  if (analysis?.status === 'error') return `<p class="error">${escape(analysis.error)}</p>`;
  if (analysis?.status !== 'done') return '<p>Audio analysis is pending. Explicit filename labels are kept; analysis fills missing values.</p>';
  const excerpt = sample.duration > analysis.analyzedSeconds + 1 ? ' (opening excerpt)' : '';
  return `<p>Audio estimate: <strong>${analysis.bpm ? `${analysis.bpm} BPM` : 'tempo unknown'}</strong> · <strong>${escape(analysis.key || 'key unknown')}</strong></p>`
    + `<p>Beat confidence: ${Number(analysis.bpmConfidence || 0).toFixed(2)} · key strength: ${Number(analysis.keyStrength || 0).toFixed(2)}<br>`
    + `Examined ${analysis.analyzedSeconds.toFixed(1)} seconds${excerpt}. These scores are algorithm measures, not probabilities.</p>`
    + `<p>${(analysis.warnings || []).map(escape).join('<br>')}</p>`;
}

function evidence(sample) {
  return `<p>Sound type: <strong>${escape(sample.type)}</strong> · ${escape(sample.typeSource || 'unknown')}${sample.typeHint ? `: ${escape(sample.typeHint)}` : ''}</p>`
    + filenameLabels(sample)
    + `<p>Current tempo: <strong>${escape(metadataSource(sample.bpmSource))}</strong> · key: <strong>${escape(sample.keySource || 'unknown')}</strong></p>`
    + audioEvidence(sample);
}

function conflictCard([field, conflict]) {
  const tempo = field === 'bpm';
  const unit = tempo ? ' BPM' : '';
  const kind = conflict.kind === 'relative-key' ? ' · relative major/minor' : conflict.kind === 'half-double' ? ' · half/double tempo' : '';
  const status = conflict.resolved ? 'Your correction is in use.' : 'The filename label is kept. Choose a value below or enter your own.';
  const what = tempo ? 'BPM' : 'key';
  return `<div class="metadata-conflict"><strong>${tempo ? 'Tempo' : 'Key'} disagreement${conflict.resolved ? ' · manually resolved' : ''}</strong>`
    + `<p>Filename: ${escape(conflict.label)}${unit} · Audio: ${escape(conflict.estimate)}${unit}${kind}</p><p>${status}</p>`
    + `<div><button type="button" class="button small" data-metadata-field="${field}" data-metadata-value="label">Use filename ${what}</button>`
    + `<button type="button" class="button small" data-metadata-field="${field}" data-metadata-value="estimate">Use audio ${what}</button></div></div>`;
}

function ensureKeyOption(key) {
  if (!key || Array.from($('#sampleKey').options).some(option => option.value === key)) return;
  const option = document.createElement('option');
  option.value = key;
  option.textContent = key;
  $('#sampleKey').append(option);
}

export function openMetadata(id = state.selected) {
  const sample = sampleById(id);
  if (!sample) return;
  metadataId = sample.id;
  $('#metadataTitle').textContent = sample.name;
  $('#metadataFile').textContent = `${sample.filename}\n${sample.path || sample.folder}`;
  $('#sampleBpm').value = sample.bpm ?? '';
  ensureKeyOption(sample.key);
  $('#sampleKey').value = sample.key || '';
  $('#metadataError').textContent = '';
  $('#analysisEvidence').innerHTML = evidence(sample);
  $('#metadataDraft').textContent = '';
  $('#metadataConflicts').innerHTML = Object.entries(sample.conflicts || {}).map(conflictCard).join('');
  $('#metadataDialog').showModal();
}

async function applyMetadata(input) {
  const updated = catalog.update(await api('metadata', { id: metadataId, ...input }));
  state.pageItems = state.pageItems.map(sample => sample.id === updated.id ? updated : sample);
  if (state.tracks.some(track => track.id === updated.id) && isMixActive()) stopMix();
  renderTracks();
  renderRows();
  updateConflictCount();
  refreshPreviewMetadata();
  $('#metadataDialog').close();
  toast(input.reset ? 'Label priority restored; manual corrections cleared.' : 'Corrections saved. Press play to hear the updated sync.');
}

function chooseConflictValue(event) {
  const button = event.target.closest('[data-metadata-field]');
  if (!button) return;
  const field = button.dataset.metadataField;
  const value = sampleById(metadataId).conflicts[field][button.dataset.metadataValue];
  $(field === 'bpm' ? '#sampleBpm' : '#sampleKey').value = value;
  $('#metadataError').textContent = '';
  $('#metadataDraft').textContent = 'Choice ready. Save corrections to apply it.';
}

function scaleBpm(multiplier) {
  const bpm = Number($('#sampleBpm').value) * multiplier;
  if (bpm >= 40 && bpm <= 240) $('#sampleBpm').value = Math.round(bpm * 10) / 10;
  else $('#metadataError').textContent = 'Source BPM must stay between 40 and 240.';
}

const showError = error => { $('#metadataError').textContent = error.message; };

export function initDetails() {
  $('#sampleDetails').onclick = () => openMetadata();
  $('#metadataConflicts').onclick = chooseConflictValue;
  $('#halfBpm').onclick = () => scaleBpm(.5);
  $('#doubleBpm').onclick = () => scaleBpm(2);
  $('#metadataForm').onsubmit = event => {
    event.preventDefault();
    const bpm = $('#sampleBpm').value === '' ? null : Number($('#sampleBpm').value);
    applyMetadata({ bpm, key: $('#sampleKey').value || null }).catch(showError);
  };
  $('#resetMetadata').onclick = () => applyMetadata({ reset: true }).catch(showError);
  $('#reanalyzeSample').onclick = async () => {
    try {
      state.analysis = await api('analysis', { action: 'reanalyze', ids: [metadataId] });
      renderAnalysis();
      $('#metadataDialog').close();
      toast('Sample queued. Corrections will be kept.');
    } catch (error) {
      showError(error);
    }
  };
}
