// Pure workbench helpers, kept DOM-free so node --test can cover them.
import { clampVariety } from './harmony.js';

const varietyNames = ['Safe', 'Close', 'Balanced', 'Adventurous', 'Wild'];

export function varietyLabel(value) {
  const step = Math.min(varietyNames.length - 1, Math.floor(clampVariety(value) * varietyNames.length));
  return varietyNames[step];
}

const pad = number => String(number).padStart(2, '0');

// "Mix export · 2026-10-26 14:03:05", in local time, for automatic sets.
export function timestampedSetName(date, kind) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${kind} · ${day} ${time}`;
}

export function findSetByName(sets, name) {
  const wanted = name.trim().toLocaleLowerCase();
  return sets.find(set => set.name.trim().toLocaleLowerCase() === wanted) || null;
}

// A prefetched reroll candidate stays valid while everything that fed
// chooseCombination is unchanged. Volume, mute and solo do not affect it.
export function candidateContext({ source, settings, variety, tracks }, index) {
  const layers = tracks.map(track => [track.id, track.type, track.locked]);
  return JSON.stringify([source || '', settings.tempo, settings.sync, settings.key, clampVariety(variety), layers, index]);
}

// Places a sample on the workbench: an empty unlocked layer first, then an
// unlocked layer of the same type, then any unlocked layer.
export function layerForSample(tracks, sample) {
  const open = (test) => tracks.findIndex(track => !track.locked && test(track));
  let index = open(track => !track.id);
  if (index < 0) index = open(track => track.type === sample.type);
  if (index < 0) index = open(() => true);
  return index;
}
