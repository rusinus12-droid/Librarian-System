'use strict';
const assert = require('node:assert/strict');
const {createFixture} = require('./fixtures/lia_native_runtime_fixture.cjs');
const transformSource = source => source.replace('      getLiveSyncCaptureState:', `
      cancelProvider: (config, options) => callIndependentProvider('System', 'User', config, options),
      getLiveSyncCaptureState:`);
(async () => {
  const f = await createFixture('official', {transformSource});
  try {
    const rows = [];
    for (const provider of ['openai', 'claude', 'gemini', 'ollama']) {
      const config = {provider, model:'mock-model', apiKey:'mock-test-key', endpoint:'https://example.invalid', stream:false, promptCacheMode:'off', timeout:1000};
      let calls=0;
      f.api.nativeFetch=async()=>{calls++;return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'mock'}}],content:[{type:'text',text:'mock'}],candidates:[{content:{parts:[{text:'mock'}]}}],message:{content:'mock'}})};};
      const before=new AbortController();before.abort();
      await assert.rejects(()=>f.runtime.cancelProvider(config,{signal:before.signal}),error=>error.code==='LIA_PROVIDER_CANCELLED',`${provider}: pre-cancelled action cannot call a model`);
      assert.equal(calls,0,`${provider}: pre-cancelled transport calls`);
      const controller=new AbortController();let entered, observed=false;
      const started=new Promise(resolve=>{entered=resolve;});
      f.api.nativeFetch=async(_url,init)=>{
        calls++; entered();
        return new Promise((_resolve,reject)=>{
          init.signal?.addEventListener('abort',()=>{observed=true;reject(Object.assign(new Error('caller cancelled'),{name:'AbortError'}));},{once:true});
        });
      };
      const running=f.runtime.cancelProvider(config,{signal:controller.signal});
      await started; controller.abort();
      await assert.rejects(()=>running,error=>error.code==='LIA_PROVIDER_CANCELLED',`${provider}: in-flight cancellation propagates`);
      assert(observed,`${provider}: transport observes abort`);
      assert.equal(calls,1,`${provider}: cancellation never retries model`);
      rows.push({provider,passed:true,actualNetworkCalls:0});
    }
    console.log(JSON.stringify({test:'lia_manual_provider_cancel',rows}));
  } finally { await f.dispose(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
