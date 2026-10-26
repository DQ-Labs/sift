// Shared front-end state. Samples live in the catalogue client's cache, not here.
import { api } from './api.js';
import { CatalogClient } from './catalog-client.js';
import { defaultVariety } from './harmony.js';

export const catalog = new CatalogClient({ request: api });

export const state = {
  // Library
  favorites: [],
  folders: [],
  sets: [],
  counts: { total: 0, real: 0, demo: 0, conflicts: 0, byRoot: {} },
  analysis: null,
  scan: null,
  statusUnavailable: false,
  capabilities: null,
  // Collection
  source: null,
  view: 'discover',
  collectionOpen: false,
  query: '',
  type: '',
  bpm: '',
  sort: 'name',
  page: 0,
  conflictsOnly: false,
  pageItems: [],
  total: 0,
  selected: null,
  // Workbench
  tracks: [],
  tempo: 92,
  sync: true,
  key: 'A min',
  variety: defaultVariety,
  setName: 'Untitled set'
};

export const sampleById = id => catalog.sampleById(id);

// Settings that change how audio is rendered.
export const currentSettings = () => ({ tempo: state.tempo, sync: state.sync, key: state.key });

export function snapshot() {
  return { tracks: state.tracks, tempo: state.tempo, sync: state.sync, key: state.key, variety: state.variety, name: state.setName };
}

export function applyWorkspace(workspace) {
  state.tracks = workspace.tracks;
  state.tempo = workspace.tempo;
  state.sync = workspace.sync;
  state.key = workspace.key;
}

// Every sample the UI may show without fetching it first.
export function referencedIds() {
  const ids = [
    ...state.tracks.map(track => track.id),
    ...state.sets.flatMap(set => set.tracks.map(track => track.id)),
    state.selected
  ];
  return ids.filter(Boolean);
}

catalog.pin(() => [...referencedIds(), ...state.pageItems.map(sample => sample.id)]);
