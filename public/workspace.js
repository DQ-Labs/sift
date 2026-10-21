import { parseKey } from './harmony.js';
import { defaultTiming, repeatModes } from './timing.js';
export const trackTypes = ['Drums', 'Bass', 'Melodic', 'Texture', 'Vocal', 'Other'];
const defaults = trackTypes.slice(0, 4);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The same rules protect API writes and repair older workspaces on load.
export function normalizeWorkspace(input, { strict = false } = {}) {
  const fresh = input == null && !strict;
  const fail = message => { if (strict) throw Object.assign(new Error(message), { status: 400 }); };
  if (!object(input)) { fail('A workspace must be an object.'); input = {}; }
  if (!Array.isArray(input.tracks) || input.tracks.length > 4) fail('A workspace needs an array of up to four tracks.');
  const tracks = defaults.map((type, index) => {
    let t = Array.isArray(input.tracks) ? input.tracks[index] : undefined;
    if (t !== undefined && !object(t)) fail('Each track must be an object.');
    if (!object(t)) t = {};
    if (t.type !== undefined && !trackTypes.includes(t.type)) fail('Choose a valid track type.');
    if (t.id !== undefined && t.id !== null && (typeof t.id !== 'string' || !t.id || t.id.length > 200)) fail('Choose a valid sample ID.');
    if (t.volume !== undefined && (!Number.isFinite(t.volume) || t.volume < 0 || t.volume > 1)) fail('Track volume must be between 0 and 1.');
    for (const flag of ['locked', 'mute', 'solo']) if (t[flag] !== undefined && typeof t[flag] !== 'boolean') fail(`Track ${flag} must be true or false.`);
    let timing = t.timing;
    if (timing !== undefined && !object(timing)) fail('Layer timing must be an object.');
    if (!object(timing)) timing = {};
    if (timing.offset !== undefined && timing.offset !== null && (!Number.isFinite(timing.offset) || timing.offset < 0 || timing.offset > 3600)) fail('Start offset must be between 0 and 3600 seconds, or blank for first sound.');
    if (timing.repeat !== undefined && !repeatModes.includes(timing.repeat)) fail('Choose a valid repeat mode.');
    return {
      type: trackTypes.includes(t.type) ? t.type : type,
      id: typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 200 ? t.id : null,
      volume: Number.isFinite(t.volume) ? Math.max(0, Math.min(1, t.volume)) : .72,
      locked: t.locked === true, mute: t.mute === true, solo: t.solo === true,
      timing: { offset:Number.isFinite(timing.offset) && timing.offset >= 0 && timing.offset <= 3600 ? timing.offset : null, repeat:repeatModes.includes(timing.repeat) ? timing.repeat : defaultTiming().repeat }
    };
  });
  if (input.tempo !== undefined && (!Number.isFinite(input.tempo) || input.tempo < 40 || input.tempo > 240)) fail('Session tempo must be 40–240 BPM.');
  if (input.sync !== undefined && typeof input.sync !== 'boolean') fail('Tempo sync must be true or false.');
  if (input.key !== undefined && input.key !== null && !parseKey(input.key)) fail('Choose a valid session key, or original keys.');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 100)) fail('Workspace name must be text up to 100 characters.');
  return { tracks, tempo: Number.isFinite(input.tempo) ? Math.max(40, Math.min(240, input.tempo)) : 92, sync: fresh || input.sync === true, key: fresh ? 'A min' : parseKey(input.key)?.name || null, name: typeof input.name === 'string' ? input.name.slice(0, 100) : 'Untitled set' };
}
