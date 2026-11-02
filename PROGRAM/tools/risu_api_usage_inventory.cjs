'use strict';
/**
 * Librarian RisuAI Host API Usage Inventory
 *
 * Performs scope-aware AST static analysis across all six shipped Librarian plugins
 * (HAYAKU, Flashback, LIBRA, LIA, RETRACE, GRADIA) to extract every RisuAI host API
 * method and property used by each owner.
 *
 * Tracks:
 * - Direct RisuAI global aliases: Risuai, RisuAI, risuai, risuApi, risuAPI
 * - Alias arrays (e.g. RISU_API_ALIASES) and globalThis[alias] lookups
 * - Helper functions returning host objects, arrays of host objects, or { api, source } wrappers
 * - Host adapters passed into embedded SDKs / unified read / snapshot modules
 * - Guarded legacy/fork optional capability probes (explicitly allowlisted)
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveAcorn } = require('./build_plugins.cjs');

const programDir = path.resolve(__dirname, '..');

const SHIPPED_PLUGINS = Object.freeze([
  { owner: 'hayaku', file: 'HAYAKU_Locator_Continuity.js', pluginName: 'hayaku_locator_continuity' },
  { owner: 'flashback', file: 'Flashback_Memory.js', pluginName: 'flashback_memory' },
  { owner: 'libra', file: 'LIBRA.js', pluginName: 'libra' },
  { owner: 'lia', file: 'LIA_Persona_Linker.js', pluginName: 'lia_persona_linker' },
  { owner: 'retrace', file: 'RETRACE.js', pluginName: 'flashback_hayaku_bridge' },
  { owner: 'gradia', file: 'GRADIA.js', pluginName: 'serial_gradation_agents_for_rp' }
]);

const ALIAS_NAMES = new Set(['Risuai', 'RisuAI', 'risuai', 'risuApi', 'risuAPI']);
const GLOBAL_OBJ_NAMES = new Set(['globalThis', 'window', 'self']);

const JS_BUILTINS = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toLocaleString', 'constructor', 'prototype', '__proto__', 'then', 'catch', 'finally',
  'bind', 'call', 'apply', 'length', 'name'
]);

// Explicitly allowlisted legacy/fork capability probes guarded by `typeof api?.X === 'function'`.
// These are non-authoritative optional fallbacks; plugins do not depend on them on stock RisuAI v3.
const ALLOWLISTED_OPTIONAL_PROBES = Object.freeze({
  removePluginChannelListener: {
    guard: 'typeof api?.removePluginChannelListener === "function"',
    reason: 'Optional fork/legacy IPC cleanup probe; RisuAI v3 unregisters channel listeners automatically via addPluginUnloadCallback.'
  },
  unregisterPluginChannelListener: {
    guard: 'typeof api?.unregisterPluginChannelListener === "function"',
    reason: 'Optional fork/legacy IPC cleanup probe; RisuAI v3 unregisters channel listeners automatically via addPluginUnloadCallback.'
  },
  unregisterSetting: {
    guard: 'typeof api?.unregisterSetting === "function"',
    reason: 'Optional legacy UI unregistration probe; RisuAI v3 uses unregisterUIPart(id).'
  },
  unregisterButton: {
    guard: 'typeof api?.unregisterButton === "function"',
    reason: 'Optional legacy UI unregistration probe; RisuAI v3 uses unregisterUIPart(id).'
  },
  getChat: {
    guard: 'typeof direct?.getChat === "function"',
    reason: 'Optional legacy chat getter probe; RisuAI v3 uses getChatFromIndex(characterIndex, chatIndex).'
  },
  getCurrentChat: {
    guard: 'typeof chatApi?.getCurrentChat === "function"',
    reason: 'Optional legacy chat getter probe; RisuAI v3 uses getChatFromIndex(characterIndex, chatIndex).'
  },
  promptInput: {
    guard: 'typeof promptApi?.promptInput === "function"',
    reason: 'Optional fork prompt modal probe in GRADIA; falls back to GRADIA in-container composer.'
  },
  addEventListener: {
    guard: 'typeof api?.addEventListener === "function"',
    reason: 'Optional legacy event target probe when onUnload is absent.'
  },
  getPluginStorage: {
    guard: 'typeof g.getPluginStorage === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  setPluginStorage: {
    guard: 'typeof g.setPluginStorage === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  deletePluginStorage: {
    guard: 'typeof g.deletePluginStorage === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  pluginStorageGet: {
    guard: 'typeof g.pluginStorageGet === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  pluginStorageSet: {
    guard: 'typeof g.pluginStorageSet === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  pluginStorageDelete: {
    guard: 'typeof g.pluginStorageDelete === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  getStorage: {
    guard: 'typeof g.getStorage === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  setStorage: {
    guard: 'typeof g.setStorage === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  },
  deleteStorage: {
    guard: 'typeof g.deleteStorage === "function"',
    reason: 'Legacy v1 storage adapter probe in LibrarianIntegrityCore fallback.'
  }
});

// Explicitly allowlisted dynamic dispatch patterns where the method name comes from a bounded array parameter.
const ALLOWLISTED_DYNAMIC_DISPATCHES = Object.freeze([
  {
    helperPattern: 'methods.every(name => !name || typeof api?.[name] === "function")',
    description: 'Capability resolver checking a caller-supplied list of required RisuAI method names (all literal call sites are statically extracted).'
  },
  {
    helperPattern: 'typeof candidate[methodName] === "function"',
    description: 'Storage SDK / host helper invoking a method name from a fixed literal candidate list (e.g. ["getArgument", "getArg"]).'
  }
]);

const STORAGE_OBJECT_NAMES = new Set(['pluginStorage', 'safeLocalStorage']);
const STORAGE_SUB_METHODS = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key', 'keys', 'length']);

function analyzePluginSource(src, options = {}) {
  const acorn = resolveAcorn();
  if (!acorn) {
    throw new Error('Acorn AST parser is required for risu_api_usage_inventory.cjs');
  }
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });

  function collectPatternIdentifiers(pattern, out = []) {
    if (!pattern || typeof pattern.type !== 'string') return out;
    if (pattern.type === 'Identifier') {
      out.push(pattern.name);
    } else if (pattern.type === 'AssignmentPattern') {
      collectPatternIdentifiers(pattern.left, out);
    } else if (pattern.type === 'RestElement') {
      collectPatternIdentifiers(pattern.argument, out);
    } else if (pattern.type === 'ArrayPattern') {
      for (const el of pattern.elements || []) {
        if (el) collectPatternIdentifiers(el, out);
      }
    } else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties || []) {
        if (prop.type === 'Property') collectPatternIdentifiers(prop.value, out);
        else if (prop.type === 'RestElement') collectPatternIdentifiers(prop.argument, out);
      }
    }
    return out;
  }

  let nextScopeId = 1;
  function attachScopes(node, parentScope) {
    if (!node || typeof node.type !== 'string') return;
    let currentScope = parentScope;
    if ([
      'Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
      'BlockStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'CatchClause'
    ].includes(node.type)) {
      currentScope = { id: nextScopeId++, parent: parentScope, decls: new Map() };
      node._scope = currentScope;
      if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier' && parentScope) {
        parentScope.decls.set(node.id.name, `${parentScope.id}:${node.id.name}`);
      }
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
        if (node.id?.type === 'Identifier' && node.type !== 'FunctionDeclaration') {
          currentScope.decls.set(node.id.name, `${currentScope.id}:${node.id.name}`);
        }
        for (const p of node.params || []) {
          for (const idName of collectPatternIdentifiers(p)) {
            currentScope.decls.set(idName, `${currentScope.id}:${idName}`);
          }
        }
      }
      if (node.type === 'CatchClause' && node.param) {
        for (const idName of collectPatternIdentifiers(node.param)) {
          currentScope.decls.set(idName, `${currentScope.id}:${idName}`);
        }
      }
    } else {
      node._scope = currentScope;
    }
    if (node.type === 'VariableDeclaration') {
      const targetScope = node.kind === 'var' ? findFunctionScope(currentScope) : currentScope;
      for (const d of node.declarations) {
        for (const idName of collectPatternIdentifiers(d.id)) {
          targetScope.decls.set(idName, `${targetScope.id}:${idName}`);
        }
      }
    }
    for (const k of Object.keys(node)) {
      if (k === '_scope') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item.type === 'string') attachScopes(item, currentScope);
      } else if (v && typeof v.type === 'string') {
        attachScopes(v, currentScope);
      }
    }
  }

  function findFunctionScope(scope) {
    let s = scope;
    while (s && s.parent) s = s.parent;
    return s;
  }

  function resolveVar(scope, name) {
    let s = scope;
    while (s) {
      if (s.decls.has(name)) return s.decls.get(name);
      s = s.parent;
    }
    return `global:${name}`;
  }

  attachScopes(ast, null);

  function walk(node, cb) {
    if (!node || typeof node.type !== 'string') return;
    cb(node);
    for (const k of Object.keys(node)) {
      if (k === '_scope') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item.type === 'string') walk(item, cb);
      } else if (v && typeof v.type === 'string') {
        walk(v, cb);
      }
    }
  }

  function walkOwnBlock(node, cb) {
    if (!node || typeof node.type !== 'string') return;
    cb(node);
    for (const k of Object.keys(node)) {
      if (k === '_scope') continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item.type === 'string' && !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(item.type)) {
            walkOwnBlock(item, cb);
          }
        }
      } else if (v && typeof v.type === 'string' && !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(v.type)) {
        walkOwnBlock(v, cb);
      }
    }
  }

  function unwrap(node) {
    while (node && (node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression' || node.type === 'AwaitExpression')) {
      node = node.expression || node.argument;
    }
    return node;
  }

  const aliasArrays = new Set();
  const aliasLoopVars = new Set();
  const hostVars = new Set([...ALIAS_NAMES].map(n => `global:${n}`));
  const hostArrayVars = new Set();
  const hostFuncs = new Set();
  const hostArrayFuncs = new Set();
  const hostWrapperVars = new Set();
  const hostWrapperFuncs = new Set();

  function isAliasStringArray(node) {
    node = unwrap(node);
    if (!node) return false;
    if (node.type === 'ArrayExpression') {
      return node.elements.some(el => el && el.type === 'Literal' && ALIAS_NAMES.has(el.value));
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object?.name === 'Object' && node.callee.property?.name === 'freeze' &&
        node.arguments[0]) {
      return isAliasStringArray(node.arguments[0]);
    }
    return false;
  }

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isAliasStringArray(node.init)) {
      aliasArrays.add(resolveVar(node._scope, node.id.name));
    }
  });

  walk(ast, (node) => {
    if (node.type === 'ForOfStatement' && node.right?.type === 'Identifier' && aliasArrays.has(resolveVar(node.right._scope, node.right.name))) {
      const left = node.left;
      if (left.type === 'VariableDeclaration' && left.declarations[0]?.id?.type === 'Identifier') {
        aliasLoopVars.add(resolveVar(left._scope, left.declarations[0].id.name));
      }
    }
  });

  function isDirectGlobalAlias(node) {
    node = unwrap(node);
    if (!node) return false;
    if (node.type === 'Identifier' && ALIAS_NAMES.has(node.name)) {
      const resolved = resolveVar(node._scope, node.name);
      if (resolved.startsWith('global:')) return true;
    }
    if (node.type === 'MemberExpression' && !node.computed &&
        node.object.type === 'Identifier' && GLOBAL_OBJ_NAMES.has(node.object.name) &&
        node.property.type === 'Identifier' && ALIAS_NAMES.has(node.property.name)) {
      return true;
    }
    if (node.type === 'MemberExpression' && node.computed &&
        node.object.type === 'Identifier' && GLOBAL_OBJ_NAMES.has(node.object.name)) {
      if (node.property.type === 'Literal' && ALIAS_NAMES.has(node.property.value)) return true;
      if (node.property.type === 'Identifier' && aliasLoopVars.has(resolveVar(node.property._scope, node.property.name))) return true;
    }
    return false;
  }

  function isHostWrapperExpr(node) {
    node = unwrap(node);
    if (!node) return false;
    if (node.type === 'Identifier' && hostWrapperVars.has(resolveVar(node._scope, node.name))) return true;
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier' && hostWrapperFuncs.has(resolveVar(callee._scope, callee.name))) return true;
    }
    if (node.type === 'ObjectExpression' && node.properties.some(p => p.key?.name === 'api' && isHostExpr(p.value))) {
      return true;
    }
    return false;
  }

  function isHostExpr(node) {
    node = unwrap(node);
    if (!node) return false;
    if (isDirectGlobalAlias(node)) return true;
    if (node.type === 'Identifier' && hostVars.has(resolveVar(node._scope, node.name))) return true;
    if (node.type === 'MemberExpression' && !node.computed && node.property?.name === 'api' && isHostWrapperExpr(node.object)) {
      return true;
    }
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier' && hostFuncs.has(resolveVar(callee._scope, callee.name))) return true;
      if (callee.type === 'FunctionExpression' || callee.type === 'ArrowFunctionExpression') {
        if (callee.body.type !== 'BlockStatement') return isHostExpr(callee.body);
        let returnsHost = false;
        walkOwnBlock(callee.body, (sub) => {
          if (sub.type === 'ReturnStatement' && sub.argument && isHostExpr(sub.argument)) returnsHost = true;
        });
        if (returnsHost) return true;
      }
      if (callee.type === 'MemberExpression' && !callee.computed &&
          callee.property.type === 'Identifier' && ['find', 'at'].includes(callee.property.name) &&
          isHostArrayExpr(callee.object)) {
        return true;
      }
    }
    if (node.type === 'MemberExpression' && node.computed && isHostArrayExpr(node.object)) {
      return true;
    }
    if (node.type === 'LogicalExpression') {
      if (node.operator === '&&') return isHostExpr(node.right);
      return isHostExpr(node.left) || isHostExpr(node.right);
    }
    if (node.type === 'ConditionalExpression') {
      return isHostExpr(node.consequent) || isHostExpr(node.alternate);
    }
    return false;
  }

  function isHostArrayExpr(node) {
    node = unwrap(node);
    if (!node) return false;
    if (node.type === 'Identifier' && hostArrayVars.has(resolveVar(node._scope, node.name))) return true;
    if (node.type === 'ArrayExpression' && node.elements.some(el => el?.type === 'SpreadElement' && isHostArrayExpr(el.argument))) {
      return true;
    }
    if (node.type === 'CallExpression') {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier' && hostArrayFuncs.has(resolveVar(callee._scope, callee.name))) return true;
      if (callee.type === 'MemberExpression' && !callee.computed &&
          callee.property.type === 'Identifier' && ['filter', 'slice', 'concat', 'sort'].includes(callee.property.name) &&
          isHostArrayExpr(callee.object)) {
        return true;
      }
    }
    return false;
  }

  function analyzeFnBody(fnNode) {
    if (fnNode.end - fnNode.start > 3500) return { returnsHost: false, returnsHostArray: false, returnsHostWrapper: false };
    if (fnNode.body.type !== 'BlockStatement') {
      return {
        returnsHost: isHostExpr(fnNode.body),
        returnsHostArray: isHostArrayExpr(fnNode.body),
        returnsHostWrapper: isHostWrapperExpr(fnNode.body)
      };
    }
    const localArrays = new Set();
    const pushHelpers = new Map();
    let pushesWrapper = false;
    walkOwnBlock(fnNode.body, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init?.type === 'ArrayExpression') {
        localArrays.add(resolveVar(n._scope, n.id.name));
      }
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' &&
          (n.init?.type === 'ArrowFunctionExpression' || n.init?.type === 'FunctionExpression')) {
        walkOwnBlock(n.init.body, (sub) => {
          if (sub.type === 'CallExpression' && sub.callee.type === 'MemberExpression' &&
              ['push', 'unshift'].includes(sub.callee.property?.name) && sub.callee.object?.type === 'Identifier') {
            const arrKey = resolveVar(sub.callee.object._scope, sub.callee.object.name);
            if (localArrays.has(arrKey)) {
              const wrapsApi = sub.arguments[0]?.type === 'ObjectExpression' && sub.arguments[0].properties.some(p => p.key?.name === 'api');
              pushHelpers.set(resolveVar(n._scope, n.id.name), { arrKey, wrapsApi });
            }
          }
        });
      }
    });
    walkOwnBlock(fnNode.body, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
        const k = resolveVar(n.callee._scope, n.callee.name);
        const h = pushHelpers.get(k);
        if (h && n.arguments[0] && isHostExpr(n.arguments[0])) {
          if (h.wrapsApi) pushesWrapper = true;
          else hostArrayVars.add(h.arrKey);
        }
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
          ['push', 'unshift'].includes(n.callee.property?.name) && n.callee.object?.type === 'Identifier') {
        const arrKey = resolveVar(n.callee.object._scope, n.callee.object.name);
        if (localArrays.has(arrKey) && n.arguments[0] && isHostExpr(n.arguments[0])) {
          hostArrayVars.add(arrKey);
        }
      }
    });

    let returnsHost = false;
    let returnsHostArray = false;
    let returnsHostWrapper = false;
    walkOwnBlock(fnNode.body, (sub) => {
      if (sub.type === 'ReturnStatement' && sub.argument) {
        const ret = unwrap(sub.argument);
        if (pushesWrapper) returnsHostWrapper = true;
        else if (isHostWrapperExpr(ret)) returnsHostWrapper = true;
        else if (isHostArrayExpr(ret)) returnsHostArray = true;
        else if (isHostExpr(ret)) returnsHost = true;
      }
    });
    return { returnsHost, returnsHostArray, returnsHostWrapper };
  }

  for (let pass = 0; pass < 6; pass++) {
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
        const key = resolveVar(node._scope, node.id.name);
        const init = unwrap(node.init);
        if (init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression') {
          const info = analyzeFnBody(init);
          if (info.returnsHostWrapper) hostWrapperFuncs.add(key);
          if (info.returnsHostArray) hostArrayFuncs.add(key);
          if (info.returnsHost) hostFuncs.add(key);
        } else {
          if (isHostWrapperExpr(init)) hostWrapperVars.add(key);
          else if (isHostArrayExpr(init)) hostArrayVars.add(key);
          else if (isHostExpr(init)) hostVars.add(key);
        }
      }
      if (node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
        const key = resolveVar(node._scope.parent || node._scope, node.id.name);
        const info = analyzeFnBody(node);
        if (info.returnsHostWrapper) hostWrapperFuncs.add(key);
        if (info.returnsHostArray) hostArrayFuncs.add(key);
        if (info.returnsHost) hostFuncs.add(key);
      }
      if (node.type === 'ForOfStatement' && isHostArrayExpr(node.right)) {
        const left = node.left;
        if (left.type === 'VariableDeclaration' && left.declarations[0]?.id?.type === 'Identifier') {
          const id = left.declarations[0].id;
          hostVars.add(resolveVar(left._scope, id.name));
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed &&
          ['find', 'forEach', 'map', 'some', 'filter'].includes(node.callee.property?.name) &&
          isHostArrayExpr(node.callee.object)) {
        const fnArg = node.arguments[0];
        if (fnArg && (fnArg.type === 'ArrowFunctionExpression' || fnArg.type === 'FunctionExpression') && fnArg.params[0]?.type === 'Identifier') {
          hostVars.add(resolveVar(fnArg._scope, fnArg.params[0].name));
        }
      }
    });
  }

  const rawApis = new Set();
  const storageSubApis = {
    pluginStorage: new Set(),
    safeLocalStorage: new Set(),
    localPluginStorage: new Set()
  };

  walk(ast, (node) => {
    if (node.type === 'MemberExpression' && isHostExpr(node.object)) {
      let name = null;
      if (!node.computed && node.property.type === 'Identifier') {
        name = node.property.name;
      } else if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
        name = node.property.value;
      }
      if (name && !JS_BUILTINS.has(name)) {
        rawApis.add(name);
      }
    }
    // Check chained storage sub-methods: api.pluginStorage.getItem / api.safeLocalStorage.getItem
    if (node.type === 'MemberExpression' && node.object) {
      const inner = unwrap(node.object);
      if (inner?.type === 'MemberExpression' && isHostExpr(inner.object)) {
        const propName = !inner.computed ? inner.property?.name : (inner.property?.type === 'Literal' ? inner.property.value : null);
        const subName = !node.computed ? node.property?.name : (node.property?.type === 'Literal' ? node.property.value : null);
        if (propName && STORAGE_OBJECT_NAMES.has(propName) && subName && STORAGE_SUB_METHODS.has(subName)) {
          storageSubApis[propName].add(subName);
        }
      }
      if (inner?.type === 'CallExpression') {
        const callee = unwrap(inner.callee);
        if (callee?.type === 'MemberExpression' && isHostExpr(callee.object) && callee.property?.name === 'getLocalPluginStorage') {
          const subName = !node.computed ? node.property?.name : (node.property?.type === 'Literal' ? node.property.value : null);
          if (subName && STORAGE_SUB_METHODS.has(subName)) {
            storageSubApis.localPluginStorage.add(subName);
          }
        }
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      const calleeKey = resolveVar(node.callee._scope, node.callee.name);
      if (hostFuncs.has(calleeKey) || hostWrapperFuncs.has(calleeKey)) {
        for (const arg of node.arguments) {
          if (arg.type === 'Literal' && typeof arg.value === 'string' && !JS_BUILTINS.has(arg.value)) {
            rawApis.add(arg.value);
          } else if (arg.type === 'ArrayExpression') {
            for (const el of arg.elements) {
              if (el?.type === 'Literal' && typeof el.value === 'string' && !JS_BUILTINS.has(el.value)) {
                rawApis.add(el.value);
              }
            }
          }
        }
      }
    }
  });

  const apis = [];
  const optionalProbes = [];
  for (const name of [...rawApis].sort()) {
    if (Object.prototype.hasOwnProperty.call(ALLOWLISTED_OPTIONAL_PROBES, name)) {
      optionalProbes.push(name);
    } else {
      apis.push(name);
    }
  }

  return {
    apis,
    optionalProbes,
    storageSubApis: {
      pluginStorage: [...storageSubApis.pluginStorage].sort(),
      safeLocalStorage: [...storageSubApis.safeLocalStorage].sort(),
      localPluginStorage: [...storageSubApis.localPluginStorage].sort()
    }
  };
}

function buildRisuApiUsageInventory(options = {}) {
  const pluginDir = options.pluginDir ? path.resolve(options.pluginDir) : path.join(programDir, 'plugins');
  const apis = {};
  const optionalProbes = {};
  const byOwner = {};

  for (const entry of SHIPPED_PLUGINS) {
    const filePath = path.join(pluginDir, entry.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing_plugin_file:${filePath}`);
    }
    const src = fs.readFileSync(filePath, 'utf8');
    const analysis = analyzePluginSource(src, { owner: entry.owner, filePath });
    byOwner[entry.owner] = {
      file: entry.file,
      pluginName: entry.pluginName,
      apis: analysis.apis,
      optionalProbes: analysis.optionalProbes
    };
    for (const apiName of analysis.apis) {
      if (!apis[apiName]) apis[apiName] = { owners: [] };
      if (!apis[apiName].owners.includes(entry.owner)) {
        apis[apiName].owners.push(entry.owner);
        apis[apiName].owners.sort();
      }
    }
    for (const probeName of analysis.optionalProbes) {
      if (!optionalProbes[probeName]) {
        optionalProbes[probeName] = {
          owners: [],
          ...ALLOWLISTED_OPTIONAL_PROBES[probeName]
        };
      }
      if (!optionalProbes[probeName].owners.includes(entry.owner)) {
        optionalProbes[probeName].owners.push(entry.owner);
        optionalProbes[probeName].owners.sort();
      }
    }
  }

  const sortedApis = Object.fromEntries(
    Object.keys(apis).sort().map(k => [k, apis[k]])
  );
  const sortedProbes = Object.fromEntries(
    Object.keys(optionalProbes).sort().map(k => [k, optionalProbes[k]])
  );

  return {
    schema: 'librarian.risu-api-usage.v1',
    trackedAliases: [...ALIAS_NAMES],
    apis: sortedApis,
    allowlistedOptionalProbes: sortedProbes,
    allowlistedDynamicDispatches: ALLOWLISTED_DYNAMIC_DISPATCHES,
    byOwner
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { pluginDir: null, outputPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plugin-dir') out.pluginDir = path.resolve(argv[++i]);
    else if (arg === '--out' || arg === '--output') out.outputPath = path.resolve(argv[++i]);
    else throw new Error(`unknown_argument:${arg}`);
  }
  return out;
}

if (require.main === module) {
  try {
    const args = parseArgs();
    const inventory = buildRisuApiUsageInventory({ pluginDir: args.pluginDir });
    const json = JSON.stringify(inventory, null, 2) + '\n';
    if (args.outputPath) {
      fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
      fs.writeFileSync(args.outputPath, json, 'utf8');
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SHIPPED_PLUGINS,
  ALIAS_NAMES,
  ALLOWLISTED_OPTIONAL_PROBES,
  ALLOWLISTED_DYNAMIC_DISPATCHES,
  analyzePluginSource,
  buildRisuApiUsageInventory
};
