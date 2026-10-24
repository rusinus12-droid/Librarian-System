'use strict';
const fs = require('node:fs'), path = require('node:path');
const factory = require('./memory_suite_current_status.cjs');
const begin = '  /* MEMORY SUITE CURRENT STATUS START */', end = '  /* MEMORY SUITE CURRENT STATUS END */';
const block = `${begin}\n  const createMemorySuiteCurrentStatus = (${factory.toString()});\n${end}`;
function sync({ root = path.resolve(__dirname, '..'), check = false } = {}) {
  let changed = false;
  for (const [file, anchor] of [['HAYAKU_Locator_Continuity.js','  const HayakuCurrentStatus ='],['Flashback_Memory.js','  const FlashbackCurrentStatus =']]) {
    const target = path.join(root, 'plugins', file), source = fs.readFileSync(target, 'utf8');
    const start = source.indexOf(begin), stop = source.indexOf(end);
    if (start >= 0 && stop < start) throw Error('current_status_block_invalid:' + file);
    if (start < 0 && !source.includes(anchor)) throw Error('current_status_anchor_missing:' + file);
    const output = start < 0 ? source.replace(anchor, block + '\n\n' + anchor)
      : source.slice(0, start) + block + source.slice(stop + end.length);
    if (output.replace(/\r\n/g,'\n') !== source.replace(/\r\n/g,'\n')) {
      changed = true; if (!check) fs.writeFileSync(target, output);
    }
  }
  if (changed && check) throw Error('current_status_embed_stale');
  return { changed, checked:check };
}
if (require.main === module) console.log(JSON.stringify(sync({ check:process.argv.includes('--check') })));
module.exports = { sync };
