import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo, parseWavHeader, tagsFromName, tempoHintFromName } from '../lib/audio.mjs';

test('filename tags recognize tempo, key and role without inventing unknowns', () => {
  assert.deepEqual(tagsFromName('warm_rhodes_92bpm_Amin.wav'), { name:'warm_rhodes_92bpm_Amin',bpm:92,key:'A min',type:'Melodic' });
  assert.equal(tagsFromName('take_01.wav').bpm, null);
  assert.equal(tagsFromName('field_rain.wav').type, 'Texture');
  assert.equal(tagsFromName('Bass_C#minor_120.wav').key, 'C# min');
  assert.equal(tagsFromName('kick_125_Bbmaj.wav').key, 'Bb maj');
  assert.equal(tagsFromName('untitled.wav').key, null);
});
test('numeric tempo hints exclude attached text, technical units and conflicting numbers', () => {
  for (const name of ['sample_128bit.wav', 'song_2024.wav', 'audio_128-bit.wav', 'audio_44.1_kHz.wav', 'audio_64_bars.wav', 'take_100_120.wav']) assert.equal(tagsFromName(name).bpm, null, name);
  assert.deepEqual(tempoHintFromName('take_120.wav'), { bpm: 120, explicit: false });
  assert.deepEqual(tempoHintFromName('take_64_120bpm.wav'), { bpm: 120, explicit: true });
  assert.deepEqual(tempoHintFromName('take_120_120.wav'), { bpm: 120, explicit: false });
  assert.deepEqual(tempoHintFromName('take_120bpm_140bpm.wav'), { bpm: null, explicit: false });
});
test('synthesized demo is valid audible PCM and waveform matches its samples', () => {
  for (const type of ['Drums','Bass','Melodic','Texture']) {
    const {buffer,peaks,duration} = makeDemo(type,0);
    const info = parseWavHeader(buffer);
    assert.equal(info.rate,22050); assert.equal(info.channels,1); assert.equal(info.bits,16);
    assert.ok(Math.abs(info.duration-duration)<1/22050);
    assert.ok(peaks.some(p=>p>.02)); assert.ok(peaks.every(p=>p<=1));
    assert.equal(buffer.readInt16LE(44),0); assert.equal(buffer.readInt16LE(buffer.length-2),0);
    let energy=0;for(let i=44;i<buffer.length;i+=2)energy+=Math.abs(buffer.readInt16LE(i));assert.ok(energy>1_000_000);
  }
});
test('WAV parser rejects non-WAV and bounds truncated data by file size', () => {
  assert.equal(parseWavHeader(Buffer.from('not a wave file')),null);
  const {buffer}=makeDemo('Bass',0);
  assert.equal(parseWavHeader(buffer.subarray(0,44),100).dataSize,56);
  assert.equal(parseWavHeader(buffer.subarray(0,44),buffer.length).dataSize,buffer.length-44);
});
