'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourcePath = process.env.LIBRA_TEST_PLUGIN
  ? path.resolve(process.env.LIBRA_TEST_PLUGIN)
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const lightScope = ':is(.libra-book-page,.libra-book-drawer)';
assert.match(source, new RegExp(`${lightScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.sga-result-label\\{color:#725a42!important;-webkit-text-fill-color:#725a42!important\\}`), 'light agent workbench labels use readable ink');
assert.match(source, new RegExp(`${lightScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.sga-result-value\\{color:#4a3829!important;-webkit-text-fill-color:#4a3829!important\\}`), 'light agent workbench values use readable ink');
assert.match(source, new RegExp(`${lightScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\.sga-stage-result details>summary\\{color:#744b26!important;-webkit-text-fill-color:#744b26!important\\}`), 'expanded JSON summary uses readable ink');

const stageResult = source.slice(source.indexOf("const buildStageResultPanel"), source.indexOf("const executionResultTracesForStage"));
assert.ok(stageResult.includes("rows.push(resultLineNode('호출'"), 'stage result keeps semantic labels');
assert.ok(source.includes("class: options.code ? 'sga-result-code' : 'sga-result-value'"), 'stage result keeps distinct value/code surfaces');
assert.ok(stageResult.includes("text: '실제 값 JSON'"), 'stage result keeps the raw JSON disclosure');

process.stdout.write('libra_agent_workbench_color_contrast_contract_test: PASS\n');
