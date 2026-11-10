import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

const vanishedCodes = new Set(['ENOENT', 'ENOTDIR']);

// A sample's ID is a hash of its path. `salt` separates two paths that would
// otherwise collide.
function pathId(filepath, salt = 0) {
  const input = salt ? `${filepath}\0${salt}` : filepath;
  return createHash('sha256').update(input).digest('hex').slice(0, 20);
}

// Finds the catalogue record for a file met during a scan, so its ID, and
// with it every gem, set and workspace layer that points at it, survives a
// rescan. That includes records stored under a different spelling of the
// path's case, which older versions wrote on Windows.
export class SampleIndex {
  constructor(samples, { platform = process.platform, statFile = stat } = {}) {
    this.platform = platform;
    this.statFile = statFile;
    this.byId = new Map();
    this.byPath = new Map();
    // Lower-cased path to every record whose path differs from it only by case.
    this.folded = new Map();
    for (const sample of samples) this.remember(sample);
  }

  remember(sample) {
    const previous = this.byId.get(sample.id);
    if (previous) {
      this.byPath.delete(previous.path);
      this.folded.get(previous.path.toLowerCase())?.delete(previous);
    }
    this.byId.set(sample.id, sample);
    this.byPath.set(sample.path, sample);
    const key = sample.path.toLowerCase();
    if (!this.folded.has(key)) this.folded.set(key, new Set());
    this.folded.get(key).add(sample);
  }

  // On Windows two spellings of a path can name one file. The record that
  // names the same file on disk (same volume and file number) is the match.
  async sameFileUnderAnotherCase(filepath, info) {
    for (const candidate of this.folded.get(filepath.toLowerCase()) || []) {
      try {
        const previous = await this.statFile(candidate.path);
        if (previous.dev === info.dev && previous.ino === info.ino) return candidate;
      } catch (error) {
        if (!vanishedCodes.has(error.code)) throw error;
      }
    }
    return undefined;
  }

  // The existing record and ID for a file, or a fresh ID for a new one.
  async identify(filepath, info) {
    let old = this.byPath.get(filepath);
    if (!old && this.platform === 'win32' && info?.ino) old = await this.sameFileUnderAnotherCase(filepath, info);
    if (old) return { id: old.id, old };
    let salt = 0;
    let id = pathId(filepath);
    while (this.byId.has(id)) id = pathId(filepath, ++salt);
    return { id, old: undefined };
  }
}
