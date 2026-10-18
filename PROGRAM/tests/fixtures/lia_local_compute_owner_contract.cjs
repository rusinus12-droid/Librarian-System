'use strict';
// Parse source only. Never evaluate the plugin or its factories.
const assert = require('node:assert/strict');
const { resolveAcorn } = require('../../tools/build_plugins.cjs');

function checkLiaLocalComputeOwner(source) {
  const acorn = resolveAcorn();
  assert.ok(acorn, 'Acorn is required for the LIA local owner contract');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const owners = ast.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression'
    && ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.expression.callee.type)
    && node.expression.callee.async && node.expression.callee.body.type === 'BlockStatement');
  assert.equal(owners.length, 1, 'LIA has one top-level async owner IIFE');
  const statements = owners[0].expression.callee.body.body;
  // Only direct owner declarations count; nested SDK examples, comments and strings do not.
  const binding = name => {
    const declarations = statements.filter(node => node.type === 'VariableDeclaration')
      .flatMap(node => node.declarations.map(declaration => ({ kind: node.kind, declaration })))
      .filter(({ declaration }) => declaration.id.type === 'Identifier' && declaration.id.name === name);
    assert.equal(declarations.length, 1, `LIA requires one direct owner binding: ${name}`);
    assert.equal(declarations[0].kind, 'const', `LIA owner binding is immutable: ${name}`);
    return declarations[0].declaration.init;
  };
  const identity = binding('PLUGIN_NAME');
  assert.equal(identity?.type, 'Literal', 'LIA owner identity is literal');
  assert.equal(identity.value, 'LIA', 'LIA owner identity');
  const factory = (name, factoryName, expected) => {
    const call = binding(name);
    assert.equal(call?.type, 'CallExpression', `LIA owner factory call: ${name}`);
    assert.equal(call.callee.type, 'Identifier', `LIA owner factory identifier: ${name}`);
    assert.equal(call.callee.name, factoryName, `LIA owner factory target: ${name}`);
    assert.equal(call.arguments.length, 1, `LIA owner factory options: ${name}`);
    const options = call.arguments[0];
    assert.equal(options.type, 'ObjectExpression', `LIA owner literal options: ${name}`);
    const values = new Map();
    for (const property of options.properties) {
      assert.ok(property.type === 'Property' && property.kind === 'init'
        && !property.computed && !property.method && !property.shorthand,
      `LIA owner options cannot use spreads, dynamic keys or accessors: ${name}`);
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      assert.ok(!values.has(key), `LIA owner options cannot override a key: ${name}.${key}`);
      values.set(key, property.value);
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
      assert.equal(values.get(key)?.type, 'Literal', `LIA owner literal policy: ${name}.${key}`);
      assert.equal(values.get(key).value, expectedValue, `LIA owner policy: ${name}.${key}`);
    }
  };
  factory('MemorySuiteStorageBridge', 'createMemorySuiteStorageBridge', {
    namespace: 'lia', pluginId: 'lia_persona_linker', storagePolicy: 'local_only',
    autoMigratePlugin: false, autoMigrateLocal: false
  });
  // The Compute SDK is retired: world-lore rerank runs locally and no owner bridge exists.
  const computeOwners = statements.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations)
    .filter(declaration => declaration.id.type === 'Identifier' && declaration.id.name === 'MemorySuiteLiaComputeBridge');
  assert.equal(computeOwners.length, 0, 'LIA owns no retired Compute bridge: MemorySuiteLiaComputeBridge');
  return true;
}

module.exports = { checkLiaLocalComputeOwner };
