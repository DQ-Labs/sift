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

export function renderPlan(sample, { tempo, sync = true, key = null }) {
  const pitch = pitchPlan(sample, key);
  const knownTempo = Number.isFinite(sample.bpm) && sample.bpm > 0;
  const rate = sync && knownTempo ? tempo / sample.bpm : 1;
  return { ...pitch, rate, tempoUnknown: sync && !knownTempo, processed: Math.abs(rate - 1) > .000001 || pitch.semitones !== 0 };
}

export function combinationCost(sample, { tempo, key = null }) {
  const pitch = pitchPlan(sample, key);
  let cost = sample.bpm > 0 ? Math.abs(Math.log2(tempo / sample.bpm)) * 10 : 4;
  cost += pitch.status === 'unknown' ? 8 : Math.abs(pitch.semitones) * .7;
  if (sample.bpmSource === 'filename-hint') cost += 2;
  for (const field of ['bpm', 'key']) {
    const conflict = sample.conflicts?.[field];
    if (conflict && !conflict.resolved && (field === 'bpm' || key)) cost += 2;
  }
  return cost;
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
    const ranked = (alternatives.length ? alternatives : pool).map(sample => ({ sample, cost: combinationCost(sample, settings) })).sort((a, b) => a.cost - b.cost);
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
