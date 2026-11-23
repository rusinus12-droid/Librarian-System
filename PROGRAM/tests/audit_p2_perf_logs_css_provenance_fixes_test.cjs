'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
const PLUGINS = path.resolve(__dirname, '../plugins');

test('Stage 4A: LIA log caps (<= 160 debug entries, <= 4096 char sanitize, <= 180000 stored bytes)', () => {
  const src = fs.readFileSync(path.join(PLUGINS, 'LIA_Persona_Linker.js'), 'utf8');
  assert.match(src, /const OPERATION_LOG_MAX = 200;/);
  assert.match(src, /const DEBUG_LOG_MAX = 160;/);
  assert.match(src, /const LOG_MAX_STORED_CHARS = 180000;/);
  assert.match(src, /return limitText\(redacted, 4096\);/);
  assert.match(src, /while \(serialized\.length > LOG_MAX_STORED_CHARS && \(dbg\.length > 1 \|\| ops\.length > 1\)\)/);

  const sliceStart = src.indexOf('const LOG_SCHEMA_VERSION = 1;');
  const sliceEnd = src.indexOf('function normalizeStoredLogEntry');
  assert.ok(sliceStart > 0 && sliceEnd > sliceStart);
  const helperStart = src.indexOf('const asArray =');
  const helperEnd = src.indexOf('async function runWithLiaAiJob');
  const sanitizeStart = src.indexOf('const LOG_SECRET_KEY_RE =');
  const persistStart = src.indexOf('async function persistLogStore()');
  const persistEnd = src.indexOf('function scheduleLogPersist()');

  let storedValue = '';
  const snippet = [
    src.slice(sliceStart, src.indexOf('const PLUGIN_VERSION =')),
    src.slice(helperStart, helperEnd),
    src.slice(sanitizeStart, sliceEnd),
    src.slice(persistStart, persistEnd)
  ].join('\n');

  const ctx = vm.createContext({
    LOG_STORAGE_KEY: 'liaPersonaLinkerLogsV1',
    operationLogEntries: [],
    debugLogEntries: [],
    logsLoaded: true,
    logSequence: 0,
    lastOperationFingerprint: '',
    lastOperationAt: 0,
    scheduleLogPersist() {},
    async readLogStore() {},
    async waitForPluginStorage() { return { async setItem(_k, v) { storedValue = v; return true; } }; },
    getRuntimeApi() { return {}; }
  });
  vm.runInContext(snippet + ';globalThis.__test={sanitizeLogValue,appendDebugLog,persistLogStore};', ctx);
  const longStr = 'A'.repeat(9000);
  assert.equal(ctx.__test.sanitizeLogValue(longStr).length, 4096);
  for (let i = 0; i < 120; i++) ctx.__test.appendDebugLog('gen', 'chunk_' + i, { body: 'X'.repeat(3500) });
  return ctx.__test.persistLogStore().then(ok => {
    assert.equal(ok, true);
    assert.ok(storedValue.length > 0 && storedValue.length <= 180000, `stored chars ${storedValue.length} must be <= 180000`);
  });
});

