// Mix and stem export helpers, shared by the browser and the server.

const headroom = .98;
const wavHeaderBytes = 44;
// Two channels of 16-bit samples.
const bytesPerFrame = 4;
const fadeInFrames = 128;
const fadeOutFrames = 256;

// One master gain for the mix and its stems, so the stems still sum to the
// mix when recombined. It only ever turns the level down: a mix that already
// peaks below full scale keeps its level.
export function mixScale(layers) {
  let peak = 1;
  const length = layers[0]?.channels[0]?.length || 0;
  for (let frame = 0; frame < length; frame++) {
    for (let channel = 0; channel < 2; channel++) {
      let sum = 0;
      for (const layer of layers) sum += layer.channels[channel][frame] * layer.gain;
      peak = Math.max(peak, Math.abs(sum));
    }
  }
  return headroom / peak;
}

function writeText(view, offset, value) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
}

function writeWavHeader(view, frames, rate) {
  const dataBytes = frames * bytesPerFrame;
  writeText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(view, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // Size of the format chunk.
  view.setUint16(20, 1, true); // PCM.
  view.setUint16(22, 2, true); // Channels.
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * bytesPerFrame, true); // Bytes per second.
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, 16, true); // Bits per sample.
  writeText(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
}

// Encodes two equal-length channels as a stereo 16-bit WAV, with a few
// milliseconds of fade at each end so the file never starts or stops on a click.
export function encodeWav(channels, { gain = 1, scale = 1, rate = 44100 } = {}) {
  const length = channels[0].length;
  if (channels.length !== 2 || channels[1].length !== length) throw new Error('Export requires equal stereo channels.');
  const result = new ArrayBuffer(wavHeaderBytes + length * bytesPerFrame);
  const view = new DataView(result);
  writeWavHeader(view, length, rate);
  for (let frame = 0; frame < length; frame++) {
    const fade = Math.min(1, frame / fadeInFrames, (length - 1 - frame) / fadeOutFrames);
    for (let channel = 0; channel < 2; channel++) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame] * gain * scale * fade));
      view.setInt16(wavHeaderBytes + (frame * 2 + channel) * 2, Math.round(value * 32767), true);
    }
  }
  return result;
}

// The loaded layers that are heard: not muted, and soloed when any layer is.
// `includeAll` ignores mute and solo.
export function audibleTracks(tracks, includeAll = false) {
  const anySolo = tracks.some(track => track.solo);
  const heard = track => !track.mute && (!anySolo || track.solo);
  return tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.id && (includeAll || heard(track)));
}
