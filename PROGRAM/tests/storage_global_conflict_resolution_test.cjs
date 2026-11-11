'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {fixture,installedSdkVariants} = require('./storage_global_allchat_job_test.cjs');
const {makePanelDom} = require('./helpers/global-allchat-panel-dom.cjs');

async function waitForHandler(node) {
  for (let attempt=0;attempt<200;attempt++) {
    if (typeof node.onclick==='function') return node.onclick;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('Mode action handler unavailable');
}

for (const variant of installedSdkVariants) {
  const [namespace] = variant;
  const a = namespace+'.A', b = namespace+'.B';
  test(namespace+': same-screen selection remembers each reviewed copy and keeps the other source intact', async () => {
    const f = await fixture(variant), dom = makePanelDom();
    try {
      await f.bridge.setGlobalMode('server_only');
      await f.proxy.setItem(a,'SERVER_A');
      await f.proxy.setItem(b,'SERVER_B');
      f.values.set(a,'DEVICE_A');f.values.set(b,'DEVICE_B');
      await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),e=>e.details?.review?.key===a);
      await f.bridge.mountConnectionPanel(dom.container);
      assert.match(dom.byAttr('data-job-result').textContent,new RegExp(namespace+'\\.A'));
      const choosing = dom.byAttr('data-job-resolve').onclick();
      const approve = await waitForHandler(dom.byAttr('data-ask-a'));
      assert.match(dom.byAttr('data-ask-text').textContent,/기기 사본 지문/);
      assert.doesNotMatch(dom.byAttr('data-ask-text').textContent,/SERVER_A|DEVICE_A/);
      approve();await choosing;
      assert.equal(f.bridge.getSyncJob().errorDetails.review.key,b);
      const second = dom.byAttr('data-job-resolve').onclick();
      (await waitForHandler(dom.byAttr('data-ask-b')))();await second;
      assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
      assert.equal(await f.proxy.getItem(a),'DEVICE_A');
      assert.equal(await f.proxy.getItem(b),'SERVER_B');
      assert.equal(f.app.repositories[namespace].get('plugin',a).value,'SERVER_A');
    } finally { dom.root.isConnected=false;await f.close(); }
  });

  test(namespace+': choosing either side before upload changes only the reviewed key', async () => {
    for(const choice of ['plugin','server']) {
      const f=await fixture(variant);
      try {
        const repo=f.app.repositories[namespace];
        repo.mutate({kind:'set',space:'plugin',key:a,value:'INDEPENDENT_SERVER',operationId:'independent_server_copy'});
        await assert.rejects(()=>f.bridge.setGlobalMode('server_only'),e=>e.details?.review?.key===a);
        const job=f.bridge.getSyncJob();
        const result=await f.bridge.retryGlobalModeFailure(job.jobId,choice);
        assert.equal(result.mode,'server_only');
        assert.equal(repo.get('plugin',a).value,choice==='server'?'INDEPENDENT_SERVER':'A_SOURCE');
        assert.equal(repo.get('plugin',b).value,'B_SOURCE');
        assert.equal(f.values.get(a),'A_SOURCE');
      } finally { await f.close(); }
    }
  });

  test(namespace+': approval is invalid when either reviewed copy changes', async () => {
    const f = await fixture(variant);
    try {
      await f.bridge.setGlobalMode('server_only');
      await f.proxy.setItem(a,'SERVER_A');
      f.values.set(a,'DEVICE_A');
      await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),e=>e.details?.review?.key===a);
      const job = f.bridge.getSyncJob();
      f.values.set(a,'NEW_DEVICE_A');
      await assert.rejects(()=>f.bridge.retryGlobalModeFailure(job.jobId,'server'),
        e=>e.code==='MEMORY_SUITE_GLOBAL_DESTINATION_CONFLICT'&&e.details.review.localProof!==job.errorDetails.review.localProof);
      assert.equal(f.values.get(a),'NEW_DEVICE_A');
      assert.equal((await f.bridge.getGlobalMode()).mode,'server_only');
      await assert.rejects(()=>f.bridge.retryGlobalModeFailure(job.jobId,'server'),e=>e.code==='MEMORY_SUITE_GLOBAL_REVIEW_EXPIRED');
    } finally { await f.close(); }
  });

  test(namespace+': a deletion conflict requires an explicit choice and cannot be repaired as missing', async () => {
    const f=await fixture(variant);
    try {
      await f.bridge.setGlobalMode('server_only');
      await f.proxy.removeItem(a);
      f.values.set(a,'DEVICE_EDIT');
      await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),e=>e.details?.review?.serverProof?.[2]===true);
      const job=f.bridge.getSyncJob();
      await assert.rejects(()=>f.bridge.retryGlobalModeFailure(job.jobId,'restore'),e=>e.code==='MEMORY_SUITE_GLOBAL_REVIEW_EXPIRED');
      assert.equal((await f.bridge.retryGlobalModeFailure(job.jobId,'plugin')).mode,'plugin_only');
      assert.equal(await f.proxy.getItem(a),'DEVICE_EDIT');
      assert.equal(f.app.repositories[namespace].get('plugin',a).tombstone,true);
    } finally { await f.close(); }
  });

  test(namespace+': recheck continues from the same card after external source restoration', async () => {
    const f=await fixture(variant),dom=makePanelDom();
    try {
      await f.bridge.setGlobalMode('server_only');
      const repo=f.app.repositories[namespace];
      repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',a);
      f.values.set(a,'UNKNOWN_LOCAL_COPY');
      await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),e=>e.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'&&!e.details.review);
      await f.bridge.mountConnectionPanel(dom.container);
      assert.equal(dom.byAttr('data-job-resolve').hidden,true);
      assert.match(dom.byAttr('data-job-result').textContent,/백업에서 복원/);
      repo.mutate({kind:'set',space:'plugin',key:a,value:'UNKNOWN_LOCAL_COPY',operationId:'external_verified_restore'});
      await dom.byAttr('data-job-recheck').onclick();
      assert.equal((await f.bridge.getGlobalMode()).mode,'plugin_only');
      assert.equal(await f.proxy.getItem(a),'UNKNOWN_LOCAL_COPY');
    } finally { dom.root.isConnected=false;await f.close(); }
  });

  test(namespace+': only a matching replica can repair a missing server record', async () => {
    const f = await fixture(variant);
    try {
      await f.bridge.setGlobalMode('server_only');
      const repo=f.app.repositories[namespace];
      repo.database.prepare('DELETE FROM kv WHERE space=? AND key=?').run('plugin',a);
      f.values.set(a,'UNVERIFIED');
      await assert.rejects(()=>f.bridge.setGlobalMode('plugin_only'),
        e=>e.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'&&!e.details.review);
      const unverified = f.bridge.getSyncJob();
      await assert.rejects(()=>f.bridge.retryGlobalModeFailure(unverified.jobId,'restore'),
        e=>e.code==='MEMORY_SUITE_GLOBAL_REVIEW_EXPIRED');
      assert.equal(repo.get('plugin',a).exists,false);
      f.values.set(a,'A_SOURCE');
      await assert.rejects(()=>f.bridge.retryGlobalModeFailure(unverified.jobId,'retry'),
        e=>e.code==='MEMORY_SUITE_GLOBAL_SOURCE_CHANGED'&&e.details.review?.kind==='restore');
      const repair = f.bridge.getSyncJob();
      const applied = await f.bridge.retryGlobalModeFailure(repair.jobId,'restore');
      assert.equal(applied.mode,'plugin_only');
      assert.equal(repo.get('plugin',a).value,'A_SOURCE');
      assert.equal(await f.proxy.getItem(a),'A_SOURCE');
    } finally { await f.close(); }
  });
}
