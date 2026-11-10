export const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const roots = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const mod12 = value => (value % 12 + 12) % 12;

export function parseKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^([A-G])([#b]?) (maj|min)$/.exec(value);
  if (!match) return null;
  const root = mod12(roots[match[1]] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0));
  return { root, mode: match[3], name: `${noteNames[root]} ${match[3]}` };
}

// Relative major/minor share a diatonic scale. Transposition preserves mode;
// it does not turn major chords into minor chords or guarantee chord agreement.
export function pitchPlan(sample, key) {
  const target = parseKey(key), source = parseKey(sample.key);
  if (!target) return { semitones: 0, status: 'original', outputKey: source?.name || null };
  if (sample.type === 'Drums') return { semitones: 0, status: 'drums', outputKey: null };
  if (!source) return { semitones: 0, status: 'unknown', outputKey: null };
  const sourceScale = source.root + (source.mode === 'min' ? 3 : 0);
  const targetScale = target.root + (target.mode === 'min' ? 3 : 0);
  const semitones = mod12(targetScale - sourceScale + 6) - 6;
  return {
    semitones, status: source.mode !== target.mode ? 'relative' : 'matched',
    outputKey: `${noteNames[mod12(source.root + semitones)]} ${source.mode}`
  };
}

// How a sample at `bpm` meets a session at `tempo` with the least stretching.
// Tempos an octave apart share a beat grid, so a 70 BPM loop in a 140 BPM
// session plays at its own speed, in half time, instead of twice as fast.
// `octaves` counts the doublings from the sample's tempo to the session's
// (1 = half time, -1 = double time); `rate` is the speed change left over,
// always between 1/√2 and √2.
export function tempoMatch(bpm, tempo) {
  const ratio = tempo / bpm;
  const octaves = Math.round(Math.log2(ratio));
  return { rate: ratio / 2 ** octaves, octaves };
}

export function renderPlan(sample, { tempo, sync = true, key = null }) {
  const pitch = pitchPlan(sample, key);
  const knownTempo = Number.isFinite(sample.bpm) && sample.bpm > 0;
  const { rate, octaves } = sync && knownTempo ? tempoMatch(sample.bpm, tempo) : { rate: 1, octaves: 0 };
  return { ...pitch, rate, octaves, tempoUnknown: sync && !knownTempo, processed: Math.abs(rate - 1) > .000001 || pitch.semitones !== 0 };
}

// What each octave of half or double time adds to a match's cost: enough to
// prefer a sample at the session's own tempo, not enough to rule the other out.
export const octaveCost = 1;

function tempoCost(sample, tempo) {
  if (!(sample.bpm > 0)) return 4;
  const { rate, octaves } = tempoMatch(sample.bpm, tempo);
  const stretch = Math.abs(Math.log2(rate)) * 10;
  // A tempo worked out from a clip's length has no octave of its own.
  if (sample.bpmSource === 'length') return stretch + 1;
  return stretch + Math.abs(octaves) * octaveCost;
}

export function combinationCost(sample, { tempo, key = null }) {
  const pitch = pitchPlan(sample, key);
  let cost = tempoCost(sample, tempo);
  cost += pitch.status === 'unknown' ? 8 : Math.abs(pitch.semitones) * .7;
  if (sample.bpmSource === 'filename-hint') cost += 2;
  for (const field of ['bpm', 'key']) {
    const conflict = sample.conflicts?.[field];
    if (conflict && !conflict.resolved && (field === 'bpm' || key)) cost += 2;
  }
  return cost;
}

// ---- Loops -------------------------------------------------------------------

export const loopBarCounts = [1, 2, 4, 8];

// How close a length must be to a whole number of beats to count as one:
// 1.5% of the length, at least 20 ms and at most 80 ms. Shared with the
// automatic repeat in planCycle() (public/timing.js).
export const loopTolerance = seconds => Math.min(.08, Math.max(.02, seconds * .015));

