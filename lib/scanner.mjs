import { readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { extensions, tagsFromName, wavInfo } from './audio.mjs';
import { effectiveMetadata, refreshSampleMetadata } from './metadata.mjs';
import { checkMissingSamples } from './library.mjs';
import { SampleIndex } from './sample-index.mjs';
import { ANALYSIS_VERSION } from './analysis.mjs';

// System folders directly under a drive root, so `D:\` can be a source.
const driveRootFolders = new Set(['windows', 'programdata', '$recycle.bin', 'system volume information']);
// Never sample material, wherever they appear.
const skippedEverywhere = new Set(['appdata', 'node_modules', '.git']);
const vanishedCodes = new Set(['ENOENT', 'ENOTDIR']);

export const invalidReasons = {
  empty: 'Empty file (0 bytes).',
  unreadable: 'This file cannot be read. Check its permissions, or close any program that has it locked, then rescan.'
};

export function skipDirectory(name, parent, pathApi = path) {
  const folded = name.toLowerCase();
  if (skippedEverywhere.has(folded)) return true;
  const atDriveRoot = pathApi.parse(parent).root === parent;
  return atDriveRoot && (driveRootFolders.has(folded) || folded.startsWith('program files'));
}

const idleStatus = () => ({ running: false, count: 0, skipped: 0, invalid: 0, error: null, cancelled: false, phase: null, current: null });

const sameOverrides = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// Indexes folders into the catalogue and checks for missing files.
export class Scanner {
  constructor({ catalogue, analysis, fs = { readdir, stat, open }, platform = process.platform, pathApi = path, batchSize = 500 }) {
    this.catalogue = catalogue;
    this.analysis = analysis;
    this.fs = fs;
    this.platform = platform;
    this.path = pathApi;
    this.batchSize = batchSize;
    this.status = idleStatus();
    this.cleaning = false;
  }

  get busy() {
    return this.status.running || this.cleaning;
  }

  cancel() {
    this.status.cancelled = true;
    return this.status;
  }

  folderName(root) {
    return this.path.basename(root) || root;
  }

  // Whether `inner` is `outer` or lies inside it. Follows the platform's
  // rules, so case does not matter on Windows.
  contains(outer, inner) {
    const relative = this.path.relative(outer, inner);
    return !relative.startsWith('..') && !this.path.isAbsolute(relative);
  }

  // Source folders can nest: a drive may be added before or after a folder
  // on it. A file belongs to the deepest source that contains it, whichever
  // was added first, so every file is counted once and under the same source
  // however it was reached. Returns the sources inside `root`, deepest first.
  sourcesWithin(root) {
    const inside = this.catalogue.folders
      .map(folder => folder.path)
      .filter(folder => folder !== root && this.contains(root, folder));
    return inside.sort((a, b) => b.length - a.length);
  }

  // Starts indexing root. Resolves when the scan has finished.
  async scan(root) {
    const status = idleStatus();
    Object.assign(status, { running: true, phase: 'indexing', current: this.folderName(root) });
    this.status = status;
    const pending = new Map();
    try {
      const index = new SampleIndex(this.catalogue.fileRecords(), { platform: this.platform, statFile: this.fs.stat });
      const nested = this.sourcesWithin(root);
      await this.walk(root, { index, pending, status, nested });
      this.flush(pending);
      this.catalogue.addFolder({ path: root, name: this.folderName(root) });
      status.phase = 'saving';
      // The walk covered the sources inside this one too.
      for (const source of [root, ...nested]) {
        if (!status.cancelled) await this.checkMissing({ root: source });
      }
    } catch (error) {
      status.error = error.message;
    } finally {
      try {
        this.flush(pending);
      } catch (error) {
        status.error ||= error.message;
      }
      status.running = false;
      status.current = null;
      this.enqueueAnalysis();
    }
  }

  async walk(root, { index, pending, status, nested = [] }) {
    const stack = [root];
    while (stack.length && !status.cancelled) {
      const directory = stack.pop();
      // Everything directly in this directory has the same owner.
      const owner = nested.find(source => this.contains(source, directory)) || root;
      status.current = this.path.relative(root, directory) || this.folderName(root);
      let entries;
      try {
        entries = await this.fs.readdir(directory, { withFileTypes: true });
      } catch {
        status.skipped++;
        continue;
      }
      for (const entry of entries) {
        if (status.cancelled) break;
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const filepath = this.path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirectory(entry.name, directory, this.path)) stack.push(filepath);
          continue;
        }
        if (!entry.isFile() || !extensions.has(this.path.extname(entry.name).toLowerCase())) continue;
        try {
          await this.indexFile({ filepath, filename: entry.name, root: owner, index, pending, status });
          status.count++;
        } catch {
          status.skipped++;
        }
        if (pending.size >= this.batchSize) this.flush(pending);
      }
    }
  }

  async indexFile({ filepath, filename, root, index, pending, status }) {
    const info = await this.fs.stat(filepath);
    const { id, old } = await index.identify(filepath, info);
    const unchanged = old && !old.invalid && old.path === filepath && old.mtime === info.mtimeMs && old.size === info.size;
    if (unchanged) {
      if (old.missing) this.restore(id);
      if (old.root !== root) this.moveToSource({ id, root, pending });
      return;
    }
    const previous = old ? pending.get(old.id) || this.catalogue.get(old.id) || old : undefined;
    const sample = await this.describe({ id, filepath, filename, root, info, previous });
    if (sample.invalid) status.invalid++;
    pending.set(id, sample);
    index.remember(sample);
  }

  // Zero-byte and unreadable files are kept as invalid records, never queued.
  async readProblem(filepath, info) {
    if (info.size === 0) return invalidReasons.empty;
    try {
      const handle = await this.fs.open(filepath, 'r');
      await handle.close();
      return null;
    } catch (error) {
      if (vanishedCodes.has(error.code)) throw error;
      return invalidReasons.unreadable;
    }
  }

  // Finished analysis for the same bytes: this path's previous record, or
  // any record with the same name, size and change time.
  reusableAnalysis(filename, info, previous) {
    const sameFile = previous && previous.size === info.size && previous.mtime === info.mtimeMs;
    if (sameFile && previous.analysis?.status === 'done' && previous.analysis.version === ANALYSIS_VERSION) {
      const { duration, rate, channels, bits, type } = previous;
      return { analysis: previous.analysis, peaks: previous.peaks, beats: previous.beats, metadata: { duration, rate, channels, bits }, type };
    }
    return this.catalogue.analysisForFingerprint({ filename, size: info.size, mtime: info.mtimeMs }, ANALYSIS_VERSION);
  }

  async describe({ id, filepath, filename, root, info, previous }) {
    const sample = {
      id, path: filepath, filename, ...tagsFromName(filename),
      duration: null, rate: null, channels: null, bits: null,
      size: info.size, mtime: info.mtimeMs, folder: this.folderName(root), root, demo: false,
      overrides: previous?.overrides || {}
    };
    const problem = await this.readProblem(filepath, info);
    if (problem) {
      sample.invalid = problem;
      return refreshSampleMetadata(sample);
    }
    if (/\.wave?$/i.test(filename)) {
      const wav = await wavInfo(filepath, info.size);
      Object.assign(sample, { duration: wav?.duration ?? null, rate: wav?.rate ?? null, channels: wav?.channels ?? null, bits: wav?.bits ?? null });
    }
    const reuse = this.reusableAnalysis(filename, info, previous);
    if (reuse) {
      for (const [field, value] of Object.entries(reuse.metadata)) if (sample[field] == null && value != null) sample[field] = value;
      sample.analysis = reuse.analysis;
      if (reuse.peaks) sample.peaks = reuse.peaks;
      if (reuse.beats) sample.beats = reuse.beats;
      // Refreshing below drops the analysis if the drum rule now differs.
      if (reuse.type) sample.type = reuse.type;
    }
    return refreshSampleMetadata(sample);
  }

  // Hands an unchanged file to the source that now owns it, keeping its
  // analysis and corrections. Its sound type may change, because type is
  // inferred from folder names inside the source only.
  moveToSource({ id, root, pending }) {
    const sample = pending.get(id) || this.catalogue.get(id);
    if (!sample) return;
    sample.root = root;
    sample.folder = this.folderName(root);
    pending.set(id, refreshSampleMetadata(sample));
  }

  restore(id) {
    this.catalogue.update(id, sample => {
      if (sample.analysis?.status === 'error') delete sample.analysis;
      delete sample.missing;
      refreshSampleMetadata(sample);
    });
  }

  // Writes indexed records, keeping corrections made while the scan ran.
  flush(pending) {
    if (!pending.size) return;
    const samples = [...pending.values()];
    pending.clear();
    this.catalogue.transaction(() => {
      for (const sample of samples) {
        const current = this.catalogue.get(sample.id);
        if (current && !sameOverrides(current.overrides, sample.overrides)) {
          sample.overrides = current.overrides || {};
          Object.assign(sample, effectiveMetadata(sample));
        }
        this.catalogue.put(sample);
      }
    });
  }

  // Updates missing flags for one root, or the whole catalogue.
  async checkMissing({ root } = {}) {
    const records = this.catalogue.fileRecords(root === undefined ? {} : { root });
    const wasMissing = new Set(records.filter(record => record.missing).map(record => record.id));
    const result = await checkMissingSamples(records, { statFile: this.fs.stat });
    const newlyMissing = result.missingIds.filter(id => !wasMissing.has(id));
    this.catalogue.updateMany(newlyMissing, sample => {
      sample.missing = true;
    });
    this.catalogue.updateMany(result.restoredIds, sample => {
      if (sample.analysis?.status === 'error') delete sample.analysis;
      delete sample.missing;
    });
    return result;
  }

  // Removes missing files nothing refers to. Offline roots are never pruned.
  async cleanup() {
    if (this.busy) throw Object.assign(new Error('Wait for the current library scan or cleanup to finish.'), { status: 409 });
    this.cleaning = true;
    try {
      const result = await this.checkMissing();
      // Read references after the filesystem checks so concurrent saves are protected.
      const referenced = this.catalogue.referencedIds();
      const removable = result.missingIds.filter(id => !referenced.has(id));
      this.catalogue.remove(removable);
      this.enqueueAnalysis();
      return { removed: removable.length, missing: result.missing - removable.length, unavailableRoots: result.unavailableRoots };
    } finally {
      this.cleaning = false;
    }
  }

  enqueueAnalysis() {
    this.analysis?.enqueue(this.catalogue.pendingAnalysisIds(ANALYSIS_VERSION).map(id => ({ id })));
  }
}
