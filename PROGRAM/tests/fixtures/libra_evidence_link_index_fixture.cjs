'use strict';
// Shared helpers for the evidence link index suites.
//
// `advance` commits a further five-turn batch whose artifact carries evidence spans for the
// turns it actually covers. The bundled `fiveMore` always shifts by +5, so it can only drive a
// second batch; a third batch built with it is rejected as UNIFIED_FACTS_INVALID because its
// spans still point at turns 6-10.
const { fixture, artifact } = require('./libra_unified_runtime_fixture.cjs');

const shiftRefs = (record, offset) => {
  for (const row of [...record.entities, ...record.facts]) {
    for (const span of row.evidenceSpans || []) span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
  }
  return record;
};

// Append five turns copied from the base batch and install a matching artifact.
const advance = (f, offset) => {
  const start = Number(offset) + 1;
  const extra = f.chat.message.slice(0, 10).map((message, i) => ({
    ...message, chatId: `t${start + Math.floor(i / 2)}-${i % 2 ? 'a' : 'u'}`
  }));
  f.chat.message.push(...extra);
  f.control.artifact = shiftRefs(artifact(), Number(offset));
  return f.control.artifact;
};

// Append one fact bound to a turn this batch actually covers, so validation can bind the quote.
const addFact = (f, offset, spec) => {
  const turn = Number(offset) + 5;
  const text = spec.text || '추가 관측.';
  const message = f.chat.message.find(entry => entry.chatId === `t${turn}-a`);
  message.data += ' ' + text;
  const fact = {
    tempFactId: spec.tempFactId, domain: spec.domain, subjectTempRef: spec.subjectTempRef,
    claimKind: spec.claimKind, values: spec.values, text,
    temporalRole: 'current_sequence', certainty: 'confirmed',
    evidenceSpans: [{ ref: `t${turn}-a`, quote: message.data }],
    ...(spec.targetTempRef ? { targetTempRef: spec.targetTempRef } : {}),
    ...(spec.dimension ? { dimension: spec.dimension } : {})
  };
  f.control.artifact.facts.push(fact);
  if (spec.stateField) f.control.artifact.stateBindings.push({
    factTempId: fact.tempFactId, typedValueField: spec.typedValueField, stateDomain: spec.domain, stateField: spec.stateField
  });
  return fact;
};

// Rewrite a persisted record in the harness storage, then let the caller re-read the index.
const patchRecord = (f, schema, patch) => {
  const found = f.getRecords(schema)[0];
  if (!found) throw new Error(`record ${schema} not found`);
  f.r.values.set(found.key, JSON.stringify({ ...found.value, ...patch }));
  return found.value;
};

const holderField = (index, name = '은빛 열쇠') => {
  const entity = index.entities.find(row => row.name === name);
  if (!entity) return null;
  return index.current.fields.find(field => field.entityId === entity.id && field.field === 'holderRef') || null;
};

const entityNamed = (index, name) => index.entities.find(row => row.name === name) || null;

module.exports = { fixture, artifact, advance, addFact, patchRecord, holderField, entityNamed, shiftRefs };
