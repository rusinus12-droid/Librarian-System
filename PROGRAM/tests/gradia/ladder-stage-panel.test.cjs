'use strict';
// 파이프라인 레더에서 단계를 눌렀을 때 그 단계의 상세 패널이 열리는지 확인한다.
// 실측 사고: 화술·대화 행을 눌러도 SHADOW ACT 패널이 열렸다(클릭 핸들러의 인라인 표에
// dialogue 키가 없어 || 'shadow' 로 떨어졌다).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./host.cjs');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'GRADIA.js');

const shippedMarkup = () => {
  const line = fs.readFileSync(PLUGIN, 'utf8').split('\n').find(l => l.startsWith('  const GRADIA_MOCKUP_MARKUP ='));
  assert.ok(line, 'mockup markup is shipped');
  return JSON.parse(line.trim().replace(/^const GRADIA_MOCKUP_MARKUP = /, '').replace(/;$/, ''));
};

const ladderRows = markup => [...markup.matchAll(/class="node[^"]*" data-select-row="([a-z_]+)"/g)].map(m => m[1]);
const detailPanels = markup => new Set([...markup.matchAll(/data-detail="([a-z_]+)"/g)].map(m => m[1]));

test('every ladder row opens its own stage panel, dialogue included', async () => {
  const markup = shippedMarkup();
  const rows = ladderRows(markup);
  assert.ok(rows.includes('dialogue'), 'the ladder has a 화술·대화 row');
  const panels = detailPanels(markup);
  const host = await load();
  const keys = host.plugin.debugLadderStageKeys();
  for (const row of rows) {
    assert.ok(keys.includes(row), `row ${row} is mapped to a detail key`);
  }
  for (const key of keys) {
    if (key === 'shadow') continue;
    assert.ok(panels.has(key), `detail panel ${key} exists`);
  }
  const missing = rows.filter(row => !panels.has(row));
  assert.deepEqual(missing, [], 'no ladder row falls back to another panel');
});
