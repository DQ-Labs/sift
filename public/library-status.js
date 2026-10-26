// Library refresh, scan/analysis status, clean-up tools and adding folders.
import { api } from './api.js';
import { libraryActivity } from './library-activity.js';
import { $, escape, toast, plural } from './ui.js';
import { state, catalog, referencedIds, sampleById } from './state.js';
import { clearSelection, isMixActive, refreshPreviewMetadata } from './player.js';
import { loadRows, renderSets, renderSources, updateConflictCount } from './collection.js';
import { renderTracks } from './workbench.js';
import { confirmAction } from './dialogs.js';

function showRecovery(recovery) {
  $('#recoveryNotice').hidden = !recovery;
  $('#recoveryNotice').textContent = recovery ? `${recovery.message} Preserved files: ${recovery.preserved.join(', ') || 'none'}` : '';
}

// Reloads library metadata, the visible page and every sample the workbench,
// sets and preview refer to.
export async function refreshLibrary() {
  const data = await catalog.loadLibrary();
  state.favorites = data.favorites;
  state.folders = data.folders;
  state.sets = data.sets;
  state.analysis = data.analysis;
  state.scan = data.scan;
  state.counts = data.counts;
  state.statusUnavailable = false;
  showRecovery(data.recovery);
  const workspaceIds = (data.workspace?.tracks || []).map(track => track.id);
  await catalog.hydrate([...referencedIds(), ...workspaceIds], { refresh: true });
  renderSources();
  renderSets();
  renderAnalysis();
  refreshPreviewMetadata();
  await Promise.all([loadRows(), updateConflictCount()]);
  return data;
}

export function renderLibraryActivity() {
  const activity = libraryActivity(state.scan, state.analysis, state.statusUnavailable);
  const panel = $('#libraryActivity');
  const progress = $('#libraryActivityProgress');
  const button = $('#libraryActivityAction');
  panel.hidden = !activity.visible;
  panel.classList.toggle('busy', activity.busy);
  $('#scanState').classList.toggle('processing', activity.busy);
  $('#scanState').innerHTML = `<i></i> ${escape(activity.label)}`;
  if (!activity.visible) return;
  // Assigning identical text would re-announce the live region on every poll.
  if ($('#libraryActivityTitle').textContent !== activity.title) $('#libraryActivityTitle').textContent = activity.title;
  $('#libraryActivityDetail').textContent = activity.detail;
  $('#libraryActivityCurrent').textContent = activity.current || '';
  $('#libraryActivityCurrent').title = activity.current || '';
  progress.hidden = !activity.busy && !activity.progress;
  if (activity.progress) {
    progress.max = Math.max(1, activity.progress.max);
    progress.value = activity.progress.value;
    progress.setAttribute('aria-valuetext', `${activity.progress.value} of ${activity.progress.max} samples processed`);
  } else {
    progress.removeAttribute('value');
    progress.removeAttribute('aria-valuetext');
  }
  button.hidden = !activity.action;
  button.dataset.action = activity.action || '';
  button.textContent = activity.actionLabel || '';
}

// Totals come from the catalogue when it reports them; older query servers
// only report this session's analysis counters.
function analysisTotals(status) {
  return {
    done: state.counts.analyzed ?? status.completed ?? 0,
    errors: state.counts.analysisFailed ?? status.failed ?? 0
  };
}

function analysisSummary(status, { done, errors }) {
  if (status.saveError) return 'Analysis paused: could not save results.';
  if (status.paused) return `Analysis paused · ${status.pending} queued${status.running ? ' · finishing current sound' : ''}`;
  if (status.running) return `Analyzing ${status.current} · ${status.pending} queued`;
  return `${done.toLocaleString()} analyzed${errors ? ` · ${errors} failed — retry below` : ''} · local audio analysis`;
}

export function renderAnalysis() {
  renderLibraryActivity();
  const status = state.analysis;
  if (!status) return;
  $('#analysisSaveNotice').hidden = !status.saveError;
  if ($('#analysisSaveError').textContent !== (status.saveError || '')) $('#analysisSaveError').textContent = status.saveError || '';
  const totals = analysisTotals(status);
  let tools = `${totals.done.toLocaleString()} analyzed${totals.errors ? ` · ${totals.errors} failed` : ''}`;
  if (status.saveError) tools = 'Save needs attention';
  else if (status.paused) tools = 'Analysis paused';
  else if (status.running) tools = 'Analyzing…';
  $('#toolsStatus').textContent = tools;
  $('#analysisSummary').textContent = analysisSummary(status, totals);
  $('#analysisSummary').title = status.saveError || 'Tempo and key are estimates. Open Sample details to inspect or correct them.';
  $('#analysisPause').textContent = status.paused ? 'Resume analysis' : 'Pause analysis';
  $('#analysisPause').disabled = !status.paused && !status.running && !status.pending;
}

function scanFinishedMessage(scan, analysis) {
  if (scan.error) return `Scan failed: ${scan.error}`;
  const skipped = scan.skipped ? ` · ${scan.skipped} unreadable items skipped` : '';
  const background = analysis.remaining ? ' Audio analysis continues in the background.' : '';
  return `${scan.cancelled ? 'Stopped. ' : ''}${plural(scan.count, 'sample')} indexed${skipped}.${background}`;
}

