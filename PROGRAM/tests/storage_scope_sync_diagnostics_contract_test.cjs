'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sources = [
  path.join(root, 'sdk', 'MemorySuiteStorageClient.source.js'),
  path.join(root, 'sdk', 'MemorySuiteStorageClient.libra.source.js')
];
const failureFields = ['key', 'stage', 'errorCode', 'message', 'operation', 'localBytes', 'remoteBytes', 'retryable'];

for (const file of sources) {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /MEMORY_SUITE_SCOPE_SYNC_DIAGNOSTICS_V1/);
  assert.match(source, /const scopedSyncFailure = \(\{ key = '', stage = 'unknown', operation = 'unknown', error, localBytes = 0, remoteBytes = 0 \} = \{\}\)/);
  for (const field of failureFields) assert.match(source, new RegExp(`\\b${field}\\b`), `${path.basename(file)} failure field ${field}`);
  assert.match(source, /remoteReadCount/);
  assert.match(source, /remoteReadBytes/);
  assert.match(source, /remoteListCount/);
  assert.match(source, /byOperation/);
  assert.match(source, /result\.failures\.push\(detail\)/);
  assert.match(source, /result\.conflicts\.push\(\{ \.\.\.conflict, space/);
  assert.match(source, /result\.ok = result\.failures\.length === 0 && result\.conflicts\.length === 0/);
  assert.match(source, /requestedMode, effectiveMode/);
  assert.match(source, /requestedMode: result\?\.requestedMode/);
  assert.match(source, /effectiveMode: result\?\.effectiveMode/);
  assert.match(source, /data-job-diagnostics/);
  assert.match(source, /data-job-copy/);
  assert.match(source, /scope-sync-diagnostics\.v1/);
}

const embedded = [
  ['Flashback_Memory.js', 'MemorySuiteStorageClient.source.js'],
  ['HAYAKU_Locator_Continuity.js', 'MemorySuiteStorageClient.source.js'],
  ['LIBRA.js', 'MemorySuiteStorageClient.libra.source.js'],
  ['LIA_Persona_Linker.js', 'MemorySuiteStorageClient.source.js'],
  ['RETRACE.js', 'MemorySuiteStorageClient.source.js']
];
for (const [plugin, sdk] of embedded) {
  const pluginText = fs.readFileSync(path.join(root, 'plugins', plugin), 'utf8');
  const sdkText = fs.readFileSync(path.join(root, 'sdk', sdk), 'utf8').trim();
  assert.equal(pluginText.split(sdkText).length - 1, 1, `${plugin} embedded SDK is exact`);
}

process.stdout.write(JSON.stringify({
  test: 'storage_scope_sync_diagnostics_contract',
  passed: sources.length + embedded.length,
  failureFields,
  resultFields: ['metrics.remoteReadCount', 'metrics.remoteReadBytes', 'requestedMode', 'effectiveMode', 'diagnostics.failures']
}) + '\n');
