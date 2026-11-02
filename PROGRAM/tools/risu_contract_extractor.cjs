'use strict';
/**
 * RisuAI Upstream Contract Extractor
 *
 * Extracts the Librarian-relevant RisuAI host contracts from a pinned RisuAI upstream
 * checkout without vendoring or duplicating RisuAI's full source tree:
 * - Tracked file SHA-256 hashes (upstream-lock.json)
 * - Normalized API surface from `src/ts/plugins/apiV3/risuai.d.ts` and `v3.svelte.ts`
 * - Normalized runtime semantic fingerprints from `v3.svelte.ts`, `plugins.svelte.ts`,
 *   `pluginSafeClass.ts`, and `pluginStorageStore.ts`
 * - Plugin loader header contract from `src/ts/plugins/plugins.svelte.ts`
 * - Observable storage contract from `pluginSafeClass.ts` and `pluginStorageStore.ts`
 * - Bidirectional IPC contract from `v3.svelte.ts` and `plugins.svelte.ts`
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildRisuApiUsageInventory, SHIPPED_PLUGINS } = require('./risu_api_usage_inventory.cjs');

const TRACKED_UPSTREAM_FILES = Object.freeze([
  'src/ts/plugins/apiV3/risuai.d.ts',
  'src/ts/plugins/apiV3/v3.svelte.ts',
  'src/ts/plugins/plugins.svelte.ts',
  'src/ts/plugins/pluginSafeClass.ts',
  'src/ts/process/pluginStorageStore.ts'
]);

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeImplementationSlice(sourceText) {
  return String(sourceText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBalancedBlock(sourceText, startIndex, openChar = '{', closeChar = '}') {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockStart = -1;

  for (let i = startIndex; i < sourceText.length; i++) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '`') inTemplate = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }

    if (ch === openChar) {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0 && blockStart !== -1) {
        return sourceText.slice(startIndex, i + 1);
      }
    }
  }
  throw new Error(`unbalanced_block_at:${startIndex}`);
}

function stripDtsComments(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed.startsWith('/*')) {
        if (!trimmed.endsWith('*/') || trimmed === '/*' || trimmed === '/**') {
          inBlock = true;
        }
        continue;
      }
      if (trimmed.startsWith('//')) continue;
      out.push(line.replace(/\/\/[^\n]*$/, ''));
    } else {
      if (trimmed === '*/' || (trimmed.endsWith('*/') && !trimmed.startsWith('* ') && !trimmed.includes('replace('))) {
        inBlock = false;
      }
    }
  }
  return out.join('\n');
}

function extractInterfaceBody(dtsText, interfaceName) {
  const re = new RegExp(`^interface\\s+${interfaceName}\\b[^\\{]*\\{([\\s\\S]*?)^\\}`, 'm');
  const m = re.exec(dtsText);
  if (!m) throw new Error(`dts_interface_missing:${interfaceName}`);
  return m[1];
}

