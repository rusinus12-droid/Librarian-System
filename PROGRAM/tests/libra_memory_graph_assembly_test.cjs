'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { sync, block } = require('../tools/sync_libra_memory_graph.cjs');
const network = require('../tools/sync_libra_memory_network.cjs');
const { buildPlugins } = require('../tools/build_plugins.cjs');
(async () => {
  assert.equal(sync({ check: true }).changed, false, 'the shipped plugin embeds all exact graph factories');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-graph-assembly-'));
  try {
    const target = path.join(tmp, 'LIBRA.js');
    for (const source of ['const empty = true;', block().replace('createLibraMemoryGraphReaders', 'staleReaders'),
      block().replace('createLibraMemoryGraphIdentity', 'staleIdentity'), `${block()}\n${block()}`,
      block().replace('createLibraMemoryGraphPages', 'stalePages'),
      block().replace('createLibraMemoryGraphStore', 'staleStore'),
      block().replace('createLibraMemoryGraphIndex', 'staleIndex'),
      block().replace('createLibraMemoryGraphLane', 'staleLane'),
      block().replace('createLibraMemoryGraphQuery', 'staleQuery'),
      block().replace('createLibraMemoryGraphCompiler', 'staleCompiler'),
      block().replace('createLibraMemoryGraphRollout', 'staleRollout'),
      '// END LIBRA MEMORY GRAPH\n// BEGIN LIBRA MEMORY GRAPH']) {
      fs.writeFileSync(target, source);
      assert.throws(() => sync({ target, check: true }), /marker|synchronization/i);
    }
    fs.writeFileSync(target, network.block());
    assert.equal(sync({ target }).changed, true);
    assert.equal(fs.readFileSync(target, 'utf8'), network.block() + '\n' + block());
    assert.equal(sync({ target, check: true }).changed, false);
    fs.writeFileSync(target, network.block() + '\n' + network.block());
    assert.throws(() => sync({ target }), /anchor ambiguous/);
    const programDir = path.join(tmp, 'PROGRAM');
    fs.mkdirSync(path.join(programDir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(programDir, 'plugins/LIBRA.js'), network.block());
    await assert.rejects(buildPlugins({ only: 'libra', programDir, profile: 'source', outDir: path.join(tmp, 'out') }),
      /graph.*marker/i, 'the builder refuses a valid legacy network with missing new reader factories');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log('libra_memory_graph_assembly_test: PASS');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
