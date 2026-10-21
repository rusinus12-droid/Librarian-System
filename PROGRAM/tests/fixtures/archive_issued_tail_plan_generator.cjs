'use strict';

// Static maintenance utility. The official fixture never imports this module.
// Regenerate only after reviewing the product/fixture change and AST proof.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const acorn = require('acorn');
const key = '__root085IssuedStartupObserver';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const planPath = path.join(__dirname, 'archive_issued_tail_plans.json');
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [name, value] of Object.entries(node)) {
    if (name === 'loc') continue;
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};
const replaceOnce = (source, before, after) => {
  assert.equal(source.split(before).length - 1, 1, 'unique actual source variant seam');
  return source.replace(before, after);
};
function replacementFromFixture(name, firstLiteral) {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8'), matches = [];
  walk(acorn.parse(source, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'CallExpression' && node.callee.object?.name === 'source' && node.callee.property?.name === 'replace' && node.arguments[0]?.value === firstLiteral) {
      matches.push(node.arguments.map(argument => argument.value));
    }
  });
  assert.equal(matches.length, 1);
  assert(matches[0].every(value => typeof value === 'string'));
  return { name, sha256: sha(source), before: matches[0][0], after: matches[0][1] };
}
function actualVariants() {
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/Flashback_Memory.js'), 'utf8');
  const injection = replacementFromFixture('embedding_contract_harness.cjs', '  globalThis.__FlashbackMemory = publicApi;');
  const exposure = replacementFromFixture('archive_owner_fixture.cjs', 'abortEmbeddingJobs, buildRecordsFromSources, hydrateFlashbackVectorRecords,');
  const owner = replaceOnce(replaceOnce(source, injection.before, injection.after), exposure.before, exposure.after);
  const test = fs.readFileSync(path.join(__dirname, '../flashback_archive_owner_failure_test.cjs'), 'utf8');
  const declarations = [], replacements = [];
  walk(acorn.parse(test, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'VariableDeclarator' && node.id.name === 'accelerator') declarations.push(node.init.value);
    if (node.type === 'CallExpression' && node.callee.object?.name === 'source' && node.callee.property?.name === 'replace' && node.arguments[0]?.name === 'accelerator') replacements.push(node.arguments[1].value);
  });
  assert.equal(declarations.length, 1); assert.equal(replacements.length, 1);
  assert.equal(typeof declarations[0], 'string'); assert.equal(typeof replacements[0], 'string');
  return {
    inputs: [injection, exposure].map(({ name, sha256 }) => ({ name, sha256 })),
    variants: [
      { name: 'raw_reporting', source },
      { name: 'owner_injected', source: owner },
      { name: 'owner_injected_collision', source: replaceOnce(owner, declarations[0], replacements[0]) }
    ]
  };
}
function fixedSeams() {
  return [
    ["try { fn(); } catch (error) { warn('scheduled timer callback failed', error); }", `try { globalThis.${key}.invoke(fn); } catch (error) { warn('scheduled timer callback failed', error); }`],
    ['      callback();\n    }, Math.max(0, Number(delayMs || 0) || 0));', `      globalThis.${key}.invoke(callback);\n    }, Math.max(0, Number(delayMs || 0) || 0));`],
    ['  globalThis.__FlashbackMemory = publicApi;', `  globalThis.${key}.captureRuntime({ Runtime, sharedScopeWriteLocks, clearScheduledTimers, scheduleTimer, withDeadline });\n  globalThis.__FlashbackMemory = publicApi;`],
    ['  const autoMigratePlugin = !localOnlyOwner', `  globalThis.${key}.captureSdk({ timers: lifecycle.timers, clear: clearLifecycleTimeout });\n  const autoMigratePlugin = !localOnlyOwner`],
    ['void refreshHostRuntimeInfo();', `void globalThis.${key}.promise('startup.runtime_info',refreshHostRuntimeInfo());`],
    ["registerUi(Runtime.settings).catch(error => warn('registerUi async failed', error));", `globalThis.${key}.promise('startup.ui',registerUi(Runtime.settings).catch(error => warn('registerUi async failed', error)));`],
    ['    Runtime.scheduledTimers.add(id);', `    Runtime.scheduledTimers.add(id);\n    globalThis.${key}.timerRegistered('runtime',id,fn,ms);`],
    ['    lifecycle.timers.add(timer);', `    lifecycle.timers.add(timer);\n    globalThis.${key}.timerRegistered('sdk',timer,callback,delayMs);`, 'storage-sdk']
  ];
}
function buildPlan({ name, source }, expectedExpressions = 52) {
  const tree = acorn.parse(source, { ecmaVersion: 'latest', locations: true });
  const edits = [], expressions = new Map(), callsites = [];
  const searchMarker = source.indexOf('// BEGIN MEMORY SUITE SEARCH');
  const searchBoundary = searchMarker > 0 ? searchMarker : source.length; // Flashback no longer embeds the search section
  assert(searchBoundary > 0);
  const wrap = (node, prefix) => edits.push({ start: node.start, end: node.end, prefix, suffix: ')' });
  walk(tree, node => {
    if (node.type !== 'CallExpression') return;
    const family = node.callee.name;
    if (family !== 'scheduleTimer' && !(family === 'scheduleLifecycleTimeout' && node.start < searchBoundary)) return;
    const callback = node.arguments[0], label = `${family}:${node.loc.start.line}`;
    callsites.push({ family, label, callbackSha256: sha(source.slice(callback.start, callback.end)) });
    wrap(callback, `globalThis.${key}.label(${JSON.stringify(label)},`);
    if (callback.type === 'Identifier') return;
    walk(callback.body, child => {
      if (child.type !== 'ExpressionStatement') return;
      let expression = child.expression;
      if (expression.type === 'UnaryExpression' && expression.operator === 'void') expression = expression.argument;
      if (expression.type !== 'CallExpression' && !(expression.type === 'AssignmentExpression' && expression.right.type === 'CallExpression')) return;
      expressions.set(expression.start, expression);
    });
  });
  assert.equal(callsites.filter(row => row.family === 'scheduleTimer').length, 18);
  assert.equal(callsites.filter(row => row.family === 'scheduleLifecycleTimeout').length, 14);
  assert.equal(expressions.size, expectedExpressions);
  for (const node of expressions.values()) wrap(node, `globalThis.${key}.promise('scheduled.chain',`);
  const insertions = new Map();
  const add = (at, text, order) => { const rows = insertions.get(at) || []; rows.push({ text, order }); insertions.set(at, rows); };
  for (const edit of edits) { add(edit.start, edit.prefix, -edit.end); add(edit.end, edit.suffix, -edit.start); }
  const patches = [...insertions].map(([start, rows]) => ({ start, end: start, before: '', after: rows.sort((a, b) => a.order - b.order).map(row => row.text).join('') }));
  const anchors = fixedSeams().map(([before, after, scope = 'full']) => {
    const end = scope === 'storage-sdk' ? searchBoundary : source.length;
    const region = source.slice(0, end);
    assert.equal(region.split(before).length - 1, 1, 'unique complete fixed source anchor');
    const start = region.indexOf(before);
    patches.push({ start, end: start + before.length, before, after });
    return { before, start, regionEnd: end };
  });
  patches.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0;
  const chunks = [];
  for (const patch of patches) {
    assert(patch.start >= cursor, 'nonoverlapping UTF-16 patch boundaries');
    assert.equal(source.slice(patch.start, patch.end), patch.before);
    chunks.push(source.slice(cursor, patch.start), patch.after);
    cursor = patch.end;
  }
  chunks.push(source.slice(cursor));
  const result = chunks.join('');
  assert.deepEqual(unwrap(tree), unwrap(acorn.parse(result, { ecmaVersion: 'latest' })), 'all original product AST restored after removing observations');
  return { name, sourceSha256: sha(source), sourceBytes: Buffer.byteLength(source), sourceCodeUnits: source.length,
    observedSha256: sha(result), callsites, expressionCount: expressions.size, anchors, patches };
}
function unwrap(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(unwrap).filter(value => value !== null);
  const call = node.type === 'ExpressionStatement' ? node.expression : node;
  if (node.type === 'ExpressionStatement' && call.type === 'CallExpression' && call.callee.object?.property?.name === key && ['captureRuntime', 'captureSdk', 'timerRegistered'].includes(call.callee.property.name)) return null;
  if (node.type === 'CallExpression' && node.callee.object?.property?.name === key) {
    if (['promise', 'label'].includes(node.callee.property.name)) return unwrap(node.arguments[1]);
    if (node.callee.property.name === 'invoke') return { type: 'CallExpression', callee: unwrap(node.arguments[0]), arguments: [], optional: false };
  }
  return Object.fromEntries(Object.entries(node).filter(([name]) => !['start', 'end', 'loc', 'raw'].includes(name)).map(([name, value]) => [name, unwrap(value)]));
}
// Exact outputs of the reviewed ac4b2bd AST transformer for these real inputs.
// These are independent evidence pins, not regenerated from the new plans.
const historicalOutputs = {
  d9026d86f5310fcc2357b824735007fd515719d0b7ddfa515cc34e5ea08336be: 'ee65d897321c7b490971dddd61ce601cf41e318200219f2c4e438ff50377e96d',
  '2bf10d0d6444f5b32f543bede329bbb85179de2141b66c0a71a6a024f168300e': 'c7347dc5fb4e68d6195c98edb73d34a7fd4f998fe4dfafd86226bddc9816ce00',
  ac13711909519ca3915067a5421d44b7279b5d7bbfe01656cf8721f979055d83: '56d861635994a48e3b68c874424d811f09aa388f22cb4ac60a2c82c1a5a2587f'
};
function generate() {
  const { inputs, variants } = actualVariants();
  const plans = variants.map(variant => buildPlan(variant));
  for (const plan of plans) assert.equal(plan.observedSha256, historicalOutputs[plan.sourceSha256], 'byte-exact ac4 observer output');
  return { schema: 'root085.source-observer-plans.v1', offsetUnit: 'javascript-utf16-code-unit', inputs, plans };
}
module.exports = { actualVariants, buildPlan, generate, unwrap, historicalOutputs };
if (require.main === module) {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--write'));
  const generated = generate();
  if (process.argv[2] === '--write') fs.writeFileSync(planPath, JSON.stringify(generated, null, 2) + '\n');
  else assert.deepEqual(JSON.parse(fs.readFileSync(planPath, 'utf8')), generated, 'committed plans match reproducible static generator');
  console.log(JSON.stringify({ classification: 'STATIC_PLAN_GENERATION_NO_PRODUCT_EXECUTION', planSha256: sha(fs.readFileSync(planPath)), variants: generated.plans.map(({ name, sourceSha256, observedSha256, callsites, expressionCount }) => ({ name, sourceSha256, observedSha256, callbackCount: callsites.length, expressionCount })) }));
}
