import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateContext, findSetByName, layerForSample, timestampedSetName, varietyLabel } from '../public/workbench-model.js';

test('variety labels cover the whole range and tolerate bad values', () => {
  assert.deepEqual([0, .25, .5, .75, 1].map(varietyLabel), ['Safe', 'Close', 'Balanced', 'Adventurous', 'Wild']);
  assert.equal(varietyLabel(undefined), 'Balanced');
  assert.equal(varietyLabel(7), 'Wild');
});

test('automatic set names are local timestamps and fit the 100-character limit', () => {
  const name = timestampedSetName(new Date(2026, 0, 5, 9, 3, 7), 'Mix export');
  assert.equal(name, 'Mix export · 2026-01-05 09:03:07');
  assert.ok(name.length <= 100);
});

test('set overwrite detection ignores case and surrounding spaces', () => {
  const sets = [{ id: 'a', name: 'Late Night ' }];
  assert.equal(findSetByName(sets, ' late night')?.id, 'a');
  assert.equal(findSetByName(sets, 'Early'), null);
});

test('prefetched candidates expire when anything that feeds the choice changes', () => {
  const base = { source: null, settings: { tempo: 92, sync: true, key: 'A min' }, variety: .5, tracks: [{ id: 'a', type: 'Bass', locked: false, volume: .5 }] };
  const context = candidateContext(base, 0);
  assert.equal(candidateContext({ ...base, source: '' }, 0), context);
  assert.equal(candidateContext({ ...base, tracks: [{ ...base.tracks[0], volume: .9, mute: true }] }, 0), context, 'levels do not matter');
  for (const changed of [
    { ...base, settings: { ...base.settings, tempo: 93 } },
    { ...base, variety: .6 },
    { ...base, source: 'demo' },
    { ...base, tracks: [{ ...base.tracks[0], locked: true }] }
  ]) assert.notEqual(candidateContext(changed, 0), context);
  assert.notEqual(candidateContext(base, 1), context);
});

test('added samples fill an empty layer, then a same-type layer, never a locked one', () => {
  const tracks = [{ type: 'Drums', id: 'x', locked: true }, { type: 'Bass', id: 'y' }, { type: 'Melodic', id: null }];
  assert.equal(layerForSample(tracks, { type: 'Bass' }), 2);
  tracks[2].id = 'z';
  assert.equal(layerForSample(tracks, { type: 'Melodic' }), 2);
  assert.equal(layerForSample(tracks, { type: 'Drums' }), 1);
  assert.equal(layerForSample([{ locked: true }], { type: 'Bass' }), -1);
});
