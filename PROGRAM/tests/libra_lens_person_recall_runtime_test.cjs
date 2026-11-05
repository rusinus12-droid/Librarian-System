'use strict';
// Lens recall gathers notes under the person they belong to, and the people in the scene come first
// even when the input shares no words with their notes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const item = (id, name, label, text) => ({ itemId: id, label, text, evidenceLevel: 'interpreted', refs: ['t1-u'], basis: '근거', who: name ? [{ name, ref: 't1-u', role: 'named' }] : [], whoIssue: name ? '' : 'unknown' });
const seed = async (f, role, items, recall = {}) => {
  f.setReply({ items: [{ label: '시작', text: '시작 기록입니다.', refs: ['t1-u'], basis: '근거' }] });
  const lens = await f.add(`렌즈-${role}`, 'active', { trackSubject: true, recall: { role, ...recall } });
  assert.equal(lens.recall.role, role, 'the role is kept with the lens');
  const key = [...f.r.values.keys()].find(k => k.endsWith(`:lens:${lens.lensId}:records`));
  const stored = JSON.parse(f.r.values.get(key));
  for (const record of Object.values(stored.records)) { record.items = items; record.trackedSubject = true; }
  f.r.values.set(key, JSON.stringify(stored));
  return lens;
};
// An input with nothing in common with the notes below.
const UNRELATED = '오늘은 창밖으로 눈이 내리는 걸 구경하자';

test('notes are gathered per person across lenses, without needing words in common', async () => {
  const f = await lensFixture();
  try {
    await seed(f, 'current', [item('a1', '지호', '증상', '왼손 손목이 붓고 아프다.'), item('a2', '민아', '컨디션', '밤새 잠을 못 잤다.')]);
    await seed(f, 'persistent', [item('b1', '지호', '비밀', '상자의 암호를 숨기고 있다.')]);
    const recall = JSON.parse(JSON.stringify(await f.api.recallLensMemories({ query: UNRELATED, canonicalBudgetChars: 12000 })));
    const block = recall.renderedBlock;
    assert.equal((block.match(/^■ 지호$/gm) || []).length, 1, 'one heading per person');
    const jiho = block.split('■ ').find(part => part.startsWith('지호\n'));
    assert.match(jiho, /손목이 붓고/, 'the body note sits under the person');
    assert.match(jiho, /암호를 숨기고/, 'and so does the note from another lens');
    assert.doesNotMatch(jiho, /잠을 못 잤다/, "another person's note does not");
    assert.match(block, /정본 기억이 우선/, 'precedence still travels with the notes');
    assert.doesNotMatch(block, /관점유형|근거턴|rev=/, 'lines carry no bookkeeping');
  } finally { await f.close?.(); }
});

test('a search-only lens still needs words in common, and people not in the scene wait', async () => {
  const f = await lensFixture();
  try {
    await seed(f, 'relevant', [item('c1', '지호', '메모', '손목에 붕대를 감았다.')]);
    await seed(f, 'current', [item('d1', '외부인물', '증상', '손목이 붓고 아프다.')]);
    const recall = JSON.parse(JSON.stringify(await f.api.recallLensMemories({ query: UNRELATED, canonicalBudgetChars: 12000 })));
    assert.equal(recall.renderedBlock, '', 'no shared words and no one in the scene, so nothing is delivered');
  } finally { await f.close?.(); }
});

test('each person in the scene gets a turn within the lens total and character budget', async () => {
  const f = await lensFixture();
  try {
    const many = (name, n) => Array.from({ length: n }, (_, i) => item(`${name}${i}`, name, '증상', `${name}의 기록 ${i}번입니다. 내용이 조금 길게 이어집니다.`));
    await seed(f, 'persistent', [...many('지호', 6), ...many('민아', 6)]);
    const small = JSON.parse(JSON.stringify(await f.api.recallLensMemories({ query: UNRELATED, canonicalBudgetChars: 3000 })));
    assert.ok(small.renderedBlock.length <= small.budgetChars, 'the budget holds');
    assert.match(small.renderedBlock, /^■ 지호$/m);
    assert.match(small.renderedBlock, /^■ 민아$/m, 'a small budget still reaches both people');
    const large = JSON.parse(JSON.stringify(await f.api.recallLensMemories({ query: UNRELATED, canonicalBudgetChars: 12000 })));
    const counts = large.injectedItems.reduce((map, row) => { map[row.groupName] = (map[row.groupName] || 0) + 1; return map; }, {});
    assert.equal(large.injectedItems.length, 3, 'the default maxItems applies across people');
    assert.ok(counts.지호 >= 1 && counts.지호 <= 2);
    assert.ok(counts.민아 >= 1 && counts.민아 <= 2);
  } finally { await f.close?.(); }
});

for (const maxItems of [1, 3, 8]) test(`scene and general selection share the lens limit ${maxItems}`, async () => {
  const f = await lensFixture();
  try {
    const notes = ['지호', '민아', '외부인물'].flatMap(name => Array.from({ length: 6 }, (_, i) => item(`${name}${i}`, name, '검증 기록', `${name}의 검증 기록 ${i}번입니다.`)));
    const lens = await seed(f, 'persistent', notes, { maxItems });
    const recall = await f.api.recallLensMemories({ query: '검증 기록', canonicalBudgetChars: 30000 });
    assert.equal(recall.injectedItems.filter(row => row.lensId === lens.lensId).length, maxItems);
    assert.ok(recall.skippedCandidates.some(row => row.reasonCode === 'item_limit'));
    assert.ok(recall.usedChars <= recall.budgetChars);
    if (maxItems >= 3) for (const name of ['지호', '민아']) assert.ok(recall.injectedItems.some(row => row.groupName === name), name);
  } finally { await f.close?.(); }
});
