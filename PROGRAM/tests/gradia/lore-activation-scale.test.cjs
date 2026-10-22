'use strict';
// Key/recursive lore activation keeps its results while large lorebooks stay bounded.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');
const entry=(index,fields)=>({id:'c'+index,label:'L'+index,source:'character',sourceType:'character',originalIndex:index,priority:0,insertorder:0,mode:'normal',
 keys:[],secondaryKeys:[],selective:false,additionalKeys:[],excludeKeys:[],excludeKeysAll:[],useRegex:false,fullWordMatching:null,recursive:null,
 dontSearchWhenRecursive:false,alwaysActive:false,forceState:'',scanDepth:null,hiddenKeys:[],activationMin:0,activationEvery:0,content:'',...fields});
const recent=latestUser=>({loreSearchMessages:[{role:'user',data:'The archivist waits.'},{role:'assistant',data:'Dusk falls over the reading room.'}],latestUser,visibleMessageCount:2});
const labels=result=>JSON.parse(JSON.stringify(Array.isArray(result)?result:result.activeLore||[])).map(item=>item.label).sort();

test('recursive activation re-checks a matched entry whose conditional key appears in a later pass',async()=>{
 const host=await load();
 const candidates=[
  entry(0,{keys:['brass key'],content:'The brass key opens the vault door.'}),
  entry(1,{keys:['vault'],selective:true,secondaryKeys:['river'],content:'The vault floods when the river rises.'}),
  entry(2,{keys:['vault door'],content:'Behind it lies the river gate.'}),
  entry(3,{keys:['nothing here'],content:'Never activated.'}),
  entry(4,{keys:['river gate'],dontSearchWhenRecursive:true,content:'Recursive text cannot open this one.'}),
  entry(5,{keys:['/vau.t/i'],useRegex:true,content:'Regex keys still match recursive text.'})
 ];
 const result=host.plugin.debugActivateLore(recent('Hand me the brass key.'),candidates);
 assert.deepEqual(labels(result),['L0','L1','L2','L5']);
});

test('a large cross-referencing lorebook activates in bounded time',{timeout:60000},async()=>{
 const host=await load(),count=2000;
 const candidates=Array.from({length:count},(_,i)=>entry(i,{keys:[`entity-${i}`],content:`entity-${i} keeps records about entity-${(i+1)%count} and entity-${(i*7+3)%count}. `+'Archive notes. '.repeat(40)}));
 const started=Date.now();
 const result=host.plugin.debugActivateLore(recent('Tell me about entity-0.'),candidates);
 const elapsedMs=Date.now()-started;
 assert.equal(labels(result).length,count,'the whole chain activates through recursion');
 assert.ok(elapsedMs<15000,`activation took ${elapsedMs} ms`);
});
