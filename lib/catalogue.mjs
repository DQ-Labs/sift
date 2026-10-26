import { access, copyFile, rename, rm } from 'node:fs/promises';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync, isDamagedDatabaseError } from './sqlite.mjs';
import { readLegacyLibrary, legacyFiles, recoveryMessages, preserveDamaged } from './library.mjs';
import { refreshSampleMetadata } from './metadata.mjs';

export const catalogueFiles = { database: 'library.sqlite', backup: 'library.backup.sqlite' };
const schemaVersion = 1;
const sidecars = ['-wal', '-shm', '-journal'];
const fingerprintToleranceMs = 2000;

const schema = `
CREATE TABLE samples (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  root TEXT,
  filename TEXT NOT NULL,
  name_key TEXT NOT NULL,
  name_case TEXT NOT NULL,
  type TEXT,
  bpm REAL,
  musical_key TEXT,
  bpm_source TEXT,
  conflicts TEXT,
  duration REAL,
  size INTEGER,
  mtime REAL,
  demo INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  conflict INTEGER NOT NULL DEFAULT 0,
  search TEXT NOT NULL,
  analysis_status TEXT,
  analysis_version INTEGER
);
CREATE INDEX samples_path ON samples(path);
CREATE INDEX samples_root ON samples(root);
CREATE INDEX samples_fingerprint ON samples(size, mtime);
-- Full records live apart from the filter columns so scans and sorts stay small.
CREATE TABLE sample_records (seq INTEGER PRIMARY KEY, data TEXT NOT NULL, peaks BLOB);
CREATE TABLE folders (seq INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE favorites (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE);
CREATE TABLE sets (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
PRAGMA user_version = ${schemaVersion};
`;
const requiredTables = ['samples', 'sample_records', 'folders', 'favorites', 'sets', 'meta'];

const sampleColumns = [
  'id', 'path', 'root', 'filename', 'name_key', 'name_case', 'type', 'bpm', 'musical_key', 'bpm_source', 'conflicts',
  'duration', 'size', 'mtime', 'demo', 'missing', 'invalid', 'conflict', 'search', 'analysis_status', 'analysis_version'
];
const upsertSample = `INSERT INTO samples (${sampleColumns.join(', ')}) VALUES (${sampleColumns.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET ${sampleColumns.slice(1).map(column => `${column} = excluded.${column}`).join(', ')}
  RETURNING seq`;
const upsertRecord = `INSERT INTO sample_records (seq, data, peaks) VALUES (?, ?, ?)
  ON CONFLICT(seq) DO UPDATE SET data = excluded.data, peaks = excluded.peaks`;
const recordById = 'SELECT r.data, r.peaks FROM samples s JOIN sample_records r ON r.seq = s.seq WHERE s.id = ?';

export const sortOrders = {
  name: 'name_key, name_case, seq',
  bpm: 'coalesce(nullif(bpm, 0), 999), seq',
  duration: 'duration IS NULL, duration, seq'
};
export const bpmRanges = {
  slow: 'bpm IS NOT NULL AND bpm <> 0 AND bpm < 90',
  mid: 'bpm >= 90 AND bpm <= 120',
  fast: 'bpm > 120',
  unknown: '(bpm IS NULL OR bpm = 0)'
};

class DamagedCatalogueError extends Error {}

const text = value => (typeof value === 'string' ? value : null);
const number = value => (Number.isFinite(value) ? value : null);
const flag = value => (value ? 1 : 0);

// ICU's root collation order for ASCII punctuation and symbols, all of which
// sort before digits and letters. Checked against localeCompare in tests.
const punctuationOrder = ` _-,;:!?.'"()[]{}@*/\\&#%\`^+<=>|~$`;
const punctuationKeys = new Map([...punctuationOrder].map((char, rank) => [char, String.fromCharCode(1 + rank)]));
const baseLetters = name => String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '');

// Sorting by nameKey, then caseKey, matches localeCompare for typical sample
// names: punctuation first, then digits, then letters ignoring case and
// accents, with lowercase before uppercase breaking ties.
export function nameKey(name) {
  let key = '';
  for (const char of baseLetters(name).toLowerCase()) key += punctuationKeys.get(char) ?? char;
  return key;
}

export function caseKey(name) {
  let key = '';
  for (const char of baseLetters(name)) key += char !== char.toLowerCase() ? 'b' : 'a';
  return key;
}

