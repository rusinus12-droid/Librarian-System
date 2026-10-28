'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const PRODUCTS = ['LIBRA.js', 'HAYAKU_Locator_Continuity.js', 'Flashback_Memory.js'];
const START = '/* MEMORY SUITE SOURCE TURN ACCOUNTING v1 — BEGIN';
const END = '/* MEMORY SUITE SOURCE TURN ACCOUNTING v1 — END */';
function synchronize({root = path.resolve(__dirname, '..'), check = false} = {}) {
  const shared = fs.readFileSync(path.join(root, 'sdk/MemorySuiteSourceTurnAccounting.source.js'), 'utf8').trimEnd();
  new vm.Script(shared);
  if (!shared.startsWith(START) || !shared.endsWith(END)) throw Error('Invalid source-turn accounting markers');
  const prepared = PRODUCTS.map(name => {
    const file = path.join(root, 'plugins', name), source = fs.readFileSync(file, 'utf8');
    const starts = source.split(START).length - 1, ends = source.split(END).length - 1;
    if (starts > 1 || ends > 1 || starts !== ends) throw Error('Ambiguous source-turn accounting markers: ' + name);
    if (!starts) {
      if (check) throw Error('Missing source-turn accounting: ' + name);
      // Keep every host directive ahead of executable helpers, including @arg
      // and @allowed-ipc directives that follow @version.
      const header = /^(?:\/\/@[^\r\n]*\r?\n)+/.exec(source);
      if (!header || !/^\/\/@version\s/m.test(header[0]) || !/^\/\/@api\s/m.test(header[0])) {
        throw Error('Missing leading plugin metadata: ' + name);
      }
      const at = header[0].length;
      return {file, source: source.slice(0, at) + shared + '\n' + source.slice(at)};
    }
    const start = source.indexOf(START), end = source.indexOf(END, start) + END.length;
    if (check && source.slice(start, end) !== shared) throw Error('Source-turn accounting differs: ' + name);
    return {file, source: source.slice(0, start) + shared + source.slice(end)};
  });
  for (const item of prepared) new vm.Script(item.source, {filename:item.file});
  if (!check) for (const item of prepared) fs.writeFileSync(item.file, item.source);
  return PRODUCTS.length;
}
module.exports = {synchronize};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw Error('Usage: sync_source_turn_accounting.cjs [--check]');
  console.log('Source-turn accounting embeddings: ' + synchronize({check:args.includes('--check')}) + ' verified');
}
