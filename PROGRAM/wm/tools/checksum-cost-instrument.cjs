'use strict';
const assert=require('node:assert/strict'),acorn=require('/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules/acorn');
module.exports=code=>{
 const nodes=[],todo=[acorn.parse(code,{ecmaVersion:'latest'})];while(todo.length){const n=todo.pop();if(!n||typeof n!=='object')continue;nodes.push(n);for(const v of Object.values(n))if(Array.isArray(v))todo.push(...v);else if(v&&typeof v==='object')todo.push(v);}
 const one=name=>{const x=nodes.filter(n=>n.type==='VariableDeclarator'&&n.id?.name===name);assert.equal(x.length,1,name);return x[0].init.body;};
 const body=one('computeRecordChecksum'),v=one(nodes.some(n=>n.type==='VariableDeclarator'&&n.id?.name==='validateIntegrityMetaCore')?'validateIntegrityMetaCore':'validateIntegrityMeta');assert.notEqual(body.type,'BlockStatement');assert.equal(v.type,'BlockStatement');
 const edits=[{at:body.start,text:'(globalThis.__CHECKSUM_COST__.checksums++,globalThis.__CHECKSUM_COST__.markedParents+=record?.checksumBatchFixture===true?1:0,'},{at:body.end,text:')'},{at:v.start+1,text:'globalThis.__CHECKSUM_COST__.decisions++;'}];
 const witness=nodes.find(n=>n.type==='VariableDeclarator'&&n.id?.name==='TypedChecksumWitness');
 if(witness){
  const inside=nodes.filter(n=>n.start>=witness.start&&n.end<=witness.end),matches=inside.find(n=>n.type==='FunctionDeclaration'&&n.id?.name==='matches')||inside.find(n=>n.type==='Property'&&n.key?.name==='matches')?.value;assert(matches);
  edits.push({at:matches.body.start+1,text:'globalThis.__CHECKSUM_COST__.witnessCalls++;'});
  if(process.env.WM_WITNESS_DETAIL==='1')for(const n of inside.filter(n=>n.start>matches.body.start&&n.end<matches.body.end&&['ForOfStatement','ForStatement'].includes(n.type)))edits.push({at:n.body.start+1,text:'globalThis.__CHECKSUM_COST__.'+(n.type==='ForOfStatement'?'witnessNodes':'witnessProperties')+'++;'});
 }
 for(const e of edits.sort((a,b)=>b.at-a.at))code=code.slice(0,e.at)+e.text+code.slice(e.at);
 return 'globalThis.__CHECKSUM_COST__={checksums:0,markedParents:0,decisions:0,witnessCalls:0,witnessNodes:0,witnessProperties:0};\n'+code;
};
