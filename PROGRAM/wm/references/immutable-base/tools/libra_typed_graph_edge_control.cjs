'use strict';
// Test-only structural location of the original edge-removal control.
// Min uses mangle:false but may join declarations and remove all indentation.
const assert = require('node:assert/strict');
const { parse } = require('acorn');
function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) visit(child, fn); return; }
  if (node.type) fn(node);
  for (const [key, value] of Object.entries(node)) if (key !== 'start' && key !== 'end') visit(value, fn);
}
function removeTypedGraphEdges(code) {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  const scopes = [];
  visit(ast, node => {
    if (node.type === 'VariableDeclarator' && node.id?.name === 'searchHmeTypedGraphCandidates') scopes.push(node.init);
    // Terser may inline a once-used function into its same-named export property.
    if (node.type === 'Property' && node.key?.name === 'searchHmeTypedGraphCandidates' && /FunctionExpression$/.test(node.value?.type || '')) scopes.push(node.value);
  });
  assert.equal(scopes.length, 1, 'exactly one graph search scope must exist');
  const declarations = [], graphs = [], expansions = [];
  visit(scopes[0].body, node => {
    if (node.type === 'VariableDeclarator' && node.id?.name === 'typedEntriesByIdentity') declarations.push(node);
    if (node.type === 'VariableDeclarator' && node.id?.name === 'typedGraph') graphs.push(node);
    if (node.type === 'CallExpression' && node.callee?.name === 'expandHmeGraphRecallCandidates') expansions.push(node);
  });
  assert.equal(declarations.length, 1, 'exactly one typed identity-map declaration must exist');
  assert.equal(graphs.length, 1, 'exactly one typed graph declaration must exist');
  assert.equal(expansions.length, 1, 'exactly one graph expansion call must exist');
  const map = declarations[0].init, graph = graphs[0].init, expansion = expansions[0];
  assert.equal(map?.type, 'NewExpression'); assert.equal(map.callee?.name, 'Map');
  assert.equal(map.arguments[0]?.callee?.object?.name, 'valid'); assert.equal(map.arguments[0]?.callee?.property?.name, 'map');
  assert.equal(graph?.callee?.name, 'rebuildHmeGraphRuntimeShape');
  assert(graph.end < map.start && map.end < expansion.start, 'graph/map/expansion evaluation order must be retained');
  assert.equal(expansion.arguments[1]?.name, 'typedEntriesByIdentity');
  assert(expansion.arguments[2]?.properties?.some(p => p.key?.name === 'graph' && p.value?.name === 'typedGraph'), 'expansion must consume the same typed graph');
  const replacement = '(typedGraph.edges=[],typedGraph.adjacentByNode={},' + code.slice(map.start, map.end) + ')';
  const transformed = code.slice(0, map.start) + replacement + code.slice(map.end);
  assert.notEqual(transformed, code, 'edge control mutation must be applied');
  parse(transformed, { ecmaVersion: 'latest', sourceType: 'script' });
  return transformed;
}
module.exports = { removeTypedGraphEdges };