function splitTopLevelParams(paramString) {
  const text = String(paramString || '').trim();
  if (!text) return [];
  const parts = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '<') depthAngle++;
    else if (ch === '>' && prev !== '=') depthAngle = Math.max(0, depthAngle - 1);

    if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseParameterDef(rawParam) {
  const clean = stripDtsComments(rawParam).replace(/\s+/g, ' ').trim();
  const colonIdx = clean.indexOf(':');
  if (colonIdx === -1) {
    return { name: clean, optional: false, type: 'any' };
  }
  const rawName = clean.slice(0, colonIdx).trim();
  const optional = rawName.endsWith('?') || clean.slice(colonIdx + 1).includes('=');
  const name = rawName.replace(/\?$/, '').trim();
  let typePart = clean.slice(colonIdx + 1).trim();
  const eqMatch = typePart.match(/^(.*?)\s*=\s*['"0-9a-zA-Z_-]+$/);
  if (eqMatch) typePart = eqMatch[1].trim();
  const isCallback = typePart.includes('=>') || typePart === 'Function' || /Callback\b/.test(typePart);
  return {
    name,
    optional,
    type: typePart,
    ...(isCallback ? { callbackShape: typePart } : {})
  };
}

function parseInterfaceMembers(dtsText, interfaceName) {
  const rawBody = extractInterfaceBody(dtsText, interfaceName);
  const deprecatedNames = new Set();
  for (const m of rawBody.matchAll(/@deprecated[\s\S]*?\n\s*\*\/\s*\n\s*([a-zA-Z0-9_]+)/g)) {
    deprecatedNames.add(m[1]);
  }

  const cleanBody = stripDtsComments(rawBody);

  const statements = [];
  let current = '';
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let depthAngle = 0;

  for (let i = 0; i < cleanBody.length; i++) {
    const ch = cleanBody[i];
    const prev = cleanBody[i - 1];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '<') depthAngle++;
    else if (ch === '>' && prev !== '=') depthAngle = Math.max(0, depthAngle - 1);

    if (depthParen === 0 && depthBrace === 0 && depthBracket === 0 && depthAngle === 0 && (ch === ';' || ch === '\n')) {
      const trimmed = current.replace(/\s+/g, ' ').trim();
      if (trimmed && (ch === ';' || (trimmed.includes(':') && !trimmed.endsWith(':') && !trimmed.endsWith('=>')))) {
        statements.push(trimmed.replace(/;$/, '').trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) {
    statements.push(current.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim());
  }

  const members = {};
  for (const normalizedStmt of statements) {
    if (!normalizedStmt) continue;
    const fnPropMatch = normalizedStmt.match(/^([a-zA-Z0-9_]+)\s*:\s*\((.*)\)\s*=>\s*(.+)$/);
    const methodMatch = normalizedStmt.match(/^([a-zA-Z0-9_]+)(?:<[^>]+>)?\s*\(([\s\S]*)\)\s*:\s*(.+)$/);
    const propMatch = normalizedStmt.match(/^([a-zA-Z0-9_]+)\s*:\s*(.+)$/);

    if (fnPropMatch || methodMatch) {
      const m = fnPropMatch || methodMatch;
      const name = m[1];
      const rawParams = m[2];
      const returnType = m[3].trim();
      const params = splitTopLevelParams(rawParams).map(parseParameterDef);
      const requiredArgs = params.filter(p => !p.optional).length;
      const optionalArgs = params.filter(p => p.optional).length;
      const returnsPromise = /^Promise<[\s\S]+>$/.test(returnType);
      const deprecated = deprecatedNames.has(name);

      if (members[name]) {
        members[name].overloads = members[name].overloads || [
          {
            parameters: members[name].parameters,
            returnType: members[name].returnType
          }
        ];
        members[name].overloads.push({ parameters: params, returnType });
      } else {
        members[name] = {
          name,
          kind: 'method',
          requiredArgs,
          optionalArgs,
          parameters: params,
          returnType,
          returnsPromise,
          deprecated,
          declaredInDts: true
        };
      }
    } else if (propMatch) {
      const name = propMatch[1];
      const propType = propMatch[2].trim();
      const isStorageNamespace = ['PluginStorage', 'SafeLocalStorage'].includes(propType);
      members[name] = {
        name,
        kind: isStorageNamespace ? 'namespace' : 'property',
        type: propType,
        deprecated: deprecatedNames.has(name),
        declaredInDts: true
      };
    }
  }

  return members;
}

function parseRisuaiDtsSurface(dtsText) {
  return parseInterfaceMembers(dtsText, 'RisuaiPluginAPI');
}

function extractV3MethodBlock(v3Text, methodName) {
  const apiStart = v3Text.indexOf('const makeRisuaiAPIV3 =');
  if (apiStart === -1) throw new Error('v3_makeRisuaiAPIV3_missing');
  const slice = v3Text.slice(apiStart);
  const pattern = new RegExp(`(?:^|\\n)\\s{8}${methodName}\\s*(?::|\\()`, 'm');
  const match = pattern.exec(slice);
  if (!match) return null;
  const startIdx = apiStart + match.index + match[0].indexOf(methodName);

  const lineEnd = v3Text.indexOf('\n', startIdx);
  const firstLine = v3Text.slice(startIdx, lineEnd).trim();
  if (!firstLine.includes('{') && firstLine.endsWith(',')) {
    return firstLine.slice(0, -1).trim();
  }
  const openBraceIdx = v3Text.indexOf('{', startIdx);
  if (openBraceIdx !== -1 && openBraceIdx - startIdx < 350) {
    return extractBalancedBlock(v3Text, startIdx, '{', '}');
  }
  return firstLine;
}

function extractV2MethodBlock(pluginsText, methodName) {
  const v2Start = pluginsText.indexOf('export const getV2PluginAPIs =');
  if (v2Start === -1) return null;
  const slice = pluginsText.slice(v2Start);
  const pattern = new RegExp(`(?:^|\\n)\\s{8}${methodName}\\s*:`, 'm');
  const match = pattern.exec(slice);
  if (!match) return null;
  const startIdx = v2Start + match.index + match[0].indexOf(methodName);
  const lineEnd = pluginsText.slice(startIdx).indexOf('\n');
  const firstLine = slice.slice(match.index + match[0].indexOf(methodName), match.index + match[0].indexOf(methodName) + lineEnd).trim();
  if (!firstLine.includes('{') && firstLine.endsWith(',')) {
    return firstLine.slice(0, -1).trim();
  }
  return extractBalancedBlock(pluginsText, startIdx, '{', '}');
}

function extractClassOrFunctionBlock(sourceText, marker) {
  const idx = sourceText.indexOf(marker);
  if (idx === -1) throw new Error(`marker_not_found:${marker}`);
  return extractBalancedBlock(sourceText, idx, '{', '}');
}

const HIGH_RISK_SEMANTIC_DEFINITIONS = Object.freeze({
  addRisuChatListener: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    delegateFile: 'src/ts/plugins/plugins.svelte.ts',
    semanticContract: [
      'requires_replacer_permission_periodically',
      'accepts_output_mode_only',
      'registers_listener_in_chatOutput_set',
      'auto_unregisters_on_plugin_unload',
      'callback_receives_committed_snapshot_char_chat_characterIndex_chatIndex_messageIndex'
    ]
  },
  removeRisuChatListener: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    delegateFile: 'src/ts/plugins/plugins.svelte.ts',
    semanticContract: [
      'accepts_output_mode_only',
      'deletes_listener_from_chatOutput_set'
    ]
  },
  addRisuReplacer: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    delegateFile: 'src/ts/plugins/plugins.svelte.ts',
    semanticContract: [
      'requires_replacer_permission_periodically',
      'supports_beforeRequest_and_afterRequest',
      'auto_unregisters_on_plugin_unload'
    ]
  },
  removeRisuReplacer: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    delegateFile: 'src/ts/plugins/plugins.svelte.ts',
    semanticContract: [
      'supports_beforeRequest_and_afterRequest',
      'deletes_handler_from_replacer_set'
    ]
  },
  addRisuScriptHandler: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    delegateFile: 'src/ts/plugins/plugins.svelte.ts',
    semanticContract: [
      'supports_display_output_input_process_modes',
      'registers_handler_in_edit_mode_set'
    ]
  },
  getChatFromIndex: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'resolves_character_by_index_in_db_characters',
      'resolves_chat_by_chatIndex_in_character_chats',
      'returns_state_snapshot_clone_or_null'
    ]
  },
  setChatToIndex: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'resolves_character_by_index_and_chat_by_chatIndex',
      'assigns_chat_when_character_and_chat_exist'
    ]
  },
  getCurrentCharacterIndex: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'returns_selectedCharID_store_value'
    ]
  },
  getCurrentChatIndex: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'reads_selectedCharID_and_returns_character_chatPage'
    ]
  },
  getCharacterFromIndex: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'resolves_character_by_index_in_db_characters',
      'returns_state_snapshot_clone_or_null'
    ]
  },
  getDatabase: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'requires_db_permission_periodically',
      'returns_null_when_permission_denied',
      'filters_to_allowedDbKeys_and_includeOnly_subset',
      'returns_state_snapshots_of_allowed_keys'
    ]
  },
  getArgument: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'looks_up_current_plugin_by_name_in_db_plugins',
      'returns_realArg_value_for_key'
    ]
  },
  setArgument: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'looks_up_current_plugin_by_name_in_db_plugins',
      'mutates_realArg_value_for_key'
    ]
  },
  getLocalPluginStorage: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    classFile: 'src/ts/plugins/pluginSafeClass.ts',
    classMarker: 'export class SafeLocalPluginStorage',
    semanticContract: [
      'returns_remote_required_SafeLocalPluginStorage_instance',
      'prefixes_keys_with_safe_plugin_',
      'stores_json_serializable_values_in_localforage'
    ]
  },
  requestPluginPermission: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'delegates_to_getPermission_with_script_hash_session_cache'
    ]
  },
  addPluginChannelListener: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'scopes_channel_key_by_plugin_name_plus_channelName',
      'auto_deletes_channel_listener_on_plugin_unload'
    ]
  },
  postPluginChannelMessage: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'receiver_exists',
      'receiver_allows_sender',
      'sender_allows_receiver',
      'callback_receives_sender_and_channel'
    ]
  },
  runLLMModel: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'delegates_to_requestChatDataMain_with_formated_messages',
      'blocks_plugin_models_by_default_unless_allowPlugins_true',
      'passes_mode_and_optional_staticModel'
    ]
  },
  nativeFetch: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'blocks_urlBlacklist_domains',
      'delegates_to_oldApis_nativeFetch'
    ]
  },
  risuFetch: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'deprecated_in_favor_of_nativeFetch',
      'blocks_urlBlacklist_domains',
      'delegates_to_oldApis_risuFetch'
    ]
  },
  registerSetting: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'validates_iconType_html_img_or_none',
      'replaces_in_place_when_id_already_exists_in_additionalSettingsMenu',
      'registers_unload_cleanup_callback',
      'returns_object_with_id'
    ]
  },
  registerButton: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'validates_name_non_empty_and_iconType_html_img_none',
      'defaults_location_to_action_supports_action_hamburger_chat',
      'replaces_in_place_across_button_stores_when_id_exists',
      'registers_unload_cleanup_callback',
      'returns_object_with_id'
    ]
  },
  unregisterUIPart: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'removes_matching_id_from_settings_action_hamburger_chat_menus_and_chatPanelStore'
    ]
  },
  onUnload: {
    sourceFile: 'src/ts/plugins/apiV3/v3.svelte.ts',
    semanticContract: [
      'registers_callback_in_pluginUnloadCallbacks_for_current_plugin'
    ]
  },
  pluginStorage: {
    sourceFile: 'src/ts/process/pluginStorageStore.ts',
    classMarker: 'export class PluginStorageStore',
    semanticContract: [
      'json_serializes_values_on_setItem_and_parses_on_getItem',
      'returns_null_for_missing_keys',
      'protects_reserved_keys_coldpluginIndex_and_coldplugin',
      'maintains_immediate_in_memory_readback_consistency'
    ]
  }
});

