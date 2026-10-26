// Keyboard shortcuts. Inactive while typing or while a dialog is open.
import { playMix } from './player.js';
import { focusCollectionSearch, stepSelection } from './collection.js';
import { newBatch, reroll } from './workbench.js';
import { state } from './state.js';

const plainKey = event => !event.ctrlKey && !event.metaKey && !event.altKey;

function onKeyDown(event) {
  if (event.target.closest('input,select,textarea') || document.querySelector('dialog[open]')) return;
  if (event.key === '/' && plainKey(event)) {
    event.preventDefault();
    focusCollectionSearch();
    return;
  }
  if (event.target.closest('button')) return;
  const key = event.key.toLowerCase();
  if (event.key === ' ') {
    event.preventDefault();
    playMix();
  } else if (key === 'r' && plainKey(event)) {
    event.preventDefault();
    newBatch();
  } else if (/^[1-4]$/.test(event.key) && plainKey(event)) {
    event.preventDefault();
    const index = Number(event.key) - 1;
    if (!state.tracks[index]?.locked) reroll(index);
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && state.pageItems.length) {
    event.preventDefault();
    stepSelection(event.key === 'ArrowDown' ? 1 : -1);
  }
}

export function initShortcuts() {
  document.addEventListener('keydown', onKeyDown);
}
