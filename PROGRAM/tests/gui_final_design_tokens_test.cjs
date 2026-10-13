'use strict';
// Verify the approved shared design inputs are embedded verbatim, independently
// of product-only data bindings and explicitly documented host overrides.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const root = path.resolve(__dirname, '..');
const design = path.join(root, 'docs/gui-redesign/assets');
const inputs = ['suite.css', 'themes.css'].map(name => ({name, text: fs.readFileSync(path.join(design, name), 'utf8')}));
const names = ['LIBRA.js', 'HAYAKU_Locator_Continuity.js', 'Flashback_Memory.js', 'GRADIA.js', 'LIA_Persona_Linker.js', 'RETRACE.js'];
const pages = ['libra', 'hayaku', 'flashback', 'gradia', 'lia', 'retrace'];
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const results = [];
for (const name of names) {
  const source = fs.readFileSync(path.join(root, 'plugins', name), 'utf8');
  const queue = [acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'script'})];
  const strings = [];
  while (queue.length) {
    const node = queue.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    if (node.type === 'TemplateLiteral' && !node.expressions.length) strings.push(node.quasis.map(part => part.value.cooked).join(''));
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === 'object') queue.push(value);
    }
  }
  const exact = Object.fromEntries(inputs.map(input => [input.name, strings.some(value => value.includes(input.text))]));
  const page = fs.readFileSync(path.join(root, 'docs/gui-redesign', pages[names.indexOf(name)] + '.html'), 'utf8');
  const inline = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1].trim());
  // Leading/trailing whitespace around a style element has no CSS meaning.
  exact.productInlineCss = inline.length > 0 && inline.every(css => strings.some(value => value.includes(css)));
  results.push({name, sourceSha256: hash(source), exact});
}
console.log(JSON.stringify({inputs: inputs.map(input => ({name: input.name, sha256: hash(input.text)})), results}, null, 2));
for (const result of results) for (const [name, exact] of Object.entries(result.exact)) assert.ok(exact, `${result.name}: shared ${name} differs from the approved input`);
console.log('PASS: all six products embed the exact shared design inputs');
