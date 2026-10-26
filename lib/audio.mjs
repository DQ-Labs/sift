import { open } from 'node:fs/promises';
import path from 'node:path';

export const extensions = new Set(['.wav', '.wave', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.aif', '.aiff', '.caf']);
export function classifyType(name) {
  const words = name.replace(/[_-]/g, ' ');
  // Match role words, not substrings such as "hat" in "What" or "key" in "Monkey".
  return /\b(drums?|breaks?|breakbeat|kicks?|snares?|hi\s?hats?|hats?|percs?|percussion|claps?|rims?|rimshots?|shakers?|stomps?|crash|rides?|cymbals?|toms?|tambourines?|congas?|bongos?)\b/i.test(words) ? 'Drums'
    : /\b(bass|sub|subs|808s?)\b/i.test(words) ? 'Bass'
    : /\b(pads?|textures?|ambient|ambience|field|noise|atmosphere|atmos|fx|effects?|rain|impacts?|risers?)\b/i.test(words) ? 'Texture'
    : /\b(vocals?|voice|voices|vox|chants?)\b/i.test(words) ? 'Vocal'
    : /\b(keys?|pianos?|guitars?|chords?|synths?|leads?|plucks?|rhodes|melody|melodies|melodic|arps?|arpeggios?|bells?|harps?|flutes?|strings?|violins?|cellos?|organs?|mellotron|brass|sax(?:ophone)?|trumpets?)\b/i.test(words) ? 'Melodic' : 'Other';
}
export function tempoHintFromName(filename) {
  const words = path.parse(filename).name.replace(/[_-]/g, ' ');
  const explicit = [...words.matchAll(/\b(\d{2,3})\s*bpm\b/gi)];
  const matches = explicit.length ? explicit : [...words.matchAll(/\b(\d{2,3})\b/g)].filter(match => {
    const before = words.slice(0, match.index), after = words.slice(match.index + match[1].length);
    // Avoid bit depth, sample rates, bar counts and decimal fragments.
    return !/\d\.$/.test(before) && !/^\.\d/.test(after) && !/^\s*(?:bits?|k?hz|samples?|channels?|bars?)\b/i.test(after);
  });
  const values = new Set(matches.map(match => +match[1]).filter(value => value >= 40 && value <= 240));
  const bpm = values.size === 1 ? [...values][0] : null;
  return { bpm, explicit: explicit.length > 0 && bpm !== null };
}
export function tagsFromName(filename) {
  const name = path.parse(filename).name;
  const words = name.replace(/[_-]/g, ' ');
  const { bpm } = tempoHintFromName(filename);
  const keyMatch = words.match(/(?:^|\s)([A-G])([#b]?)[\s]?(maj(?:or)?|min(?:or)?|m)(?=\s|$)/i);
  const key = keyMatch ? keyMatch[1].toUpperCase() + keyMatch[2] + (/^m(?!aj)/i.test(keyMatch[3]) ? ' min' : ' maj') : null;
  const type = classifyType(name);
  return { name, bpm, key, type };
}

export function parseWavHeader(buffer, fileSize = buffer.length) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let format, channels, rate, byteRate, bits, blockAlign;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size >= 16 && offset + 24 <= buffer.length) {
      format = buffer.readUInt16LE(offset + 8); channels = buffer.readUInt16LE(offset + 10);
      rate = buffer.readUInt32LE(offset + 12); byteRate = buffer.readUInt32LE(offset + 16);
      blockAlign = buffer.readUInt16LE(offset + 20); bits = buffer.readUInt16LE(offset + 22);
    }
    if (id === 'data' && rate && byteRate && channels && blockAlign) {
      return { format, channels, rate, bits, blockAlign, dataOffset: offset + 8, dataSize: Math.min(size, Math.max(0, fileSize - offset - 8)), duration: Math.min(size, Math.max(0, fileSize - offset - 8)) / byteRate };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

export async function wavInfo(filename, size) {
  const file = await open(filename, 'r');
  try { const buffer = Buffer.alloc(Math.min(size, 262144)); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); return parseWavHeader(buffer.subarray(0, bytesRead), size); }
  finally { await file.close(); }
}

// Original synthesized audition material. No third-party recordings or assets.
export function makeDemo(type, variant, bpm = 92) {
  const rate = 22050, duration = 16 * 60 / bpm, length = Math.round(duration * rate);
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(36 + length * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(length * 2, 40);
  let seed = 1337 + variant, smooth = 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 0) / 2147483648 - 1; };
  const peaks = Array(160).fill(0);
  for (let i = 0; i < length; i++) {
    const t = i / rate, beat = t * bpm / 60, phase = beat % 1, beatNumber = Math.floor(beat);
    const n = random(); let value = 0;
    if (type === 'Drums') {
      const k = phase * 60 / bpm;
      if (beatNumber % 2 === 0 || (variant === 1 && beatNumber % 4 === 3)) value += Math.sin(2 * Math.PI * (48 * k + 9 * (1 - Math.exp(-35 * k)))) * Math.exp(-12 * k) * .65;
      if (beatNumber % 2 === 1) value += n * Math.exp(-20 * k) * .32;
      const h = (beat * (variant === 2 ? 4 : 2) % 1) * 60 / bpm / 2;
      value += n * Math.exp(-95 * h) * .14;
    } else if (type === 'Bass') {
      const notes = [55, 55, 65.406, 49]; const f = notes[(Math.floor(beat / 4) + variant) % 4];
      const env = Math.min(1, phase * 65) * Math.exp(-2.7 * phase);
      value = (Math.sin(t * f * 2 * Math.PI) + .22 * Math.sin(t * f * 4 * Math.PI)) * env * .48;
    } else if (type === 'Melodic') {
      const notes = [220, 261.626, 329.628, 391.995];
      const p = (beat / 2) % 1, env = Math.min(1, p * 90) * Math.exp(-4 * p);
      const f = notes[(Math.floor(beat / 2) + variant) % 4];
      value = (Math.sin(t * f * 2 * Math.PI) + .27 * Math.sin(t * f * 6 * Math.PI)) * env * .3;
      value += Math.sin(t * 110 * 2 * Math.PI) * .045;
    } else {
      smooth = .985 * smooth + .015 * n;
      const env = Math.sin(Math.PI * t / duration) ** 2;
      value = (smooth * .5 + Math.sin(t * (220 + variant * .3) * 2 * Math.PI) * .055 + Math.sin(t * 329.628 * 2 * Math.PI) * .04) * env;
    }
    value *= Math.min(1, i / 120, (length - 1 - i) / 220);
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
    const index = Math.min(159, Math.floor(i / length * 160)); peaks[index] = Math.max(peaks[index], Math.abs(value));
  }
  return { buffer, duration, peaks };
}
