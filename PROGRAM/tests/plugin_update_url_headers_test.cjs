'use strict';
// Exact user-selected main URLs. Historical fixture headers remain frozen.
// Set PLUGIN_UPDATE_URL_FULL_DIR and PLUGIN_UPDATE_URL_MIN_DIR to verify actual
// output directories after the source and release builders have completed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { maskSource } = require('../tools/lib/ultralight_scan.cjs');
const program = path.resolve(__dirname, '..');
const prefix = 'https://raw.githubusercontent.com/rusinus12-droid/Librarian-System/refs/heads/main/PROGRAM/plugins/';
const filenames = [
  'Flashback_Memory.js',
  'HAYAKU_Locator_Continuity.js',
  'GRADIA.js',
  'LIBRA.js',
  'RETRACE.js',
  'LIA_Persona_Linker.js'
];
const read = file => fs.readFileSync(file, 'utf8');
function checkHeader(source, filename) {
  const lines = source.match(/^[ \t]*\/\/@update-url\b[^\r\n]*$/gm) || [];
  assert.deepEqual(lines, ['//@update-url ' + prefix + filename], filename + ': one exact update URL');
  const directives = [];
  const masked = maskSource(source, { onLineComment(start, end) {
    if (/^\/\/@/.test(source.slice(start, end)) && /^[ \t]*$/.test(source.slice(source.lastIndexOf('\n', start - 1) + 1, start))) directives.push(start);
  } });
  const firstCode = masked.search(/\S/);
  assert.ok(source.startsWith('//@name '), filename + ': metadata starts the script');
  assert.ok(firstCode >= 0, filename + ': executable plugin body');
  assert.match(source.slice(0, firstCode), /^\/\/@api 3\.0\s*$/m, filename + ': API declared before execution');
  assert.ok(directives.every(start => start < firstCode), filename + ': all host directives precede executable helpers');
}
function version(source, filename) {
  const matches = [...source.matchAll(/^\/\/@version[ \t]+([^\r\n]+)$/gm)];
  assert.equal(matches.length, 1, filename + ': one version header');
  return matches[0][1];
}
for (const filename of filenames) {
  test('source exact update URL: ' + filename, () => {
    checkHeader(read(path.join(program, 'plugins', filename)), filename);
  });
}
for (const [label, variable] of [['Full', 'PLUGIN_UPDATE_URL_FULL_DIR'], ['Min', 'PLUGIN_UPDATE_URL_MIN_DIR']]) {
  const directory = process.env[variable];
  test(label + ' generated artifacts retain exact URLs and source versions', { skip: directory ? false : 'set ' + variable + ' after building' }, () => {
    for (const filename of filenames) {
      const artifact = read(path.join(directory, filename));
      checkHeader(artifact, filename);
      assert.equal(version(artifact, filename), version(read(path.join(program, 'plugins', filename)), filename), label + ': unchanged version for ' + filename);
    }
  });
}
