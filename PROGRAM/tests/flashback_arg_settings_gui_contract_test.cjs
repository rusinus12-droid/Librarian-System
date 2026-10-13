'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js');
const source = fs.readFileSync(pluginPath, 'utf8');

assert.equal(source.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1], source.match(/^\/\/@version (\d+\.\d+\.\d+)\s*$/m)?.[1], 'ARG settings runtime and install versions agree');

const declaredArgs = Array.from(source.matchAll(/^\/\/@arg\s+([a-z0-9_]+)\s+/gm), match => match[1]);
assert.ok(declaredArgs.length > 0, 'declared ARG inventory is not empty');
assert.equal(new Set(declaredArgs).size, declaredArgs.length, 'declared Flashback ARG names remain unique');

const block = (name, endMarker) => {
  const start = source.indexOf(name);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return source.slice(start, end);
};
const quotedNames = body => Array.from(body.matchAll(/name:\s*'([a-z0-9_]+)'/g), match => match[1]);
const camel = name => name.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());

const settingArgumentBlock = block('const SETTING_ARGUMENT_NAMES', 'const FLASHBACK_SPECIAL_ARGUMENTS');
const settingArgs = Array.from(settingArgumentBlock.matchAll(/'([a-z0-9_]+)'/g), match => match[1]);
assert.ok(settingArgs.length > 0, 'normal setting ARG inventory is not empty');
assert.equal(new Set(settingArgs).size, settingArgs.length, 'normal setting ARG names remain unique');

const specialBlock = block('const FLASHBACK_SPECIAL_ARGUMENTS', 'const FLASHBACK_READ_ONLY_ARGUMENT_SETTINGS');
const specialArgs = quotedNames(specialBlock);
assert.deepEqual(specialArgs, ['memory_suite_server_mode', 'memory_suite_server_url', 'embedding_key']);

const readOnlyBlock = block('const FLASHBACK_READ_ONLY_ARGUMENT_SETTINGS', 'const FLASHBACK_ARGUMENT_SETTING_GROUPS');
const readOnlyArgs = quotedNames(readOnlyBlock);
assert.equal(new Set(readOnlyArgs).size, readOnlyArgs.length, 'read-only ARG policies remain unique');
assert.ok(readOnlyArgs.every(name => settingArgs.includes(name)), 'read-only policies reference declared normal settings');
for (const name of ['min_capture_chars', 'enable_gui', 'auto_open_gui', 'continuation_tail_messages', 'hash_dimensions', 'fallback_hash_embedding']) {
  assert.ok(readOnlyArgs.includes(name), name + ' retains its explicit read-only policy');
}

const fieldBlock = block('const FLASHBACK_ARGUMENT_SETTING_FIELDS', 'const FLASHBACK_EXISTING_SETTING_CONTROLS');
const newFieldArgs = quotedNames(fieldBlock);
assert.ok(newFieldArgs.length > 0, 'active ARGs have grouped GUI fields');
assert.equal(new Set(newFieldArgs).size, newFieldArgs.length, 'new ARG-backed fields remain unique');
assert.deepEqual([...settingArgs, ...specialArgs].sort(), [...declaredArgs].sort(),
  'every declared ARG belongs to exactly one normal or special policy');
assert.ok(newFieldArgs.every(name => settingArgs.includes(name)), 'editable fields reference declared normal settings');
assert.ok(newFieldArgs.every(name => !readOnlyArgs.includes(name)), 'read-only settings cannot also have editable fields');

const existingBlock = block('const FLASHBACK_EXISTING_SETTING_CONTROLS', 'const argumentSettingControlId');
const existingKeys = Array.from(existingBlock.matchAll(/\b([A-Za-z][A-Za-z0-9]+):\s*'/g), match => match[1]);
const coveredKeys = new Set([
  ...newFieldArgs.map(camel),
  ...readOnlyArgs.map(camel),
  ...existingKeys
]);
const uncovered = settingArgs.filter(name => !coveredKeys.has(camel(name)));
assert.deepEqual(uncovered, [], 'every normal setting ARG has an editable control or an explicit read-only policy');

assert.match(source, /우선순위: 기본값 &lt; GUI 저장값 &lt; 명시적 ARG/);
assert.match(source, /data-clear-setting-arg=/);
assert.match(source, /data-toggle-arg-setting-group=/, 'ARG groups use explicit host-compatible toggle buttons');
assert.match(source, /aria-expanded="\$\{expanded\}"/, 'ARG group toggle exposes expanded state');
assert.match(source, /class="card" data-arg-setting-group="\$\{escapeHtml\(group\.id\)\}"/, 'ARG toggle remains inside the group ancestor required by its event binding');
assert.match(source, /id="\$\{panelId\}" class="stack" \$\{expanded \? '' : 'hidden'\}/, 'collapsed ARG panels use an explicit hidden state');
assert.match(source, /button\.addEventListener\('click',[\s\S]*?panel\.hidden = expanded;/, 'ARG group toggle controls the paired panel');
assert.doesNotMatch(source, /<details class="card arg-setting-group"/, 'ARG groups no longer depend on native details rendering');
assert.match(source, /const clearFlashbackSettingArgument = async/);
assert.match(source, /await setPluginArgumentValue\(name, ''\)/, 'ARG clear writes blank through the host API');
assert.match(source, /const after = await readArgumentEntry\(name\)/, 'ARG clear reads the canonical value back');
assert.match(source, /FLASHBACK_ARGUMENT_CLEAR_READBACK_FAILED/, 'failed clear readback is surfaced');
assert.match(source, /node\.disabled = true;[\s\S]*data-arg-locked/, 'explicit ARGs lock their GUI controls');
assert.match(source, /combined\.embeddingFallbackProvider = overrides\.fallbackHashEmbedding === false \? '' : 'hash'/,
  'fallback_hash_embedding overrides the normalized derived field');
assert.doesNotMatch(source, /id="argSetting_enableGui"/, 'the GUI cannot disable its own recovery surface');

process.stdout.write('flashback_arg_settings_gui_contract_test: PASS\n');
