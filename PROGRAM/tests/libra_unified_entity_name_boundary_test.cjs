'use strict';

const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

async function checkNameBinding(name, sourceText, expected) {
  const f = await fixture();
  try {
    const source = f.chat.message.find(row => row.chatId === 't1-u');
    assert.ok(source);
    source.data = sourceText;
    const entity = f.control.artifact.entities.find(row => row.tempId === 'mina');
    assert.ok(entity);
    entity.name = name;
    entity.evidenceSpans = [{ ref: 't1-u', quote: sourceText }];
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    const saved = f.getMemory();
    assert.ok(saved?.canonicalArtifact, 'canonical artifact should be saved');
    assert.equal(saved.canonicalArtifact.entities.some(row => row.tempId === 'mina'), expected,
      `entity ${name} from ${sourceText}`);
  } finally {
    await f.r.cleanup();
  }
}

(async () => {
  await checkNameBinding('민아', '민아린은 도서관의 이용 규칙을 물었다.', false);
  await checkNameBinding('민아', '민아는 도서관의 이용 규칙을 물었다.', true);
  await checkNameBinding('Alice', 'Aliceville asked about the library rules.', false);
  await checkNameBinding('Alice', 'Alice는 도서관의 이용 규칙을 물었다.', true);
  await checkNameBinding('민아', '민아린은 물었고, 민아는 대답했다.', true);

  const f = await fixture();
  try {
    const entity = f.control.artifact.entities.find(row => row.tempId === 'mina');
    entity.evidenceSpans = [{ ref: 't1-u', quote: '민아는 원문에 없는 질문을 했다.' }];
    const result = await f.run();
    assert.equal(result.completed, 1, JSON.stringify(result));
    assert.equal(f.getMemory().canonicalArtifact.entities.some(row => row.tempId === 'mina'), false);
  } finally {
    await f.r.cleanup();
  }
  console.log('PASS libra_unified_entity_name_boundary_test');
})().catch(error => { console.error(error); process.exitCode = 1; });
