'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createMemorySuiteServer } = require('../server/server.cjs');

const ROOT = path.resolve(__dirname, '../..');
const PROGRAM = path.join(ROOT, 'PROGRAM');

test('Stage 5.1: 1_서버_실행.bat releases PROGRAM cwd before every pause', () => {
  const bat = fs.readFileSync(path.join(PROGRAM, '1_서버_실행.bat'), 'utf8');
  const lines = bat.split(/\r?\n/).map(l => l.trim());
  const pauseIndexes = [];
  lines.forEach((line, idx) => {
    if (/^pause$/i.test(line)) pauseIndexes.push(idx);
  });
  assert.equal(pauseIndexes.length, 2, '1_서버_실행.bat must have both missing-runner and exit pauses');
  for (const idx of pauseIndexes) {
    assert.ok(idx > 0 && /^cd \/d "%~dp0\.\."$/i.test(lines[idx - 1]),
      `pause at line ${idx + 1} must be immediately preceded by cd /d "%~dp0.."`);
  }
});

test('Stage 5.2: UPDATER program-only & migration-required clean .update/download after commit', () => {
  for (const rel of ['UPDATER/core/program-only.cjs', 'UPDATER/core/migration-required.cjs']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(src, /const downloadDir = path\.join\(updateDir,\s*'download'\)/, `${rel} must define downloadDir`);
    assert.match(src, /!fs\.lstatSync\(downloadDir\)\.isSymbolicLink\(\)/, `${rel} must reject symlinked downloadDir`);
    assert.match(src, /fs\.rmSync\(downloadDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/, `${rel} must remove downloadDir on commit`);
  }
});

test('Stage 5.3: server.cjs removes all unbounded readBody(request) calls and rejects oversized manager/admin JSON with HTTP 413', async () => {
  const serverSrc = fs.readFileSync(path.join(PROGRAM, 'server/server.cjs'), 'utf8');
  const unboundedMatches = serverSrc.match(/readBody\(\s*request\s*\)/g) || [];
  assert.equal(unboundedMatches.length, 0, 'server.cjs must have zero unbounded readBody(request) calls');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-stage5-body-limit-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir: dir, autoBackup: false });
  const addr = await app.listen();
  try {
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const mgrBoot = await fetch(`${baseUrl}/bootstrap`, {
      headers: { 'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge' }
    }).then(r => r.json());
    assert.equal(mgrBoot.ok, true);

    const oversizedResetBody = JSON.stringify({ pad: 'A'.repeat(70 * 1024), namespaces: ['libra'] });
    const resetRes = await fetch(`${baseUrl}/v1/manager/reset/plan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mgrBoot.token}`,
        'X-Memory-Suite-Plugin': 'flashback_hayaku_bridge',
        'Content-Type': 'application/json'
      },
      body: oversizedResetBody
    });
    assert.equal(resetRes.status, 413);
    assert.equal((await resetRes.json()).error, 'manager_reset_body_too_large');

    const adminRes = await fetch(`${baseUrl}/v1/admin/backups/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${app.token}`,
        'X-Memory-Suite-Admin': '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ kind: 'manual', label: 'B'.repeat(70 * 1024) })
    });
    assert.equal(adminRes.status, 413);
    assert.equal((await adminRes.json()).error, 'admin_body_too_large');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Stage 5.4: Flashback dot() accepts Array and Float32Array and hydrateFlashbackVectorRecords uses single-pass Float32 indexing', () => {
  const fbSrc = fs.readFileSync(path.join(PROGRAM, 'plugins/Flashback_Memory.js'), 'utf8');
  const dotIdx = fbSrc.indexOf('  const dot = (a, b) => {');
  assert.ok(dotIdx > 0, 'Flashback dot definition present');
  const dotEnd = fbSrc.indexOf('\n  };', dotIdx) + 5;
  const ctx = vm.createContext({});
  vm.runInContext(fbSrc.slice(dotIdx, dotEnd) + '\nglobalThis.dot = dot;', ctx);

  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0.6, 0.8, 0]);
  assert.ok(Math.abs(ctx.dot(a, b) - 0.6) < 1e-6);
  assert.ok(Math.abs(ctx.dot([1, 0, 0], b) - 0.6) < 1e-6);
  assert.equal(ctx.dot(new DataView(new ArrayBuffer(8)), [1, 0]), 0);

  const hydStart = fbSrc.indexOf('  const hydrateFlashbackVectorRecords = async');
  const hydEnd = fbSrc.indexOf('  const removeFlashbackLocalVectorShard =', hydStart);
  assert.ok(hydStart > 0 && hydEnd > hydStart);
  const hydSlice = fbSrc.slice(hydStart, hydEnd);
  assert.doesNotMatch(hydSlice, /Array\.from\(\s*\{\s*length:\s*ref\.length/, 'single-pass hydration must avoid Array.from callback overhead');
  assert.match(hydSlice, /floats instanceof Float32Array/, 'single-pass hydration should check Float32Array fast path');
});

test('Stage 5.5: LIBRA storage.keys forwards prefix and hot-path scanners pass scoped prefixes', () => {
  const libraSrc = fs.readFileSync(path.join(PROGRAM, 'plugins/LIBRA.js'), 'utf8');
  assert.match(libraSrc, /async keys\(prefix = ''\) \{[\s\S]{0,300}await runtime\.pluginStorage\.keys\(wanted\)/);
  assert.match(libraSrc, /for \(const storageKey of await storage\.keys\(`\$\{prefix\}micro-`\)\)/);
  assert.match(libraSrc, /storage\.keys\(scopePrefix\)/);
  assert.match(libraSrc, /storage\.keys\(jobPrefix\)/);
});

test('Stage 5.6: risu-upstream-drift.yml passes resolved --head-commit SHA to verifier', () => {
  const driftYml = fs.readFileSync(path.join(ROOT, '.github/workflows/risu-upstream-drift.yml'), 'utf8');
  assert.match(driftYml, /HEAD_COMMIT=\$\(git -C \.risuai-upstream-head rev-parse HEAD\)/);
  assert.match(driftYml, /--head-commit "\$HEAD_COMMIT"/);
  assert.match(driftYml, /Head Commit/);
});

test('Stage 5.7: sourceRuleSync.ask keeps timeout refd and settles pending promises on dispose', () => {
  const sdkSrc = fs.readFileSync(path.join(PROGRAM, 'sdk/MemorySuiteSourceInputControls.source.js'), 'utf8');
  const askStart = sdkSrc.indexOf('  const ask=async(');
  const askEnd = sdkSrc.indexOf('  const compare=async(', askStart);
  assert.ok(askStart > 0 && askEnd > askStart);
  const askSlice = sdkSrc.slice(askStart, askEnd);
  assert.doesNotMatch(askSlice, /record\.timer\?\.unref/, 'awaited ask() timer must stay refd to avoid premature event-loop drain');
  assert.match(sdkSrc, /record\.resolve\(\{ok:false,error:'SOURCE_RULE_SYNC_DISPOSED'\}\)/);
});
