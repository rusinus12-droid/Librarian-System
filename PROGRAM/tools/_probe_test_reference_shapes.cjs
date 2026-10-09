'use strict';
// Enumerate EVERY statement that references `_test` in the three plugins that have a surface, so
// the removal rule is written from the actual shapes instead of guessed.
//
// Motivation: the first rule handled `X._test.y = z` and `X._test.y()` but missed
// `Object.assign(publicApi._test, {...})`, where `_test` appears as an ARGUMENT. The release
// artifact then threw at load: `Cannot convert undefined or null to object at Object.assign`.
// Before widening the rule, list the shapes so a product statement is never caught by it.
const fs = require('node:fs');
const path = require('node:path');

const ACORN = (() => {
  const base = path.join(process.env.HOME || '', '.npm', '_npx');
  for (const entry of fs.readdirSync(base)) {
    const candidate = path.join(base, entry, 'node_modules', 'acorn');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
})();

(async () => {
  const acorn = require(ACORN);
  const rows = [];
  for (const name of ['HAYAKU_Locator_Continuity', 'Flashback_Memory', 'RETRACE']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', `${name}.js`), 'utf8');
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    const shapes = new Map();

    const referencesTest = node => {
      let found = false;
      const visit = n => {
        if (!n || typeof n !== 'object' || found) return;
        if (Array.isArray(n)) { for (const item of n) visit(item); return; }
        if (n.type === 'MemberExpression') {
          const prop = n.property?.name || n.property?.value;
          if (prop === '_test') { found = true; return; }
        }
        if (n.type === 'Identifier' && n.name === '_test') { found = true; return; }
        for (const key of Object.keys(n)) {
          if (key === 'type' || key === 'start' || key === 'end') continue;
          visit(n[key]);
        }
      };
      visit(node);
      return found;
    };

    const classify = statement => {
      const expr = statement.expression;
      if (!expr) return 'non-expression';
      if (expr.type === 'AssignmentExpression') {
        const left = expr.left;
        if (left?.type === 'MemberExpression' && (left.property?.name || left.property?.value) === '_test') return 'assign-property';
        if (left?.type === 'MemberExpression' && /\._test\./.test(source.slice(left.start, left.end))) return 'assign-nested';
        return 'assign-other';
      }
      if (expr.type === 'CallExpression') {
        const calleeText = source.slice(expr.callee.start, expr.callee.end);
        if (/\._test(\.|\[|$)/.test(calleeText)) return 'call-test-fn';
        if (expr.arguments.some(a => referencesTest(a))) return 'call-with-test-arg';
        return 'call-other';
      }
      return `other:${expr.type}`;
    };

    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const item of node) walk(item); return; }
      if (node.type === 'ExpressionStatement' && referencesTest(node)) {
        const kind = classify(node);
        const text = source.slice(node.start, node.end).replace(/\s+/g, ' ');
        const entry = shapes.get(kind) || { kind, count: 0, samples: [] };
        entry.count += 1;
        if (entry.samples.length < 3) entry.samples.push({ line: source.slice(0, node.start).split('\n').length, text: text.slice(0, 150) });
        shapes.set(kind, entry);
      }
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        walk(node[key]);
      }
    };
    walk(ast);
    rows.push({ plugin: name, shapes: [...shapes.values()] });
  }
  console.log(JSON.stringify({ test: 'test_reference_shapes', rows }, null, 1).slice(0, 9000));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
