// Tempo for clips too short for the beat tracker.
//
// Analysis leaves the tempo of anything under four seconds unknown, which is
// most one- and two-bar loops. A loop cut to a whole number of beats gives its
// tempo away by its length, so this reads the tempo from the length when the
// waveform looks like a loop: several attacks, the first at the very start,
// and nearly all of them on an even division of the clip.
//
// The length cannot say whether a clip is one bar at 120 BPM or two at 240.
// The answer is folded into 80–160 BPM, or to the octave of a number in the
// filename when that number fits. Sessions match tempos an octave apart
// without stretching (tempoMatch() in public/harmony.js), so the octave
// changes the label, not the sound.

// The analysis worker runs the beat tracker from this length up.
export const trackedSeconds = 4;
const shortestSeconds = .9;
const foldFrom = 80;
const fewestAttacks = 4;

// Bins of the waveform where the level jumps: a rise of a fifth of the
// loudest peak. A rise spread over neighbouring bins counts once.
export function attackBins(peaks) {
  const loudest = Math.max(...peaks);
  if (!(loudest > 0)) return [];
  const attacks = [];
  let previous = 0;
  let lastRise = -2;
  peaks.forEach((peak, bin) => {
    if (peak - previous > loudest * .2) {
      if (bin - lastRise > 1) attacks.push(bin);
      lastRise = bin;
    }
    previous = peak;
  });
  return attacks;
}

// The share of attacks within one bin of a line that cuts the clip into
// `divisions` equal parts.
function shareOnGrid(attacks, bins, divisions) {
  const step = bins / divisions;
  const near = attacks.filter(bin => {
    const offset = bin % step;
    return Math.min(offset, step - offset) <= 1;
  });
  return near.length / attacks.length;
}

function looksLikeLoop(peaks) {
  const attacks = attackBins(peaks);
  if (attacks.length < fewestAttacks || attacks[0] > 1) return false;
  if (shareOnGrid(attacks, peaks.length, 16) >= .8) return true;
  // A finer grid is easier to land on by chance, so it needs more attacks.
  return attacks.length >= 8 && shareOnGrid(attacks, peaks.length, 32) >= .9;
}

function foldTempo(bpm, hint) {
  if (hint > 0) {
    const nearHint = bpm * 2 ** Math.round(Math.log2(hint / bpm));
    if (Math.abs(nearHint / hint - 1) <= .03) return nearHint;
  }
  let folded = bpm;
  while (folded < foldFrom) folded *= 2;
  while (folded >= foldFrom * 2) folded /= 2;
  return folded;
}

// The tempo of an analysed short clip, or null when it does not look like a
// loop. `hint` is an unlabelled number from the filename, if there is one.
export function tempoFromLength(sample, hint = null) {
  const analysis = sample.analysis;
  if (analysis?.status !== 'done' || analysis.bpm != null) return null;
  const seconds = analysis.analyzedSeconds;
  if (!(seconds >= shortestSeconds && seconds < trackedSeconds)) return null;
  if (!Array.isArray(sample.peaks) || sample.peaks.length < 64) return null;
  if (!looksLikeLoop(sample.peaks)) return null;
  // One beat lasting the whole clip, then doubled or halved into range.
  return Math.round(foldTempo(60 / seconds, hint) * 10) / 10;
}
