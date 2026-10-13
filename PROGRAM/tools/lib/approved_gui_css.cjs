'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const pages = {'Flashback_Memory.js': 'flashback', 'HAYAKU_Locator_Continuity.js': 'hayaku', 'LIBRA.js': 'libra'};
function verifyApprovedCss(programDir, file, text) {
  assert(pages[file], 'known approved GUI owner');
  const folder = path.join(programDir, 'docs/gui-redesign');
  const page = fs.readFileSync(path.join(folder, pages[file] + '.html'), 'utf8');
  const required = ['suite.css', 'themes.css'].map(name => fs.readFileSync(path.join(folder, 'assets', name), 'utf8'));
  required.push(...[...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1].trim()));
  assert(required.length > 2, 'approved product stylesheet exists');
  const strings = [], nodes = [acorn.parse(text, {ecmaVersion: 'latest'})];
  while (nodes.length) {
    const node = nodes.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value);
    if (node.type === 'TemplateLiteral' && !node.expressions.length) strings.push(node.quasis.map(part => part.value.cooked).join(''));
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) nodes.push(...value);
      else if (value && typeof value === 'object') nodes.push(value);
    }
  }
  for (const css of required) assert(strings.some(value => value.includes(css)), file + ': approved CSS drift');
  return true;
}
module.exports = {verifyApprovedCss};