test('Stage 4B: HAYAKU debug-OFF fast path, compact fingerprint, captureRaw/ledger memo, partial preloaded reuse, conditional .disabled', () => {
  const src = fs.readFileSync(path.join(PLUGINS, 'HAYAKU_Locator_Continuity.js'), 'utf8');
  assert.match(src, /const CAPTURE_RAW_BODY_CACHE_MAX = 128;/);
  assert.match(src, /Memory\.parsedLedgerMemo = \{/);
  assert.match(src, /authoritativeLedger\?\.current\?\.enabled === true\s*\n\s*\? \{ snapshot: authoritativeSnapshot, boundLedger: authoritativeLedger\.current \}/);
  assert.match(src, /if\(input\.disabled!==locked\)input\.disabled=locked;/);

  const idxFp = src.indexOf('const HAYAKU_SIMPLE_MSG_KEYS =');
  const idxFpEnd = src.indexOf('const latestCurrentInputRange =', idxFp);
  assert.ok(idxFp > 0 && idxFpEnd > idxFp);
  const fpCtx = vm.createContext({
    canonicalPromptCacheStringify: v => JSON.stringify(v),
    stableHash64: s => {
      let h = 2166136261n;
      for (let i = 0; i < s.length; i++) { h ^= BigInt(s.charCodeAt(i)); h = BigInt.asUintN(64, h * 1099511628211n); }
      return h.toString(16);
    },
    text: v => String(v ?? ''),
    roleOf: m => String(m?.role || '')
  });
  vm.runInContext(src.slice(idxFp, idxFpEnd) + ';globalThis.fp=hayakuInjectionFingerprint;', fpCtx);
  const msgsA = [{ role: 'user', chatId: 'm1', content: 'Hello '.repeat(50) }, { role: 'assistant', chatId: 'm2', swipeId: 0, content: 'World '.repeat(50) }];
  const msgsB = [{ role: 'user', chatId: 'm1', content: 'Hello '.repeat(50) }, { role: 'assistant', chatId: 'm2', swipeId: 1, content: 'World '.repeat(50) }];
  assert.equal(fpCtx.fp([{}, {}, msgsA, {}]), fpCtx.fp([{}, {}, msgsA, {}]));
  assert.notEqual(fpCtx.fp([{}, {}, msgsA, {}]), fpCtx.fp([{}, {}, msgsB, {}]));
});

test('Stage 4C: Flashback single-scope incremental load, LIBRA light previousResolvedContext / state receipt slice / debug cap / worldline pagination', () => {
  const fb = fs.readFileSync(path.join(PLUGINS, 'Flashback_Memory.js'), 'utf8');
  assert.match(fb, /const additional = await loadSingleScopeRecordsForRecall\(scope\.scopeKey, \{ indexes: additionalIndexes, reason: 'previous_turn_context'/);
  assert.match(fb, /const epLoaded = await loadSingleScopeRecordsForRecall\(scope\.scopeKey, \{ indexes: missingChildShards, reason: 'episode_child_hydration'/);
  assert.match(fb, /if\(input\.disabled!==locked\)input\.disabled=locked;/);

  const libra = fs.readFileSync(path.join(PLUGINS, 'LIBRA.js'), 'utf8');
  assert.match(libra, /state\.previousResolvedContext = \{\s*\n\s*scope: previous\.scope/);
  assert.doesNotMatch(libra, /state\.previousResolvedContext = previous;/);
  assert.match(libra, /const executionReceiptRows = async \(\{kind,worldlineId,expectedScopeKey='',targetId=''\}=\{\}\) =>/);
  assert.match(libra, /if \(allRefs\.length>retention\) refs=allRefs\.slice\(-retention\);/);
  assert.match(libra, /executionReceiptRows\(\{kind,worldlineId,expectedScopeKey,targetId:id\}\)/);
  assert.match(libra, /const formatDebugPreview = \(value, maxChars = 24000\) =>/);
  assert.match(libra, /\.wl-row\{[^}]*content-visibility:auto;contain-intrinsic-size:auto 48px/);
  assert.match(libra, /const WORLDLINE_PAGE_STEP=120;/);
  assert.match(libra, /dataset:\{worldlineShowMore:'true'\}/);
});

test('Stage 4D: Source controls CSS virtualization synced, GRADIA scope bucket + Jaccard caps, and launcher 5MB log rotation', () => {
  const sdk = fs.readFileSync(path.join(ROOT, 'PROGRAM/sdk/MemorySuiteSourceInputControls.source.js'), 'utf8');
  assert.match(sdk, /\.ms-reanalysis-turn--compact\{[^}]*content-visibility:auto;contain-intrinsic-size:auto 168px/);
  assert.match(sdk, /if\(node\.disabled!==nextDisabled\)node\.disabled=nextDisabled;/);
  for (const pluginFile of ['LIBRA.js', 'HAYAKU_Locator_Continuity.js', 'Flashback_Memory.js', 'GRADIA.js']) {
    const pSrc = fs.readFileSync(path.join(PLUGINS, pluginFile), 'utf8');
    assert.match(pSrc, /content-visibility:auto;contain-intrinsic-size:auto 168px/, pluginFile);
  }

  const gradia = fs.readFileSync(path.join(PLUGINS, 'GRADIA.js'), 'utf8');
  assert.match(gradia, /const GRADIA_RUNTIME_SCOPE_MAX = 16;/);
  assert.match(gradia, /const LORE_JACCARD_SIMILARITY_CACHE_LIMIT = 32768;/);
  assert.match(gradia, /const LORE_JACCARD_GRAM_CACHE_LIMIT = 16384;/);

  const { rotateLogFileIfOversized } = require('../tools/platform_launcher.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-log-rot-'));
  try {
    const small = path.join(tmp, 'small.log');
    fs.writeFileSync(small, 'hello');
    assert.equal(rotateLogFileIfOversized(small, 1024), false);
    assert.equal(fs.existsSync(small), true);
    assert.equal(fs.existsSync(small + '.1'), false);

    const big = path.join(tmp, 'server.log');
    fs.writeFileSync(big, Buffer.alloc(2048, 0x41));
    assert.equal(rotateLogFileIfOversized(big, 1024), true);
    assert.equal(fs.existsSync(big), false);
    assert.equal(fs.statSync(big + '.1').size, 2048);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Stage 4E: release_version archives published releases (not drafts) and CI workflows include audit + upstream fail-closed gates', () => {
  const { applyReleaseVersion } = require('../tools/release_version.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-rel-prov-'));
  try {
    const prog = path.join(tmp, 'PROGRAM');
    for (const d of ['server/portable', 'tools', 'docs/release-provenance']) fs.mkdirSync(path.join(prog, d), { recursive: true });
    for (const rel of ['VERSION.txt', 'server/server.cjs', 'release-policy.json', 'server/portable/logical_migration.cjs', 'server/portable/transfer_manager.cjs', 'tools/portable_export_stopped.cjs']) {
      fs.copyFileSync(path.join(ROOT, 'PROGRAM', rel), path.join(prog, rel));
    }
    const provPath = path.join(prog, 'docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json');
    const prov = JSON.parse(fs.readFileSync(path.join(ROOT, 'PROGRAM/docs/release-provenance/PLUGIN_RELEASE_PROVENANCE.json'), 'utf8'));
    const curVer = fs.readFileSync(path.join(prog, 'VERSION.txt'), 'utf8').trim();
    const [maj, min, pat] = curVer.split('.').map(Number);
    const nextVer = `${maj}.${min}.${pat + 1}`;
    const publishedProv = structuredClone(prov);
    publishedProv.currentRelease.archiveSha256 = 'f'.repeat(64);
    publishedProv.currentRelease.sourceState = 'published';
    fs.writeFileSync(provPath, JSON.stringify(publishedProv, null, 2) + '\n');

    applyReleaseVersion(tmp, nextVer);
    const after = JSON.parse(fs.readFileSync(provPath, 'utf8'));
    assert.equal(after.releases.some(r => r.packageVersion === curVer && r.archiveSha256 === 'f'.repeat(64)), true);
    assert.equal(after.currentRelease.packageVersion, nextVer);
    assert.equal(after.currentRelease.archiveSha256, undefined);
    assert.equal(after.currentRelease.sourceState, 'unpublished-source-candidate');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const gateYml = fs.readFileSync(path.join(ROOT, '.github/workflows/release-builder-gate.yml'), 'utf8');
  assert.doesNotMatch(gateYml, /risu-compatibility-gate:/);
  assert.match(gateYml, /audit_p0a_cache_ai_embedding_fixes_test\.cjs/);
  assert.match(gateYml, /audit_p2_perf_logs_css_provenance_fixes_test\.cjs/);

  const risuGateYml = fs.readFileSync(path.join(ROOT, '.github/workflows/risu-compatibility-gate.yml'), 'utf8');
  assert.match(risuGateYml, /uses:\s+\.\/\.github\/workflows\/_risu-compatibility-check\.yml/);

  const manualReleaseYml = fs.readFileSync(path.join(ROOT, '.github/workflows/manual-release.yml'), 'utf8');
  assert.match(manualReleaseYml, /uses:\s+\.\/\.github\/workflows\/_risu-compatibility-check\.yml/);

  const compatYml = fs.readFileSync(path.join(ROOT, '.github/workflows/_risu-compatibility-check.yml'), 'utf8');
  assert.match(compatYml, /UPSTREAM_REPO: \$\{\{ steps\.lock\.outputs\.repository \}\}/);
  assert.match(compatYml, /UPSTREAM_COMMIT: \$\{\{ steps\.lock\.outputs\.commit \}\}/);

  const driftYml = fs.readFileSync(path.join(ROOT, '.github/workflows/risu-upstream-drift.yml'), 'utf8');
  assert.match(driftYml, /steps\.drift\.outputs\.status != 'compatible_pin_current'/);
});