let polling = false;

export async function pollAnalysis() {
  if (polling) return;
  polling = true;
  try {
    const latest = await api('library/status');
    const previousRevision = state.analysis?.revision;
    const scanFinished = state.scan?.running && !latest.scan.running;
    state.analysis = latest.analysis;
    state.scan = latest.scan;
    state.statusUnavailable = false;
    if (latest.analysis.revision !== previousRevision || scanFinished) {
      await refreshLibrary();
      const editing = document.activeElement?.matches('.level,#tempo,#variety');
      if (!isMixActive() && !editing) renderTracks();
    } else {
      renderAnalysis();
    }
    if (scanFinished) toast(scanFinishedMessage(latest.scan, latest.analysis));
  } catch {
    state.statusUnavailable = true;
    renderLibraryActivity();
    $('#analysisSummary').textContent = 'Analysis service unavailable — check that Sift is running.';
  } finally {
    polling = false;
  }
}

// ---- Clean-up -------------------------------------------------------------

function cleanupLibraryMessage(result) {
  let message = `${result.removed} missing entries removed.`;
  if (result.missing) message += ` ${result.missing} kept for gems, sets or the workbench.`;
  if (result.unavailableRoots) message += ` ${result.unavailableRoots} unavailable source folders skipped; reconnect their drives.`;
  return message;
}

async function cleanupLibrary() {
  const confirmed = await confirmAction({
    title: 'Clean up the library?',
    message: 'Entries for files that no longer exist in connected folders are removed from Sift. Samples used by gems, saved sets or the workbench are kept, and no audio files are touched.',
    confirmLabel: 'Clean up library'
  });
  if (!confirmed) return;
  const button = $('#cleanupLibrary');
  button.disabled = true;
  try {
    const result = await api('library/cleanup', {});
    await refreshLibrary();
    if (state.selected && !sampleById(state.selected)) clearSelection();
    toast(cleanupLibraryMessage(result));
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function cleanupExports() {
  const confirmed = await confirmAction({
    title: 'Clean up unfinished exports?',
    message: 'Unfinished stem exports inactive for 7 days are deleted from Sift’s export folder. Completed handoffs are kept.',
    confirmLabel: 'Delete unfinished exports'
  });
  if (!confirmed) return;
  const button = $('#cleanupExports');
  button.disabled = true;
  $('#exportCleanupResult').textContent = 'Cleaning up unfinished exports…';
  try {
    const { removed } = await api('handoffs/cleanup', {});
    $('#exportCleanupResult').textContent = `${plural(removed, 'unfinished export')} removed. Completed handoffs were kept.`;
  } catch (error) {
    $('#exportCleanupResult').textContent = `Cleanup failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

// ---- Folders and analysis controls ----------------------------------------

async function addFolder(event) {
  event.preventDefault();
  const button = event.submitter || $('#folderForm [type="submit"]');
  button.disabled = true;
  $('#folderError').textContent = '';
  try {
    await api('scan', { path: $('#folderPath').value.trim() });
    state.scan = { running: true, count: 0 };
    state.statusUnavailable = false;
    state.source = null;
    $('#folderDialog').close();
    renderLibraryActivity();
    void pollAnalysis();
  } catch (error) {
    $('#folderError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function browseFolder() {
  const button = $('#browseFolder');
  button.disabled = true;
  button.textContent = 'Choose folder…';
  try {
    const result = await api('pick-folder', {});
    if (result.path) $('#folderPath').value = result.path;
  } catch (error) {
    $('#folderError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Browse…';
  }
}

async function analysisAction(action, extra = {}) {
  state.analysis = await api('analysis', { action, ...extra });
  renderAnalysis();
}

export function initLibraryStatus() {
  $('#cleanupLibrary').onclick = cleanupLibrary;
  $('#cleanupExports').onclick = cleanupExports;
  for (const id of ['addFolder', 'sidebarAdd']) {
    $(`#${id}`).onclick = () => {
      $('#folderError').textContent = '';
      $('#folderDialog').showModal();
    };
  }
  $('#folderForm').onsubmit = addFolder;
  $('#browseFolder').onclick = browseFolder;
  $('#libraryActivityAction').onclick = async () => {
    const button = $('#libraryActivityAction');
    const action = button.dataset.action;
    button.disabled = true;
    try {
      if (action === 'cancel') {
        state.scan = await api('cancel-scan', {});
        renderAnalysis();
      } else {
        await analysisAction(action);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  };
  $('#analysisPause').onclick = () => analysisAction(state.analysis?.paused ? 'resume' : 'pause').catch(error => toast(error.message));
  $('#retryAnalysisSave').onclick = async () => {
    const button = $('#retryAnalysisSave');
    button.disabled = true;
    button.textContent = 'Retrying save…';
    try {
      await analysisAction('resume');
      toast('Analysis results saved. Analysis resumed.');
    } catch (error) {
      $('#analysisSaveError').textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Retry save and resume';
    }
  };
  $('#analyzeSource').onclick = async () => {
    try {
      const ids = await catalog.sourceSampleIds(state.source);
      await analysisAction('reanalyze', { ids });
      toast('Source queued for audio analysis. Your corrections are preserved.');
    } catch (error) {
      toast(error.message);
    }
  };
  setInterval(pollAnalysis, 2000);
}
