'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {validateHostLineage,validateStoredHostLineage}=require('../server/core/host-lineage-metadata.cjs');
const {parent,branch,character,clone}=require('./fixtures/native_branch_fixture.cjs');
const sdk=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteHostLineage.source.js'),'utf8')+';createMemorySuiteHostLineage()');
const p=parent(),b=branch(p,7),proof=JSON.parse(JSON.stringify(sdk.inspect(character([b,p]),b)));let passed=0;
function check(name,f){f();passed++;console.log('PASS '+name)}
check('valid optional metadata accepted',()=>validateHostLineage(proof,{characterId:'character',chatId:'branch'},'libra'));
check('legacy opaque storage untouched',()=>{validateStoredHostLineage('old payload','libra');validateStoredHostLineage({memories:[]},'libra')});
for(const [name,patch] of [['different owner',{owner:'lia'}],['fake future prefix',{canonicalPrefixEnd:10}],['oversized ID',{hostChatId:'x'.repeat(513)}],['wrong target path',{path:['parent','sibling']}],['unverified eligibility claim',{status:'unverified'}],['negative pair range',{commonPrefixPairs:-1}],['unsafe number',{commonPrefixMessages:Infinity}],['missing identity',{characterId:''}]])check(name,()=>assert.throws(()=>validateHostLineage({...clone(proof),...patch},{},'libra'),e=>e.code==='HOST_LINEAGE_METADATA_INVALID'));
check('outer owner chat checked',()=>assert.throws(()=>validateStoredHostLineage({chatId:'sibling',nativeChatCopy:{hostLineage:proof}},'libra'),/owner_chat_mismatch/));
check('outer character checked',()=>assert.throws(()=>validateStoredHostLineage({characterId:'another',hostLineage:proof},'flashback'),/owner_character_mismatch/));
check('handoff source metadata checked against source not target',()=>validateStoredHostLineage({chatId:'target',memorySessionBridge:{sourceChatId:'branch',sourceCharacterId:'character',sourceHostLineage:proof}},'retrace'));
console.log(JSON.stringify({test:'native_branch_server_metadata',passed}));
