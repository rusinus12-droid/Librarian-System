'use strict';
// Diagnose the mirror-mode restore mismatch by instrumenting the plugin IN MEMORY.
//
// The failure is stable (2 of 10 runs, always `...:manifest`, only mirror/server_only) and always
// at the same verify step. This probe wraps the plugin source the fixture loads — the shipped file
// is never touched — and on mismatch writes the expected and actual manifest shapes to a file, so
// the cause is READ rather than inferred. It also records whether the mismatch is a content
// difference or a structural one (different keys), and which side has more memories.
const fs = require('node:fs');
const path = require('node:path');
// Repository-relative: an absolute path here meant this probe only ran on the machine it was
// written on, while `path` was already imported for exactly this purpose.
const { serverFixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_server_runtime_fixture.cjs'));

const VERIFY_ANCHOR = '          if (!valid) throw new Error(`portable_backup_post_restore_mismatch:${record.key}`);';
const PROBE = [
  '          if (!valid) {',
  '            try {',
  '              const summarize = v => {',
  '                if (v === null || v === undefined) return { type: String(v) };',
  '                if (typeof v !== "object") return { type: typeof v, raw: String(v).slice(0, 300) };',
  '                return { schema: v.schema || "", keys: Object.keys(v).sort().slice(0, 30),',
  '                  jsonLen: JSON.stringify(v).length, revision: v.revision ?? null,',
  '                  committed: v.memories ? Object.keys(v.memories).length : null,',
  '                  inFlight: v.inFlight ? String(v.inFlight.status || "") : "",',
  '                  failedBatches: v.failedBatches ? Object.keys(v.failedBatches).length : null,',
  '                  generatedAt: v.generatedAt || v.updatedAt || "" };',
  '              };',
  '              fs.writeFileSync("/tmp/restore_mismatch_dump.json", JSON.stringify({',
  '                key: record.key, kind: record.kind,',
  '                expected: summarize(expected), actual: summarize(actual),',
  '                expectedJson: JSON.stringify(expected).slice(0, 3000),',
  '                actualJson: JSON.stringify(actual).slice(0, 3000)',
  '              }, null, 2));',
  '            } catch (_) {}',
  '            throw new Error(`portable_backup_post_restore_mismatch:${record.key}`);',
  '          }'
].join('\n');

const instrument = source => {
  if (!source.includes(VERIFY_ANCHOR)) throw new Error('verify anchor missing');
  return source.replace(VERIFY_ANCHOR, PROBE);
};

(async () => {
  const attempts = 12;
  let failures = 0, passes = 0;
  const observed = [];
  for (let i = 0; i < attempts; i += 1) {
    fs.rmSync('/tmp/restore_mismatch_dump.json', { force: true });
    const snapshot = await serverFixture({ mode: 'mirror', transformSource: instrument });
    try {
      const api = snapshot.f.r.api;
      await api.runManualColdStart({});
      let portable = null;
      for (let k = 0; k < 500; k += 1) {
        if (snapshot.f.r.context.__LIBRAPortableMemoryBackup) { portable = snapshot.f.r.context.__LIBRAPortableMemoryBackup; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      if (!portable) throw new Error('portable API did not appear');
      const retry = async (operation, label) => {
        let last = null;
        for (let k = 0; k < 40; k += 1) {
          try { return await operation(); }
          catch (error) {
            const code = String(error?.code || '');
            if (code !== 'LIBRA_WORLD_MANAGER_BUSY' && !/BUSY/.test(code)) throw error;
            last = error;
            await new Promise(r => setTimeout(r, 250));
          }
        }
        throw new Error(`stayed busy: ${label}`);
      };
      const envelope = await retry(() => portable.exportCurrentScope(), 'export');
      await retry(() => portable.restoreCurrentScope(envelope), 'restore');
      passes += 1;
    } catch (error) {
      failures += 1;
      const dump = fs.existsSync('/tmp/restore_mismatch_dump.json')
        ? JSON.parse(fs.readFileSync('/tmp/restore_mismatch_dump.json', 'utf8'))
        : null;
      observed.push({ attempt: i + 1, error: String(error?.message || error).slice(0, 160), dump });
    } finally {
      await snapshot.cleanup();
    }
  }
  console.log(JSON.stringify({ attempts, passes, failures, observed }, null, 1).slice(0, 12000));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
