'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./gradia/host.cjs');

test('GRADIA analysis JSON robustness against truncated outputs, unescaped quotes, and multi-object payloads', async (t) => {
  let exposed = null;
  await load({
    testGlobals: { setExposed: (val) => { exposed = val; } },
    transformSource: (src) => src.replace('const publicApi = Object.freeze({',
      'setExposed({ relaxedJsonParse, inspectStructuredJsonCompletion, analysisContractIssue, extractLooseJsonObjectString, extractJsonObjectString, normalizeAnalysisResult, hasMeaningfulAnalysisResult });\n  const publicApi = Object.freeze({')
  });

  await t.test('recovers truncated analysis JSON where keys were cut off before closing braces', () => {
    const truncated = `{"schema":"serial_gradation_agents_for_rp_analysis_v4","stage":"shadow_act","ok":true,"analysis":{"summary":"세아는 약에 의해 몸이 반응하는 상황","constraints":["신체 반응 지속"],"risks":["조급한 전개 금지"]},"domain":{"current_scene_anchor":{"latest_confirmed_situation":"푸딩이 압박 중"},"story_author_plan":{"beats":["비트1","비트2","비트3","비트4","비트5","비트6"]},"director_brief":{"ending_requirement":"긴장감 유지"},"active_world_and_causality_constraints`;
    const parsed = exposed.relaxedJsonParse(truncated, 'shadow_act');
    assert.ok(parsed, 'should parse truncated json');
    assert.equal(parsed.schema, 'serial_gradation_agents_for_rp_analysis_v4');
    assert.equal(parsed.stage, 'shadow_act');
    const issue = exposed.analysisContractIssue('shadow_act', truncated, {});
    assert.equal(issue, '', 'contract issue should be empty (valid)');
    const normalized = exposed.normalizeAnalysisResult('shadow_act', truncated);
    assert.ok(normalized, 'should normalize analysis result');
  });

  await t.test('repairs unescaped double quotes inside Korean summary and dialogue values', () => {
    const unescaped = `{"schema":"serial_gradation_agents_for_rp_analysis_v4","stage":"shadow_act","ok":true,"analysis":{"summary":"세아는 "안 돼"라며 "제발"을 외쳤다.","constraints":[],"risks":[]},"domain":{"story_author_plan":{"beats":["비트1","비트2","비트3","비트4","비트5","비트6"]},"director_brief":{"ending_requirement":"short"}}}`;
    const parsed = exposed.relaxedJsonParse(unescaped, 'shadow_act');
    assert.ok(parsed, 'should parse unescaped quotes');
    assert.equal(parsed.analysis.summary, '세아는 "안 돼"라며 "제발"을 외쳤다.');
    const issue = exposed.analysisContractIssue('shadow_act', unescaped, {});
    assert.equal(issue, '', 'contract issue should be empty');
  });

  await t.test('selects the target analysis schema object when preceded by thoughts or preamble object', () => {
    const multiObj = `{"thought": "내부 추론 과정 완료"}\n{"schema":"serial_gradation_agents_for_rp_analysis_v4","stage":"shadow_act","ok":true,"analysis":{"summary":"정상 분석 완료","constraints":[],"risks":[]},"domain":{"story_author_plan":{"beats":["비트1","비트2","비트3","비트4","비트5","비트6"]},"director_brief":{"ending_requirement":"short"}}}`;
    const parsed = exposed.relaxedJsonParse(multiObj, 'shadow_act');
    assert.ok(parsed, 'should parse multi-object payload');
    assert.equal(parsed.schema, 'serial_gradation_agents_for_rp_analysis_v4');
    const issue = exposed.analysisContractIssue('shadow_act', multiObj, {});
    assert.equal(issue, '', 'contract issue should be empty');
  });

  await t.test('falls back safely to field-level recovery when syntax is severely broken but schema exists', () => {
    // A string where braces are mismatched/broken so discrete JSON parsing fails, triggering fallback
    const broken = `schema: serial_gradation_agents_for_rp_analysis_v4, "summary": "필수 요약 문장입니다.", "beats": ["비트1","비트2","비트3","비트4","비트5","비트6"]`;
    const parsed = exposed.relaxedJsonParse(broken, 'shadow_act');
    assert.ok(parsed, 'fallback should recover plain object');
    assert.equal(parsed.analysis.summary, '필수 요약 문장입니다.');
    assert.equal(parsed._truncatedRepaired, true, 'should be marked as truncatedRepaired');
  });

  await t.test('truncated non-analysis payload (replace_draft) is strictly rejected to prevent silently cutting draft', () => {
    const truncatedDraft = `{"schema":"serial_gradation_agents_draft_patch_v1","action":"replace_draft","draft":"문장의 앞부분만 생성되다가 중간에 잘린 원고`;
    const parsed = exposed.relaxedJsonParse(truncatedDraft, 'replace_draft');
    assert.equal(parsed, null, 'truncated replace_draft must NOT be repaired into a broken draft');
  });

  await t.test('analysis without beats does NOT fabricate fake placeholder beats and fails contract', () => {
    // When beats are absent in a broken string, fallbackParseAnalysisSchema must return null instead of generating fake beats
    const brokenWithoutBeats = `schema: serial_gradation_agents_for_rp_analysis_v4, "summary": "요약만 있고 계획은 없음"`;
    const parsed = exposed.relaxedJsonParse(brokenWithoutBeats, 'shadow_act');
    assert.equal(parsed, null, 'schema fallback must return null when beats are absent, preventing fake beat generation');

    // And even if parsed via partial json, analysisContractIssue must reject it
    const partialWithoutPlan = `{"schema":"serial_gradation_agents_for_rp_analysis_v4","stage":"shadow_act","ok":true,"analysis":{"summary":"요약만 있음"}}`;
    const issue = exposed.analysisContractIssue('shadow_act', partialWithoutPlan, {});
    assert.equal(issue, 'domain_missing', 'contract must reject analysis without domain/plan');
  });
});
