// Per-layer timing: start offset and repeat length, with a by-ear preview.
import { api } from './api.js';
import { audibleStart, defaultTiming } from './timing.js';
import { $, toast } from './ui.js';
import { state, sampleById, currentSettings, snapshot } from './state.js';
import { audioContext, cycleForTrack, decode, preview, stopMix, updatePreviewControls } from './player.js';
import { cancelPendingSave, renderTracks } from './workbench.js';

let timingIndex = null;
let timingSampleId = null;
let previewNode = null;
let previewToken = 0;

function stopTimingPreview() {
  previewToken++;
  if (previewNode) {
    try {
      previewNode.stop();
    } catch {
      // Already finished.
    }
    previewNode.disconnect();
    previewNode = null;
  }
  $('#timingPreview').textContent = 'Preview start';
}

export function openTiming(index) {
  const track = state.tracks[index];
  const sample = sampleById(track.id);
  if (!sample) return;
  stopMix();
  preview.pause();
  updatePreviewControls();
  stopTimingPreview();
  timingIndex = index;
  timingSampleId = sample.id;
  const timing = track.timing || defaultTiming();
  $('#timingTitle').textContent = `Layer ${index + 1} timing`;
  $('#timingTitle').title = sample.filename;
  $('#timingOffset').value = timing.offset ?? '';
  $('#timingRepeat').value = timing.repeat;
  $('#timingError').textContent = '';
  $('#timingDialog').showModal();
}

function enteredOffset() {
  const entered = $('#timingOffset').value;
  return entered === '' ? null : Number(entered);
}

async function togglePreview() {
  if (previewNode) {
    stopTimingPreview();
    return;
  }
  stopTimingPreview();
  const token = previewToken;
  try {
    const sample = sampleById(timingSampleId);
    let offset = enteredOffset();
    if (!sample || (offset !== null && (!Number.isFinite(offset) || offset < 0))) throw new Error('Choose a valid start offset.');
    const ctx = audioContext();
    await ctx.resume();
    const buffer = await decode(sample);
    offset ??= audibleStart(buffer) / buffer.sampleRate;
    if (token !== previewToken || !$('#timingDialog').open) return;
    if (offset >= buffer.duration) throw new Error('Start offset is past the end of this sample.');
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    previewNode = source;
    source.onended = () => {
      source.disconnect();
      if (previewNode !== source) return;
      previewNode = null;
      $('#timingPreview').textContent = 'Preview start';
    };
    source.start(0, offset, Math.min(8, buffer.duration - offset));
    $('#timingPreview').textContent = 'Stop preview';
    $('#timingError').textContent = '';
  } catch (error) {
    $('#timingError').textContent = error.message;
  }
}

async function applyTiming(event) {
  event.preventDefault();
  const button = event.submitter || $('#timingForm [type="submit"]');
  button.disabled = true;
  stopTimingPreview();
  const index = timingIndex;
  const id = timingSampleId;
  try {
    const track = state.tracks[index];
    if (track?.id !== id) throw new Error('This layer changed. Reopen its timing controls.');
    const timing = { offset: enteredOffset(), repeat: $('#timingRepeat').value };
    // Validate by preparing the cycle before saving anything.
    await cycleForTrack({ ...track, timing }, currentSettings());
    if (!$('#timingDialog').open || state.tracks[index]?.id !== id) return;
    cancelPendingSave();
    const workspace = snapshot();
    workspace.tracks = state.tracks.map((layer, i) => i === index ? { ...layer, timing } : layer);
    await api('workspace', workspace);
    if (state.tracks[index]?.id !== id) return;
    state.tracks[index].timing = timing;
    renderTracks();
    $('#timingDialog').close();
    toast('Timing saved for playback and export.');
  } catch (error) {
    $('#timingError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

export function initTimingDialog() {
  $('#timingDialog').addEventListener('close', stopTimingPreview);
  $('#resetTiming').onclick = () => {
    stopTimingPreview();
    $('#timingOffset').value = '';
    $('#timingRepeat').value = 'auto';
    $('#timingError').textContent = '';
  };
  $('#timingOffset').oninput = stopTimingPreview;
  $('#timingPreview').onclick = togglePreview;
  $('#timingForm').onsubmit = applyTiming;
}
