#!/usr/bin/env node
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const PRODUCTS = ['LIBRA.js', 'Flashback_Memory.js', 'HAYAKU_Locator_Continuity.js'];
const contractPattern = () => /\/\* (?:MEMORY SUITE|LIBRARIAN SYSTEM) EXECUTION CONTRACT v[^\n]*— BEGIN[\s\S]*?\/\* (?:MEMORY SUITE|LIBRARIAN SYSTEM) EXECUTION CONTRACT v[^\n]*— END \*\//g;
const taskPattern = () => /  const TASK_DEFAULTS = Object\.freeze\(\{[\s\S]*?\n  \}\);/g;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys, label) {
  if (!object(value) || Object.keys(value).sort().join('\n') !== keys.slice().sort().join('\n')) throw new Error(`Invalid ${label} fields`);
}
function extractContract(text, label) {
  const blocks = [...text.matchAll(contractPattern())];
  const starts = text.match(/\/\* (?:MEMORY SUITE|LIBRARIAN SYSTEM) EXECUTION CONTRACT v[^\n]*— BEGIN/g) || [];
  const ends = text.match(/\/\* (?:MEMORY SUITE|LIBRARIAN SYSTEM) EXECUTION CONTRACT v[^\n]*— END \*\//g) || [];
  if (blocks.length !== 1 || starts.length !== 1 || ends.length !== 1) throw new Error(`Expected exactly one execution contract in ${label}`);
  if (starts[0].replace(/— BEGIN$/, '') !== ends[0].replace(/— END \*\/$/, '')) throw new Error(`Mismatched execution contract markers in ${label}`);
  return blocks[0][0];
}
function taskBlock(source) {
  const blocks = [...source.matchAll(taskPattern())];
  if (blocks.length !== 1) throw new Error('Expected exactly one TASK_DEFAULTS declaration');
  return blocks[0][0];
}
function withoutTaskDefaults(source) { return source.replace(taskBlock(source), '  /* designated task defaults */'); }
function readDefaults(source) {
  const block = taskBlock(source);
  const defaults = vm.runInNewContext(block + ';TASK_DEFAULTS', {}, {timeout:1000});
  validateDefaults(defaults);
  return defaults;
}
function validateDefaults(defaults) {
  if (!object(defaults)) throw new Error('Invalid task defaults');
  for (const [name, budget] of Object.entries(defaults)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || ['constructor','prototype'].includes(name) || !Array.isArray(budget) || budget.length !== 2 || !own(budget,0) || !own(budget,1) ||
        !budget.every(n => Number.isSafeInteger(n) && n > 0) || budget[0] > budget[1]) throw new Error(`Invalid task budget: ${name}`);
  }
}
function validateManifest(manifest, defaults) {
  exactKeys(manifest, ['version','products','profiles'], 'profile manifest');
  if (manifest.version !== 1) throw new Error('Unsupported execution profile manifest version');
  exactKeys(manifest.products, PRODUCTS, 'profile products');
  if (!object(manifest.profiles) || !Object.keys(manifest.profiles).length) throw new Error('Missing execution profiles');
  for (const [id, profile] of Object.entries(manifest.profiles)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid profile ID: ${id}`);
    exactKeys(profile, ['remove','add'], `profile ${id}`);
    if (!Array.isArray(profile.remove) || new Set(profile.remove).size !== profile.remove.length) throw new Error(`Invalid removals: ${id}`);
    for (const name of profile.remove) if (typeof name !== 'string' || !own(defaults,name)) throw new Error(`Unknown removed task: ${name}`);
    validateDefaults(profile.add);
    for (const name of Object.keys(profile.add)) if (own(defaults,name)) throw new Error(`Existing task cannot be overridden: ${name}`);
  }
  for (const id of Object.values(manifest.products)) if (typeof id !== 'string' || !own(manifest.profiles,id)) throw new Error(`Unknown execution profile: ${id}`);
}
function renderContract(source, manifest, profileId) {
  if (extractContract(source, 'shared source') !== source) throw new Error('Unexpected content outside shared execution contract');
  // Parse the entire shared contract without executing it: malformed helpers or
  // duplicate lexical declarations must never be propagated by a task-table sync.
  new vm.Script(source, {filename:'MemorySuiteExecutionContract.source.js'});
  const defaults = readDefaults(source);
  validateManifest(manifest, defaults);
  if (!own(manifest.profiles,profileId)) throw new Error(`Unknown execution profile: ${profileId}`);
  const profile = manifest.profiles[profileId];
  if (!profile.remove.length && !Object.keys(profile.add).length) return source;
  const selected = {...defaults};
  profile.remove.forEach(name => delete selected[name]);
  Object.assign(selected, profile.add);
  const block = '  const TASK_DEFAULTS = Object.freeze({\n' + Object.entries(selected).map(([name,budget]) => `    ${name}: [${budget.join(', ')}]`).join(',\n') + '\n  });';
  const generated = source.replace(taskBlock(source), () => block);
  new vm.Script(generated, {filename:`execution-profile-${profileId}.js`});
  return generated;
}
function synchronize({root = path.resolve(__dirname,'..'), check = false} = {}) {
  const source = fs.readFileSync(path.join(root,'sdk/MemorySuiteExecutionContract.source.js'),'utf8').trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'sdk/MemorySuiteExecutionProfiles.json'),'utf8'));
  // Prepare and validate the entire set before any write. A late bad target cannot partially sync the earlier ones.
  const prepared = PRODUCTS.map(file => {
    const generated = renderContract(source, manifest, manifest.products?.[file]);
    const target = path.join(root,'plugins',file), text = fs.readFileSync(target,'utf8');
    const block = extractContract(text,file);
    taskBlock(block);
    new vm.Script(block, {filename:file});
    if (check && block !== generated) throw new Error(`Execution contract profile ${manifest.products[file]} differs in ${file}`);
    return {target, text: text.replace(block, () => generated)};
  });
  if (!check) for (const row of prepared) fs.writeFileSync(row.target,row.text);
}
module.exports = {extractContract, withoutTaskDefaults, renderContract, synchronize};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check')) throw new Error('Usage: sync_execution_contract.cjs [--check]');
  const check = args.includes('--check');
  synchronize({check});
  console.log(check ? 'Execution contract embeddings match designated profiles.' : 'Execution contract profiles synchronized.');
}
