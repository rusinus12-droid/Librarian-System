'use strict';
const fs = require('node:fs'), path = require('node:path');
const factory = require('./memory_suite_chat_status.cjs');
const begin = '  /* MEMORY SUITE CHAT STATUS START */', end = '  /* MEMORY SUITE CHAT STATUS END */';
const block = `${begin}\n  const createMemorySuiteChatStatus = (${factory.toString()});\n${end}`;
const norm = s => String(s || '').replace(/\r\n/g, '\n');
const sync = ({ root = path.resolve(__dirname, '..'), check = false, plugins = ['LIBRA.js','GRADIA.js'] } = {}) => {
  let changed = false;
  for (const name of plugins) {
    if (!['LIBRA.js','GRADIA.js'].includes(name)) throw new Error('chat_status_owner_invalid');
    const file = path.join(root, 'plugins', name), source = fs.readFileSync(file, 'utf8');
    const start = source.indexOf(begin), stop = source.indexOf(end);
    let output;
    if (start < 0) {
      const anchor = name === 'LIBRA.js' ? '  let PipelineWorkPanelTimer = null;' : '  let InputAssistContinuePanelTimer = null;';
      if (!source.includes(anchor)) throw new Error(`chat_status_anchor_missing:${name}`);
      output = source.replace(anchor, `${block}\n\n${anchor}`);
    } else {
      if (stop < start) throw new Error(`chat_status_block_invalid:${name}`);
      const existing = source.slice(start, stop + end.length);
      const eol = existing.includes('\r\n') ? '\r\n' : '\n';
      const replacement = block.replace(/\r?\n/g, eol);
      output = source.slice(0, start) + replacement + source.slice(stop + end.length);
    }
    if (norm(source) !== norm(output)) {
      changed = true;
      if (!check) fs.writeFileSync(file, output);
    }
  }
  if (changed && check) throw new Error('chat_status_embed_stale');
  return { changed, checked:check };
};
if (require.main === module) console.log(JSON.stringify(sync({ check:process.argv.includes('--check') })));
module.exports = { sync };
