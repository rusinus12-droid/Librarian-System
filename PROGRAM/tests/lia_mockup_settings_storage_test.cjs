'use strict';
const assert=require('node:assert/strict');
const {createFixture}=require('./fixtures/lia_native_runtime_fixture.cjs');

const expose=source=>source.replace('      getLiveSyncCaptureState:',`      readLiaMockupSettings: async()=>({llm:await readStoredLLMConfig(),image:await readStoredIllustrationConfig(true)}),
      writeLiaMockupSettings: async()=>({llm:await writeStoredLLMConfig({provider:'openai',model:'fixture-model',endpoint:'https://fixture.invalid/v1',apiKey:'',temp:0.4,maxCompletionTokens:4096,timeout:45000,reasoningPreset:'off',reasoningEffort:'low',promptCacheMode:'explicit',extraBodyJson:'{"top_p":0.8}'}),image:await writeStoredIllustrationConfig({provider:'custom-json',model:'fixture-image',endpoint:'https://fixture.invalid/image',apiKey:'',enabled:false,width:640,height:960,steps:18,stylePrompt:'synthetic',runtimeAttachEnabled:false})}),
      getLiveSyncCaptureState:`);

(async()=>{
  const fixture=await createFixture('official',{transformSource:expose});
  try{
    const written=await fixture.runtime.writeLiaMockupSettings();
    assert.equal(written.llm.provider,'openai');assert.equal(written.llm.model,'fixture-model');
    assert.equal(written.llm.maxCompletionTokens,4096);assert.equal(written.llm.promptCacheMode,'explicit');assert.equal(written.llm.extraBodyJson,'{"top_p":0.8}');
    assert.equal(written.image.provider,'custom-json');assert.equal(written.image.model,'fixture-image');assert.equal(written.image.enabled,false);
    assert.equal(written.image.width,640);assert.equal(written.image.height,960);assert.equal(written.image.runtimeAttachEnabled,false);
    const readback=await fixture.runtime.readLiaMockupSettings();
    assert.equal(readback.llm.model,'fixture-model');assert.equal(readback.llm.apiKey,'');
    assert.equal(readback.image.model,'fixture-image');assert.equal(readback.image.apiKey,'');
    assert.equal(readback.image.stylePrompt,'synthetic');assert.equal(readback.llm.timeout,45000);
    assert.equal([...fixture.values.keys()].some(key=>String(key).toLowerCase().includes('api_key')&&String(fixture.values.get(key)||'').includes('fixture.invalid')),false);
    console.log('lia_mockup_settings_storage_test: PASS (real settings writers/readback, no credentials)');
  }finally{await fixture.dispose();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
