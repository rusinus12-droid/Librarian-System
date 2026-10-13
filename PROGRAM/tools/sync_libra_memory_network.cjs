'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const factory = require('./libra_memory_network.cjs');
const defaultTarget = path.join(__dirname, '../plugins/LIBRA.js');
const begin = '// BEGIN LIBRA MEMORY NETWORK', end = '// END LIBRA MEMORY NETWORK';
const block = () => `    ${begin}\n    const createLibraMemoryNetwork = (${factory.toString()});\n    ${end}`;
function sync({ target = defaultTarget, check = false } = {}) {
  const before = fs.readFileSync(target, 'utf8');
  const starts = [...before.matchAll(/^[ \t]*\/\/ BEGIN LIBRA MEMORY NETWORK[ \t]*$/gm)];
  const ends = [...before.matchAll(/^[ \t]*\/\/ END LIBRA MEMORY NETWORK[ \t]*$/gm)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw new Error('LIBRA network marker missing, duplicate or reversed: ' + target);
  const after = before.slice(0, starts[0].index) + block() + before.slice(ends[0].index + ends[0][0].length);
  if (check && after !== before) throw new Error('LIBRA network synchronization mismatch: ' + target);
  if (!check && after !== before) {
    const temp = target + '.network.sync.tmp';
    try { fs.writeFileSync(temp, after); fs.renameSync(temp, target); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { checked: check, changed: after !== before, factorySHA256: crypto.createHash('sha256').update(factory.toString()).digest('hex') };
}
module.exports = { sync, block };
if (require.main === module) try { console.log(JSON.stringify(sync({ check: process.argv.includes('--check') }))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
