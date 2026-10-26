// Shared dialog behaviour: close buttons and a promise-based confirmation.
import { $ } from './ui.js';

let pending = null;

// Resolves true when the user confirms, false on cancel, Escape or close.
export function confirmAction({ title, message, confirmLabel = 'Continue' }) {
  // Only one question at a time; a newer one cancels the older.
  pending?.(false);
  pending = null;
  const dialog = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmAccept').textContent = confirmLabel;
  dialog.returnValue = '';
  if (!dialog.open) dialog.showModal();
  $('#confirmCancel').focus();
  return new Promise(resolve => {
    pending = resolve;
  });
}

export function initDialogs() {
  document.querySelectorAll('[data-close]').forEach(button => {
    button.onclick = () => $(`#${button.dataset.close}`).close();
  });
  $('#confirmDialog').addEventListener('close', () => {
    const resolve = pending;
    pending = null;
    resolve?.($('#confirmDialog').returnValue === 'confirm');
  });
}
