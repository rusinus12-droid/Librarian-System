'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const program = path.resolve(__dirname, '..');

test('readonly-context regeneration is idempotent and rejects a stale or duplicated embed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-context-composition-'));
  try {
    for (const dir of ['tools', 'plugins', 'sdk']) fs.mkdirSync(path.join(root, dir));
    for (const file of ['tools/sync_libra_read_context.cjs', 'sdk/LibraReadonlySourceContext.source.js', 'plugins/LIBRA.js']) fs.copyFileSync(path.join(program, file), path.join(root, file));
    const target = path.join(root, 'plugins/LIBRA.js');
    const initial = fs.readFileSync(target, 'utf8');
    const cli = (file, args = []) => spawnSync(process.execPath, [path.join(root, 'tools', file), ...args], { encoding: 'utf8', timeout: 10000 });
    const pass = (file, args) => { const r = cli(file, args); assert.equal(r.status, 0, r.stdout + r.stderr); };
    pass('sync_libra_read_context.cjs'); assert.equal(fs.readFileSync(target, 'utf8'), initial);
    const source = path.join(root, 'sdk/LibraReadonlySourceContext.source.js');
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('const MiB=', 'const MiB ='));
    assert.notEqual(cli('sync_libra_read_context.cjs', ['--check']).status, 0);
    pass('sync_libra_read_context.cjs');
    const updated = fs.readFileSync(target, 'utf8');
    assert.notEqual(updated, initial);
    pass('sync_libra_read_context.cjs', ['--check']); pass('sync_libra_read_context.cjs');
    assert.equal(fs.readFileSync(target, 'utf8'), updated, 'sync is idempotent');
    const block = updated.match(/\/\* LIBRA READONLY SOURCE CONTEXT v1[\s\S]*?\/\* END LIBRA READONLY SOURCE CONTEXT \*\//)[0];
    const duplicated = updated.replace(block, block + '\n\n' + block);
    fs.writeFileSync(target, duplicated);
    assert.notEqual(cli('sync_libra_read_context.cjs').status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), duplicated, 'ambiguous source is never overwritten');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
