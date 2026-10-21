'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const program = path.resolve(__dirname, '..');

test('readonly-context regeneration preserves ranked components through both sync orders and rejects duplicate embeds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-context-composition-'));
  try {
    for (const dir of ['tools', 'plugins', 'sdk']) fs.mkdirSync(path.join(root, dir));
    for (const file of ['tools/sync_libra_read_context.cjs', 'tools/sync_gradia_ranked_evidence.cjs',
      'sdk/LibraReadonlySourceContext.source.js', 'sdk/GradiaEvidenceRender.v2.source.js',
      'plugins/LIBRA.js', 'plugins/GRADIA.js']) fs.copyFileSync(path.join(program, file), path.join(root, file));
    fs.cpSync(path.join(program, 'sdk/gradia'), path.join(root, 'sdk/gradia'), { recursive: true });
    const target = path.join(root, 'plugins/LIBRA.js');
    const component = text => text.match(/\/\* GRADIA RANKED EVIDENCE V2 COMPONENTS BEGIN \*\/[\s\S]*?\/\* GRADIA RANKED EVIDENCE V2 COMPONENTS END \*\//)[0];
    const initial = fs.readFileSync(target, 'utf8'), originalComponent = component(initial);
    const cli = (file, args = []) => spawnSync(process.execPath, [path.join(root, 'tools', file), ...args], { encoding: 'utf8', timeout: 10000 });
    const pass = (file, args) => { const r = cli(file, args); assert.equal(r.status, 0, r.stdout + r.stderr); };
    pass('sync_libra_read_context.cjs'); assert.equal(fs.readFileSync(target, 'utf8'), initial);
    const source = path.join(root, 'sdk/LibraReadonlySourceContext.source.js');
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('const MiB=', 'const MiB ='));
    assert.notEqual(cli('sync_libra_read_context.cjs', ['--check']).status, 0);
    pass('sync_libra_read_context.cjs');
    const updated = fs.readFileSync(target, 'utf8');
    assert.notEqual(updated, initial); assert.equal(component(updated), originalComponent);
    pass('sync_libra_read_context.cjs', ['--check']); pass('sync_gradia_ranked_evidence.cjs');
    pass('sync_gradia_ranked_evidence.cjs', ['--write']); pass('sync_libra_read_context.cjs');
    assert.equal(fs.readFileSync(target, 'utf8'), updated, 'both sync orders are idempotent');
    const duplicated = updated.replace(originalComponent, originalComponent + '\n\n' + originalComponent);
    fs.writeFileSync(target, duplicated);
    assert.notEqual(cli('sync_libra_read_context.cjs').status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), duplicated, 'ambiguous source is never overwritten');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
