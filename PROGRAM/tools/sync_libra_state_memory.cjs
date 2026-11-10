'use strict';
const fs = require('node:fs'), path = require('node:path');
const factories = [
  ['createLibraMemoryFingerprint', require('./libra_memory_fingerprint.cjs')],
  ['createLibraStateMemoryEngine', require('./libra_state_memory_engine.cjs')],
  ['createLibraStateMemoryCapture', require('./libra_state_memory_capture.cjs')],
  ['createLibraStateMemoryRuntime', require('./libra_state_memory_runtime.cjs')]
];
const start = '    // BEGIN LIBRA STATE MEMORY', end = '    // END LIBRA STATE MEMORY';
const target = path.join(__dirname, '../plugins/LIBRA.js');
const before = fs.readFileSync(target, 'utf8');
const a = before.indexOf(start), b = before.indexOf(end);
if (a < 0 || b <= a) throw Error('LIBRA_STATE_MEMORY_MARKER_MISSING');
const block = start + '\n' + factories.map(([name, factory]) => '    const ' + name + ' = (' + factory.toString() + ');').join('\n') + '\n' + end;
let after = before.slice(0, a) + block + before.slice(b + end.length);
const ownerStart = '    // BEGIN LIBRA STATE OWNER', ownerEnd = '    // END LIBRA STATE OWNER';
const ownerA = after.indexOf(ownerStart), ownerB = after.indexOf(ownerEnd);
if (ownerA < 0 || ownerB <= ownerA) throw Error('LIBRA_STATE_OWNER_MARKER_MISSING');
after = after.slice(0, ownerA) + ownerStart + '\n' + fs.readFileSync(path.join(__dirname, '../sdk/LibraStateMemoryOwner.source.js'), 'utf8').trimEnd()
  + '\n' + ownerEnd + after.slice(ownerB + ownerEnd.length);
if (process.argv.includes('--check')) { if (before !== after) throw Error('LIBRA_STATE_MEMORY_EMBED_STALE'); }
else if (before !== after) fs.writeFileSync(target, after);
console.log(JSON.stringify({ checked: process.argv.includes('--check'), changed: before !== after }));
