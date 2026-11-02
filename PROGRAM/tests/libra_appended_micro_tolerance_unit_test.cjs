'use strict';
// appendedOnlyMicroTurns decides when a delivery-time owner proof may ignore a Micro
// that appeared mid-recall. It must accept only a first publication
// (missing -> verified on the same turn pair and head keys). The function is cut
// out of the shipped plugin source and run as is, so this checks the real code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const start = source.indexOf('    const appendedOnlyMicroTurns = (published, live, verdict) => {');
const end = source.indexOf('    const volatileMemoryGraphCorpus = ', start);
assert.ok(start > 0 && end > start, 'appendedOnlyMicroTurns is present in LIBRA.js');
const stableReferenceJson = value => JSON.stringify(value);
const asArray = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value : String(value ?? '');
const appendedOnlyMicroTurns = new Function('asArray', 'stableReferenceJson', 'string',
  source.slice(start, end) + '\nreturn appendedOnlyMicroTurns;')(asArray, stableReferenceJson, string);

const item = (turn, patch = {}) => ({ turn, pairRevisionId: 'rev' + turn, pairSourceDigest: 'src' + turn,
  completedHeadKey: 'ch' + turn, microHeadKey: 'mh' + turn, completedHeadDigest: 'd0', microHeadDigest: 'd0',
  workKey: '', workDigest: '', attemptId: '', status: 'missing', recordKey: '', receiptKey: '', ...patch });
const published = () => ({ turnPairsDigest: 'p', manifestDigest: 'm', registryDigest: 'r',
  windows: [{ canonicalSlice: [{ key: 'c1' }], microSlice: [item(1, { status: 'verified', recordKey: 'rk1' }), item(2)] }] });
const verdict = { frameChanged: false, windowCountChanged: false, changedFamilies: ['micro'] };
const firstPublication = { status: 'verified', recordKey: 'rk2', receiptKey: 'rc2', microHeadDigest: 'd1', workKey: 'w2', workDigest: 'wd2', attemptId: 'a2' };
const liveWith = (patch, mutateLive = () => {}) => {
  const live = published();
  Object.assign(live.windows[0].microSlice[1], patch);
  mutateLive(live);
  return live;
};

test('accepts a first Micro publication on the same turn pair', () => {
  assert.deepEqual(appendedOnlyMicroTurns(published(), liveWith(firstPublication), verdict), [2]);
});

test('rejects every other change', () => {
  const cases = {
    'missing -> stale_source': liveWith({ ...firstPublication, status: 'stale_source' }),
    'missing -> still missing with a different head': liveWith({ microHeadDigest: 'd1' }),
    'turn pair revision changed': liveWith({ ...firstPublication, pairRevisionId: 'other' }),
    'turn pair source changed': liveWith({ ...firstPublication, pairSourceDigest: 'other' }),
    'micro head key changed': liveWith({ ...firstPublication, microHeadKey: 'other' }),
    'completed head key changed': liveWith({ ...firstPublication, completedHeadKey: 'other' }),
    'published verified Micro replaced': liveWith(firstPublication, live => { live.windows[0].microSlice[0].recordKey = 'rk1b'; }),
    'canonical slice changed': liveWith(firstPublication, live => { live.windows[0].canonicalSlice[0].key = 'c2'; }),
    'turn removed': liveWith(firstPublication, live => { live.windows[0].microSlice.pop(); })
  };
  for (const [name, live] of Object.entries(cases)) assert.equal(appendedOnlyMicroTurns(published(), live, verdict), null, name);
  const priorRecord = published(); priorRecord.windows[0].microSlice[1].recordKey = 'stale';
  assert.equal(appendedOnlyMicroTurns(priorRecord, liveWith(firstPublication), verdict), null, 'a prior record key is not a first publication');
  const priorStale = published(); priorStale.windows[0].microSlice[1].status = 'stale_source';
  assert.equal(appendedOnlyMicroTurns(priorStale, liveWith(firstPublication), verdict), null, 'stale_source -> verified is a replacement');
  for (const [field, value] of [['turnPairsDigest', 'x'], ['manifestDigest', 'x'], ['registryDigest', 'x']]) {
    assert.equal(appendedOnlyMicroTurns(published(), liveWith(firstPublication, live => { live[field] = value; }), verdict), null, field);
  }
  for (const v of [{ ...verdict, frameChanged: true }, { ...verdict, windowCountChanged: true }, { ...verdict, changedFamilies: ['micro', 'state'] }]) {
    assert.equal(appendedOnlyMicroTurns(published(), liveWith(firstPublication), v), null, JSON.stringify(v));
  }
});
