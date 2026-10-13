'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const identity = require('./libra_memory_graph_identity.cjs'), readers = require('./libra_memory_graph_readers.cjs');
const pages = require('./libra_memory_graph_pages.cjs');
const begin = '// BEGIN LIBRA MEMORY GRAPH', end = '// END LIBRA MEMORY GRAPH';
const block = () => `    ${begin}\n    const createLibraMemoryGraphIdentity = (${identity.toString()});\n    const createLibraMemoryGraphReaders = (${readers.toString()});\n    const createLibraMemoryGraphPages = (${pages.toString()});\n    ${end}`;
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
    identitySHA256: crypto.createHash('sha256').update(identity.toString()).digest('hex'),
    readersSHA256: crypto.createHash('sha256').update(readers.toString()).digest('hex'),
    pagesSHA256: crypto.createHash('sha256').update(pages.toString()).digest('hex') };
}
module.exports = { sync, block };
if (require.main === module) try { console.log(JSON.stringify(sync({ check: process.argv.includes('--check') }))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
