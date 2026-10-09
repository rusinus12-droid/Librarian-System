'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto'),fs=require('node:fs');
const {fixture,hook,plain,base}=require('./wm-native-cache-support.cjs');
const {exactRaw,CAP}=require(base+'/tools/libra_owned_hydration_cap_support.cjs');
const root=path.resolve(__dirname,'..'),candidate=process.env.WM_CHECKSUM_DIST||root+'/dist/LIBRA World Manager Full.js',reference=path.join(JSON.parse(fs.readFileSync(root+'/BASE-PINS.json')).base,'dist',path.basename(candidate));
for(const scenario of ['threeMiB','chunked','overHydrationCap'])test('base/candidate exact hook payload and physical root/chunk reads: '+scenario,async()=>{
 const rows=[];
 for(const artifact of [reference,candidate]){
  const f=await fixture({artifact}),raw=exactRaw({scope:f.scope},JSON.parse(f.raw).entries,scenario==='overHydrationCap'?CAP+1:3*1024*1024);
  if(scenario==='chunked')await f.native.compat.pluginStorage.setItem(f.key,raw);else f.r.store.set(f.key,raw);
  f.physical.length=0;f.counts.total=0;f.counts.freezeVisits=0;f.counts.stages={};
  const out=plain(await hook(f)),state=f.r.context.__REFRESH_OBS__;
  assert.match(JSON.stringify(out),/Historical reference;/);assert.equal(f.r.state.calls.length,0);
  assert.equal(f.cache.stats().requestOwners,0);assert.equal(f.cache.stats().requestBorrows,0);assert.equal(f.cache.stats().pendingReads,0);
  rows.push({out,physical:f.physical.map(({key,bytes})=>({kind:key===f.key?'root':'chunk',bytes})),parses:f.counts.total,freezeVisits:f.counts.freezeVisits,stages:plain(f.counts.stages),targetReads:state.targetReads,targetPhysical:state.targetPhysical,targetFull:state.targetFull,targetParses:state.targetParses,targetChecksums:state.targetChecksums});
 }
 fs.writeFileSync(root+'/evidence/HOOK-PAYLOADS-'+(candidate.includes(' Full.js')?'Full':'Min')+'-'+scenario+'.json',JSON.stringify({reference,candidate,scenario,rows},null,2)+'\n');
 assert.deepEqual(rows[1],rows[0]);assert.equal(rows[1].physical.length,scenario==='chunked'?140:20);assert.equal(rows[1].parses,2);
 console.log('EXACT_HOOK_PARITY '+JSON.stringify({scenario,physicalReads:rows[1].physical.length,physicalBytes:rows[1].physical.reduce((n,x)=>n+x.bytes,0),parses:rows[1].parses,targetReads:rows[1].targetReads,targetChecksums:rows[1].targetChecksums,outputSha256:crypto.createHash('sha256').update(JSON.stringify(rows[1].out)).digest('hex')}));
});
