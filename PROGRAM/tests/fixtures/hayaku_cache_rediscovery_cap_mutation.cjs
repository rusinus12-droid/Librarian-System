'use strict';
// Explicit diagnostic invocation only; never registered as another official root.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),vm=require('node:vm'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const sourcePath=path.resolve(__dirname,'../../plugins/HAYAKU_Locator_Continuity.js'),source=fs.readFileSync(sourcePath,'utf8');
const cap='    const limitAt=now()+Math.max(0,Math.min(150,(deadlineAt-now())/3));';assert.equal(source.split(cap).length,2);
const mutant=source.replace(cap,cap.replace('Math.min(150,','Math.min(600,'));
const clock='  const now = () => Date.now();';assert.equal(mutant.split(clock).length,2);
new vm.Script(mutant.replace(clock,'  let rediscoveryTestClock=null;\n  const now = () => rediscoveryTestClock ? rediscoveryTestClock() : Date.now();'));
if(process.argv.includes('--run')){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hayaku246-cap-mutant-')),mutantPath=path.join(directory,'HAYAKU.js');fs.writeFileSync(mutantPath,mutant);
 const result=spawnSync(process.execPath,[path.resolve(__dirname,'../hayaku_cache_rediscovery_runtime_test.cjs'),mutantPath],{encoding:'utf8',timeout:180000});
 fs.writeFileSync(path.join(directory,'stdout.txt'),result.stdout||'');fs.writeFileSync(path.join(directory,'stderr.txt'),result.stderr||'');
 assert.equal(result.error,undefined);assert.notEqual(result.status,0,'widening150ms to600ms must fail actual-work assertion');
 assert.match(result.stderr,/temporary posting routing must obey the150ms window at10ms per gate/,'mutant must fail the work bound, not observer anchors or another condition');
 console.log(JSON.stringify({directory,mutation:'temporary posting cap150ms->600ms',actualWorkAssertionRefused:true,sourceUnchanged:fs.readFileSync(sourcePath,'utf8')===source,mutantSHA256:crypto.createHash('sha256').update(mutant).digest('hex')}));
}else console.log('Mutant observer compiles; runtime not executed (explicit --run required).');
