'use strict';
// Reproduce the mirror restore mismatch by running the test's OWN sequence, not an approximation.
//
// Why earlier probes missed it: they never ran the three modes in order inside ONE process. Two
// facts only hold in that sequence —
//   * `portableRestore` runs for `plugin_only` FIRST, and the fixture's local map is seeded with a
//     scope-registry pointing at `seventh-server-scope`, shared by every later mode;
//   * between export and restore the test DELETES a scope-local extra record from the local map
//     (`extra-not-in-backup`), so the local mirror and the server diverge on purpose.
// Mirror is the mode that reads BOTH, which is where the verify step then disagrees on `manifest`.
//
// This probe mirrors the real sequence and, on mismatch, prints the expected/actual manifest so the
// cause is read rather than inferred. Plugin source is instrumented in memory only.
const fs = require('node:fs');
const path = require('node:path');

const VERIFY_ANCHOR = 'if (!valid) throw new Error(`portable_backup_post_restore_mismatch:${record.key}`);';
const INSTRUMENT = [
  'if (!valid) {',
  '  try {',
  '    const s = v => v && typeof v === "object" ? { schema: v.schema || "", keys: Object.keys(v).sort(),',
  '      len: JSON.stringify(v).length, revision: v.revision ?? null,',
  '      committed: v.memories ? Object.keys(v.memories).length : null,',
  '      inFlight: v.inFlight ?? null, failedBatches: v.failedBatches ? Object.keys(v.failedBatches) : null,',
  '      generatedAt: v.generatedAt || v.updatedAt || "" } : { scalar: String(v) };',
  '    fs.writeFileSync("/tmp/restore_mismatch_dump.json", JSON.stringify({ key: record.key, kind: record.kind,',
  '      expected: s(expected), actual: s(actual),',
  '      expectedMemStarts: expected && expected.memories ? Object.keys(expected.memories) : null,',
  '      actualMemStarts: actual && actual.memories ? Object.keys(actual.memories) : null,',
  '      expectedJson: JSON.stringify(expected).slice(0, 2500),',
  '      actualJson: JSON.stringify(actual).slice(0, 2500) }, null, 2));',
  '  } catch (_) {}',
  '  throw new Error(`portable_backup_post_restore_mismatch:${record.key}`);',
  '}'
].join('\n');

const instrument = source => {
  if (!source.includes(VERIFY_ANCHOR)) throw new Error('verify anchor missing');
  return source.replace(VERIFY_ANCHOR, INSTRUMENT);
};

(async () => {
  const { serverFixture } = require(path.join(__dirname, '..', 'tests', 'fixtures', 'libra_server_runtime_fixture.cjs'));
  const MODES = ['plugin_only', 'mirror', 'server_only'];
  const observations = [];

  const runMode = async (mode, attempt) => {
    fs.rmSync('/tmp/restore_mismatch_dump.json', { force: true });
    const snapshot = await serverFixture({ mode, transformSource: instrument });
    try {
      const api = snapshot.f.r.api;
      await api.runManualColdStart({});
      let portable = null;
      for (let i = 0; i < 500; i += 1) {
        if (snapshot.f.r.context.__LIBRAPortableMemoryBackup) { portable = snapshot.f.r.context.__LIBRAPortableMemoryBackup; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      if (!portable) throw new Error('portable API did not appear');
      const retry = async (op, label) => {
        let last = null;
        for (let i = 0; i < 40; i += 1) {
          try { return await op(); } catch (error) {
            if (!/BUSY/.test(String(error?.code || ''))) throw error;
            last = error; await new Promise(r => setTimeout(r, 250));
          }
        }
        throw new Error(`stayed busy: ${label}`);
      };
      const envelope = await retry(() => portable.exportCurrentScope(), `${mode} export`);
      // Mirror the test: drop the scope-local extra record the backup does not contain.
      const manifestBefore = snapshot.getManifest();
      const scopeKey = manifestBefore?.scopeKey || 'seventh-server-scope';
      const extraKey = `libra:v1:scope:${scopeKey}:extra-not-in-backup`;
      if (snapshot.local.has(extraKey)) snapshot.local.delete(extraKey);
      const restored = await retry(() => portable.restoreCurrentScope(envelope), `${mode} restore`);
      return { ok: restored?.ok === true };
    } finally {
      await snapshot.cleanup();
    }
  };

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    for (const mode of MODES) {
      try {
        const result = await runMode(mode, attempt);
        observations.push({ attempt, mode, result: 'PASS', ok: result.ok });
      } catch (error) {
        const dump = fs.existsSync('/tmp/restore_mismatch_dump.json')
          ? JSON.parse(fs.readFileSync('/tmp/restore_mismatch_dump.json', 'utf8')) : null;
        observations.push({ attempt, mode, result: 'FAIL', error: String(error?.message || error).slice(0, 200), dump });
        if (dump) {
          console.log(JSON.stringify({ FAILURE: observations[observations.length - 1] }, null, 1));
          process.stdout.write(JSON.stringify({ attemptsDone: observations.length, failures: 1 }, null, 1) + '\n');
          process.exitCode = 0;
          return;
        }
      }
    }
  }
  console.log(JSON.stringify({ attempts: 6 * MODES.length, failures: observations.filter(o => o.result === 'FAIL').length, observations: observations.slice(0, 20) }, null, 1).slice(0, 6000));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