// The same haystack and test as filteredSamples() in public/app.js.
export function searchText(sample) {
  return `${sample.name} ${sample.filename} ${sample.folder} ${sample.typeHint || ''} ${sample.key || ''} ${sample.type}`.toLowerCase();
}

export function hasConflict(sample) {
  return Object.values(sample.conflicts || {}).some(conflict => !conflict?.resolved);
}

function encodePeaks(peaks) {
  if (!Array.isArray(peaks)) return null;
  const values = Float32Array.from(peaks, value => (Number.isFinite(value) ? value : 0));
  return Buffer.from(values.buffer);
}

function decodePeaks(blob) {
  const bytes = Uint8Array.from(blob);
  return Array.from(new Float32Array(bytes.buffer), value => Math.round(value * 1e6) / 1e6);
}

// The filter columns and the stored record for one sample.
function sampleRow(sample) {
  const { peaks, ...record } = sample;
  // Waveform peaks live in their own column; analysis no longer keeps a second copy.
  if (record.analysis?.peaks) {
    const { peaks: duplicate, ...analysis } = record.analysis;
    record.analysis = analysis;
  }
  const conflicts = record.conflicts && Object.keys(record.conflicts).length ? JSON.stringify(record.conflicts) : null;
  const columns = [
    sample.id, sample.path, text(sample.root), sample.filename, nameKey(sample.name), caseKey(sample.name),
    text(sample.type), number(sample.bpm), text(sample.key), text(sample.bpmSource), conflicts,
    number(sample.duration), number(sample.size), number(sample.mtime),
    flag(sample.demo), flag(sample.missing), flag(sample.invalid), flag(hasConflict(sample)), searchText(sample),
    text(sample.analysis?.status), Number.isInteger(sample.analysis?.version) ? sample.analysis.version : null
  ];
  return { columns, data: JSON.stringify(record), peaks: encodePeaks(peaks) };
}

function sampleFromRow(row) {
  const sample = JSON.parse(row.data);
  if (row.peaks) sample.peaks = decodePeaks(row.peaks);
  return sample;
}

