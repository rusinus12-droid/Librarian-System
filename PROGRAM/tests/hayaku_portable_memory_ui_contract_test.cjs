'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'HAYAKU_Locator_Continuity.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.match(source, releasePattern("^\\/\\/@version {hayaku}\\s*$", "m"));
assert.match(source, /<h2 class="card__title">기억 복원 · Portable JSON<\/h2>/);
assert.match(source, /data-portable-backup-host="hayaku_locator_continuity"/);
assert.match(source, /같은 채팅은 교체 복원, 다른 채팅은 이사\/복사 모드만 허용됩니다\. 작업 전 대상 기억을 자동 백업합니다\./);
assert.match(source, /백업 파일에는 역할극 원문과 비공개 기억이 포함될 수 있습니다/);
assert.match(source, /↓ JSON 백업 다운로드/);
assert.match(source, /↑ JSON 백업에서 복원/);
assert.match(source, /label: '새 채팅으로 이사'/);
assert.match(source, /label: '복사된 채팅 복구'/);
assert.doesNotMatch(source, /data-portable-paste|pasteJsonDialog|doRestorePaste|JSON 직접 붙여넣기/);
assert.match(source, /mode === Hayaku_PORTABLE_IMPORT_MODES\.SAME_CHAT\s*\? Number\(prepared\?\.currentRecords \|\| 0\) > 0/, 'empty same-chat targets must not be blocked by an impossible safety-backup export');
assert.match(source, /expectedTargetFingerprint:\s*prepared\.targetFingerprint/,
  'confirmed imports must carry the analyzed target fingerprint into the queued transaction');
assert.match(source, /const exportEnvelope = async \(\) => await enqueueStorageOperation\(createEnvelope\)/,
  'portable exports should share the storage mutation queue');
assert.match(source, /exportCurrentScope:\s*exportEnvelope/,
  'public exports should use the serialized snapshot path');
assert.match(source, /PORTABLE_IMPORT_TARGET_CHANGED/,
  'a target mutation after confirmation must fail closed before writes');
assert.match(source, /runtime\.lastError = '';\s*invalidateExternalLedgerCaches\(scope\.scopeKey\);\s*await refreshRuntime\(result\)/,
  'successful same-chat restore must invalidate authoritative and projection caches');
assert.match(source, /invalidatePortableArchiveCaches\(\);\s*invalidateExternalLedgerCaches\(scope\.scopeKey\);/,
  'same-chat rollback must invalidate restored-scope caches');
assert.match(source, /HayakuHydratedArchiveCache\.clear\(\);[^]*?invalidateExternalLedgerCaches\(prepared\?\.targetScope\?\.key \|\| prepared\?\.portableScope\?\.scopeKey\);/,
  'cross-chat rollback must invalidate target-scope caches');
assert.match(source, /title: 'HAYAKU JSON 기억 백업'/);
assert.match(source, /title: 'HAYAKU JSON 기억 복원'/);
assert.match(source, /const dedicatedHost = document\.querySelector\('\[data-portable-backup-host="hayaku_locator_continuity"\]'\)/);
assert.match(source, /if \(!dedicatedHost\) \{/);
assert.doesNotMatch(source, /anchor === document\.body/);
assert.doesNotMatch(source, /position:fixed;right:14px;bottom:14px/);
assert.doesNotMatch(source, />💾 기억 백업<\/button>/);
assert.doesNotMatch(source, />📥 기억 복원<\/button>/);
assert.match(source, /className = 'portable-memory-controls'/);
assert.match(source, /className = 'overlay is-open'/);
assert.match(source, /overlay\.setAttribute\('data-hayaku-portable-job', 'true'\)/);
assert.match(source, /data-portable-job-minimize/);
assert.match(source, /data-portable-job-cancel/);
assert.match(source, /chip\.className = 'btn btn--sm'/);
assert.match(source, /id="exportHayakuViewer"[^>]*>[^<]*원장 JSON/);
assert.match(source, /addEventListener\('click', \(\) => downloadLedgerViewerJson\(\)\)/,
  'packet-ledger export remains a separate read-only export action, not a portable restore source');
assert.match(source, /input type="file" accept="\.json,application\/json" hidden/,
  'restore accepts a selected JSON backup file only');

const recoveryStart = source.indexOf('const recoveryPage = `');
const portableHost = source.indexOf('data-portable-backup-host', recoveryStart);
const serverStart = source.indexOf('data-hayaku-viewer-panel="server"', recoveryStart);
assert.ok(recoveryStart >= 0 && portableHost > recoveryStart && serverStart > portableHost, 'portable memory card must live inside the Recovery panel');

console.log('PASS hayaku_portable_memory_ui_contract_test');
