'use strict';
// Diagnostic for `portable_backup_post_restore_mismatch` — runs the real 3-mode test sequence but
// INSTRUMENTS the storage adapter in memory, so the verify step's disagreement is READ.
//
// Evidence so far (all from the real code, not inference):
//   * the failure is always the `manifest` key, only in mirror/server_only, about 1 in 5 runs;
//   * it happens in the POST-restore verification loop (restoreEnvelope), where every record is
//     re-read through `adapter.get(key)` and compared to the envelope value;
//   * `adapter.get` tries the bridge FIRST, then the compat store, then the raw store. Those can
//     return different things, and `equalValues` compares canonicalised strings;
//   * a neighbouring commit already documents that "a fresh read of the same key also triggers the
//     bridge's mirror reconcile side effect" and that interleaving with "the storage bridge's
//     mirror local/server sequence" broke the 3-mode parity contract 10/10.
//
// What this probe adds: for the mismatching key only, it records WHICH source answered, the raw
// values from every source, and whether the difference is formatting or content.
const fs = require('node:fs');
const path = require('node:path');

const DIAG_ANCHOR = 'const valid = equalValues(actual, expected);\n          if (!valid) throw new Error(`portable_backup_post_restore_mismatch:${record.key}`);';
const DIAG = [
  'const valid = equalValues(actual, expected);',
  'if (!valid) {',
  '  try {',
  '    const snap = async k => {',
  '      const out = { key: k };',
  '      try { out.bridge = await bridge.get("plugin", k); } catch (e) { out.bridgeError = String(e?.message || e).slice(0,80); }',
  '      try { out.compat = await callFirst(compat, ["getStorageItem","getItem"], [k, null]); } catch (e) { out.compatError = String(e?.message || e).slice(0,80); }',
  '      try { out.raw = await raw.getItem(k); } catch (e) { out.rawError = String(e?.message || e).slice(0,80); }',
  '      out.bridgeType = typeof out.bridge; out.rawType = typeof out.raw;',
  '      out.bridgeLen = typeof out.bridge === "string" ? out.bridge.length : null;',
  '      out.rawLen = typeof out.raw === "string" ? out.raw.length : null;',
  '      const c = v => typeof v === "string" ? v : JSON.stringify(v);',
  '      out.bridgeHead = c(out.bridge || "").slice(0, 400);',
  '      out.rawHead = c(out.raw || "").slice(0, 400);',
  '      out.compatHead = c(out.compat || "").slice(0, 400);',
  '      return out;',
  '    };',
  '    const payload = {',
  '      recordKey: record.key, kind: record.kind,',
  '      expectedHead: JSON.stringify(expected || "").slice(0, 400),',
  '      actualHead: JSON.stringify(actual || "").slice(0, 400),',
  '      expectedEqualActual: equalValues(expected, actual),',
  '      sources: await snap(record.key)',
  '    };',
  '    fs.writeFileSync("/tmp/restore_source_dump.json", JSON.stringify(payload, null, 2));',
  '  } catch (e) {}',
  '  throw new Error(`portable_backup_post_restore_mismatch:${record.key}`);',
  '}'
].join('\n');

const instrument = source => {
  if (!source.includes(DIAG_ANCHOR)) throw new Error(`anchor missing (has ${source.includes('portable_backup_post_restore_mismatch')})`);
  return source.replace(DIAG_ANCHOR, DIAG);
};

(async () => {
  const { serverFixture } = require(path.join(__dirname, '..', 'tests', 'fixtures', 'libra_server_runtime_fixture.cjs'));
  const MODES = ['plugin_only', 'mirror', 'server_only'];
  const runs = Number(process.env.PROBE_RUNS || 10);
  let failures = 0;

  for (let attempt = 1; attempt <= runs; attempt += 1) {
    for (const mode of MODES) {
      fs.rmSync('/tmp/restore_source_dump.json', { force: true });
      const snapshot = await serverFixture({ mode, transformSource: instrument });
      try {
        await snapshot.f.r.api.runManualColdStart({});
        let portable = null;
        for (let i = 0; i < 500; i += 1) {
          if (snapshot.f.r.context.__LIBRAPortableMemoryBackup) { portable = snapshot.f.r.context.__LIBRAPortableMemoryBackup; break; }
          await new Promise(r => setTimeout(r, 10));
        }
        if (!portable) throw new Error('portable API missing');
        const retry = async (op) => {
          for (let i = 0; i < 40; i += 1) {
            try { return await op(); } catch (error) {
              if (!/BUSY/.test(String(error?.code || ''))) throw error;
              await new Promise(r => setTimeout(r, 250));
            }
          }
          throw new Error('busy');
        };
        const envelope = await retry(() => portable.exportCurrentScope());
        const manifestBefore = snapshot.getManifest();
        const extraKey = `libra:v1:scope:${manifestBefore?.scopeKey || 'seventh-server-scope'}:extra-not-in-backup`;
        if (snapshot.local.has(extraKey)) snapshot.local.delete(extraKey);
        await retry(() => portable.restoreCurrentScope(envelope));
      } catch (error) {
        failures += 1;
        const dump = fs.existsSync('/tmp/restore_source_dump.json')
          ? JSON.parse(fs.readFileSync('/tmp/restore_source_dump.json', 'utf8')) : null;
        console.log(JSON.stringify({ attempt, mode, error: String(error?.message || error).slice(0, 180), dump }, null, 1));
        process.exitCode = failures ? 1 : 0;
        return;
      } finally {
        await snapshot.cleanup();
      }
    }
    process.stdout.write(`attempt ${attempt}: all modes ok\n`);
  }
  console.log(JSON.stringify({ runs, failures }, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
