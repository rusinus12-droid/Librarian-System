'use strict';
// HAYAKU cross-language recall: summary recallAliases must stay a working search
// channel, and the packet contract must keep asking the response model for them.
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const report = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '../tools/rag_eval/hayaku_recall_eval.cjs')], { encoding: 'utf8', timeout: 120000 }));
const s = report.scenarios;
assert.ok(s['memory ko / question ko'].hitRate >= 0.75, 'same-language Korean floor');
assert.ok(s['memory en / question en'].hitRate >= 0.9, 'same-language English floor');
assert.ok(s['memory en + ko aliases / question ko'].hitRate > s['memory en / question ko'].hitRate, 'Korean aliases make English memory findable from Korean questions');
assert.ok(s['memory ko + en aliases / question en'].hitRate > s['memory ko / question en'].hitRate, 'English aliases make Korean memory findable from English questions');
assert.ok(s['memory ko + en aliases / question ko'].hitRate >= s['memory ko / question ko'].hitRate, 'aliases never hurt same-language recall');
assert.ok(s['memory ko + en aliases / question en'].emptyResults < s['memory ko / question en'].emptyResults, 'aliases remove empty cross-language results');

const source = fs.readFileSync(path.join(__dirname, '../plugins/HAYAKU_Locator_Continuity.js'), 'utf8');
assert.ok(source.includes("always add en and the user's language if different."), 'normal-turn packet contract requests cross-language aliases');
assert.ok(source.includes('Always include en and the language of the latest user input whenever it differs from the summary language'), 'recovery contract requests cross-language aliases');
console.log(JSON.stringify({ test: 'rag_eval_hayaku_cross_lingual', scenarios: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.hitRate])) }));
