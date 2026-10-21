import { readFile, writeFile, rename, copyFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeWorkspace } from '../public/workspace.js';

const emptyLibrary = () => ({ samples: [], folders: [], favorites: [], sets: [], workspace: null, analysisPaused: false });
function parseLibrary(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid catalogue structure.');
  const db = { ...emptyLibrary(), ...value };
  for (const key of ['samples', 'folders', 'favorites', 'sets']) if (!Array.isArray(db[key])) throw new Error(`Invalid catalogue ${key}.`);
  if (db.samples.some(s => !s || typeof s.id !== 'string' || typeof s.path !== 'string' || typeof s.filename !== 'string')) throw new Error('Invalid catalogue sample.');
  if (db.folders.some(f => !f || typeof f.path !== 'string' || typeof f.name !== 'string') || db.favorites.some(id => typeof id !== 'string')) throw new Error('Invalid catalogue folders or gems.');
  if (db.sets.some(s => !s || typeof s.id !== 'string' || typeof s.name !== 'string' || !Array.isArray(s.tracks))) throw new Error('Invalid saved sets.');
  db.workspace = db.workspace == null ? null : normalizeWorkspace(db.workspace);
  db.sets = db.sets.map(s => ({ ...s, ...normalizeWorkspace(s) }));
  return db;
}

export async function openLibrary(directory) {
  const primary = path.join(directory, 'library.json'), backup = path.join(directory, 'library.backup.json');
  const damaged = [];
  async function readCatalogue(filename) {
    let raw;
    try { raw = await readFile(filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try { return parseLibrary(raw); } catch {
      const preserved = `${filename}.corrupt-${Date.now()}-${randomUUID()}`;
      // Never replace the unreadable original until its exact bytes are safe.
      await copyFile(filename, preserved, constants.COPYFILE_EXCL);
      damaged.push(path.basename(preserved));
      return null;
    }
  }
  let db = await readCatalogue(primary), recovery = null;
  if (!db) {
    db = await readCatalogue(backup);
    if (db) recovery = { message: 'Catalogue restored from the rolling backup.', preserved: damaged };
    else if (damaged.length) recovery = { message: 'The catalogue could not be read. A fresh collection was started; damaged files were preserved.', preserved: damaged };
  }
  db ||= emptyLibrary();
  let lastPayload = JSON.stringify(db), queue = Promise.resolve();
  async function atomicWrite(filename, payload) {
    await writeFile(filename + '.tmp', payload);
    await rename(filename + '.tmp', filename);
  }
  function persist() {
    const payload = JSON.stringify(db);
    queue = queue.catch(() => {}).then(async () => {
      await atomicWrite(backup, lastPayload);
      await atomicWrite(primary, payload);
      lastPayload = payload;
    });
    return queue;
  }
  return { db, recovery, persist };
}

// An unavailable source root may be a disconnected drive. Never prune it.
export async function checkMissingSamples(samples, { remove = false, referenced = new Set(), statFile = stat } = {}) {
  const roots = new Map(), kept = [], unavailableRoots = new Set(), missingIds = [];
  let removed = 0, missing = 0;
  for (const sample of samples) {
    if (sample.demo || !sample.root) { kept.push(sample); continue; }
    if (!roots.has(sample.root)) {
      try { roots.set(sample.root, (await statFile(sample.root)).isDirectory()); } catch { roots.set(sample.root, false); }
    }
    if (!roots.get(sample.root)) { unavailableRoots.add(sample.root); kept.push(sample); continue; }
    let absent = false;
    try { absent = !(await statFile(sample.path)).isFile(); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) { kept.push(sample); continue; }
      absent = true;
    }
    if (absent) {
      // Recheck the root in case a drive disconnected during the sweep.
      try { if (!(await statFile(sample.root)).isDirectory()) throw new Error(); } catch {
        roots.set(sample.root, false); unavailableRoots.add(sample.root); kept.push(sample); continue;
      }
      sample.missing = true;
      missingIds.push(sample.id);
      if (remove && !referenced.has(sample.id)) { removed++; continue; }
      missing++;
    } else {
      if (sample.missing && sample.analysis?.status === 'error') delete sample.analysis;
      delete sample.missing;
    }
    kept.push(sample);
  }
  return { samples: kept, removed, missing, missingIds, unavailableRoots: unavailableRoots.size };
}
