import { open } from 'node:fs/promises';
import path from 'node:path';

export const extensions = new Set(['.wav', '.wave', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.aif', '.aiff', '.caf']);

// ---- Reading a filename ------------------------------------------------------

// Role words for each sound type, checked in this order. They match whole
// words only, so "hat" does not fire on "What" nor "key" on "Monkey".
const typeWords = [
  ['Drums', /\b(drums?|breaks?|breakbeat|kicks?|snares?|hi\s?hats?|hats?|percs?|percussion|claps?|rims?|rimshots?|shakers?|stomps?|crash|rides?|cymbals?|toms?|tambourines?|congas?|bongos?)\b/i],
  ['Bass', /\b(bass|sub|subs|808s?)\b/i],
  ['Texture', /\b(pads?|textures?|ambient|ambience|field|noise|atmosphere|atmos|fx|effects?|rain|impacts?|risers?)\b/i],
  ['Vocal', /\b(vocals?|voice|voices|vox|chants?)\b/i],
  ['Melodic', /\b(keys?|pianos?|guitars?|chords?|synths?|leads?|plucks?|rhodes|melody|melodies|melodic|arps?|arpeggios?|bells?|harps?|flutes?|strings?|violins?|cellos?|organs?|mellotron|brass|sax(?:ophone)?|trumpets?)\b/i]
];

const spaced = name => name.replace(/[_-]/g, ' ');

export function classifyType(name) {
  const words = spaced(name);
  const match = typeWords.find(([, pattern]) => pattern.test(words));
  return match ? match[0] : 'Other';
}

// A two- or three-digit number that is not a bit depth, a sample rate, a bar
// count or part of a decimal.
function looksLikeTempo(words, match) {
  const before = words.slice(0, match.index);
  const after = words.slice(match.index + match[1].length);
  const decimal = /\d\.$/.test(before) || /^\.\d/.test(after);
  const otherUnit = /^\s*(?:bits?|k?hz|samples?|channels?|bars?)\b/i.test(after);
  return !decimal && !otherUnit;
}

// The tempo a filename states. `explicit` is true when the number is followed
// by "bpm"; a bare number is only a hint. Two different candidates cancel out.
export function tempoHintFromName(filename) {
  const words = spaced(path.parse(filename).name);
  const explicit = [...words.matchAll(/\b(\d{2,3})\s*bpm\b/gi)];
  const bare = () => [...words.matchAll(/\b(\d{2,3})\b/g)].filter(match => looksLikeTempo(words, match));
  const matches = explicit.length ? explicit : bare();
  const values = new Set(matches.map(match => Number(match[1])).filter(value => value >= 40 && value <= 240));
  const bpm = values.size === 1 ? [...values][0] : null;
  return { bpm, explicit: explicit.length > 0 && bpm !== null };
}

// A key such as "Amin", "F# major" or "Dm", standing as its own word.
function keyFromWords(words) {
  const match = words.match(/(?:^|\s)([A-G])([#b]?)[\s]?(maj(?:or)?|min(?:or)?|m)(?=\s|$)/i);
  if (!match) return null;
  const minor = /^m(?!aj)/i.test(match[3]);
  return `${match[1].toUpperCase()}${match[2]}${minor ? ' min' : ' maj'}`;
}

export function tagsFromName(filename) {
  const name = path.parse(filename).name;
  const { bpm } = tempoHintFromName(filename);
  return { name, bpm, key: keyFromWords(spaced(name)), type: classifyType(name) };
}

// ---- WAV headers -------------------------------------------------------------

function readFormatChunk(buffer, offset) {
  return {
    format: buffer.readUInt16LE(offset + 8),
    channels: buffer.readUInt16LE(offset + 10),
    rate: buffer.readUInt32LE(offset + 12),
    byteRate: buffer.readUInt32LE(offset + 16),
    blockAlign: buffer.readUInt16LE(offset + 20),
    bits: buffer.readUInt16LE(offset + 22)
  };
}

// Walks the RIFF chunks to the format and data chunks. Returns null for
// anything that is not a WAV with both. `fileSize` is the whole file's size
// when `buffer` holds only its beginning.
export function parseWavHeader(buffer, fileSize = buffer.length) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = {};
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 16 && offset + 24 <= buffer.length) fmt = readFormatChunk(buffer, offset);
    if (id === 'data' && fmt.rate && fmt.byteRate && fmt.channels && fmt.blockAlign) {
      // A header may claim more audio than the file holds.
      const dataSize = Math.min(size, Math.max(0, fileSize - offset - 8));
      const { format, channels, rate, bits, blockAlign } = fmt;
      return { format, channels, rate, bits, blockAlign, dataOffset: offset + 8, dataSize, duration: dataSize / fmt.byteRate };
    }
    // Chunks are padded to an even length.
    offset += 8 + size + (size % 2);
  }
  return null;
}

const headerReadBytes = 262144;

export async function wavInfo(filename, size) {
  const file = await open(filename, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, headerReadBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return parseWavHeader(buffer.subarray(0, bytesRead), size);
  } finally {
    await file.close();
  }
}

// ---- Demo collection ---------------------------------------------------------
// Original synthesized audition material. No third-party recordings or assets.
// The arithmetic below decides the exact bytes of the demo files, so it is
// kept as it was written; a test pins the result.

const demoRate = 22050;
const demoPeakBins = 160;
const bassNotes = [55, 55, 65.406, 49];
const melodyNotes = [220, 261.626, 329.628, 391.995];

function writeMonoWavHeader(buffer, rate, dataBytes) {
  buffer.write('RIFF');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); // Size of the format chunk.
  buffer.writeUInt16LE(1, 20); // PCM.
  buffer.writeUInt16LE(1, 22); // One channel.
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28); // Bytes per second.
  buffer.writeUInt16LE(2, 32); // Bytes per frame.
  buffer.writeUInt16LE(16, 34); // Bits per sample.
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
}

