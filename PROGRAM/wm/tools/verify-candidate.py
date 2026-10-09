from pathlib import Path
import json,hashlib,re,datetime
root=Path(__file__).resolve().parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((root/'SOURCE-ARTIFACT-PINS.json').read_text())
for item in manifest['files']:
 assert sha(root/item['path'])==item['sha256'],('candidate pin changed',item['path'])
origin=json.loads((root/'ORIGIN.json').read_text())
for item in origin['files']:
 path=Path(item.get('source',item['path']))
 assert sha(path)==item['sha256'],('base pin changed',str(path))
base=Path(manifest['base']);actual=[]
for p in (root/'src/parts').iterdir():
 if p.read_bytes()!=(base/'src/parts'/p.name).read_bytes():actual.append('src/parts/'+p.name)
assert sorted(actual)==sorted(manifest['production_allowlist']),actual
results={};labels=['WITNESS','CALLBACK-BOUNDARY','CHECKSUM-SAFETY','HOOK-PARITY','NATIVE-SAFETY','CONSUMERS','CONSUMER-REVIEW','BINDING-SIZE','READ-PASS-CHECKSUM']
for flavor in ['Full','Min']:
 results[flavor]={}
 for label in labels:
  log=root/'evidence'/f'{label}-{flavor}.log';exitfile=log.with_suffix('.exit')
  assert exitfile.exists(),('suite pending',label,flavor)
  exitcode=int(exitfile.read_text());text=log.read_text();assert exitcode==0,(label,flavor,exitcode)
  native=re.search(r'ℹ tests (\d+).*?ℹ pass (\d+).*?ℹ fail (\d+)',text,re.S)
  if native:total,passed,failed=map(int,native.groups())
  else:
   summaries=re.findall(r'\{"passed":(\d+),"failed":(\d+)\}',text);assert summaries,(label,flavor,'missing summary')
   passed,failed=map(int,summaries[-1]);total=passed+failed
  assert failed==0 and passed==total,(label,flavor,total,passed,failed)
  assert 'FINAL_DELIVERY_BLOCKED_TRANSPORTS' not in text,(label,flavor,'outbound attempted')
  results[flavor][label]={'tests':total,'pass':passed,'fail':failed,'exit':exitcode,'logSha256':sha(log)}
  if label=='HOOK-PARITY':results[flavor][label]['physicalParity']=[json.loads(line.split(' ',1)[1]) for line in text.splitlines() if line.startswith('EXACT_HOOK_PARITY ')]
 totals={flavor:sum(x['tests'] for x in suites.values()) for flavor,suites in results.items()}
report={'status':'FOCUSED_GREEN_PENDING_INDEPENDENT_REVIEW','verifiedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'basePinsVerified':len(origin['files']),'candidatePinsVerified':len(manifest['files']),'productionChanges':actual,'totals':totals,'results':results,'limits':['No original97 performance/heap acceptance','No aggregate/cold-start acceptance','No release or main-tree edit']}
(root/'RESULTS.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'totals':totals,'basePinsVerified':len(origin['files']),'candidatePinsVerified':len(manifest['files'])}))
