'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const s=fs.readFileSync(require('node:path').join(__dirname,'../plugins/LIA_Persona_Linker.js'),'utf8');
const extract=(a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
async function check(kind,expected,external=false){
 let called=0,abortObserved=false;const caller=new AbortController();if(external)caller.abort();
 const ctx={AbortController,Date,Error,Promise,setTimeout:fn=>setTimeout(fn,5),clearTimeout,sanitizeLogUrl:x=>x,appendDebugLog:()=>{},errorForLog:e=>e.message,
 getRuntimeApi:()=>({nativeFetch:(_u,{signal})=>{called++;if(kind==='ok')return Promise.resolve({ok:true});if(kind==='host')return Promise.reject(Object.assign(new Error('signal is aborted without reason'),{name:'AbortError'}));return new Promise((_r,j)=>signal.addEventListener('abort',()=>{abortObserved=true;if(kind==='wrapped')j(new Error('signal is aborted without reason'));}));}})};
 vm.createContext(ctx);vm.runInContext(extract('  async function liaFetch(', '  async function responseBodyToText(')+extract('  function isTransientProviderError(', '  function isPromptCacheUnsupportedError(')+'this.fetch=liaFetch;this.retry=isTransientProviderError;',ctx);
 let error;try{await ctx.fetch('fixture',external?{signal:caller.signal}:{},60000)}catch(e){error=e}
 assert.equal(error?.code,expected,kind);if(expected)assert.equal(ctx.retry(error),expected==='LIA_PROVIDER_TIMEOUT');
 if(external)assert.equal(called,0);if(kind==='ignored'||kind==='wrapped')assert(abortObserved);
}
(async()=>{await check('wrapped','LIA_PROVIDER_TIMEOUT');await check('ignored','LIA_PROVIDER_TIMEOUT');await check('host','LIA_PROVIDER_CANCELLED');await check('ok',undefined);await check('preabort','LIA_PROVIDER_CANCELLED',true);console.log('PASS: 5 actual-function timeout/cancellation cases');})().catch(e=>{console.error(e);process.exitCode=1});
