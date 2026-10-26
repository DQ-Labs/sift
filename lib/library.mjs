import { readFile, copyFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeWorkspace } from '../public/workspace.js';

// Catalogue files written before the SQLite move. They are read once, migrated,
// then renamed so a stale copy is never imported twice.
export const legacyFiles = {
  primary: 'library.json',
  backup: 'library.backup.json',
  migratedPrimary: 'library.pre-sqlite.json',
  migratedBackup: 'library.pre-sqlite.backup.json'
};

export const recoveryMessages = {
  restored: 'Catalogue restored from the rolling backup.',
  fresh: 'The catalogue could not be read. A fresh collection was started; damaged files were preserved.'
};

export const emptyLibrary = () => ({ samples: [], folders: [], favorites: [], sets: [], workspace: null, analysisPaused: false });

function invalid(message) {
  return new Error(message);
}

export function parseLibrary(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Invalid catalogue structure.');
  const db = { ...emptyLibrary(), ...value };
  for (const key of ['samples', 'folders', 'favorites', 'sets']) {
    if (!Array.isArray(db[key])) throw invalid(`Invalid catalogue ${key}.`);
  }
  const badSample = sample => !sample || typeof sample.id !== 'string' || typeof sample.path !== 'string' || typeof sample.filename !== 'string';
  if (db.samples.some(badSample)) throw invalid('Invalid catalogue sample.');
  const badFolder = folder => !folder || typeof folder.path !== 'string' || typeof folder.name !== 'string';
  if (db.folders.some(badFolder) || db.favorites.some(id => typeof id !== 'string')) throw invalid('Invalid catalogue folders or gems.');
  const badSet = set => !set || typeof set.id !== 'string' || typeof set.name !== 'string' || !Array.isArray(set.tracks);
  if (db.sets.some(badSet)) throw invalid('Invalid saved sets.');
  db.workspace = db.workspace == null ? null : normalizeWorkspace(db.workspace);
  db.sets = db.sets.map(set => ({ ...set, ...normalizeWorkspace(set) }));
  db.analysisPaused = db.analysisPaused === true;
  return db;
}

// Copies an unreadable file next to itself before anything may replace it.
export async function preserveDamaged(filename) {
  const preserved = `${filename}.corrupt-${Date.now()}-${randomUUID()}`;
  await copyFile(filename, preserved, constants.COPYFILE_EXCL);
  return path.basename(preserved);
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

// Reads library.json, falling back to its rolling backup. Damaged files are
// preserved byte-for-byte. Returns null when neither file exists.
export async function readLegacyLibrary(directory) {
  const primary = path.join(directory, legacyFiles.primary);
  const backup = path.join(directory, legacyFiles.backup);
  if (!(await exists(primary)) && !(await exists(backup))) return null;
  const damaged = [];
  async function readCatalogue(filename) {
    let raw;
    try {
      raw = await readFile(filename, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return parseLibrary(raw);
    } catch {
      damaged.push(await preserveDamaged(filename));
      return null;
    }
  }
  let db = await readCatalogue(primary);
  let recovery = null;
  if (!db) {
    db = await readCatalogue(backup);
    if (db) recovery = { message: recoveryMessages.restored, preserved: damaged };
    else if (damaged.length) recovery = { message: recoveryMessages.fresh, preserved: damaged };
  }
  return { db: db || emptyLibrary(), recovery };
}

const unavailableCodes = new Set(['ENOENT', 'ENOTDIR']);

async function isDirectory(statFile, directory) {
  try {
    return (await statFile(directory)).isDirectory();
  } catch {
    return false;
  }
}

// An unavailable source root may be a disconnected drive. Never prune it.
// Updates each sample's `missing` flag in place.
export async function checkMissingSamples(samples, { remove = false, referenced = new Set(), statFile = stat } = {}) {
  const roots = new Map();
  const kept = [];
  const unavailableRoots = new Set();
  const missingIds = [];
  const restoredIds = [];
  let removed = 0;
  let missing = 0;
  for (const sample of samples) {
    if (sample.demo || !sample.root) {
      kept.push(sample);
      continue;
    }
    if (!roots.has(sample.root)) roots.set(sample.root, await isDirectory(statFile, sample.root));
    if (!roots.get(sample.root)) {
      unavailableRoots.add(sample.root);
      kept.push(sample);
      continue;
    }
    let absent = false;
    try {
      absent = !(await statFile(sample.path)).isFile();
    } catch (error) {
      if (!unavailableCodes.has(error.code)) {
        kept.push(sample);
        continue;
      }
      absent = true;
    }
    if (absent) {
      // Recheck the root in case a drive disconnected during the sweep.
      if (!(await isDirectory(statFile, sample.root))) {
        roots.set(sample.root, false);
        unavailableRoots.add(sample.root);
        kept.push(sample);
        continue;
      }
      sample.missing = true;
      missingIds.push(sample.id);
      if (remove && !referenced.has(sample.id)) {
        removed++;
        continue;
      }
      missing++;
    } else if (sample.missing) {
      if (sample.analysis?.status === 'error') delete sample.analysis;
      delete sample.missing;
      restoredIds.push(sample.id);
    }
    kept.push(sample);
  }
  return { samples: kept, removed, missing, missingIds, restoredIds, unavailableRoots: unavailableRoots.size };
}
