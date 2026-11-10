import path from 'node:path';
import { tagsFromName, classifyType, tempoHintFromName } from './audio.mjs';
import { tempoFromLength } from './loop-tempo.mjs';

// A sample's type, tempo and key, and where each came from.
//
// Tempo and key are chosen in this order: a correction the user made, a
// label in the filename, the audio analysis, and for tempo a short loop's
// length, then an unlabelled number in the filename. When a filename label
// and the analysis disagree the label is kept and the disagreement is
// recorded as a conflict for review.

const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchClasses = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Spells a key with sharps ("Eb maj" becomes "D# maj"). Anything that is
// not a key is returned as it was, or null.
export function normalizeKey(value) {
  const match = /^([A-G])([#b]?) (min|maj)$/.exec(value || '');
  if (!match) return value ?? null;
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  const pitch = (pitchClasses[match[1]] + accidental + 12) % 12;
  return `${notes[pitch]} ${match[3]}`;
}

// The major scale a key's notes belong to, as a pitch class.
function scaleRoot(key) {
  const [note, mode] = key.split(' ');
  return (notes.indexOf(note) + (mode === 'min' ? 3 : 0)) % 12;
}

// A major key and the minor key that shares its notes.
function relativeKeys(a, b) {
  const sameMode = a.split(' ')[1] === b.split(' ')[1];
  return !sameMode && scaleRoot(a) === scaleRoot(b);
}

// The folder names between a sample and its source, nearest first, with the
// source folder itself last. Folders outside the source the user indexed say
// nothing about the sample, so they are never read.
function foldersInsideSource(sample) {
  const parent = path.dirname(sample.path);
  const root = sample.root || parent;
  const relative = path.relative(root, parent);
  const outside = path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  if (outside) return [];
  return [path.basename(root), ...relative.split(path.sep).filter(Boolean)].reverse();
}

// Sound type from the filename, then from the nearest folder that names one.
export function classification(sample) {
  if (sample.demo) return { type: sample.type, typeSource: 'demo', typeHint: 'Sift demo collection' };
  const fromName = tagsFromName(sample.filename).type;
  if (fromName !== 'Other') return { type: fromName, typeSource: 'filename', typeHint: sample.filename };
  if (sample.path) {
    for (const folder of foldersInsideSource(sample)) {
      const type = classifyType(folder);
      if (type !== 'Other') return { type, typeSource: 'folder', typeHint: folder };
    }
  }
  return { type: 'Other', typeSource: 'unknown', typeHint: null };
}

function analysisEstimate(sample, field) {
  if (sample.analysis?.status !== 'done') return null;
  return field === 'key' ? normalizeKey(sample.analysis.key) : sample.analysis[field];
}

// The value in use for one field and its source.
function chooseValue(sample, field, { label, labelled, estimate, lengthBpm }) {
  if (Object.hasOwn(sample.overrides || {}, field)) {
    const value = field === 'key' ? normalizeKey(sample.overrides[field]) : sample.overrides[field];
    return { value, source: 'manual' };
  }
  if (sample.demo) {
    // The demo loops are all 92 BPM in A minor; drums have no key.
    const value = field === 'bpm' ? 92 : sample.type === 'Drums' ? null : 'A min';
    return { value, source: value === null ? 'unknown' : 'demo' };
  }
  if (labelled && label != null) return { value: label, source: 'filename' };
  if (estimate != null) return { value: estimate, source: 'analysis' };
  if (field === 'bpm' && lengthBpm != null) return { value: lengthBpm, source: 'length' };
  if (label == null) return { value: label, source: 'unknown' };
  // A bare number in a filename is only a hint at the tempo.
  return { value: label, source: field === 'bpm' ? 'filename-hint' : 'filename' };
}

function tempoDiffers(label, estimate) {
  return Math.abs(label - estimate) > Math.max(2, label * .015);
}

function conflictKind(field, label, estimate) {
  if (field === 'key') return relativeKeys(label, estimate) ? 'relative-key' : 'different';
  const double = Math.abs(estimate / label - 2) < .04;
  const half = Math.abs(estimate / label - .5) < .02;
  return double || half ? 'half-double' : 'different';
}

// A filename label and the analysis that disagree, or null.
function conflictFor(field, { label, estimate, source }) {
  const differs = field === 'bpm' ? tempoDiffers(label, estimate) : label !== estimate;
  if (!differs) return null;
  return { label, estimate, kind: conflictKind(field, label, estimate), resolved: source === 'manual' };
}

export function effectiveMetadata(sample) {
  const tags = tagsFromName(sample.filename);
  const explicitBpm = tempoHintFromName(sample.filename).explicit;
  const labels = { bpm: tags.bpm, key: normalizeKey(tags.key), bpmExplicit: explicitBpm };
  // A short loop's tempo read from its length; an unlabelled filename number picks the octave.
  const lengthBpm = sample.demo || explicitBpm ? null : tempoFromLength(sample, tags.bpm);
  const result = {};
  const conflicts = {};
  for (const field of ['bpm', 'key']) {
    const label = labels[field];
    const estimate = analysisEstimate(sample, field);
    // A key in a filename is always a label; a tempo only when it says "bpm".
    const labelled = field === 'key' || explicitBpm;
    const { value, source } = chooseValue(sample, field, { label, labelled, estimate, lengthBpm });
    result[field] = value;
    result[`${field}Source`] = source;
    if (!sample.demo && labelled && label != null && estimate != null) {
      const conflict = conflictFor(field, { label, estimate, source });
      if (conflict) conflicts[field] = conflict;
    }
  }
  return { ...result, labels, conflicts };
}

export function refreshSampleMetadata(sample) {
  const previousType = sample.type;
  Object.assign(sample, classification(sample));
  // Drum classification suppresses key estimation; re-run only when that rule changes.
  const drumRuleChanged = previousType !== sample.type && (previousType === 'Drums' || sample.type === 'Drums');
  if (sample.analysis && drumRuleChanged) delete sample.analysis;
  Object.assign(sample, effectiveMetadata(sample));
  return sample;
}
