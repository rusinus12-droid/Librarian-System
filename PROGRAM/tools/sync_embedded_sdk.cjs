'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {STORAGE_VARIANTS,extractStorageSdk,expectedStorageSdk}=require('./lib/sdk_variants.cjs');
const computeSdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8').trimEnd();
const embeddedSdkPattern = /\/\* LIBRARIAN SYSTEM STORAGE SDK v[^\r\n]+[\s\S]*?\r?\n  return bridge;\r?\n\r?\n};/;
const embeddedComputeSdkPattern = /\/\* LIBRARIAN SYSTEM COMPUTE SDK v[^\r\n]+[\s\S]*?\r?\n  return bridge;\r?\n};/;
const hostLineageSdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteHostLineage.source.js'), 'utf8').trimEnd();
const hostLineagePattern = /\/\* LIBRARIAN HOST LINEAGE SDK v[^\r\n]+[\s\S]*?\/\* END LIBRARIAN HOST LINEAGE SDK \*\//;
const pluginArgIndex = process.argv.indexOf('--plugin');
const selectedPlugin = pluginArgIndex >= 0 ? String(process.argv[pluginArgIndex + 1] || '').trim() : '';

if(selectedPlugin&&!Object.hasOwn(STORAGE_VARIANTS,selectedPlugin))throw Error('storage_sdk_variant_unknown:'+selectedPlugin);
const plannedWrites=[];
for (const [name, {embedsCompute}] of Object.entries(STORAGE_VARIANTS)) {
  if (selectedPlugin && name !== selectedPlugin) continue;
  const pluginPath = path.join(root, 'plugins', name);
  const original = fs.readFileSync(pluginPath, 'utf8');
  extractStorageSdk(original,name);
  const sdk=expectedStorageSdk(root,name,original);
  if (!embeddedSdkPattern.test(original)) throw new Error(`embedded_sdk_block_not_found:${name}`);
  let updated = original.replace(embeddedSdkPattern, sdk);
  if (hostLineagePattern.test(updated)) updated = updated.replace(hostLineagePattern, hostLineageSdk);
  else updated = updated.replace(embeddedSdkPattern, `${hostLineageSdk}\n\n${sdk}`);
  if ((updated.split(hostLineageSdk).length - 1) !== 1) throw new Error(`embedded_host_lineage_sync_ambiguous:${name}`);
  if ((updated.split(sdk).length - 1) !== 1) throw new Error(`embedded_sdk_sync_ambiguous:${name}`);
  const computeMarkerCount = (updated.match(/\/\* LIBRARIAN SYSTEM COMPUTE SDK v/g) || []).length;
  if (embedsCompute) {
    if (computeMarkerCount === 0) {
      if ((updated.split(sdk).length - 1) !== 1) throw new Error(`embedded_compute_sdk_insert_anchor_ambiguous:${name}`);
      updated = updated.replace(sdk, `${sdk}\n\n${computeSdk}`);
    } else if (computeMarkerCount === 1 && embeddedComputeSdkPattern.test(updated)) {
      updated = updated.replace(embeddedComputeSdkPattern, computeSdk);
    } else {
      throw new Error(`embedded_compute_sdk_block_not_found_or_ambiguous:${name}:markers=${computeMarkerCount}`);
    }
    if ((updated.split(computeSdk).length - 1) !== 1) throw new Error(`embedded_compute_sdk_sync_ambiguous:${name}`);
  } else if (computeMarkerCount !== 0) {
    throw new Error(`embedded_compute_sdk_unexpected:${name}:markers=${computeMarkerCount}`);
  }
  if(updated!==original)plannedWrites.push([pluginPath,updated]);
  const computeLabel = embedsCompute ? ' + Compute SDK' : '';
  process.stdout.write(`${name}: Storage SDK${computeLabel} embedded in PROGRAM/plugins canonical source\n`);
}

// Validate every selected variant before any write; preserved consumer mismatches fail closed.
for(const [file,text] of plannedWrites)fs.writeFileSync(file,text,'utf8');
