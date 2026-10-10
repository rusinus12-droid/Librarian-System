'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const drawer = source.slice(source.indexOf('const showCanonicalRangeDrawer ='), source.indexOf('const buildBookMemoryModelSummary ='));
const core = source.slice(source.indexOf('const LibraMemoryCore = (() => {'), source.indexOf('const memoryStageEnabledForSettings ='));
const gui = source.slice(source.indexOf('const buildSourceEditConsentPanel ='), source.indexOf('const buildSwallowedDiagPanel ='));

assert.match(drawer, /const eligible = row => currentMode === 'regenerate' \? row\.status === 'saved' : currentMode === 'failed' \? row\.status === 'failed' : row\.status === 'missing';/,
  'default drawer eligibility must select only missing ranges');
assert.doesNotMatch(drawer, /currentMode !== 'saved'|row\.status !== 'saved'/,
  'default drawer must not treat every non-saved range as missing');
assert.match(drawer, /sourceChangedNotice/,
  'source_changed ranges must have a separate notice');
assert.doesNotMatch(drawer, /sourceReviewCta|sourceReviewButton|reviewLibraSourceEdits/,
  'the range drawer must not offer manual consent/reanalysis for source edits');
assert.match(drawer, /원문 수정 · 자동 처리 대기/,
  'source_changed ranges must be labeled as automatic work');
assert.match(drawer, /요청 시작 시 자동으로 다시 분석합니다/,
  'the drawer must explain automatic before-request processing');
assert.match(drawer, /후속 영향 구간은 회상에서 제외/,
  'pending dependent ranges must be disclosed as withheld from recall');
assert.match(core, /const getLibraSourceEdits = \(\) =>/,
  'LIBRA retains its owner-scoped source edit journal and automatic processor');
assert.match(core, /reviewSourceEdits: async \(\) => \(\{ok:false,reason:'automatic_before_request_only'/,
  'the legacy public review API cannot launch a consent prompt');
assert.doesNotMatch(core, /reviewSourceEdits:[^\n]*\.review\(true\)/,
  'no public source-edit API can grant a manual reanalysis permit');
assert.match(core, /const inspectLibraSourceEdits = async/,
  'source edit inspection must remain available');
assert.match(core, /const completedTurnIds=\[\.\.\.new Set\(pairs[\s\S]*?identityStable===true[\s\S]*?chatId[\s\S]*?\.map\(pair=>string\(pair\.user\.chatId\)\)\)\]/,
  'the owner supplies only stable completed U IDs for SDK-managed TTL accounting');
assert.match(core, /rawDigest:currentRawDigest[\s\S]*originalDigest:previousDigests\.originalDigest,originalRawDigest:previousDigests\.originalRawDigest,policyUncertain:previousDigests\.policyUncertain/,
  'the owner supplies raw/projected hashes and validated previous-source evidence to policy reconciliation');
assert.match(core, /const suppressLibraSourceEditImpactForRequest=[\s\S]*source_edit_exception[\s\S]*source_edit_pending/,
  'exception, failed, and pending impacts are filtered from the request-local canonical manifest');
assert.match(core, /sourceEditRequestSerial[\s\S]*SOURCE_EDIT_REQUEST_CHANGED/,
  'a newer request invalidates late replacement commits');
assert.match(core, /sourceGuard\.canWrite\(selection\.scopeKey, row\.startTurn, row\.sourceDigest\)/,
  'canonical writes remain blocked until the automatic replacement permit is current');
assert.match(core, /sourceGuard\.refresh\(\{\s*prompt\s*:\s*false\s*\}\)/,
  'canonical selection must refresh source state before writing');
assert.match(core, /const expectedStatus = selection\.mode === 'regenerate' \? 'saved' : selection\.mode === 'failed' \? 'failed' : 'missing';/,
  'API selection must reject source_changed and other non-mode statuses');
assert.match(core, /if \(actual\.status !== expectedStatus\) throw new Error\('selected_batch_status_changed'\);/,
  'API selection must fail closed when status changes after rendering');
assert.match(gui, /LibraMemoryCore\.mountSourceEditTrackingControls\(card\)/,
  'LIBRA settings mount the shared recent-edit, exception, deletion, and rule controls');
assert.match(source, /setSourceEditRules: rules => getLibraSourceEdits\(\)\.setSourceRules\(rules\)/,
  'LIBRA public settings API stores rules through the owner-scoped shared SDK');

process.stdout.write('libra_missing_source_changed_contract_test: PASS\n');