function extractUpstreamContracts(upstreamDir, options = {}) {
  const root = path.resolve(upstreamDir);
  const fileHashes = {};
  const fileContents = {};

  for (const rel of TRACKED_UPSTREAM_FILES) {
    const full = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(full)) {
      throw new Error(`missing_upstream_file:${rel}`);
    }
    fileHashes[rel] = sha256File(full);
    fileContents[rel] = fs.readFileSync(full, 'utf8');
  }

  const dtsText = fileContents['src/ts/plugins/apiV3/risuai.d.ts'];
  const v3Text = fileContents['src/ts/plugins/apiV3/v3.svelte.ts'];
  const pluginsText = fileContents['src/ts/plugins/plugins.svelte.ts'];
  const safeClassText = fileContents['src/ts/plugins/pluginSafeClass.ts'];
  const storageStoreText = fileContents['src/ts/process/pluginStorageStore.ts'];

  const dtsSurface = parseRisuaiDtsSurface(dtsText);
  const subInterfaces = {
    PluginStorage: parseInterfaceMembers(dtsText, 'PluginStorage'),
    SafeLocalPluginStorage: parseInterfaceMembers(dtsText, 'SafeLocalPluginStorage'),
    SafeLocalStorage: parseInterfaceMembers(dtsText, 'SafeLocalStorage'),
    SafeDocument: parseInterfaceMembers(dtsText, 'SafeDocument'),
    SafeElement: parseInterfaceMembers(dtsText, 'SafeElement')
  };

  if (!dtsSurface.risuFetch) {
    dtsSurface.risuFetch = {
      name: 'risuFetch',
      kind: 'method',
      requiredArgs: 1,
      optionalArgs: 1,
      parameters: [
        { name: 'url', optional: false, type: 'string' },
        { name: 'options', optional: true, type: 'any' }
      ],
      returnType: 'Promise<any>',
      returnsPromise: true,
      deprecated: true,
      declaredInDts: false
    };
  }
  if (!dtsSurface.alertError) {
    dtsSurface.alertError = {
      name: 'alertError',
      kind: 'method',
      requiredArgs: 1,
      optionalArgs: 0,
      parameters: [
        { name: 'msg', optional: false, type: 'string' }
      ],
      returnType: 'Promise<void>',
      returnsPromise: true,
      deprecated: false,
      declaredInDts: false
    };
  }

  for (const [name, entry] of Object.entries(dtsSurface)) {
    if (name === 'apiVersion' || name === 'apiVersionCompatibleWith') {
      entry.implementedInV3 = v3Text.includes('_getPropertiesForInitialization') && v3Text.includes(name);
    } else if (name === 'pluginStorage' || name === 'safeLocalStorage') {
      entry.implementedInV3 = v3Text.includes('_getAliases') && v3Text.includes(`'${name}'`);
      if (name === 'pluginStorage') entry.subMethods = subInterfaces.PluginStorage;
      if (name === 'safeLocalStorage') entry.subMethods = subInterfaces.SafeLocalStorage;
    } else {
      entry.implementedInV3 = extractV3MethodBlock(v3Text, name) !== null;
      if (name === 'getLocalPluginStorage') entry.subMethods = subInterfaces.SafeLocalPluginStorage;
    }
  }

  const runtimeSemantics = {};
  for (const [methodName, spec] of Object.entries(HIGH_RISK_SEMANTIC_DEFINITIONS)) {
    const slices = [];
    if (spec.sourceFile === 'src/ts/plugins/apiV3/v3.svelte.ts') {
      const v3Block = extractV3MethodBlock(v3Text, methodName);
      if (!v3Block) throw new Error(`v3_semantic_block_missing:${methodName}`);
      slices.push(normalizeImplementationSlice(v3Block));
    }
    if (spec.delegateFile === 'src/ts/plugins/plugins.svelte.ts') {
      const v2Block = extractV2MethodBlock(pluginsText, methodName);
      if (!v2Block) throw new Error(`v2_delegate_block_missing:${methodName}`);
      slices.push(normalizeImplementationSlice(v2Block));
    }
    if (spec.classFile && spec.classMarker) {
      const classBlock = extractClassOrFunctionBlock(fileContents[spec.classFile], spec.classMarker);
      slices.push(normalizeImplementationSlice(classBlock));
    } else if (spec.sourceFile === 'src/ts/process/pluginStorageStore.ts' && spec.classMarker) {
      const classBlock = extractClassOrFunctionBlock(storageStoreText, spec.classMarker);
      slices.push(normalizeImplementationSlice(classBlock));
    }

    const combinedNormalized = slices.join(' :: ');
    runtimeSemantics[methodName] = {
      method: methodName,
      sourceFile: spec.sourceFile,
      ...(spec.delegateFile ? { delegateFile: spec.delegateFile } : {}),
      ...(spec.classFile ? { classFile: spec.classFile } : {}),
      semanticContract: spec.semanticContract,
      implementationFingerprint: sha256Text(combinedNormalized)
    };
  }

  const importPluginBlock = extractClassOrFunctionBlock(pluginsText, 'export async function importPlugin');
  const checkPluginUpdateBlock = extractClassOrFunctionBlock(pluginsText, 'export const checkPluginUpdate');
  const loaderFingerprint = sha256Text(
    normalizeImplementationSlice(importPluginBlock) + ' :: ' + normalizeImplementationSlice(checkPluginUpdateBlock)
  );

  const safeLocalStorageBlock = extractClassOrFunctionBlock(safeClassText, 'export class SafeLocalStorage');
  const safeLocalPluginStorageBlock = extractClassOrFunctionBlock(safeClassText, 'export class SafeLocalPluginStorage');
  const pluginStorageStoreBlock = extractClassOrFunctionBlock(storageStoreText, 'export class PluginStorageStore');

  return {
    fileHashes,
    dtsSurface,
    subInterfaces,
    runtimeSemantics,
    loaderFingerprint,
    storageFingerprints: {
      SafeLocalStorage: sha256Text(normalizeImplementationSlice(safeLocalStorageBlock)),
      SafeLocalPluginStorage: sha256Text(normalizeImplementationSlice(safeLocalPluginStorageBlock)),
      PluginStorageStore: sha256Text(normalizeImplementationSlice(pluginStorageStoreBlock))
    },
    ipcFingerprints: {
      addPluginChannelListener: runtimeSemantics.addPluginChannelListener.implementationFingerprint,
      postPluginChannelMessage: runtimeSemantics.postPluginChannelMessage.implementationFingerprint
    }
  };
}

