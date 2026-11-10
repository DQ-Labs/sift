import { mkdir, readFile, writeFile, rename, lstat, realpath, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeWorkspace } from '../public/workspace.js';
import { audibleTracks } from '../public/export-audio.js';
import { sessionFrames } from '../public/timing.js';
import { pitchPlan } from '../public/harmony.js';
import { parseWavHeader } from './audio.mjs';

// Stem handoff: the browser renders each layer as a WAV, uploads it into a
// batch folder under the data directory, and the finished batch (stems, a
// README, a ZIP) is what gets dragged or copied into the DAW.
//
// Batch folders are named by random UUID. Every path is checked to be a real
// folder or file directly inside the export directory before it is read,
// written or removed, so a link planted there cannot redirect Sift.

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stemNamePattern = /^\d{2}-[a-zA-Z0-9 .-]+\.wav$/;
const stemRate = 44100;
const stemBits = 16;
// Two channels of 16-bit samples.
const bytesPerFrame = 4;
const wavHeaderBytes = 44;
const longestCycleFrames = sessionFrames(40, stemRate);

export const maxStemBytes = wavHeaderBytes + longestCycleFrames * bytesPerFrame;
export const abandonedHandoffAge = 7 * 24 * 60 * 60 * 1000;

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const isGone = error => error.code === 'ENOENT';

// A name safe to use inside a stem filename.
function slug(value) {
  const cleaned = String(value || 'Untitled')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 65);
  return cleaned || 'Untitled';
}

// A stem must be exactly one four-bar cycle of stereo 44.1 kHz / 16-bit PCM.
export function checkWav(bytes, frames) {
  const header = parseWavHeader(bytes);
  const valid = header
    && header.format === 1
    && header.channels === 2
    && header.rate === stemRate
    && header.bits === stemBits
    && header.blockAlign === bytesPerFrame
    && header.dataSize === frames * bytesPerFrame
    && header.dataOffset + header.dataSize === bytes.length;
  if (!valid) throw fail('Use a stereo 44.1 kHz / 16-bit WAV with exactly four session bars.');
}

function outputKeyLabel(pitch, sample) {
  if (pitch.outputKey) return pitch.outputKey.replace('#', 'sharp').replace(' ', '-');
  return sample.type === 'Drums' ? 'Unpitched' : 'Key-unknown';
}

// The manifest entry for one layer's stem.
function stemEntry({ track, index }, samples, workspace) {
  const sample = samples.find(candidate => candidate.id === track.id);
  if (!sample || sample.missing) throw fail('A selected sample is unavailable. Reconnect its drive before exporting.');
  const pitch = pitchPlan(sample, workspace.key);
  const number = String(index + 1).padStart(2, '0');
  const name = `${number}-${slug(track.type)}-${workspace.tempo}bpm-${outputKeyLabel(pitch, sample)}-${slug(sample.name || sample.filename)}.wav`;
  return {
    index,
    name,
    type: track.type,
    source: sample.filename,
    sourceBpm: sample.bpm,
    sourceKey: sample.key,
    outputKey: pitch.outputKey,
    semitones: pitch.semitones,
    volume: track.volume,
    timing: track.timing
  };
}

function validStemEntry(file) {
  return Number.isInteger(file.index)
    && file.index >= 0
    && file.index <= 3
    && typeof file.name === 'string'
    && path.basename(file.name) === file.name
    && stemNamePattern.test(file.name);
}

function readmeText(batch) {
  const layers = batch.includeAll ? 'All loaded layers were included, ignoring mute/solo.' : 'Mute and solo choices were respected.';
  return [
    `Sift handoff — ${batch.name}`,
    `${batch.tempo} BPM | ${batch.key || 'Original keys'} | 4 bars in 4/4`,
    `Stereo WAV, 44.1 kHz / 16-bit. All files start together and have exactly ${batch.frames} frames.`,
    '',
    `FL Studio: set your project to ${batch.tempo} BPM, then drop the WAVs into the Playlist and align their left edges at the same bar. Tempo/key processing and source starts/repeats are already rendered. Keep the imported audio at its rendered speed.`,
    '',
    `Files include layer levels and one shared master attenuation, so their sum preserves the exported mix balance. ${layers}`,
    'Start positions are the first detected beat, the first sound or a manual offset; Sift does not find the downbeat, so bar 1 remains your choice.',
    ''
  ].join('\n');
}

async function isPlainFile(filename) {
  const info = await lstat(filename);
  return info.isFile() && !info.isSymbolicLink();
}

