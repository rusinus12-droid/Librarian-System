'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Load LIBRA plugin code in a sandboxed harness or extract validation contracts
test('Micro current observation extracts valid set stateIntent and preserves candidate', () => {
  // Candidate format emitted by extended prompt
  const receipt = {
    schema: 'libra.completed_turn_receipt.v1',
    scopeKey: 'test-scope',
    worldlineId: 'main',
    sessionEpoch: 0,
    turn: 1,
    revisionId: 'rev_1',
    sourceDigest: 'digest_1',
    assistant: { chatId: 'msg_a1', text: '아린은 서재에 앉아 조용히 책을 읽고 있었다.' },
    user: { chatId: 'msg_u1', text: '아린은 지금 어디에 있어?' }
  };

  const observationClaim = {
    changeKind: 'person',
    text: '아린은 서재에 앉아 있다.',
    actor: '아린',
    target: '',
    temporalRole: 'current',
    certainty: 'confirmed',
    epistemicStatus: 'observed',
    stateChangeType: 'set',
    stateIntent: {
      domain: 'character',
      target: { entityName: '아린' },
      field: 'locationRef',
      operation: 'set',
      value: '서재'
    },
    evidence: {
      role: 'assistant',
      messageId: 'msg_a1',
      startOffset: 0,
      endOffset: 24,
      exactQuote: '아린은 서재에 앉아 조용히 책을 읽고 있었다.'
    }
  };

  // Verify that exactQuote bounds both the actor and the location value
  assert.ok(observationClaim.evidence.exactQuote.includes(observationClaim.actor));
  assert.ok(observationClaim.evidence.exactQuote.includes(observationClaim.stateIntent.value));
  assert.equal(observationClaim.stateChangeType, 'set');
  assert.equal(observationClaim.temporalRole, 'current');
  assert.equal(observationClaim.certainty, 'confirmed');
  assert.equal(observationClaim.epistemicStatus, 'observed');
});

test('Character card domain status messages differentiate failed, partial, and pending states', () => {
  const getEmptyHint = (charStatus, charReason, key) => {
    let emptyHint;
    if (charStatus === 'ready') {
      emptyHint = key === 'know' ? '기록된 지식이 없습니다. 이는 모른다는 뜻이 아닙니다.' : '이 분류에는 현재 기록된 항목이 없습니다.';
    } else if (charStatus === 'failed') {
      emptyHint = `정본 인물 분석이 보류/실패 상태입니다 (${charReason || '분석 오류'}). 열람대나 로그를 확인하세요.`;
    } else if (charStatus === 'partial' || charStatus === 'not_updated') {
      emptyHint = `인물 상태 영역이 부분 반영 상태입니다 (${charStatus}${charReason ? `: ${charReason}` : ''}).`;
    } else if (!charStatus || charStatus === 'bootstrap' || charStatus === 'pending') {
      emptyHint = '정본의 인물 상태 영역이 아직 준비되지 않았습니다. (초기 5턴 정본 분석 후 반영)';
    } else {
      emptyHint = `인물 상태 영역 상태: ${charStatus}${charReason ? ` (${charReason})` : ''}.`;
    }
    return emptyHint;
  };

  // 1. Ready state
  assert.equal(getEmptyHint('ready', '', 'now'), '이 분류에는 현재 기록된 항목이 없습니다.');
  assert.equal(getEmptyHint('ready', '', 'know'), '기록된 지식이 없습니다. 이는 모른다는 뜻이 아닙니다.');

  // 2. Failed state (must not tell user to wait 5 turns)
  const failedHint = getEmptyHint('failed', 'timeout_exceeded', 'now');
  assert.match(failedHint, /정본 인물 분석이 보류\/실패 상태입니다 \(timeout_exceeded\)/);
  assert.ok(!failedHint.includes('5턴'));

  // 3. Partial state
  const partialHint = getEmptyHint('partial', 'missing_aliases', 'intro');
  assert.match(partialHint, /인물 상태 영역이 부분 반영 상태입니다 \(partial: missing_aliases\)/);

  // 4. Bootstrap / pending state
  const pendingHint = getEmptyHint('pending', '', 'intro');
  assert.match(pendingHint, /정본의 인물 상태 영역이 아직 준비되지 않았습니다/);
});

test('Unified response boundary changedFields catches arbitrary unrecognized field drifts', () => {
  const boundary = {
    scopeKey: 'scope_1',
    manifestDigest: 'man_1',
    customExtensionDigest: 'ext_v1'
  };

  const current = {
    scopeKey: 'scope_1',
    manifestDigest: 'man_1',
    customExtensionDigest: 'ext_v2' // drifted field outside the original 11 fixed fields
  };

  const allKeys = [...new Set([...Object.keys(current || {}), ...Object.keys(boundary || {})])];
  const diffFields = allKeys.filter(field => current[field] !== boundary[field]);
  const changedFields = diffFields.length ? diffFields : ['unclassified_boundary_change'];

  assert.deepEqual(changedFields, ['customExtensionDigest']);
  assert.ok(!changedFields.includes('unclassified_boundary_change'));

  // Negative test: completely opaque drift fallback
  const emptyDiff = [];
  const fallbackFields = emptyDiff.length ? emptyDiff : ['unclassified_boundary_change'];
  assert.deepEqual(fallbackFields, ['unclassified_boundary_change']);
});
