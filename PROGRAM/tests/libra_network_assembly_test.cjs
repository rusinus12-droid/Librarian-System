'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const factoryPath = path.join(__dirname, '../tools/libra_memory_network.cjs');
assert.ok(fs.existsSync(factoryPath), 'A1 requires an assembled canonical network factory');
const { sync, block } = require('../tools/sync_libra_memory_network.cjs');
const { buildPlugins } = require('../tools/build_plugins.cjs');
(async () => {
  const plugin = path.join(__dirname, '../plugins/LIBRA.js');
  assert.equal(sync({ target: plugin, check: true }).changed, false);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-network-assembly-'));
  try {
    const target = path.join(tmp, 'LIBRA.js');
    for (const [label, source] of [['missing', 'const noop = true;'], ['stale', block().replace('createLibraMemoryNetwork', 'staleNetwork')], ['duplicate', `${block()}\n${block()}`], ['reversed', '// END LIBRA MEMORY NETWORK\n// BEGIN LIBRA MEMORY NETWORK']]) {
      fs.writeFileSync(target, source);
      assert.throws(() => sync({ target, check: true }), /marker|synchronization/i, label);
    }
    fs.writeFileSync(target, block().replace('createLibraMemoryNetwork', 'oldNetwork'));
    assert.equal(sync({ target }).changed, true);
    assert.equal(fs.readFileSync(target, 'utf8'), block(), 'synchronizer installs exact pure factory source');
    assert.equal(sync({ target, check: true }).changed, false);
    const programDir = path.join(tmp, 'PROGRAM');
    fs.mkdirSync(path.join(programDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(programDir, 'plugins/LIBRA.js'), 'const noop = true;');
    await assert.rejects(buildPlugins({ only: 'libra', programDir, profile: 'source', outDir: path.join(tmp, 'out') }), /network.*marker/i, 'assembly fails closed before publishing a plugin missing the registry');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('libra_network_assembly_test: PASS');
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
