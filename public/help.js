// Version label, the Help & About dialog and the diagnostics report.
import { api, endpointExists, fetchDownload } from './api.js';
import { $, escape, saveFile, toast } from './ui.js';
import { state, catalog } from './state.js';
import { timestampedSetName } from './workbench-model.js';

export async function loadCapabilities() {
  try {
    state.capabilities = await api('capabilities');
  } catch {
    state.capabilities = null;
  }
  renderVersion();
  return state.capabilities;
}

function renderVersion() {
  const version = state.capabilities?.version;
  $('#versionLabel').hidden = !version;
  $('#versionLabel').textContent = version ? `SIFT / ${version}` : '';
  $('#aboutEyebrow').textContent = version ? `SIFT ${version}` : 'SIFT';
}

function ffmpegText(ffmpeg) {
  if (!ffmpeg) return null;
  if (!ffmpeg.found) return 'Not found';
  const rubberband = ffmpeg.rubberband ? 'Rubber Band available' : 'Rubber Band missing';
  return `${ffmpeg.version || 'Found'} · ${rubberband}`;
}

function aboutFacts() {
  const capabilities = state.capabilities || {};
  const facts = [
    ['Version', capabilities.version],
    ['Runs as', window.siftDesktop ? 'Desktop app' : 'Browser on this computer'],
    ['FFmpeg', ffmpegText(capabilities.ffmpeg)],
    ['Data folder', capabilities.dataDirectory],
    ['Catalogue', catalog.remote ? 'Query API · loads a page at a time' : 'Full library in the browser (older server)'],
    ['Licence', 'AGPL-3.0-only · see THIRD_PARTY.md for bundled components']
  ];
  return facts.filter(([, value]) => value).map(([label, value]) => `<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`).join('');
}

async function openAbout() {
  await loadCapabilities();
  $('#aboutFacts').innerHTML = aboutFacts();
  $('#aboutDialog').showModal();
  // Servers without a diagnostics route answer 404; hide the button there.
  const available = state.capabilities?.version ? true : await endpointExists('diagnostics');
  $('#diagnosticsBlock').hidden = !available;
}

async function saveDiagnostics() {
  const button = $('#saveDiagnostics');
  button.disabled = true;
  try {
    const fallback = `${timestampedSetName(new Date(), 'sift-diagnostics').replace(/[ :·]+/g, '-')}.zip`;
    const { blob, name } = await fetchDownload('diagnostics', fallback);
    saveFile(blob, name);
    toast('Diagnostics report saved. It lists versions and folder names, not your audio.');
  } catch (error) {
    if (error.status === 404) {
      $('#diagnosticsBlock').hidden = true;
      toast('This Sift version cannot create a diagnostics report yet.');
    } else {
      toast(`Could not create the diagnostics report: ${error.message}`);
    }
  } finally {
    button.disabled = false;
  }
}

export function initHelp() {
  $('#aboutButton').onclick = openAbout;
  $('#saveDiagnostics').onclick = saveDiagnostics;
}
