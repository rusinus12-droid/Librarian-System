'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const builder = require('../tools/build_distribution.cjs');

try {
  const parsed = builder.parseArgs(['--version', '0.3.54']);
  assert.equal(parsed.version, '0.3.54');

  assert.equal(typeof builder.nextPatchVersion, 'function', 'builder exports nextPatchVersion');
  assert.equal(builder.nextPatchVersion('0.3.53'), '0.3.54');
  assert.equal(typeof builder.validateTargetVersion, 'function', 'builder exports validateTargetVersion');
  assert.equal(builder.validateTargetVersion('0.3.53', '0.4.0'), '0.4.0');
  assert.throws(() => builder.validateTargetVersion('0.3.53', '0.3.53'), /distribution_version_must_increase/);
  assert.throws(() => builder.validateTargetVersion('0.3.53', '0.3.52'), /distribution_version_must_increase/);
  assert.throws(() => builder.validateTargetVersion('0.3.53', 'v0.3.54'), /distribution_version_invalid/);

  assert.equal(typeof builder.applyReleaseVersion, 'function', 'builder exports applyReleaseVersion');
  assert.equal(typeof builder.buildRelease, 'function', 'builder exports buildRelease');
  const programDir = path.resolve(__dirname, '..');
  assert.match(fs.readFileSync(path.join(programDir, '배포본_만들기.bat'), 'utf8'), /release_builder_ui\.cjs/, 'Windows wrapper uses the interactive release UI');
  assert.match(fs.readFileSync(path.join(programDir, '배포본_만들기.sh'), 'utf8'), /release_builder_ui\.cjs/, 'POSIX wrapper uses the interactive release UI');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-release-version-'));
  try {
    const program = path.join(root, 'PROGRAM');
    fs.mkdirSync(path.join(program, 'server', 'portable'), { recursive: true });
    fs.mkdirSync(path.join(program, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(program, 'VERSION.txt'), '0.3.53\n');
    fs.writeFileSync(path.join(program, 'server', 'server.cjs'), "const SERVER_VERSION = '0.3.53';\n");
    fs.writeFileSync(path.join(program, 'release-policy.json'), JSON.stringify({schema:'librarian.release-policy.v1',version:'0.3.53',channel:'stable',updatePolicy:'migration_required',minimumSourceVersion:'0.3.51',logicalMigrationFormat:1,updaterContract:1}, null, 2) + '\n');
    fs.writeFileSync(path.join(program, 'server', 'portable', 'logical_migration.cjs'), "function a(serverVersion='0.3.53'){}\nfunction b(serverVersion='0.3.53'){}\nfunction c(serverVersion='0.3.53'){}\n");
    fs.writeFileSync(path.join(program, 'server', 'portable', 'transfer_manager.cjs'), "module.exports=({serverVersion='0.3.53'})=>serverVersion;\n");
    fs.writeFileSync(path.join(program, 'tools', 'portable_export_stopped.cjs'), "const a=options.version||'0.3.53'; const b=options.version||'0.3.53';\n");
    builder.applyReleaseVersion(root, '0.3.54');
    assert.equal(fs.readFileSync(path.join(program, 'VERSION.txt'), 'utf8'), '0.3.54\n');
    assert.match(fs.readFileSync(path.join(program, 'server', 'server.cjs'), 'utf8'), /SERVER_VERSION = '0\.3\.54'/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(program, 'release-policy.json'), 'utf8')).version, '0.3.54');
    assert.equal((fs.readFileSync(path.join(program, 'server', 'portable', 'logical_migration.cjs'), 'utf8').match(/0\.3\.54/g)||[]).length, 3);
    assert.equal((fs.readFileSync(path.join(program, 'server', 'portable', 'transfer_manager.cjs'), 'utf8').match(/0\.3\.54/g)||[]).length, 1);
    assert.equal((fs.readFileSync(path.join(program, 'tools', 'portable_export_stopped.cjs'), 'utf8').match(/0\.3\.54/g)||[]).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('release_builder_version_input_test: PASS');
} catch (error) {
  console.error('release_builder_version_input_test: FAIL');
  console.error(error.stack || error);
  process.exitCode = 1;
}
