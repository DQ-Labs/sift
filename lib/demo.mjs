import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeDemo } from './audio.mjs';
import { refreshSampleMetadata } from './metadata.mjs';
import { SampleIndex } from './sample-index.mjs';

const demoNames = {
  Drums: ['Dust break', 'Loose pocket', 'Midnight hats'],
  Bass: ['Round sub', 'Low current', 'Warm foundation'],
  Melodic: ['After hours keys', 'Glass arpeggio', 'Faded chords'],
  Texture: ['Tape atmosphere', 'Soft focus', 'Room tone']
};

function demoEntries(directory) {
  const entries = [];
  for (const [type, names] of Object.entries(demoNames)) {
    names.forEach((name, variant) => {
      const filename = `${name.replaceAll(' ', '_')}_92bpm${type === 'Drums' ? '' : '_Amin'}.wav`;
      entries.push({ type, variant, name, filename, filepath: path.join(directory, filename) });
    });
  }
  return entries;
}

// Writes the synthesized demo collection on first run. Returns how many
// demo samples were added.
export async function seedDemoCollection(catalogue, directory) {
  await mkdir(directory, { recursive: true });
  const entries = demoEntries(directory);
  const known = catalogue.idsForPaths(entries.map(entry => entry.filepath));
  if (known.size === entries.length) return 0;
  const index = new SampleIndex(catalogue.fileRecords());
  const added = [];
  for (const entry of entries) {
    if (known.has(entry.filepath)) continue;
    const { id } = await index.identify(entry.filepath);
    const demo = makeDemo(entry.type, entry.variant);
    await writeFile(entry.filepath, demo.buffer);
    const sample = {
      id, path: entry.filepath, filename: entry.filename, name: entry.name, type: entry.type,
      bpm: 92, key: entry.type === 'Drums' ? null : 'A min',
      duration: demo.duration, rate: 22050, channels: 1, bits: 16, size: demo.buffer.length,
      peaks: demo.peaks, folder: 'Sift demo collection', demo: true
    };
    refreshSampleMetadata(sample);
    index.remember(sample);
    added.push(sample);
  }
  catalogue.putMany(added);
  return added.length;
}
