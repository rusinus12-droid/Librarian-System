'use strict';
// Measure what the developer-only `_test` surface actually costs in the RELEASE artifacts.
//
// The build log reports `_test blocks removed 0 (0 B)` for every plugin, so the lever the builder
// documents is not firing. Before changing the builder, measure the real size of the two shapes it
// says it handles:
//   1. the object-literal property   `_test: { ... }`
//   2. follow-up assignments         `publicApi._test.foo = foo;`
// Uses acorn (available in the npx cache) so the span is found by parsing, not by brace counting —
// the earlier brace-counting attempts corrupted the files.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ACORN_DIR = (() => {
  const base = path.join(process.env.HOME || '', '.npm', '_npx');
  for (const entry of fs.readdirSync(base)) {
    const candidate = path.join(base, entry, 'node_modules', 'acorn');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
})();

if (!ACORN_DIR) { console.log(JSON.stringify({ error: 'acorn not found in npx cache' })); process.exit(0); }
const acorn = require(ACORN_DIR);

const PLUGINS = ['HAYAKU_Locator_Continuity', 'Flashback_Memory', 'LIBRA', 'LIA_Persona_Linker', 'RETRACE'];
const rows = [];

for (const name of PLUGINS) {
  const file = path.resolve(__dirname, '..', 'plugins', `${name}.js`);
  const source = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: false });
  } catch (error) {
    rows.push({ plugin: name, parseError: String(error?.message || error).slice(0, 160) });
    continue;
  }

  let propertyBytes = 0, assignmentBytes = 0, propertyCount = 0, assignmentCount = 0;

  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (typeof node.type === 'string') {
      // shape 1: `_test: { ... }` inside an object literal
      if (node.type === 'Property' && node.value && node.key) {
        const keyName = node.key.name || node.key.value;
        if (keyName === '_test' && node.value.type === 'ObjectExpression') {
          const span = source.slice(node.start, node.end);
          // Only count a non-trivial object (a stub `_test: {}` costs nothing).
          if (span.length > 64) { propertyBytes += span.length; propertyCount += 1; }
        }
      }
      // shape 2: `something._test.foo = ...` assignment statements
      if (node.type === 'AssignmentExpression' && node.left?.type === 'MemberExpression') {
        let cursor = node.left;
        while (cursor?.type === 'MemberExpression') cursor = cursor.object;
        const chain = source.slice(node.start, node.end);
        if (/\._test(?:\.|\[)/.test(chain)) { assignmentBytes += chain.length; assignmentCount += 1; }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      walk(node[key]);
    }
  };
  walk(ast);

  rows.push({
    plugin: name,
    fileBytes: source.length,
    testPropertyBytes: propertyBytes,
    testPropertyCount: propertyCount,
    testAssignmentBytes: assignmentBytes,
    testAssignmentCount: assignmentCount,
    totalCandidateBytes: propertyBytes + assignmentBytes,
    shareOfFile: `${(((propertyBytes + assignmentBytes) / source.length) * 100).toFixed(2)}%`
  });
}

console.log(JSON.stringify({ test: 'test_surface_measurement', acornFrom: 'npx cache', rows }, null, 1));
