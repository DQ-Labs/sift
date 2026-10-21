import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';

const pathId = (filepath, salt = 0) => createHash('sha256').update(salt ? `${filepath}\0${salt}` : filepath).digest('hex').slice(0, 20);

// Preserve catalogue IDs, including old case-folded IDs referenced by gems/sets.
export class SampleIndex {
  constructor(samples, { platform = process.platform, statFile = stat } = {}) {
    this.platform = platform; this.statFile = statFile;
    this.byId = new Map(); this.byPath = new Map(); this.folded = new Map();
    for (const sample of samples) this.remember(sample);
  }
  remember(sample) {
    const previous = this.byId.get(sample.id);
    if (previous) {
      this.byPath.delete(previous.path);
      this.folded.get(previous.path.toLowerCase())?.delete(previous);
    }
    this.byId.set(sample.id, sample); this.byPath.set(sample.path, sample);
    const key = sample.path.toLowerCase();
    if (!this.folded.has(key)) this.folded.set(key, new Set());
    this.folded.get(key).add(sample);
  }
  async identify(filepath, info) {
    let old = this.byPath.get(filepath);
    if (!old && this.platform === 'win32' && info?.ino) {
      for (const candidate of this.folded.get(filepath.toLowerCase()) || []) {
        try {
          const previous = await this.statFile(candidate.path);
          if (previous.dev === info.dev && previous.ino === info.ino) { old = candidate; break; }
        } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      }
    }
    if (old) return { id: old.id, old };
    let salt = 0, id = pathId(filepath);
    while (this.byId.has(id)) id = pathId(filepath, ++salt);
    return { id, old: undefined };
  }
}
