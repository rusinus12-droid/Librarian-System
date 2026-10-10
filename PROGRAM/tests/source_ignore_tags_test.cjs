'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ctx=vm.createContext({setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk/MemorySuiteSourceEditConsent.source.js'),'utf8'),ctx);
const values=new Map();let fail=false;const config={owner:'test',requestBoundary:true,read:async k=>values.get(k)||null,write:async(k,v)=>{if(fail)return false;values.set(k,v);return true;},collect:async()=>({scopeKey:'a',units:[]})};
(async()=>{let c=ctx.createMemorySuiteSourceEditConsent(config);try{
 await c.ready();assert.deepEqual(Array.from(c.ignoredTags()),['lb-xnai']);
 const p=s=>ctx.memorySuiteProjectSourceTags(s,'test');assert.equal(p('a<lb-xnai>{{inlay::x}}</lb-xnai>b'),'ab');assert.equal(p('<lb-xnai>actual event</lb-xnai>'),'<lb-xnai>actual event</lb-xnai>');
 await c.setIgnoredTags('lb-xnai\nmy-decoration\nmy-decoration');assert.equal(p('a<MY-DECORATION a="x>y"><my-decoration>inner</my-decoration>z</MY-DECORATION>b'),'ab');assert.equal(p('a<my-decoration />b'),'ab');assert.equal(p('a<my-decoration>unfinished'),'a<my-decoration>unfinished');assert.equal(p('<my-decoration-extra>x</my-decoration-extra>'),'<my-decoration-extra>x</my-decoration-extra>');
 await assert.rejects(()=>c.setIgnoredTags('.*'),/SOURCE_IGNORE_TAGS_INVALID/);await assert.rejects(()=>c.setIgnoredTags('<tag>'),/SOURCE_IGNORE_TAGS_INVALID/);
 await c.setMode('silent');assert.ok(c.ignoredTags().includes('my-decoration'));c.dispose();c=ctx.createMemorySuiteSourceEditConsent(config);await c.ready();assert.ok(c.ignoredTags().includes('my-decoration'),'fresh controller readback');
 fail=true;await assert.rejects(()=>c.setIgnoredTags('other'),/WRITE_REJECTED/);assert.ok(c.ignoredTags().includes('my-decoration'));fail=false;await c.setIgnoredTags([]);assert.equal(p('<my-decoration>x</my-decoration>'),'<my-decoration>x</my-decoration>');
 c.beginRequest();await assert.rejects(()=>c.setIgnoredTags('busy'),/BUSY/);c.afterRequest();
 const originalWrite=config.write;config.write=async()=>true;await assert.rejects(()=>c.setIgnoredTags('not-saved'),/READBACK_FAILED/);assert.deepEqual(Array.from(c.ignoredTags()),[]);config.write=originalWrite;
 let release,entered;const writing=new Promise(r=>entered=r);config.write=async(k,v)=>{entered();await new Promise(r=>release=r);return originalWrite(k,v);};
 const saving=c.setIgnoredTags('decoration');await writing;let ready=false;const waiting=c.ready().then(()=>{ready=true;});await Promise.resolve();assert.equal(ready,false,'new requests wait for policy persistence');release();await saving;await waiting;assert.ok(c.ignoredTags().includes('decoration'));config.write=originalWrite;
 console.log('source_ignore_tags_test: PASS (defaults, exact names, nesting, partial tags, validation, durable preferences, mode preservation, failure, removal, request barrier)');
}finally{c.dispose();}})().catch(e=>{console.error(e);process.exitCode=1;});
