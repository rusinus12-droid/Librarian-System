"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const program = path.resolve(__dirname, '..');
const context = vm.createContext({ setTimeout, clearTimeout, Date, console });
vm.runInContext(fs.readFileSync(path.join(program, 'sdk/MemorySuiteSourceEditConsent.source.js'), 'utf8'), context);

(async () => {
  let checked = 0;
  for (const owner of ['libra', 'hayaku', 'flashback']) {
    const storage = new Map();
    let promptCalls = 0;
    let executions = 0;
    let unit = {
      key: '32', start: 32, end: 32, identity: owner + '-pair-32', digest: owner + '-new',
      sourceDigest: owner + '-new', originalDigest: owner + '-old', basis: owner + '-basis',
      changed: true, current: false
    };
    const controller = context.createMemorySuiteSourceEditConsent({
      owner,
      requestBoundary: true,
      externalObserver: true,
      preserveUntilReplacement: true,
      read: async key => storage.get(key) ?? null,
      write: async (key, value) => { storage.set(key, value); return true; },
      collect: async () => ({ scopeKey: owner + '-scope', units: [{ ...unit }], completedTurnIds: ['u32'] }),
      prompt: async () => { promptCalls += 1; throw new Error('automatic reconciliation must not ask for consent'); },
      execute: async (task, permit) => {
        assert.equal(task.key, '32');
        await permit.assertCurrent();
        executions += 1;
        unit = { ...unit, changed: false, current: true };
        return { ok: true };
      }
    });

    try {
      await controller.ready();
      await controller.beforeRequest();
      const state = controller.status();
      assert.equal(state.owner, owner, 'each automatic task remains bound to its owner');
      assert.equal(state.scopeKey, owner + '-scope');
      assert.equal(state.tasks.length, 1);
      assert.equal(state.tasks[0].state, 'applied');
      assert.equal(state.events.length, 1);
      assert.equal(executions, 1);
      assert.equal(promptCalls, 0, 'the request boundary never opens the legacy review prompt');

      const manual = await controller.review();
      assert.equal(manual.reason, 'automatic_before_request_only');
      assert.equal(promptCalls, 0, 'the public legacy review entry point stays closed');
      checked += 9;
    } finally {
      controller.dispose();
    }
  }
  console.log(JSON.stringify({
    test: 'source_review_owner_origin_runtime',
    result: 'pass',
    owners: ['libra', 'hayaku', 'flashback'],
    assertions: checked,
    contract: 'owner-scoped automatic reconciliation; no manual consent prompt'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