export class HandoffStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    // Batches being finalized, uploaded to, or removed. A batch does one of
    // these at a time.
    this.jobs = new Map();
    this.uploading = new Set();
    this.removing = new Set();
  }

  batchPath(id) {
    if (!idPattern.test(id)) throw fail('Invalid handoff ID.');
    return path.join(this.directory, id);
  }

  isBusy(id) {
    return this.jobs.has(id) || this.uploading.has(id) || this.removing.has(id);
  }

  // Removes unfinished batches nothing has touched for a week. Completed
  // batches can be referenced by DAW projects and are never removed.
  async pruneAbandoned() {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isGone(error)) return { removed: 0 };
      throw error;
    }
    const root = await realpath(this.directory);
    const cutoff = Date.now() - abandonedHandoffAge;
    let removed = 0;
    for (const entry of entries) {
      const id = entry.name;
      if (!idPattern.test(id) || !entry.isDirectory() || entry.isSymbolicLink() || this.isBusy(id)) continue;
      this.removing.add(id);
      try {
        if (await this.removeIfAbandoned(id, root, cutoff)) removed++;
      } catch (error) {
        if (!isGone(error)) throw error;
      } finally {
        this.removing.delete(id);
      }
    }
    return { removed };
  }

  // Deletes one batch folder when it is unfinished, old, and holds nothing
  // but old plain files. Returns whether it was deleted.
  async removeIfAbandoned(id, root, cutoff) {
    const directory = this.batchPath(id);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (path.dirname(await realpath(directory)) !== root) return false;
    const names = await readdir(directory);
    if (names.includes('ready.json') || info.mtimeMs >= cutoff) return false;
    for (const name of names) {
      const file = await lstat(path.join(directory, name));
      if (!file.isFile() || file.isSymbolicLink() || file.mtimeMs >= cutoff) return false;
    }
    // Resolve and check the exact target again before recursive removal.
    const target = await realpath(directory);
    if (path.dirname(target) !== root || (await lstat(directory)).isSymbolicLink()) return false;
    await rm(target, { recursive: true });
    return true;
  }

  // Starts a batch: validates the request and writes its manifest.
  async create(input, samples) {
    const workspace = normalizeWorkspace(input?.workspace, { strict: true });
    if (input.includeAll !== undefined && typeof input.includeAll !== 'boolean') throw fail('Choose whether to include all layers.');
    const scale = input.masterScale;
    if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0 || scale > 1)) throw fail('Invalid master attenuation.');
    const includeAll = input.includeAll === true;
    const selected = audibleTracks(workspace.tracks, includeAll);
    if (!selected.length) throw fail('No audible layers. Unmute a layer or include all loaded layers.');
    const files = selected.map(layer => stemEntry(layer, samples, workspace));

    const id = randomUUID();
    const directory = this.batchPath(id);
    await mkdir(directory, { recursive: true });
    const batch = {
      id,
      name: workspace.name,
      created: new Date().toISOString(),
      tempo: workspace.tempo,
      key: workspace.key,
      sync: workspace.sync,
      bars: 4,
      meter: '4/4',
      rate: stemRate,
      bits: stemBits,
      frames: sessionFrames(workspace.tempo, stemRate),
      masterScale: scale ?? 1,
      includeAll,
      files
    };
    await writeFile(path.join(directory, 'session.json'), JSON.stringify(batch, null, 2));
    return { ...batch, ready: false };
  }

  // Reads and validates a batch's manifest.
  async read(id) {
    const directory = this.batchPath(id);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Invalid export folder.');
    if (path.dirname(await realpath(directory)) !== await realpath(this.directory)) throw fail('Invalid export folder.');
    const batch = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
    const validManifest = batch.id === id
      && Array.isArray(batch.files)
      && batch.files.length <= 4
      && Number.isInteger(batch.frames)
      && batch.frames >= 1
      && batch.frames <= longestCycleFrames;
    if (!validManifest) throw fail('Invalid handoff manifest.');
    if (!batch.files.every(validStemEntry)) throw fail('Invalid stem filename.');
    return batch;
  }

  async isFinished(id) {
    try {
      await readFile(path.join(this.batchPath(id), 'ready.json'));
      return true;
    } catch (error) {
      if (isGone(error)) return false;
      throw error;
    }
  }

  // Stores one rendered stem. A finished batch can no longer be changed.
  async upload(id, index, bytes) {
    if (this.isBusy(id)) throw fail('This handoff is busy. Wait for its current operation.');
    this.uploading.add(id);
    try {
      if (await this.isFinished(id)) throw fail('Prepared handoffs are immutable. Prepare a new handoff instead.');
      if (bytes.length > maxStemBytes) throw fail('Stem is too large.');
      const batch = await this.read(id);
      const file = batch.files.find(candidate => candidate.index === index);
      if (!file) throw fail('Unknown stem.');
      checkWav(bytes, batch.frames);
      const destination = path.join(this.batchPath(id), file.name);
      await writeFile(`${destination}.tmp`, bytes);
      await rename(`${destination}.tmp`, destination);
      return { ok: true };
    } finally {
      this.uploading.delete(id);
    }
  }

  // Seals a batch once every stem is uploaded. Calls made while it is being
  // sealed share the same result.
  async finish(id) {
    if (this.removing.has(id)) throw fail('This handoff is being cleaned up. Prepare a new snapshot.');
    if (this.jobs.has(id)) return this.jobs.get(id);
    if (this.uploading.has(id)) throw fail('Wait for the current stem upload.');
    const job = this.finalize(id);
    this.jobs.set(id, job);
    try {
      return await job;
    } finally {
      this.jobs.delete(id);
    }
  }

  // Checks every stem again, then writes the README, the ZIP and the marker
  // that makes the batch read-only.
  async finalize(id) {
    const batch = await this.read(id);
    const directory = this.batchPath(id);
    const entries = [];
    for (const file of batch.files) {
      const filename = path.join(directory, file.name);
      if (!(await isPlainFile(filename))) throw fail('Invalid stem file.');
      const bytes = await readFile(filename);
      checkWav(bytes, batch.frames);
      entries.push({ name: file.name, bytes });
    }
    const notes = readmeText(batch);
    entries.push({ name: 'README.txt', bytes: Buffer.from(notes) });
    entries.push({ name: 'session.json', bytes: Buffer.from(JSON.stringify(batch, null, 2)) });
    await writeFile(path.join(directory, 'README.txt'), notes);
    const archive = path.join(directory, 'Stems.zip');
    await writeFile(`${archive}.tmp`, storeZip(entries));
    await rename(`${archive}.tmp`, archive);
    await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ ready: true }));
    return { ...batch, ready: true };
  }

  // The manifest of a finished batch.
  async ready(id) {
    const batch = await this.read(id);
    if (!(await this.isFinished(id))) throw fail('This handoff has not been prepared yet.', 404);
    return { ...batch, ready: true };
  }

  // The path of a stem or the ZIP inside a finished batch.
  async file(id, name) {
    const batch = await this.ready(id);
    const known = name === 'Stems.zip' || batch.files.some(file => file.name === name);
    if (!known) throw fail('Unknown handoff file.');
    const file = path.join(this.batchPath(id), name);
    if (!(await isPlainFile(file))) throw fail('Invalid handoff file.');
    return file;
  }
}

