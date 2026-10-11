'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PLUGINS = Object.freeze({
  flashback: ['Flashback_Memory.js', 'Flashback Memory', 'flashback_memory'],
  hayaku: ['HAYAKU_Locator_Continuity.js', 'HAYAKU Locator Continuity', 'hayaku_locator_continuity'],
  libra: ['LIBRA.js', 'LIBRA', 'libra'],
  lia: ['LIA_Persona_Linker.js', 'LIA Persona Linker', 'lia_persona_linker'],
  retrace: ['RETRACE.js', 'RE:TRACE', 'flashback_hayaku_bridge'],
  gradia: ['GRADIA.js', 'GRADIA', 'serial_gradation_agents_for_rp']
});
const GUIDES = ['0_설치_안내.txt', 'PROGRAM/처음_읽어주세요.txt', 'PROGRAM/PACKAGE_CONTENTS.txt'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function version(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(matches[0][1])) throw new Error(`release_version_invalid:${label}`);
  return matches[0][1];
}
function readReleaseMetadata(programDir) {
  const read = file => fs.readFileSync(path.join(programDir, file), 'utf8');
  const packageVersion = version(read('VERSION.txt').trim(), /^(\d+\.\d+\.\d+)$/g, 'package');
  const serverVersion = version(read('server/server.cjs'), /^const SERVER_VERSION = '(\d+\.\d+\.\d+)';\r?$/gm, 'server');
  if (serverVersion !== packageVersion) throw new Error('release_server_package_version_mismatch');
  const plugins = {};
  for (const [owner, [file, label, id]] of Object.entries(PLUGINS)) {
    const bytes = fs.readFileSync(path.join(programDir, 'plugins', file));
    const header = bytes.subarray(0, 512).toString('utf8');
    if (header.match(/^\/\/@name[ \t]+([^\r\n]+)/m)?.[1]?.trim() !== id) throw new Error(`release_plugin_identity_mismatch:${owner}`);
    plugins[owner] = { file, label, version: version(header, /^\/\/@version\s+(\d+\.\d+\.\d+)\s*$/gm, owner), sha256: sha(bytes) };
  }
  const sdkVersion = file => version(read(`sdk/${file}`), /^\/\* LIBRARIAN SYSTEM (?:STORAGE|COMPUTE) SDK v(\d+\.\d+\.\d+)/gm, file);
  const storageSdkVersion = sdkVersion('MemorySuiteStorageClient.source.js');
  if (storageSdkVersion !== sdkVersion('MemorySuiteStorageClient.libra.source.js')) throw new Error('release_storage_sdk_variant_mismatch');
  return { packageVersion, plugins, storageSdkVersion, computeSdkVersion: sdkVersion('MemorySuiteComputeClient.source.js') };
}
function renderGuide(source, metadata) {
  // Only installation inventory rows are generated. Historical patch notes and prose stay intact.
  let result = source;
  for (const { label, version } of Object.values(metadata.plugins)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = new RegExp(`^(- ${escaped} )\\d+\\.\\d+\\.\\d+(?=\\r?$)`, 'gm');
    const matches = [...result.matchAll(row)];
    if (matches.length !== 1) throw new Error(`release_guide_inventory_invalid:${label}`);
    result = result.replace(row, `$1${version}`);
  }
  result = result.replace(/^(Librarian System Server |\- Librarian System Server )\d+\.\d+\.\d+/gm, (_, prefix) => prefix + metadata.packageVersion);
  result = result.replace(/^(.*Storage SDK )\d+\.\d+\.\d+(?=\r?$)/gm, (_, prefix) => prefix + metadata.storageSdkVersion);
  result = result.replace(/^(.*Compute SDK )\d+\.\d+\.\d+(?=\r?$)/gm, (_, prefix) => prefix + metadata.computeSdkVersion);
  result = result.replace(/^(- 현재 DATA layout [^\r\n]*Storage SDK )\d+\.\d+\.\d+(?= 계약은)/gm, (_, prefix) => prefix + metadata.storageSdkVersion);
  result = result.replace(/^(- Compute Protocol [^\r\n]*Compute SDK )\d+\.\d+\.\d+(?=는 optional)/gm, (_, prefix) => prefix + metadata.computeSdkVersion);
  return result;
}
function syncReleaseGuides(packageRoot) {
  const metadata = readReleaseMetadata(path.join(packageRoot, 'PROGRAM'));
  const updates = GUIDES.map(file => {
    const absolute = path.join(packageRoot, file);
    const before = fs.readFileSync(absolute, 'utf8');
    return { absolute, before, after: renderGuide(before, metadata) };
  });
  for (const { absolute, before, after } of updates) {
    if (before !== after) fs.writeFileSync(absolute, after);
    if (fs.readFileSync(absolute, 'utf8') !== after) throw new Error(`release_guide_readback_failed:${absolute}`);
  }
  return metadata;
}
module.exports = { PLUGINS, GUIDES, readReleaseMetadata, renderGuide, syncReleaseGuides };
if (require.main === module) {
  try { console.log(JSON.stringify(syncReleaseGuides(path.resolve(__dirname, '../..')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