// The number of 4/4 bars (1, 2, 4 or 8) a sample's duration fills at its
// tempo, or null when it is not a whole-bar loop or its tempo is a guess.
export function loopBars(sample) {
  const { bpm, duration } = sample || {};
  if (!(bpm > 0) || !(duration > 0) || sample.bpmSource === 'filename-hint') return null;
  if (sample.conflicts?.bpm && !sample.conflicts.bpm.resolved) return null;
  const bar = 4 * 60 / bpm;
  return loopBarCounts.find(bars => Math.abs(duration - bars * bar) <= loopTolerance(bars * bar)) ?? null;
}

// Loops line up bar for bar with the other layers, so rhythmic and harmonic
// roles prefer them. The bonus only moves loops ahead of non-loops; when no
// candidate is a loop, costs and odds are exactly as before.
const loopRoles = new Set(['Drums', 'Bass', 'Melodic']);
export const loopBonus = 2;

function isLoop(sample) {
  return (sample.loopBars !== undefined ? sample.loopBars : loopBars(sample)) !== null;
}

export function roleCost(sample, role, settings) {
  const cost = combinationCost(sample, settings);
  return loopRoles.has(role) && isLoop(sample) ? cost - loopBonus : cost;
}

function playable(sample, settings) {
  if (sample.missing || sample.size > 100 * 1024 * 1024) return false;
  const plan = renderPlan(sample, settings);
  return plan.rate >= .25 && plan.rate <= 4 && (!plan.processed || !sample.duration || (sample.duration <= 180 && sample.duration / plan.rate <= 360));
}

// Variety runs from 0 (safe) to 1 (wild). It sets how far above the best
// match a candidate may score and how flat the odds are between candidates.
// 0.5 reproduces the original band of 2 and unit temperature exactly.
export const defaultVariety = .5;

export function clampVariety(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : defaultVariety;
}

export function varietyPool(variety) {
  const spread = 2 * clampVariety(variety) - 1;
  return { band: 2 * 6 ** spread, temperature: 3 ** spread };
}

export function chooseCombination(tracks, samples, settings, index = null, random = Math.random) {
  const { band, temperature } = varietyPool(settings.variety);
  const retained = (track, i) => track.locked || (index !== null && index !== i);
  const occupied = new Set(tracks.filter(retained).map(t => t.id).filter(Boolean));
  return tracks.map((track, i) => {
    if (retained(track, i)) return { ...track };
    const available = samples.filter(s => !occupied.has(s.id) && playable(s, settings));
    const typed = available.filter(s => s.type === track.type);
    const pool = typed.length ? typed : available;
    const alternatives = pool.filter(s => s.id !== track.id);
    const ranked = (alternatives.length ? alternatives : pool).map(sample => ({ sample, cost: roleCost(sample, track.type, settings) })).sort((a, b) => a.cost - b.cost);
    if (!ranked.length) {
      // A previous layer may already have claimed this sample during a full
      // reroll. Leave this slot empty rather than silently doubling that audio.
      if (track.id && occupied.has(track.id)) return { ...track, id: null, timing:{offset:null,repeat:'auto'} };
      if (track.id) occupied.add(track.id);
      return { ...track };
    }
    // Keep variety within a nearby quality band, excluding severe mismatches.
    const best = ranked.filter(item => item.cost <= ranked[0].cost + band);
    const weights = best.map(item => Math.exp((ranked[0].cost - item.cost) / temperature));
    let draw = Math.max(0, Math.min(.999999, random())) * weights.reduce((sum, weight) => sum + weight, 0);
    const selected = best.find((item, n) => (draw -= weights[n]) < 0)?.sample || best.at(-1).sample;
    occupied.add(selected.id);
    return { ...track, id: selected.id, type: selected.type, ...(selected.id!==track.id ? {timing:{offset:null,repeat:'auto'}} : {}) };
  });
}