// Kick on even beats (variant 1 adds one before the bar line), noise snare on
// odd beats, and noise hats on eighths or, for variant 2, sixteenths.
function drumValue({ beat, phase, beatNumber, noise, variant, bpm }) {
  const k = phase * 60 / bpm;
  let value = 0;
  if (beatNumber % 2 === 0 || (variant === 1 && beatNumber % 4 === 3)) {
    value += Math.sin(2 * Math.PI * (48 * k + 9 * (1 - Math.exp(-35 * k)))) * Math.exp(-12 * k) * .65;
  }
  if (beatNumber % 2 === 1) value += noise * Math.exp(-20 * k) * .32;
  const h = (beat * (variant === 2 ? 4 : 2) % 1) * 60 / bpm / 2;
  value += noise * Math.exp(-95 * h) * .14;
  return value;
}

// One plucked note per beat, changing every bar.
function bassValue({ t, beat, phase, variant }) {
  const f = bassNotes[(Math.floor(beat / 4) + variant) % 4];
  const env = Math.min(1, phase * 65) * Math.exp(-2.7 * phase);
  return (Math.sin(t * f * 2 * Math.PI) + .22 * Math.sin(t * f * 4 * Math.PI)) * env * .48;
}

// A plucked note every two beats over a quiet drone.
function melodyValue({ t, beat, variant }) {
  const p = (beat / 2) % 1;
  const env = Math.min(1, p * 90) * Math.exp(-4 * p);
  const f = melodyNotes[(Math.floor(beat / 2) + variant) % 4];
  let value = (Math.sin(t * f * 2 * Math.PI) + .27 * Math.sin(t * f * 6 * Math.PI)) * env * .3;
  value += Math.sin(t * 110 * 2 * Math.PI) * .045;
  return value;
}

// Smoothed noise and two soft tones that swell and fade over the whole loop.
function textureValue({ t, smooth, variant, duration }) {
  const env = Math.sin(Math.PI * t / duration) ** 2;
  return (smooth * .5 + Math.sin(t * (220 + variant * .3) * 2 * Math.PI) * .055 + Math.sin(t * 329.628 * 2 * Math.PI) * .04) * env;
}

// A four-bar mono loop of the given type as WAV bytes, with its duration and
// waveform peaks.
export function makeDemo(type, variant, bpm = 92) {
  const rate = demoRate;
  const duration = 16 * 60 / bpm;
  const length = Math.round(duration * rate);
  const buffer = Buffer.alloc(44 + length * 2);
  writeMonoWavHeader(buffer, rate, length * 2);

  let seed = 1337 + variant;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 2147483648 - 1;
  };
  let smooth = 0;
  const peaks = Array(demoPeakBins).fill(0);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const beat = t * bpm / 60;
    const phase = beat % 1;
    const beatNumber = Math.floor(beat);
    // Drawn for every frame, whatever the type, so each type's noise is repeatable.
    const noise = random();
    let value;
    if (type === 'Drums') value = drumValue({ beat, phase, beatNumber, noise, variant, bpm });
    else if (type === 'Bass') value = bassValue({ t, beat, phase, variant });
    else if (type === 'Melodic') value = melodyValue({ t, beat, variant });
    else {
      smooth = .985 * smooth + .015 * noise;
      value = textureValue({ t, smooth, variant, duration });
    }
    // Short fades at both ends.
    value *= Math.min(1, i / 120, (length - 1 - i) / 220);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
    const bin = Math.min(demoPeakBins - 1, Math.floor(i / length * demoPeakBins));
    peaks[bin] = Math.max(peaks[bin], Math.abs(value));
  }
  return { buffer, duration, peaks };
}
