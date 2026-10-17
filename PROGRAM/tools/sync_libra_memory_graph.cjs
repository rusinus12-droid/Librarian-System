'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const identity = require('./libra_memory_graph_identity.cjs'), readers = require('./libra_memory_graph_readers.cjs');
const pages = require('./libra_memory_graph_pages.cjs');
const store = require('./libra_memory_graph_store.cjs');
const index = require('./libra_memory_graph_index.cjs');
const corpus = require('./libra_memory_graph_corpus.cjs');
const lane = require('./libra_memory_graph_lane.cjs');
const query = require('./libra_memory_graph_query.cjs');
const semantic = require('./libra_memory_graph_semantic.cjs');
const compiler = require('./libra_memory_graph_compiler.cjs');
const rollout = require('./libra_memory_graph_rollout.cjs');
const inventory = require('./libra_memory_graph_inventory.cjs');
const representation = require('./libra_memory_graph_representation.cjs');
const resources = require('./libra_memory_graph_resources.cjs');
const localStore = require('./libra_memory_graph_local_store.cjs');
const begin = '// BEGIN LIBRA MEMORY GRAPH', end = '// END LIBRA MEMORY GRAPH';
const block = () => `    ${begin}\n    const createLibraMemoryGraphLocalStore = (${localStore.toString()});\n    const createLibraMemoryGraphResources = (${resources.toString()});\n    const createLibraMemoryGraphIdentity = (${identity.toString()});\n    const createLibraMemoryGraphReaders = (${readers.toString()});\n    const createLibraMemoryGraphPages = (${pages.toString()});\n    const createLibraMemoryGraphStore = (${store.toString()});\n    const createLibraMemoryGraphIndex = (${index.toString()});\n    const createLibraMemoryGraphCorpus = (${corpus.toString()});\n    const createLibraMemoryGraphLane = (${lane.toString()});\n    const createLibraMemoryGraphQuery = (${query.toString()});\n    const createLibraMemoryGraphSemantic = (${semantic.toString()});\n    const createLibraMemoryGraphCompiler = (${compiler.toString()});\n    const createLibraMemoryGraphRollout = (${rollout.toString()});\n    const createLibraMemoryGraphInventory = (${inventory.toString()});\n    const createLibraMemoryGraphRepresentation = (${representation.toString()});\n    ${end}`;
function sync({ target = path.join(__dirname, '../plugins/LIBRA.js'), check = false } = {}) {
  const before = fs.readFileSync(target, 'utf8');
  const starts = [...before.matchAll(/^[ \t]*\/\/ BEGIN LIBRA MEMORY GRAPH[ \t]*$/gm)];
  const ends = [...before.matchAll(/^[ \t]*\/\/ END LIBRA MEMORY GRAPH[ \t]*$/gm)];
  let after;
  if (!starts.length && !ends.length && !check) {
    const anchors = [...before.matchAll(/^[ \t]*\/\/ END LIBRA MEMORY NETWORK[ \t]*$/gm)];
    if (anchors.length !== 1) throw new Error('LIBRA graph insertion anchor ambiguous');
    const at = anchors[0].index + anchors[0][0].length;
    after = before.slice(0, at) + '\n' + block() + before.slice(at);
  } else {
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw new Error('LIBRA graph marker missing, duplicate or reversed');
    after = before.slice(0, starts[0].index) + block() + before.slice(ends[0].index + ends[0][0].length);
  }
  if (check && after !== before) throw new Error('LIBRA graph synchronization mismatch');
  if (!check && after !== before) {
    const temporary = target + '.graph.sync.tmp';
    try { fs.writeFileSync(temporary, after); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { checked: check, changed: after !== before,
    localStoreSHA256: crypto.createHash('sha256').update(localStore.toString()).digest('hex'),
    identitySHA256: crypto.createHash('sha256').update(identity.toString()).digest('hex'),
    readersSHA256: crypto.createHash('sha256').update(readers.toString()).digest('hex'),
    pagesSHA256: crypto.createHash('sha256').update(pages.toString()).digest('hex'),
    storeSHA256: crypto.createHash('sha256').update(store.toString()).digest('hex'),
    indexSHA256: crypto.createHash('sha256').update(index.toString()).digest('hex'),
    laneSHA256: crypto.createHash('sha256').update(lane.toString()).digest('hex'),
    semanticSHA256: crypto.createHash('sha256').update(semantic.toString()).digest('hex'),
    querySHA256: crypto.createHash('sha256').update(query.toString()).digest('hex'),
    compilerSHA256: crypto.createHash('sha256').update(compiler.toString()).digest('hex'),
    rolloutSHA256: crypto.createHash('sha256').update(rollout.toString()).digest('hex') };
}
module.exports = { sync, block };
if (require.main === module) try { console.log(JSON.stringify(sync({ check: process.argv.includes('--check') }))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
