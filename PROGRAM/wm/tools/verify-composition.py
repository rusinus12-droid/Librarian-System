from pathlib import Path
import difflib,hashlib,json,sys
root=Path(__file__).resolve().parent.parent;e=root/'evidence';input=json.loads((e/'INPUT-MANIFESTS.json').read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def paths(p):return {str(f.relative_to(p))for f in p.rglob('*')if f.is_file()}
verified={}
for label,entries in input['files'].items():
 origin=Path(input['roots'][label])
 for rel,item in entries.items():assert sha(origin/rel)==item['sha256'],(label,rel)
 actual=paths(origin)if label!='coalescence-review'else {p.name for p in origin.iterdir()if p.is_file()}
 assert actual==set(entries),(label,'file set')
 verified[label]=len(entries)
base=Path(input['roots']['base']);preservation=json.loads((e/'SOURCE-PRESERVATION.json').read_text())
for rel,row in preservation['productionOrigins'].items():assert sha(root/rel)==row['sha256']==sha(Path(row['root'])/rel),rel
for rel in preservation['unchangedExistingSourceToolFiles']:assert (root/rel).read_bytes()==(base/rel).read_bytes(),rel
for rel in json.loads((e/'TEST-REBASE.json').read_text())['files']:assert (root/rel).read_bytes()==(Path(input['roots']['coalescence'])/rel).read_bytes(),rel
name='dist/LIBRA World Manager Full.js';lines=(base/name).read_text().splitlines(True);edits=[]
for label in ['admission','coalescence']:
 other=(Path(input['roots'][label])/name).read_text().splitlines(True)
 for op,i,j,k,l in difflib.SequenceMatcher(None,lines,other).get_opcodes():
  if op!='equal':edits.append((i,j,other[k:l]))
ordered=sorted(edits)
for before,after in zip(ordered,ordered[1:]):assert before[1]<=after[0]
for i,j,new in reversed(ordered):lines[i:j]=new
assert ''.join(lines).encode()==(root/name).read_bytes()
artifacts=json.loads((e/'ARTIFACT-COMPOSITION.json').read_text())['artifacts']
for name,row in artifacts.items():assert sha(root/'dist'/name)==row['sha256'],name
for name in ['SOURCE-ARTIFACT-PINS.json','REVIEW-INPUT-PINS.json']:
 p=root/name
 if p.exists():
  for row in json.loads(p.read_text())['files']:assert sha(root/row['path'])==row['sha256'],(name,row['path'])
assert not any(p.suffix in ['.heapsnapshot','.heapprofile']for p in root.rglob('*'))
result={'inputFileCountsUnchanged':verified,'productionByteCopiesVerified':len(preservation['productionOrigins']),'unchangedSourceToolFilesVerified':len(preservation['unchangedExistingSourceToolFiles']),'fullExactReviewedDeltaUnion':True,'artifactPinsVerified':True,'rawHeapIncluded':False}
if len(sys.argv)>1:(e/('PIN-CHECK-'+sys.argv[1]+'.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
