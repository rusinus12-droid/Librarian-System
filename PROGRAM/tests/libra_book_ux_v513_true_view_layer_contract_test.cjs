'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const between = (start, end) => {
  const i = source.indexOf(start); assert.notEqual(i, -1, `missing ${start}`);
  const j = source.indexOf(end, i + start.length); assert.notEqual(j, -1, `missing ${end}`);
  return source.slice(i, j);
};

const desk = between('const buildBookDeskPanel =', 'const buildBookMemoryPanel =');
assert.match(desk, /libra-book-desk-view/);
assert.match(desk, /READING DESK · 현재 열람대/);
assert.doesNotMatch(desk, /buildBookPage\(/, 'Reading Desk must be a true spread, not a paper wrapper around the old page');
assert.doesNotMatch(desk, /buildLibraRecallPanel\(|buildLibraResponseResultPanel\(|buildGradiaResultsPanel\(/, 'Reading Desk must project runtime data into Book-native notes rather than embed legacy result panels');

const memory = between('const buildBookMemoryPanel =', 'const buildBookPeoplePanel =');
assert.match(memory, /buildBookMemoryReaderProjection\(\)/);
assert.match(memory, /buildBookAuxWorkbench\(/);
assert.doesNotMatch(memory, /buildLibraHubTabs\(/, 'Memory reader must not expose the old read/context/manage tabs');
assert.doesNotMatch(memory, /buildLibraMemoryHubPanel\(/, 'Memory reader must not mount the legacy memory hub');

const people = between('const buildBookPeoplePanel =', 'const buildBookWorldPanel =');
assert.match(people, /buildBookCharacterProfileProjection\(\)/);
assert.match(people, /buildBookAuxWorkbench\(/);
assert.doesNotMatch(people, /buildLibraHubTabs\(/, 'Character introduction must not expose old management tabs');

const world = between('const buildBookWorldPanel =', 'const buildBookStoryPanel =');
assert.match(world, /buildBookWorldGuideProjection\(\)/);
assert.match(world, /buildBookAuxWorkbench\(/);
assert.doesNotMatch(world, /buildLibraHubTabs\(/, 'World reference must not expose old management tabs');

const story = between('const buildBookStoryPanel =', 'const BOOK_NATIVE_SETTINGS_SECTIONS =');
assert.match(story, /buildBookNarrativeTocProjection\(\)/);
assert.match(story, /buildBookAuxWorkbench\(/);
assert.doesNotMatch(story, /buildLibraHubTabs\(/, 'Narrative almanac must not expose old management tabs');

const reader = between('const buildBookMemoryRail =', 'const buildBookCharacterProfileProjection =');
for (const token of ['libra-book-memory-reader','libra-book-memory-rail','libra-book-reading-sheet','libra-book-rail-search','근거와 상태 반영','교정']) assert.match(reader, new RegExp(token));
assert.doesNotMatch(reader, /기억의 근거|기록 계보/, 'duplicate evidence actions must stay merged');
assert.match(source, /libra-book-character-spread/);
assert.match(source, /libra-book-world-guide/);
assert.match(source, /\.libra-book-world-guide\{display:grid;grid-template-columns:minmax\(0,1fr\)/, 'World Reference should place overview and index in one readable full-width flow');
assert.match(source, /\.libra-book-world-card-grid\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(240px,1fr\)\)/, 'World cards should use available width without narrow fixed columns');
assert.match(source, /\.libra-book-world-card \.libra-book-card-meta\{[^}]*flex-wrap:wrap[^}]*justify-content:flex-start/, 'World source and freshness metadata should wrap as a group');
assert.match(source, /libra-book-toc-sheet/);
assert.match(source, /libra-book-empty-state/);
assert.match(source, /사서의 열람대 · 현재 기록을 읽고 다음 응답을 준비합니다/);
assert.match(source, /libra-book-boot-status[^\n]*JS ACTIVE|text: 'JS ACTIVE'/);
require('./fixtures/current_ui_compute_contracts.cjs').checkBookHeader(source);
assert.match(source, /note: '이번 턴 · 리콜 · 작성 결과'/);
assert.match(source, /note: '월드 매니저 · 현재 상태'/);
assert.match(source, /note: '월드 매니저 · 현재 상태'/);
assert.match(source, /note: '월드 매니저 · 현재 내러티브'/);

process.stdout.write('libra_book_ux_v513_true_view_layer_contract_test: PASS\n');