function buildCompatibilityPack(upstreamDir, options = {}) {
  const repository = options.repository || 'kwaroran/Risuai';
  const commit = options.commit || 'ea61945f9038e0189807d075f55f4e66ab7e98bf';
  const extracted = extractUpstreamContracts(upstreamDir, { repository, commit });
  const usage = buildRisuApiUsageInventory({ pluginDir: options.pluginDir });

  const upstreamLock = {
    schema: 'librarian.risu-upstream-lock.v1',
    repository,
    commit,
    files: extracted.fileHashes
  };

  const usedApiContracts = {};
  for (const [apiName, usageInfo] of Object.entries(usage.apis)) {
    const surfaceDef = extracted.dtsSurface[apiName];
    if (!surfaceDef) {
      throw new Error(`unmapped_risuai_api_in_usage:${apiName}`);
    }
    usedApiContracts[apiName] = {
      ...surfaceDef,
      owners: usageInfo.owners
    };
  }

  const apiSurface = {
    schema: 'librarian.risu-api-surface.v1',
    repository,
    commit,
    sourceFiles: {
      declarations: 'src/ts/plugins/apiV3/risuai.d.ts',
      implementation: 'src/ts/plugins/apiV3/v3.svelte.ts'
    },
    trackedAliases: usage.trackedAliases,
    apis: usedApiContracts,
    hostSurface: extracted.dtsSurface,
    allowlistedOptionalProbes: usage.allowlistedOptionalProbes,
    allowlistedDynamicDispatches: usage.allowlistedDynamicDispatches
  };

  const runtimeSemantics = {
    schema: 'librarian.risu-runtime-semantics.v1',
    repository,
    commit,
    driftFailureCode: 'RISUAI_UPSTREAM_SEMANTIC_DRIFT',
    methods: extracted.runtimeSemantics
  };

  const pluginDir = options.pluginDir ? path.resolve(options.pluginDir) : path.resolve(__dirname, '..', 'plugins');
  const shippedPluginHeaders = {};
  const ipcPeers = {};

  for (const item of SHIPPED_PLUGINS) {
    const src = fs.readFileSync(path.join(pluginDir, item.file), 'utf8');
    const lines = src.split(/\r?\n/);
    const nameLine = lines.find(l => l.startsWith('//@name'));
    const apiLine = lines.find(l => l.startsWith('//@api'));
    const verLine = lines.find(l => l.startsWith('//@version'));
    const displayLine = lines.find(l => l.startsWith('//@display-name'));
    const updateLine = lines.find(l => l.startsWith('//@update-url'));
    const allowedIpc = [];
    for (const l of lines) {
      if (l.startsWith('//@allowed-ipc')) {
        const parts = l.trim().split(/\s+/).slice(1);
        for (const p of parts) {
          if (p && !allowedIpc.includes(p)) allowedIpc.push(p);
        }
      }
    }
    const pluginName = nameLine ? nameLine.slice(7).trim() : item.pluginName;
    shippedPluginHeaders[item.owner] = {
      owner: item.owner,
      file: item.file,
      pluginName,
      displayName: displayLine ? displayLine.slice('//@display-name'.length + 1).trim() : null,
      apiVersion: apiLine ? apiLine.slice(6).trim().split(/\s+/)[0] : null,
      hasUpdateUrl: Boolean(updateLine),
      hasVersionDirective: Boolean(verLine),
      allowedIPC: allowedIpc
    };
    ipcPeers[pluginName] = {
      owner: item.owner,
      file: item.file,
      allowedIPC: allowedIpc
    };
  }

  const pluginLoaderContract = {
    schema: 'librarian.risu-plugin-loader-contract.v1',
    repository,
    commit,
    sourceFile: 'src/ts/plugins/plugins.svelte.ts',
    implementationFingerprint: extracted.loaderFingerprint,
    headerDirectives: {
      '//@name': { required: true, nonEmpty: true },
      '//@api': { required: true, supportedVersions: ['3.0'], rejectedOnInstall: ['2.0', '2.1'] },
      '//@version': {
        requiredWhenUpdateUrlPresent: true,
        minVersion: '0.0.1',
        maxByteOffsetInImportPlugin: 500,
        updateCheckRangeHeaderBytes: 512
      },
      '//@display-name': { required: false, nonEmptyWhenPresent: true },
      '//@arg': {
        aliases: ['//@arg', '//@risu-arg'],
        allowedTypes: ['int', 'string'],
        defaultValues: { int: 0, string: '' }
      },
      '//@allowed-ipc': {
        required: false,
        spaceSeparatedPeerNames: true,
        accumulatesAcrossLines: true
      },
      '//@update-url': {
        required: false,
        requiredProtocol: 'https:'
      },
      '//@link': {
        required: false,
        requiredPrefix: 'https'
      }
    },
    minifiedArtifactPreservation: {
      mustPreserveAllSourceDirectives: true,
      mustKeepVersionWithinFirst500Bytes: true
    },
    shippedPlugins: shippedPluginHeaders
  };

  const storageContract = {
    schema: 'librarian.risu-storage-contract.v1',
    repository,
    commit,
    sourceFiles: [
      'src/ts/plugins/pluginSafeClass.ts',
      'src/ts/process/pluginStorageStore.ts'
    ],
    implementationFingerprints: extracted.storageFingerprints,
    primitives: {
      pluginStorage: {
        asyncMethods: true,
        methods: ['getItem', 'setItem', 'removeItem', 'clear', 'key', 'keys', 'length'],
        valueDomain: 'json_serializable',
        missingKeyReturns: null,
        undefinedSerializesToNull: true,
        nonSerializableThrows: true,
        reservedInternalKeys: ['_coldpluginIndex', '_coldplugin'],
        immediateReadbackConsistency: true
      },
      safeLocalStorage: {
        asyncMethodsInV3Rpc: true,
        methods: ['getItem', 'setItem', 'removeItem', 'clear', 'key', 'keys', 'length'],
        valueDomain: 'string',
        keyPrefix: 'safe_plugin_',
        missingKeyReturns: null
      },
      getLocalPluginStorage: {
        asyncFactory: true,
        remoteRequiredClass: true,
        methods: ['getItem', 'setItem', 'removeItem', 'keys', 'clear'],
        valueDomain: 'json_serializable',
        keyPrefix: 'safe_plugin_',
        missingKeyReturns: null,
        freshProxyPerCall: true
      }
    },
    storageAuthoritySeparation: {
      hostOwnsStorageAuthority: false,
      authorityOwner: 'Librarian Storage SDK',
      operationalModes: ['plugin_only', 'server_only'],
      transitionCompatibilityMode: 'mirror',
      modeContracts: {
        plugin_only: {
          canonicalStore: 'risuai.pluginStorage',
          allowedServerCanonicalRequests: 0,
          worksWithoutServer: true,
          violationCode: 'PLUGIN_ONLY_SERVER_CANONICAL_REQUEST_FORBIDDEN'
        },
        server_only: {
          canonicalStore: 'Librarian Server (PROGRAM/server/server.cjs)',
          allowedLocalCanonicalWrites: 0,
          serverOfflineBehavior: 'fail_closed',
          allowSilentFallbackToPluginOnly: false,
          localWriteViolationCode: 'SERVER_ONLY_LOCAL_CANONICAL_WRITE_FORBIDDEN',
          offlineFallbackViolationCode: 'SERVER_ONLY_OFFLINE_FALLBACK_FORBIDDEN'
        }
      },
      transitionContract: {
        authoritativeDoc: 'PROGRAM/docs/STORAGE_MODE_TRANSITION_CONTRACT.md',
        pluginToServerRequiresVerifiedReadbackAndDigestBeforeCutover: true,
        serverToPluginRequiresVerifiedRestoreAndReadbackBeforeCutover: true,
        failedTransitionPreservesSourceAuthority: true
      }
    }
  };

  const ipcContract = {
    schema: 'librarian.risu-ipc-contract.v1',
    repository,
    commit,
    sourceFiles: [
      'src/ts/plugins/apiV3/v3.svelte.ts',
      'src/ts/plugins/plugins.svelte.ts'
    ],
    implementationFingerprints: extracted.ipcFingerprints,
    semantics: {
      channelKeyFormula: 'plugin.name + channelName',
      unloadAutoCleanup: true,
      requireReceiverExists: true,
      requireReceiverAllowsSender: true,
      requireSenderAllowsReceiver: true,
      callbackSecondArgShape: {
        sender: 'string',
        channel: 'string'
      },
      preserveDirectivesInMinifiedArtifact: true
    },
    plugins: ipcPeers
  };

  return {
    upstreamLock,
    apiSurface,
    runtimeSemantics,
    pluginLoaderContract,
    storageContract,
    ipcContract
  };
}