// Any change to filename tagging or metadata priority must refresh stored
// records once. Hashing the rule sources makes that automatic.
function metadataRulesHash() {
  const hash = createHash('sha256');
  for (const file of ['./metadata.mjs', './audio.mjs']) {
    hash.update(readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex').slice(0, 16);
}

export class Catalogue {
  constructor(db, { directory, file }) {
    this.db = db;
    this.directory = directory;
    this.file = file;
    this.revision = 0;
    this.backedUpRevision = 0;
    this.statements = new Map();
    this.inTransaction = false;
    this.candidateCache = null;
    this.backupTimer = null;
  }

  statement(sql) {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      // Query filters combine into a bounded but large set of statements.
      if (this.statements.size > 256) this.statements.clear();
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  // Runs fn inside one write transaction. fn must be synchronous.
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  // Writes one sample's filter columns and record. Call inside transaction().
  writeSample(sample) {
    const { columns, data, peaks } = sampleRow(sample);
    const { seq } = this.statement(upsertSample).get(...columns);
    this.statement(upsertRecord).run(seq, data, peaks);
  }

  changed() {
    this.revision++;
    this.candidateCache = null;
  }

  // Samples

  get(id) {
    if (typeof id !== 'string') return undefined;
    const row = this.statement(recordById).get(id);
    return row ? sampleFromRow(row) : undefined;
  }

  has(id) {
    return typeof id === 'string' && !!this.statement('SELECT 1 AS found FROM samples WHERE id = ?').get(id);
  }

  getMany(ids) {
    const items = [];
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const sample = this.get(id);
      if (sample) items.push(sample);
    }
    return items;
  }

  pathOf(id) {
    if (typeof id !== 'string') return undefined;
    return this.statement('SELECT path FROM samples WHERE id = ?').get(id)?.path;
  }

  put(sample) {
    this.transaction(() => this.writeSample(sample));
    this.changed();
    return sample;
  }

  putMany(samples) {
    this.transaction(() => {
      for (const sample of samples) this.writeSample(sample);
    });
    this.changed();
  }

  // Reads the current record, lets mutate change it, and writes it back.
  // Returning false from mutate skips the write.
  update(id, mutate) {
    return this.transaction(() => {
      const sample = this.get(id);
      if (!sample) return undefined;
      if (mutate(sample) === false) return sample;
      this.put(sample);
      return sample;
    });
  }

  updateMany(ids, mutate) {
    this.transaction(() => {
      for (const id of ids) this.update(id, mutate);
    });
  }

  remove(ids) {
    this.transaction(() => {
      for (const id of ids) {
        this.statement('DELETE FROM sample_records WHERE seq = (SELECT seq FROM samples WHERE id = ?)').run(id);
        this.statement('DELETE FROM samples WHERE id = ?').run(id);
      }
    });
    this.changed();
  }

  allSamples() {
    return this.statement('SELECT data, peaks FROM sample_records ORDER BY seq').all().map(sampleFromRow);
  }

  // Path, size and change time for every sample: enough to identify files
  // during a scan without loading full records.
  fileRecords({ root } = {}) {
    const columns = 'id, path, root, size, mtime, demo, missing, invalid';
    const rows = root === undefined
      ? this.statement(`SELECT ${columns} FROM samples ORDER BY seq`).all()
      : this.statement(`SELECT ${columns} FROM samples WHERE root = ? ORDER BY seq`).all(root);
    return rows.map(row => ({
      id: row.id,
      path: row.path,
      root: row.root ?? undefined,
      size: row.size ?? undefined,
      mtime: row.mtime ?? undefined,
      demo: row.demo === 1,
      missing: row.missing === 1,
      invalid: row.invalid === 1
    }));
  }

  idsForPaths(paths) {
    const found = new Map();
    for (const filepath of paths) {
      const row = this.statement('SELECT id FROM samples WHERE path = ? ORDER BY seq LIMIT 1').get(filepath);
      if (row) found.set(filepath, row.id);
    }
    return found;
  }

  // A file seen under another path (drive letter change, copy, case alias)
  // with the same name, size and change time keeps its finished analysis.
  // Copies keep change times only as precisely as the target file system
  // (2 s on FAT32), so the closest time within 2 s counts as the same.
  analysisForFingerprint({ filename, size, mtime }, version) {
    if (!Number.isFinite(size) || !Number.isFinite(mtime)) return null;
    const row = this.statement(`SELECT r.data, r.peaks FROM samples s JOIN sample_records r ON r.seq = s.seq
      WHERE s.size = ? AND s.mtime BETWEEN ? AND ? AND s.filename = ? AND s.analysis_status = 'done' AND s.analysis_version = ?
      ORDER BY abs(s.mtime - ?) LIMIT 1`).get(size, mtime - fingerprintToleranceMs, mtime + fingerprintToleranceMs, filename, version, mtime);
    if (!row) return null;
    const sample = sampleFromRow(row);
    const { duration, rate, channels, bits, type } = sample;
    return { analysis: sample.analysis, peaks: sample.peaks, metadata: { duration, rate, channels, bits }, type };
  }

  // Just enough of each record for AnalysisQueue.enqueue().
  analysisStates(ids) {
    const states = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const row = this.statement('SELECT missing, invalid FROM samples WHERE id = ?').get(id);
      if (row) states.push({ id, missing: row.missing === 1, invalid: row.invalid === 1 });
    }
    return states;
  }

  pendingAnalysisIds(version) {
    return this.statement(`SELECT id FROM samples
      WHERE missing = 0 AND invalid = 0 AND NOT (coalesce(analysis_version, -1) = ? AND analysis_status IN ('done', 'error'))
      ORDER BY seq`).all(version).map(row => row.id);
  }

  recentAnalysisErrors(limit = 50) {
    return this.statement(`SELECT json_extract(r.data, '$.analysis.error') AS error, json_extract(r.data, '$.analysis.analyzedAt') AS at
      FROM samples s JOIN sample_records r ON r.seq = s.seq WHERE s.analysis_status = 'error' ORDER BY at DESC LIMIT ?`).all(limit).map(row => ({ error: row.error, at: row.at }));
  }

  hasRealSamples() {
    return !!this.statement('SELECT 1 AS found FROM samples WHERE demo = 0 LIMIT 1').get();
  }

  // Mirrors sourceSamples() in public/app.js. A source is usually most of
  // the catalogue, where a plain scan beats an index lookup per row; the
  // unary + keeps SQLite from choosing the root index.
  sourceFilter(source, where, params) {
    if (source === 'demo') where.push('demo = 1');
    else if (source) {
      where.push('+root = ?');
      params.push(source);
    } else if (this.hasRealSamples()) where.push('demo = 0');
  }

  // Mirrors filteredSamples() in public/app.js, then pages the result.
  query({ source = '', view = 'all', q = '', type = '', bpm = '', conflicts = false, sort = 'name', page = 0, pageSize = 50 } = {}) {
    const where = [];
    const params = [];
    this.sourceFilter(source, where, params);
    if (conflicts) where.push('conflict = 1');
    if (view === 'gems') where.push('id IN (SELECT id FROM favorites)');
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    for (const word of q.toLowerCase().trim().split(/\s+/).filter(Boolean)) {
      where.push('instr(search, ?) > 0');
      params.push(word);
    }
    if (bpm) where.push(bpmRanges[bpm]);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.statement(`SELECT count(*) AS total FROM samples ${clause}`).get(...params).total;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.max(0, Math.min(page, pages - 1));
    // Sort row numbers only, then load the page: sorting whole records would
    // drag every record's JSON and peaks through the sorter.
    const rows = this.statement(`SELECT seq FROM samples ${clause} ORDER BY ${sortOrders[sort]} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, current * pageSize);
    const load = this.statement('SELECT data, peaks FROM sample_records WHERE seq = ?');
    return { total, page: current, pageSize, items: rows.map(row => sampleFromRow(load.get(row.seq))) };
  }

  counts() {
    const row = this.statement(`SELECT count(*) AS total, sum(demo = 0) AS real, sum(demo = 1) AS demo, sum(conflict) AS conflicts,
      sum(missing) AS missing, sum(invalid) AS invalid,
      sum(analysis_status = 'done') AS analyzed, sum(analysis_status = 'error') AS analysisErrors FROM samples`).get();
    const byRoot = {};
    for (const entry of this.statement('SELECT root, count(*) AS total FROM samples WHERE demo = 0 AND root IS NOT NULL GROUP BY root').all()) {
      byRoot[entry.root] = entry.total;
    }
    const counts = {};
    for (const [key, value] of Object.entries(row)) counts[key] = value ?? 0;
    return { ...counts, byRoot };
  }

  // Light records with the fields chooseCombination() reads, for one source.
  combinationCandidates(source = '') {
    const cacheKey = `${source}\0${this.revision}`;
    if (this.candidateCache?.key === cacheKey) return this.candidateCache.samples;
    const where = ['missing = 0', 'invalid = 0'];
    const params = [];
    this.sourceFilter(source, where, params);
    const rows = this.statement(`SELECT id, type, bpm, musical_key, bpm_source, conflicts, size, duration, demo, root
      FROM samples WHERE ${where.join(' AND ')} ORDER BY seq`).all(...params);
    const samples = rows.map(row => ({
      id: row.id,
      type: row.type,
      bpm: row.bpm,
      key: row.musical_key,
      bpmSource: row.bpm_source,
      conflicts: row.conflicts ? JSON.parse(row.conflicts) : {},
      size: row.size,
      duration: row.duration,
      demo: row.demo === 1,
      root: row.root ?? undefined
    }));
    this.candidateCache = { key: cacheKey, samples };
    return samples;
  }

  // Folders, gems, sets, workspace

  meta(key) {
    const row = this.statement('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  setMeta(key, value) {
    this.statement('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    this.changed();
  }

  get folders() {
    return this.statement('SELECT path, name FROM folders ORDER BY seq').all().map(row => ({ path: row.path, name: row.name }));
  }

  addFolder(folder) {
    this.statement('INSERT OR IGNORE INTO folders (path, name) VALUES (?, ?)').run(folder.path, folder.name);
    this.changed();
  }

  get favorites() {
    return this.statement('SELECT id FROM favorites ORDER BY seq').all().map(row => row.id);
  }

  // Keeps known sample IDs only, once each, in the given order.
  setFavorites(ids) {
    const kept = [...new Set(ids)].filter(id => this.has(id));
    this.transaction(() => {
      this.statement('DELETE FROM favorites').run();
      for (const id of kept) this.statement('INSERT INTO favorites (id) VALUES (?)').run(id);
    });
    this.changed();
    return kept;
  }

  // Newest first, as the JSON catalogue kept them.
  get sets() {
    return this.statement('SELECT data FROM sets ORDER BY seq DESC').all().map(row => JSON.parse(row.data));
  }

  // replaces: the id of an earlier set this one overwrites. Returns whether it existed.
  addSet(set, replaces = null) {
    let replaced = false;
    this.transaction(() => {
      if (replaces) replaced = this.statement('DELETE FROM sets WHERE id = ?').run(replaces).changes > 0;
      this.statement('INSERT INTO sets (id, data) VALUES (?, ?)').run(set.id, JSON.stringify(set));
    });
    this.changed();
    return replaced;
  }

  get workspace() {
    return this.meta('workspace') ?? null;
  }

  setWorkspace(workspace) {
    this.setMeta('workspace', workspace);
  }

  get analysisPaused() {
    return this.meta('analysisPaused') === true;
  }

  setAnalysisPaused(paused) {
    this.setMeta('analysisPaused', paused === true);
  }

  // Sample IDs that gems, sets or the workspace still point to.
  referencedIds() {
    return new Set([
      ...this.favorites,
      ...(this.workspace?.tracks || []).map(track => track.id),
      ...this.sets.flatMap(set => set.tracks.map(track => track.id))
    ].filter(Boolean));
  }

  // The whole catalogue in the shape library.json used, for GET /api/library.
  snapshot() {
    return {
      samples: this.allSamples(),
      folders: this.folders,
      favorites: this.favorites,
      sets: this.sets,
      workspace: this.workspace,
      analysisPaused: this.analysisPaused
    };
  }

  importLibrary(library, { migratedFrom }) {
    this.transaction(() => {
      for (const sample of library.samples) this.writeSample(sample);
      for (const folder of library.folders) this.addFolder(folder);
      for (const id of new Set(library.favorites)) this.statement('INSERT OR IGNORE INTO favorites (id) VALUES (?)').run(id);
      for (const set of [...library.sets].reverse()) this.statement('INSERT OR IGNORE INTO sets (id, data) VALUES (?, ?)').run(set.id, JSON.stringify(set));
      if (library.workspace) this.setWorkspace(library.workspace);
      this.setAnalysisPaused(library.analysisPaused);
      this.setMeta('migratedFrom', migratedFrom);
      this.setMeta('migratedAt', new Date().toISOString());
    });
    this.changed();
  }

  // Applies changed metadata rules to every stored sample, once per change.
  refreshMetadata({ force = false, batchSize = 1000 } = {}) {
    const rules = metadataRulesHash();
    if (!force && this.meta('metadataRules') === rules) return 0;
    let last = 0;
    let refreshed = 0;
    while (true) {
      const rows = this.statement('SELECT seq, data, peaks FROM sample_records WHERE seq > ? ORDER BY seq LIMIT ?').all(last, batchSize);
      if (!rows.length) break;
      this.transaction(() => {
        for (const row of rows) this.writeSample(refreshSampleMetadata(sampleFromRow(row)));
      });
      last = rows.at(-1).seq;
      refreshed += rows.length;
    }
    this.setMeta('metadataRules', rules);
    return refreshed;
  }

  // Backups

  backupFile() {
    return path.join(this.directory, catalogueFiles.backup);
  }

  // A consistent copy of the live catalogue, written beside it atomically.
  backup() {
    const target = this.backupFile();
    const temporary = `${target}.tmp`;
    rmSync(temporary, { force: true });
    this.statement('VACUUM INTO ?').run(temporary);
    renameSync(temporary, target);
    this.backedUpRevision = this.revision;
  }

  backupIfChanged() {
    if (this.revision === this.backedUpRevision) return false;
    this.backup();
    return true;
  }

  startBackups({ interval = 30 * 60 * 1000, onError = error => console.warn(`Catalogue backup failed: ${error.message}`) } = {}) {
    this.stopBackups();
    this.backupTimer = setInterval(() => {
      try {
        this.backupIfChanged();
      } catch (error) {
        onError(error);
      }
    }, interval);
    this.backupTimer.unref();
  }

  stopBackups() {
    clearInterval(this.backupTimer);
    this.backupTimer = null;
  }

  close({ backup = true } = {}) {
    this.stopBackups();
    try {
      if (backup) this.backupIfChanged();
    } finally {
      this.db.close();
    }
  }
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function removeDatabase(file) {
  for (const suffix of ['', ...sidecars]) await rm(file + suffix, { force: true });
}

function verifySchema(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > schemaVersion) {
    throw Object.assign(new Error('This catalogue was saved by a newer version of Sift. Update Sift to open it.'), { code: 'SIFT_CATALOGUE_NEWER' });
  }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  if (version === 0) {
    if (tables.size) throw new DamagedCatalogueError('Unknown catalogue schema.');
    db.exec(schema);
    return;
  }
  if (requiredTables.some(table => !tables.has(table))) throw new DamagedCatalogueError('Catalogue tables are missing.');
}

// Opens a catalogue database and confirms it is intact. Throws
// DamagedCatalogueError (or a SQLite corruption error) for a damaged file.
function openDatabase(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    // Up to 64 MB of pages, so repeated collection queries stay in memory.
    db.exec('PRAGMA cache_size = -65536');
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new DamagedCatalogueError('Catalogue integrity check failed.');
    verifySchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const isDamaged = error => error instanceof DamagedCatalogueError || isDamagedDatabaseError(error);

// Opens file, or preserves it byte-for-byte and returns null when damaged.
async function openOrPreserve(file, preserved) {
  try {
    return openDatabase(file);
  } catch (error) {
    if (!isDamaged(error)) throw error;
  }
  preserved.push(await preserveDamaged(file));
  if (await exists(`${file}-wal`)) preserved.push(await preserveDamaged(`${file}-wal`));
  await removeDatabase(file);
  return null;
}

async function restoreBackup(directory, file, preserved) {
  const backup = path.join(directory, catalogueFiles.backup);
  if (!(await exists(backup))) return null;
  // A stale write-ahead log must never be replayed onto the restored copy.
  await removeDatabase(file);
  await copyFile(backup, `${file}.restoring`);
  await rename(`${file}.restoring`, file);
  try {
    return openDatabase(file);
  } catch (error) {
    if (!isDamaged(error)) throw error;
  }
  preserved.push(await preserveDamaged(backup));
  await removeDatabase(file);
  return null;
}

async function migrateLegacy(directory, file, library) {
  const temporary = `${file}.migrating`;
  await removeDatabase(temporary);
  const db = openDatabase(temporary);
  try {
    new Catalogue(db, { directory, file: temporary }).importLibrary(library, { migratedFrom: legacyFiles.primary });
    // Leave WAL mode so the finished file is self-contained before the rename.
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
  await rename(temporary, file);
  return openDatabase(file);
}

// Moves migrated JSON aside so it is kept but never imported again.
async function retireLegacyFiles(directory) {
  for (const [from, to] of [[legacyFiles.primary, legacyFiles.migratedPrimary], [legacyFiles.backup, legacyFiles.migratedBackup]]) {
    const source = path.join(directory, from);
    const target = path.join(directory, to);
    if (!(await exists(source)) || (await exists(target))) continue;
    try {
      await rename(source, target);
    } catch (error) {
      console.warn(`Could not rename ${from} after migration: ${error.message}`);
    }
  }
}

// Opens data/library.sqlite. On first run it migrates library.json once. A
// damaged database is preserved and replaced by the rolling backup, or by a
// fresh catalogue when no intact backup exists.
export async function openCatalogue(directory) {
  const file = path.join(directory, catalogueFiles.database);
  const preserved = [];
  let recovery = null;
  let db = null;
  const hadDatabase = await exists(file);
  if (hadDatabase) db = await openOrPreserve(file, preserved);
  if (!db) {
    db = await restoreBackup(directory, file, preserved);
    if (db) recovery = { message: recoveryMessages.restored, preserved };
  }
  if (!db && !hadDatabase && !preserved.length) {
    const legacy = await readLegacyLibrary(directory);
    if (legacy) {
      db = await migrateLegacy(directory, file, legacy.db);
      recovery = legacy.recovery;
    }
  }
  if (!db) {
    if (preserved.length) recovery = { message: recoveryMessages.fresh, preserved };
    await removeDatabase(file);
    db = openDatabase(file);
  }
  const catalogue = new Catalogue(db, { directory, file });
  if (catalogue.meta('migratedFrom')) await retireLegacyFiles(directory);
  catalogue.refreshMetadata();
  if (await exists(catalogue.backupFile())) catalogue.backedUpRevision = catalogue.revision;
  return { catalogue, recovery };
}
