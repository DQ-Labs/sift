// Sift front end entry point: wires the modules together and loads the library.
import { normalizeWorkspace } from './workspace.js';
import { noteNames } from './harmony.js';
import { $, applyIcons, toast } from './ui.js';
import { state, catalog, applyWorkspace } from './state.js';
import { initPlayer } from './player.js';
import { initCollection } from './collection.js';
import { initWorkbench, renderTracks } from './workbench.js';
import { initTimingDialog } from './timing-dialog.js';
import { initDetails } from './details.js';
import { initHandoff } from './handoff.js';
import { initLibraryStatus, refreshLibrary, renderLibraryActivity } from './library-status.js';
import { initHelp, loadCapabilities } from './help.js';
import { initDialogs } from './dialogs.js';
import { initShortcuts } from './shortcuts.js';

function addKeyOptions(select) {
  for (const root of noteNames) {
    for (const scale of ['maj', 'min']) {
      const option = document.createElement('option');
      option.value = `${root} ${scale}`;
      option.textContent = option.value;
      select.append(option);
    }
  }
}

async function init() {
  applyIcons();
  addKeyOptions($('#sessionKey'));
  addKeyOptions($('#sampleKey'));
  initDialogs();
  initPlayer();
  initCollection();
  initWorkbench();
  initTimingDialog();
  initDetails();
  initHandoff();
  initLibraryStatus();
  initHelp();
  initShortcuts();
  void loadCapabilities();
  try {
    const data = await refreshLibrary();
    const workspace = normalizeWorkspace(data.workspace);
    applyWorkspace(workspace);
    state.variety = workspace.variety;
    state.setName = workspace.name;
    await catalog.hydrate(state.tracks.map(track => track.id));
    renderTracks();
  } catch (error) {
    toast(`Could not connect to Sift: ${error.message}`);
    state.statusUnavailable = true;
    renderLibraryActivity();
  }
}

init();