function writeCompatibilityPack(upstreamDir, contractsDir, options = {}) {
  const targetDir = path.resolve(contractsDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const pack = buildCompatibilityPack(upstreamDir, options);

  const files = {
    'upstream-lock.json': pack.upstreamLock,
    'api-surface.json': pack.apiSurface,
    'runtime-semantics.json': pack.runtimeSemantics,
    'plugin-loader-contract.json': pack.pluginLoaderContract,
    'storage-contract.json': pack.storageContract,
    'ipc-contract.json': pack.ipcContract
  };

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(targetDir, name), JSON.stringify(content, null, 2) + '\n', 'utf8');
  }
  return pack;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    upstreamDir: null,
    writePackDir: null,
    commit: 'ea61945f9038e0189807d075f55f4e66ab7e98bf',
    repository: 'kwaroran/Risuai'
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--upstream-dir') out.upstreamDir = path.resolve(argv[++i]);
    else if (arg === '--write-pack') out.writePackDir = path.resolve(argv[++i]);
    else if (arg === '--commit') out.commit = String(argv[++i]);
    else if (arg === '--repository') out.repository = String(argv[++i]);
    else throw new Error(`unknown_argument:${arg}`);
  }
  return out;
}

if (require.main === module) {
  try {
    const args = parseArgs();
    if (!args.upstreamDir) throw new Error('missing_required_argument:--upstream-dir');
    if (args.writePackDir) {
      const pack = writeCompatibilityPack(args.upstreamDir, args.writePackDir, args);
      process.stdout.write(JSON.stringify({ status: 'written', dir: args.writePackDir, files: Object.keys(pack) }, null, 2) + '\n');
    } else {
      const extracted = extractUpstreamContracts(args.upstreamDir, args);
      process.stdout.write(JSON.stringify(extracted, null, 2) + '\n');
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  TRACKED_UPSTREAM_FILES,
  HIGH_RISK_SEMANTIC_DEFINITIONS,
  sha256Text,
  sha256File,
  normalizeImplementationSlice,
  extractBalancedBlock,
  parseInterfaceMembers,
  parseRisuaiDtsSurface,
  extractV3MethodBlock,
  extractV2MethodBlock,
  extractUpstreamContracts,
  buildCompatibilityPack,
  writeCompatibilityPack
};
