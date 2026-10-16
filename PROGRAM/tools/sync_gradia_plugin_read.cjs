'use strict';
// Generate async browser readers from the audited server format validators.
// Explicit substitutions fail on upstream drift; never fork the format rules.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const replace = (text, from, to) => {
  if (!text.includes(from)) throw Error('plugin_reader_source_drift: ' + from.slice(0, 100));
  return text.replaceAll(from, to);
};
function adapter(owner) {
  let text = fs.readFileSync(path.join(root, 'server/core/gradia-' + owner + '-read-session.cjs'), 'utf8');
  text = replace(text, "const crypto = require('node:crypto');", "const crypto = { createHash: () => ({ update: value => ({ digest: () => primitives.fingerprint(value) }) }) };");
  text = replace(text, "const { gunzipSync } = require('node:zlib');", `const Buffer = { byteLength: value => primitives.byteLength(value), from: value => Uint8Array.from(atob(value), c => c.charCodeAt(0)) };
  const gunzip = async (compressed, options) => {
    if (typeof DecompressionStream !== 'function') throw Error('LIB_READ_GZIP_UNAVAILABLE');
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = []; let size = 0;
    try { while (true) { const next = await stream.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > options.maxOutputLength) throw Object.assign(Error('decode budget'), { code: 'ERR_BUFFER_TOO_LARGE' });
      chunks.push(next.value);
    } } finally { await stream.cancel().catch(() => {}); stream.releaseLock(); }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { toString: () => text };
  };`);
  text = replace(text, 'function metadataOf(', 'async function metadataOf(');
  text = replace(text, "const value = repository.getMetadata('plugin', key);", "const value = await repository.getMetadata('plugin', key);");
  text = replace(text, 'function readUnit(body)', 'async function readUnit(body)');
  text = replace(text, 'const result = body(repository);', 'const result = await body(repository);');
  text = replace(text, 'return readUnit(repository => {', 'return readUnit(async repository => {');
  text = replace(text, 'const read = ', 'const read = async ');
  text = replace(text, 'const metadata = metadataOf(repository, key);', 'const metadata = await metadataOf(repository, key);');
  text = replace(text, "row = repository.get('plugin', key,", "row = await repository.get('plugin', key,");
  text = replace(text, "gunzipSync(compressed, { maxOutputLength: ", "(await gunzip(compressed, { maxOutputLength: ");
  text = replace(text, " }).toString('utf8')", " })).toString('utf8')");
  if (owner === 'hayaku') {
    text = replace(text, 'const packetOf = (', 'const packetOf = async (');
    text = replace(text, 'const append = (', 'const append = async (');
    text = replace(text, 'const content = packetOf(', 'const content = await packetOf(');
    for (const name of ['head', 'receipt', 'stored']) text = replace(text, 'const ' + name + ' = read(', 'const ' + name + ' = await read(');
    text = replace(text, 'meta = read(cursor.metaKey).parsed', 'meta = (await read(cursor.metaKey)).parsed');
    text = replace(text, '          append(record,', '          await append(record,');
    text = replace(text, 'for (const record of selectedRecords(ledger)) append(', 'for (const record of selectedRecords(ledger)) await append(');
    text = replace(text, '      return {schema:\'memory-suite.hayaku-read-session-current.v1\',current:matches && dependencies.every(value=>same(value,metadataOf(repository,value.key))),',
      "      let allCurrent = true; for (const value of dependencies) if (!same(value, await metadataOf(repository,value.key))) allCurrent = false;\n      return {schema:'memory-suite.hayaku-read-session-current.v1',current:matches && allCurrent,");
  } else {
    text = replace(text, 'const load = (', 'const load = async (');
    text = replace(text, 'const manifest = decode(read(', 'const manifest = decode(await read(');
    text = replace(text, 'const raw = read(', 'const raw = await read(');
    text = replace(text, 'const local = load(', 'const local = await load(');
    text = replace(text, 'const layer = load(', 'const layer = await load(');
    text = replace(text, 'const current = bindingMatches && dependencies.every(value => same(value, metadataOf(repository, value.key)));',
      'let current = bindingMatches; for (const value of dependencies) if (!same(value, await metadataOf(repository, value.key))) current = false;');
  }
  text = text.replace(/module\.exports = [^;]+;\s*$/, 'return createReadSession;');
  return 'function create' + (owner === 'hayaku' ? 'Hayaku' : 'Flashback') + 'PluginReadSession(primitives) {\n' + text + '\n}';
}
const network = fs.readFileSync(path.join(__dirname, 'libra_memory_network.cjs'), 'utf8');
const primitives = 'function createGradiaReadPrimitives() {\n' + network.slice(network.indexOf('  const utf8Bytes'), network.indexOf('  const array ='))
  + '\nreturn {fingerprint: sha256Hex, byteLength: value => utf8Bytes(value).length};\n}';
const protocol = 'const createGradiaPluginRead = (' + require('./gradia_plugin_read.cjs').toString() + ');';
const snapshot = 'const createGradiaPluginSnapshot = (' + require('./gradia_plugin_snapshot.cjs').toString() + ');';
const begin = '  /* GRADIA PLUGIN READ START */', end = '  /* GRADIA PLUGIN READ END */';
let changed = false;
for (const [name, owner] of Object.entries({ 'GRADIA.js': null, 'LIBRA.js': 'libra', 'HAYAKU_Locator_Continuity.js': 'hayaku', 'Flashback_Memory.js': 'flashback' })) {
  const file = path.join(root, 'plugins', name), before = fs.readFileSync(file, 'utf8');
  const block = [begin, primitives, protocol, ...(['hayaku', 'flashback'].includes(owner) ? [snapshot, adapter(owner)] : []), end].join('\n');
  const start = before.indexOf(begin), last = before.indexOf(end);
  if (start >= 0 && last < start) throw Error('plugin_read_block_invalid:' + name);
  const anchor = name === 'HAYAKU_Locator_Continuity.js' ? '  const registerMemoryBridgeIpc = async' : name === 'LIBRA.js' ? '    const getGradiaUnifiedReadOwner = () =>' : '  const publicApi = Object.freeze({';
  let after;
  if (start < 0) {
    if (!before.includes(anchor)) throw Error('plugin_read_anchor_missing:' + name);
    after = before.replace(anchor, block + '\n' + anchor);
  } else after = before.slice(0, start) + block + before.slice(last + end.length);
  if (after !== before) { changed = true; if (process.argv.includes('--write')) fs.writeFileSync(file, after); }
}
if (changed && !process.argv.includes('--write')) throw Error('gradia_plugin_read_embed_stale');
console.log(JSON.stringify({ changed }));
module.exports = { adapter, primitives };
