'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validateNegationReport}=require('./libra_multilingual_report_contract.cjs');
function fixture(parsed){return {quality:{linguisticNegationVerified:parsed},conditions:[{queries:[{category:'explicit_negation',negationTerms:parsed?['picnic']:[],selected:['origin'],excluded:['recent'],excludedReturned:[]}],summary:{unparsedNegationQueries:parsed?0:1}}]};}
test('reported parser absence is allowed without requiring it forever',()=>validateNegationReport(fixture(false)));
test('newly supported parsing can pass the same behavior contract',()=>validateNegationReport(fixture(true)));
test('false parser support claim is rejected',()=>{const r=fixture(false);r.quality.linguisticNegationVerified=true;assert.throws(()=>validateNegationReport(r),/coverage claim/)});
test('stale missing-support claim is rejected',()=>{const r=fixture(true);r.quality.linguisticNegationVerified=false;assert.throws(()=>validateNegationReport(r),/coverage claim/)});
test('wrong unparsed count is rejected',()=>{const r=fixture(true);r.conditions[0].summary.unparsedNegationQueries=2;assert.throws(()=>validateNegationReport(r),/unparsed count/)});
test('returning excluded fact is rejected even if its metric claims success',()=>{const r=fixture(true);r.conditions[0].queries[0].selected.push('recent');assert.throws(()=>validateNegationReport(r),/metric/)});
test('honestly measured exclusion failure still fails',()=>{const r=fixture(true),q=r.conditions[0].queries[0];q.selected.push('recent');q.excludedReturned.push('recent');assert.throws(()=>validateNegationReport(r),/excluded memory/)});
