'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(process.env.LIBRA_TEST_PLUGIN || path.resolve(__dirname, '../plugins/LIBRA.js'), 'utf8');
assert.match(source, releasePattern("^\\/\\/@version {libra}\\s*$", "m"));
assert.doesNotMatch(source, /이번 장에서 남은 핵심/);
assert.match(source, /summary: memorySummary\(finalText\)/, 'summary remains available for retrieval and compatibility');
assert.match(source, /현재 필드의 정본 근거|현재 상태로 이어진 흔적/, 'evidence/state panel remains');
console.log('libra_canonical_reader_summary_dedup_contract_test: PASS');
