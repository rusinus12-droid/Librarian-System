'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const {test} = require('node:test');
const {createFlashback} = require('./fixtures/embedding_contract_harness.cjs');
const PROGRAM = path.resolve(__dirname, '..');
test('legacy hash dimensions have explicit read-only policy in the actual rows and renderer', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const t = h.api._test;
    const settings = t.normalizeSettings({hashDimensions: 256});
    const policy = t.flashbackReadOnlyArgumentSettings.find(row => row.name === 'hash_dimensions');
    assert.ok(policy, 'legacy hash_dimensions must have an explicit read-only policy');
    assert.equal(policy.key, 'hashDimensions');
    const row = t.flashbackArgumentSettingRows(settings).find(row => row.name === 'hash_dimensions');
    assert.equal(row.value, 256); assert.equal(row.editable, false); assert.equal(row.controlId, '');
    assert.equal(row.note, policy.note); assert.match(row.note, /레거시/); assert.match(row.note, /새.*(?:생성|벡터)/);
    const html = await t.buildUiHtml();
    const rendered = html.match(/<tr data-argument-row="hash_dimensions">[\s\S]*?<\/tr>/)?.[0];
    assert.ok(rendered, 'the real settings audit renders the legacy row');
    assert.match(rendered, /읽기 전용/); assert.ok(rendered.includes(policy.note));
    assert.doesNotMatch(html, /id="(?:argSetting_)?hashDimensions"/);
    assert.equal(h.networkCalls.length, 0);
  } finally { await h.cleanup(); }
});
test('legacy dimension normalization remains readable without enabling new hash vectors', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const t = h.api._test;
    const original = {embeddingProvider:'hash',hashDimensions:256,fallbackHashEmbedding:true,embeddingFallbackProvider:'hash'};
    const settings = t.normalizeSettings(original);
    assert.equal(settings.hashDimensions, 256);
    assert.equal(settings.embeddingProvider, 'hash', 'legacy provider identity is preserved');
    assert.equal(settings.fallbackHashEmbedding, false); assert.equal(settings.embeddingFallbackProvider, '');
    assert.equal(original.fallbackHashEmbedding, true, 'normalization does not rewrite caller metadata');
    await assert.rejects(t.embedTexts(['legacy metadata is not a vector generator'], settings), error => error.code === 'EMBEDDING_UNCONFIGURED');
    assert.equal(h.networkCalls.length, 0, 'no model or provider request is made');
  } finally { await h.cleanup(); }
});

test('retired fallback flag is read-only while normal lexical weighting remains editable', async () => {
  const h = await createFlashback(PROGRAM);
  try {
    const t=h.api._test,settings=t.normalizeSettings({fallbackHashEmbedding:true,embeddingFallbackProvider:'hash'});
    const policy=t.flashbackReadOnlyArgumentSettings.find(row=>row.name==='fallback_hash_embedding');
    assert.ok(policy,'retired fallback_hash_embedding requires explicit read-only policy');
    const rows=t.flashbackArgumentSettingRows(settings),row=rows.find(row=>row.name==='fallback_hash_embedding');
    assert.equal(row.value,false);assert.equal(row.editable,false);assert.equal(row.controlId,'');
    assert.equal(row.note,policy.note);assert.match(row.note,/레거시/);
    const lexical=rows.find(row=>row.name==='lexical_weight');assert.equal(lexical.editable,true);
    const html=await t.buildUiHtml();
    const rendered=html.match(/<tr data-argument-row="fallback_hash_embedding">[\s\S]*?<\/tr>/)?.[0];
    assert.ok(rendered);assert.match(rendered,/읽기 전용/);assert.ok(rendered.includes(policy.note));
    assert.doesNotMatch(html,/id="(?:embeddingFallbackProvider|argSetting_fallbackHashEmbedding)"/);
    assert.ok(html.includes('id="'+lexical.controlId+'"'),'nonretired lexical control stays rendered');
    assert.equal(h.networkCalls.length,0);
  } finally {await h.cleanup();}
});
