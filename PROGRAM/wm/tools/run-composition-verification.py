from pathlib import Path
import datetime,hashlib,json,subprocess,sys,time
root=Path(__file__).resolve().parent.parent;e=root/'evidence'
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
python='/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin/python3'
env={'PATH':'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/opt/codex/runtimes/codex-primary-runtime/dependencies/python/bin:/usr/bin:/bin','HOME':'/tmp','LANG':'C.UTF-8','NODE_PATH':'/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules','NODE_OPTIONS':'--preserve-symlinks --preserve-symlinks-main --require='+str(root/'tools/libra_final_delivery_offline_guard.cjs'),'WM_BUILD_MIN':'1'}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(label,args,extra=None,limit=180):
 local=dict(env);local.update(extra or {});started=now()
 with (e/(label+'.log')).open('w') as log:
  try:r=subprocess.run(args,cwd=root,env=local,stdout=log,stderr=subprocess.STDOUT,timeout=limit);status=r.returncode
  except subprocess.TimeoutExpired:status=124
 (e/(label+'.exit')).write_text(str(status)+'\n');print(json.dumps({'group':label,'exit':status,'startedAtUtc':started,'finishedAtUtc':now()}),flush=True)
 if status:print((e/(label+'.log')).read_text()[-5000:],flush=True);sys.exit(status)
run('COMPOSED-BUILD',[node,'tools/build-overlay.cjs'])
critical=['checksum-use-order.test.cjs','checksum-witness.test.cjs','checksum-boundary-r1.test.cjs','checksum-batch.test.cjs','checksum-read-pass.test.cjs','checksum-hook-parity.test.cjs','wm-native-cache-lifecycle.test.cjs','wm-native-cache-fallback-fence.test.cjs']
for flavor,name in [('Full','LIBRA World Manager Full.js'),('Min','LIBRA World Manager.js')]:
 artifact=str(root/'dist'/name);extra={'WM_CHECKSUM_DIST':artifact,'WM_VERSIONED_DIST':artifact,'LIBRA_RECALL_TEST_DIST':artifact,'WM_EVIDENCE_DIR':str(e)}
 for group,tests in [('ADMISSION',['proof-admission.test.cjs']),('COALESCENCE',['raw-coalescence.test.cjs']),('CRITICAL',critical)]:
  run(group+'-'+flavor,[node,'--expose-gc','--test','--test-concurrency=1']+[str(root/'tools'/test)for test in tests],extra)
for flavor,name in [('Full','LIBRA World Manager Full.js'),('Min','LIBRA World Manager.js')]:
 folder=e/('HEAP-COMPOSED-'+flavor);folder.mkdir(exist_ok=True)
 run('HEAP-'+flavor,[node,'--expose-gc','tools/raw-coalescence-heap.cjs',str(root/'dist'/name),str(folder),'composition-20261006T2250Z-'+flavor])
 run('HEAP-ASSERT-'+flavor,[python,'tools/raw-coalescence-heap-assert.py',str(folder)])
print('All granted composition groups finished.',flush=True)
