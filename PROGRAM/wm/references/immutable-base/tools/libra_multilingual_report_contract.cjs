'use strict';
const assert=require('node:assert/strict');
// Measurement consistency only. Passing synthetic exclusions is not proof of
// language understanding; parser availability may improve without breaking CI.
function validateNegationReport(report){
 let allParsed=true;
 for(const condition of report.conditions){
  const negatives=condition.queries.filter(q=>q.category==='explicit_negation');
  assert(negatives.length>0,'missing negation fixture coverage');
  for(const q of negatives){
   assert(Array.isArray(q.negationTerms),'missing parser observation');
   const actual=(q.selected||[]).filter(id=>(q.excluded||[]).includes(id));
   assert.deepEqual(Array.from(q.excludedReturned),actual,'exclusion metric must match selected results');
   assert.equal(actual.length,0,'excluded memory returned');
   if(!q.negationTerms.length)allParsed=false;
  }
  assert.equal(condition.summary.unparsedNegationQueries,negatives.filter(q=>!q.negationTerms.length).length,'unparsed count must match observations');
 }
 assert.equal(report.quality.linguisticNegationVerified,allParsed,'parser coverage claim must match observations');
}
module.exports={validateNegationReport};
