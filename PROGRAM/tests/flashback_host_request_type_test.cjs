const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../plugins/Flashback_Memory.js'), 'utf8');
const start = source.indexOf('  const FlashbackRequestKindCore = (() => {');
const end = source.indexOf('  const flashbackModelMainRequestEvidence', start);
assert.ok(start >= 0 && end > start);
const core = vm.runInNewContext(source.slice(start, end) + '\nFlashbackRequestKindCore;', {
  text: value => String(value ?? ''),
  rawMessageContentUnfiltered: message => message.content,
  rawMessageRole: message => message.role,
  compact: (value, limit) => String(value).slice(0, limit)
});

const prompts = [
  'Continue the roleplay.',
  'Continue the roleplay. Return only valid JSON.',
  'Output XML only.',
  '응답 형식: JSON',
  '[LightBoard] <lb-process>Return JSON only.</lb-process>'
];
for (const content of prompts) {
  const messages = [{ role: 'system', content }, { role: 'user', content: 'Continue.' }];
  const main = core.classify('model', messages, '', {
    requireMainEvidence: true, mainEvidence: false, failOpenMainTypeWithoutEvidence: true
  });
  assert.equal(main.main, true, content);
  assert.equal(main.auxiliary, false, content);
  for (const type of ['submodel', 'memory', 'emotion', 'otherax', 'translate']) {
    const auxiliary = core.classify(type, messages);
    assert.equal(auxiliary.auxiliary, true, `${type}: ${content}`);
    assert.equal(auxiliary.main, false);
  }
}
console.log('PASS: model remains main for 5 prompt forms; 25 explicit auxiliary cases remain auxiliary.');