// ---- ZIP -------------------------------------------------------------------
// Entries are stored, not compressed: no extra dependency, and the audio
// stays bit-for-bit what was uploaded.

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const zipVersion = 20;
// Bit 11: file names are UTF-8.
const zipUtf8Flag = 0x800;
// A fixed date field (1980-01-01); the entries carry no real timestamps.
const zipDate = 33;

function localHeader(filename, crc, size) {
  const header = Buffer.alloc(30 + filename.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(zipVersion, 4);
  header.writeUInt16LE(zipUtf8Flag, 6);
  header.writeUInt16LE(zipDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(filename.length, 26);
  filename.copy(header, 30);
  return header;
}

function centralHeader(filename, crc, size, offset) {
  const header = Buffer.alloc(46 + filename.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(zipVersion, 4);
  header.writeUInt16LE(zipVersion, 6);
  header.writeUInt16LE(zipUtf8Flag, 8);
  header.writeUInt16LE(zipDate, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(filename.length, 28);
  header.writeUInt32LE(offset, 42);
  filename.copy(header, 46);
  return header;
}

function endOfCentralDirectory(count, directorySize, directoryOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return end;
}

export function storeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const filename = Buffer.from(name);
    const crc = crc32(bytes);
    const header = localHeader(filename, crc, bytes.length);
    local.push(header, bytes);
    central.push(centralHeader(filename, crc, bytes.length, offset));
    offset += header.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([...local, directory, endOfCentralDirectory(entries.length, directory.length, offset)]);
}
