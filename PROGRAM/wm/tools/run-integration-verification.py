#!/usr/bin/env python3
"""Run explicit, serial, offline verification. No dependency installation, no overwrites."""
from pathlib import Path
import argparse, datetime, hashlib, json, os, re, shutil, subprocess, sys
ROOT = Path(__file__).resolve().parents[1]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def stamp(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('label');p.add_argument('--artifact');p.add_argument('--expected-exit',type=int,default=0)
    p.add_argument('--node',default=shutil.which('node'));p.add_argument('--node-path',default=os.environ.get('NODE_PATH',''))
    p.add_argument('--timeout',type=int,default=300);p.add_argument('--env',action='append',default=[])
    argv=sys.argv[1:]
    if '--' not in argv:p.error('separate Node arguments with --')
    split=argv.index('--');cmd=argv[split+1:];a=p.parse_args(argv[:split])
    if not re.fullmatch(r'[A-Za-z0-9_-]+',a.label):p.error('invalid evidence label')
    out=ROOT/'evidence'/a.label;out.mkdir(parents=True,exist_ok=False)
    if not a.node: p.error('Node required')
    if not cmd:p.error('explicit node command required')
    audit=out/'network-attempts.jsonl';audit.touch(exist_ok=False)
    guard=ROOT/'tools/strict-offline-guard.cjs'
    env={'PATH':str(Path(a.node).parent)+os.pathsep+os.defpath,'HOME':str(out),'LANG':'C.UTF-8',
        'NODE_PATH':a.node_path,'NODE_OPTIONS':'--require='+json.dumps(guard.as_posix())+' --require='+json.dumps((ROOT/'tools/portable-test-paths.cjs').as_posix()),
        'LIBRA_NETWORK_AUDIT':str(audit),'WM_SETTINGS_ROOT':str(ROOT),'WM_SCORING_SETTINGS_ROOT':str(ROOT),
        'WM_EVIDENCE_DIR':str(out),'WM_VECTOR_EVIDENCE':str(out/'vector.json')}
    for item in a.env:
        k,v=item.split('=',1)
        if k in ['NODE_OPTIONS','LIBRA_NETWORK_AUDIT']:p.error('cannot disable offline guard')
        env[k]=v
    artifact=Path(a.artifact).resolve() if a.artifact else None
    if artifact:
        if not artifact.is_file():p.error('artifact must exist')
        for k in ['WM_CHECKSUM_DIST','WM_VERSIONED_DIST','LIBRA_RECALL_TEST_DIST','LIBRA_GUI_TEST_DIST']:
            env[k]=str(artifact)
    row={'label':a.label,'start':stamp(),'command':[a.node]+cmd,'cwd':str(ROOT),'nodeVersion':subprocess.check_output([a.node,'--version'],text=True).strip(),
         'artifact':str(artifact) if artifact else None,'artifactSha256':sha(artifact) if artifact else None,
         'guardSha256':sha(guard),'environment':env,'expectedExit':a.expected_exit,'status':'RUNNING'}
    receipt=out/'RESULT.json';receipt.write_text(json.dumps(row,indent=2)+'\n')
    with (out/'stdout.log').open('w') as f:
        try:rc=subprocess.run(row['command'],cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=a.timeout).returncode
        except subprocess.TimeoutExpired:rc=124
    text=(out/'stdout.log').read_text(errors='replace')
    counts={k:int(v) for k,v in re.findall(r'^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (\d+)$',text,re.M)}
    custom_pass=len(re.findall(r'^(?:# )?PASS ',text,re.M));custom_fail=len(re.findall(r'^(?:# )?FAIL ',text,re.M))
    attempts=len(audit.read_text().splitlines());missing=bool(re.search(r"Cannot find module ['\"][^'\"]*(?:jsdom|terser)|WM_PINNED_TOOLCHAIN_REQUIRED|WM_LOCKED_PACKAGE_MISMATCH|ENOENT.*LIBRA World Manager\.js",text))
    status=('BLOCKED_MISSING_TOOLCHAIN' if missing else 'PASS' if rc==0 and not attempts and not any(counts.get(k,0) for k in ['fail','skipped','cancelled','todo']) and not custom_fail
            else 'EXPECTED_NEGATIVE_CONTROL' if a.expected_exit!=0 and rc==a.expected_exit and not attempts else 'FAIL')
    row.update(end=stamp(),exit=rc,status=status,tap=counts,customPass=custom_pass,customFail=custom_fail,networkAttempts=attempts,logSha256=sha(out/'stdout.log'))
    receipt.write_text(json.dumps(row,indent=2)+'\n');(out/'exit.txt').write_text(str(rc)+'\n')
    print(json.dumps({k:row[k] for k in ['label','status','exit','tap','customPass','customFail','networkAttempts']}),flush=True)
    return 0 if status in ['PASS','EXPECTED_NEGATIVE_CONTROL'] else 1
if __name__=='__main__':raise SystemExit(main())
