// Small DOM helpers shared by every front-end module.

export const $ = selector => document.querySelector(selector);

const icons = {
  down: '<path d="m5 9 7 7 7-7"/>',
  settings: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  timing: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  play: '<path d="m6 3 13 9-13 9z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/>',
  library: '<path d="M4 4v16M9 4v16M14 4v16M18 4l3 16"/>',
  gem: '<path d="m3 8 4-5h10l4 5-9 13zM3 8h18M8 8l4 13 4-13M7 3l1 5 4-5 4 5 1-5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7V4h6l3 3h9v13H3z"/>',
  'folder-plus': '<path d="M3 7V4h6l3 3h9v13H3zM8 14h8M12 10v8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  shuffle: '<path d="M3 5h3c5 0 7 14 12 14h3m-4-4 4 4-4 4M3 19h3c2 0 4-3 6-7M14 7c1-1 3-2 4-2h3m-4-4 4 4-4 4"/>',
  repeat: '<path d="M4 8h15l-4-4M20 16H5l4 4M20 8v4M4 16v-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0M12 14v3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  left: '<path d="m14 5-7 7 7 7"/>',
  right: '<path d="m10 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  batch: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.1"/>'
};

export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;

export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(element => {
    element.innerHTML = icon(element.dataset.icon);
  });
}

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => entities[char]);

export const colors = { Drums: '#c8ad85', Bass: '#a1b39a', Melodic: '#a1b7c0', Texture: '#b1a1bc', Vocal: '#c4a3a0', Other: '#a1aaa0' };

export const metadataSource = source => source === 'filename-hint' ? 'unverified filename number' : source || 'unknown';

export const displayName = sample => sample.name.replaceAll('_', ' ');

export function formatTime(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
}

export const plural = (count, word, many = `${word}s`) => `${count.toLocaleString()} ${count === 1 ? word : many}`;

let toastTimer;
export function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 4300);
}

export function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
