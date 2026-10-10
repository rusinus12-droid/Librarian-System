'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { PLUGINS, GUIDES, readReleaseMetadata, renderGuide, syncReleaseGuides } = require('../tools/release_metadata.cjs');
const { assertSourceUnchanged } = require('../tools/build_distribution.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-metadata-'));
const write = (file, text) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
try {
  write('PROGRAM/VERSION.txt', '9.8.7\n');
  write('PROGRAM/server/server.cjs', "const SERVER_VERSION = '9.8.7';\n");
  for (const [file,,id] of Object.values(PLUGINS)) write(`PROGRAM/plugins/${file}`, `//@name ${id}\r\n//@version 7.6.5\r\n`);
  for (const file of ['MemorySuiteStorageClient.source.js', 'MemorySuiteStorageClient.libra.source.js']) write(`PROGRAM/sdk/${file}`, '/* LIBRARIAN SYSTEM STORAGE SDK v4.3.2 */\n');
  write('PROGRAM/sdk/MemorySuiteComputeClient.source.js', '/* LIBRARIAN SYSTEM COMPUTE SDK v2.1.0 */\n');
  const historical = '[LIBRA 2.3.86 historical note]\nKeep this historical prose and DATA instructions.\n';
  const guide = historical + 'Librarian System Server 0.0.1\n- Librarian System Server 0.0.1 / Storage Protocol 1.9 / Storage SDK 0.0.1\n- Compute Protocol 1.2 / Compute SDK 0.0.1\n' + Object.values(PLUGINS).map(([,label])=>`- ${label} 0.0.1`).join('\n') + '\n';
  for (const file of GUIDES) write(file, guide);
  const metadata = syncReleaseGuides(root);
  for (const file of GUIDES) {
    const current = fs.readFileSync(path.join(root,file),'utf8');
    assert.ok(current.startsWith(historical));
    assert.match(current, /- LIBRA 7\.6\.5/);
    assert.match(current, /Server 9\.8\.7/);
    assert.match(current, /Storage SDK 4\.3\.2/);
    assert.equal(renderGuide(current, metadata), current, 'generation is idempotent');
  }
  write('PROGRAM/plugins/LIBRA.js', '//@name libra\n//@version 7.6.6\n');
  syncReleaseGuides(root);
  assert.match(fs.readFileSync(path.join(root, GUIDES[0]),'utf8'), /- LIBRA 7\.6\.6/);
  assert.throws(()=>renderGuide(guide.replace('- LIBRA 0.0.1','missing'),metadata),/inventory_invalid/);
  assert.throws(()=>renderGuide(guide+'- LIBRA 0.0.1\n',metadata),/inventory_invalid/);
  write('PROGRAM/plugins/LIBRA.js', '//@name other_plugin\n//@version 7.6.6\n');
  assert.throws(()=>readReleaseMetadata(path.join(root,'PROGRAM')),/identity_mismatch/);
  write('PROGRAM/plugins/LIBRA.js', '//@name libra\n//@version invalid\n');
  assert.throws(()=>readReleaseMetadata(path.join(root,'PROGRAM')),/version_invalid/);
  write('PROGRAM/server/server.cjs', "const SERVER_VERSION = '9.8.8';\n");
  assert.throws(()=>readReleaseMetadata(path.join(root,'PROGRAM')),/server_package_version_mismatch/);
  const snapshotRoot = path.join(root,'snapshot');fs.mkdirSync(snapshotRoot);
  fs.writeFileSync(path.join(snapshotRoot,'VERSION.txt'),'1.2.3');
  const rows = [{path:'VERSION.txt',sha256:crypto.createHash('sha256').update('1.2.3').digest('hex')}];
  assertSourceUnchanged(snapshotRoot,rows);
  fs.writeFileSync(path.join(snapshotRoot,'VERSION.txt'),'1.2.4');
  assert.throws(()=>assertSourceUnchanged(snapshotRoot,rows),/source_changed/);
  console.log('release_metadata_test: PASS (version bump, history preservation, idempotence, missing/duplicate inventory, bad identity/version, server mismatch, source mutation)');
} finally {
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('release-metadata-')) throw Error('unexpected fixture path');
  fs.rmSync(root,{recursive:true,force:true});
}
