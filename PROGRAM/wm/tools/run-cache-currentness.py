from pathlib import Path
import subprocess,json,sys,datetime
root=Path(__file__).resolve().parent.parent; out=root/'repair-evidence'; mode=sys.argv[1]
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
env={'PATH':'/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin','HOME':'/tmp','LANG':'C.UTF-8','NODE_PATH':'/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules','NODE_OPTIONS':'--preserve-symlinks --preserve-symlinks-main --require='+str(root/'tools/libra_final_delivery_offline_guard.cjs')}
base=Path(json.loads((out/'INPUT-PINS.json').read_text())['base'])
records=[]
def run(label,args,extra=None,limit=300):
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (out/(label+'.log')).open('w') as log:
  try: rc=subprocess.run(args,cwd=root,env={**env,**(extra or {})},stdout=log,stderr=subprocess.STDOUT,timeout=limit).returncode
  except subprocess.TimeoutExpired:rc=124
 record={'label':label,'exit':rc,'start':start,'end':datetime.datetime.now(datetime.timezone.utc).isoformat()};records.append(record)
 (out/(label+'.exit')).write_text(str(rc)+'\n');print(json.dumps(record),flush=True)
 (out/(mode+'-runs.json')).write_text(json.dumps(records,indent=2)+'\n');return rc
if mode=='build':sys.exit(run('BUILD',[node,'tools/build-overlay.cjs'],{'WM_BUILD_MIN':'1'}))
if mode=='legacy':sys.exit(run('LEGACY-FINGERPRINT',[node,'tools/libra_embedding_fingerprint_test.cjs']))
files=(['wm-cache-currentness.test.cjs','wm-cache-publication-boundaries.test.cjs'] if mode=='green' else ['wm-cache-currentness.test.cjs']) if mode in ['red','green'] else ['wm-cache-publication-boundaries.test.cjs'] if mode=='red-publication' else ['wm-cache-record-admission.test.cjs'] if mode in ['red-record','green-record'] else ['wm-cache-endpoint-privacy.test.cjs'] if mode in ['privacy-red','privacy-green'] else ['wm-native-derived-cache.test.cjs','wm-native-cache-lifecycle.test.cjs','wm-native-cache-pressure.test.cjs','wm-native-cache-final-policy.test.cjs','wm-native-cache-fallback-fence.test.cjs','wm-native-cache-large-hook.test.cjs','wm-common-derived-cache.test.cjs']
for kind,name in [('Full','LIBRA World Manager Full.js'),('Min','LIBRA World Manager.js')]:
 if len(sys.argv)>2 and kind!=sys.argv[2]:continue
 artifact=str((base if mode.startswith('red') else root)/'dist'/name)
 run(mode+'-'+kind,[node,'--expose-gc','--test','--test-concurrency=1']+[str(root/'tools'/f) for f in files],{'WM_VERSIONED_DIST':artifact,'LIBRA_RECALL_TEST_DIST':artifact,'LIBRA_GUI_TEST_DIST':artifact,'WM_EVIDENCE_DIR':str(out)})
sys.exit(0 if mode.startswith('red') or all(x['exit']==0 for x in records) else 1)
