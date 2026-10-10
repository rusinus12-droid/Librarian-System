'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const s=fs.readFileSync(path.join(__dirname,'../plugins/LIBRA.js'),'utf8');const a=s.indexOf('  const bookNarrativeHistoryKey ='),b=s.indexOf('  const bookAlmanacCss =',a);
let snapshot={scope:{scopeKey:'one'},continuityState:{throughTurn:10},manifest:{memories:{a:{revision:1}}}},pageResponse={items:[{memoryId:'one',revision:1}],nextCursor:'p2',hasMore:true},fail=false,hold=null;
const ctx=vm.createContext({Gui:{},LibraMemoryCore:{peekSnapshot:()=>snapshot},canonicalReaderBinding:()=>({scopeKey:snapshot.scope.scopeKey,worldlineId:'main',openSerial:1}),canonicalReaderIdentityKey:c=>c.memoryId+':'+c.revision,guiAsArray:x=>Array.isArray(x)?x:[],text:x=>String(x??''),queueGuiNavigationRender:()=>{},__LIBRA__:{listCanonicalReaderChapters:async()=>pageResponse,getCanonicalReaderChapter:async x=>{if(hold)await hold;if(fail)throw Error('read failed');return {...x,canonicalArtifact:{facts:[]}};}}});
vm.runInContext(s.slice(a,b)+';globalThis.read=loadBookNarrativeHistory;globalThis.state=bookNarrativeHistoryState;',ctx);
(async()=>{
 await ctx.read();assert.equal(ctx.state().chapters.length,1);assert.equal(ctx.state().cursor,'p2');assert.equal(ctx.state().hasMore,true);
 pageResponse={items:[{memoryId:'two',revision:1},{memoryId:'three',revision:1}],hasMore:false};fail=true;await ctx.read();assert.equal(ctx.state().chapters.length,1);assert.equal(ctx.state().cursor,'p2');assert.match(ctx.state().error,/read failed/);assert.equal(ctx.state().loading,false);
 fail=false;await ctx.read();assert.equal(ctx.state().chapters.length,3);assert.equal(ctx.state().hasMore,false);await ctx.read();assert.equal(ctx.state().chapters.length,3);
 let release;hold=new Promise(r=>release=r);const running=ctx.read(true);await new Promise(r=>setImmediate(r));snapshot={...snapshot,scope:{scopeKey:'two'}};const fresh=ctx.state();release();await running;assert.equal(fresh.chapters.length,0);assert.equal(fresh.loaded,false);assert.equal(fresh.error,'');
 hold=null;await ctx.read();snapshot.manifest={memories:{a:{revision:2}}};assert.equal(ctx.state().loaded,false);
 console.log('PASS history pagination, dedup, atomic failed page, retry, stale scope discard and revision invalidation');
})().catch(e=>{console.error(e);process.exitCode=1;});
