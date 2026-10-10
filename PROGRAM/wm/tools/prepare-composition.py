from pathlib import Path
import hashlib,json,shutil,difflib
r=Path('/workspace/scratch/d09f18a13aaa');base=r/'recovery_20261006T2103Z/restored/WM-supplement/references/checksum-use-candidate-1700';a=r/'wm-proof-admission-candidate-20261006T2210Z';b=r/'wm-equal-raw-candidate-20261006T2224Z';ra=Path('/workspace/shared/wm-proof-admission-review-20261006T2230Z');rb=r/'wm-equal-raw-review-20261006T2238Z';out=r/'wm-resource-composed-candidate-20261006T2250Z'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def files(p):return {str(q.relative_to(p)):{'sha256':sha(q),'bytes':q.stat().st_size}for q in sorted(p.rglob('*'))if q.is_file()}
def write(p,obj):p.write_text(json.dumps(obj,indent=2)+'\n')
def verify(root,manifest):
 for p,v in manifest.items():assert sha(root/p)==(v if isinstance(v,str)else v['sha256']),(root,p)
 assert set(files(root))==set(manifest),(root,'file_set')
ma=json.loads((ra/'CANDIDATE-PRE-HASHES.json').read_text());mb=json.loads((rb/'EXACT-CANDIDATE-PINS.json').read_text())['files'];verify(a,ma);verify(b,mb)
for p,v in json.loads((rb/'REVIEW-PINS.json').read_text())['files'].items():assert sha(rb/p)==v['sha256'],p
assert sha(rb/'REVIEW.md')=='81db40d1d94aa390b37ccfd4e0a9c01c9f7a3e6847b6ed3ecdac888997b17eef'
mp=files(base);assert len(mp)==554
for component in [a,b]:
 bp=json.loads((component/'BASE-PINS.json').read_text());assert bp['base']==str(base)
 for entry in bp['files']:assert mp[entry['file']]['sha256']==entry['sha256']
assert not out.exists();shutil.copytree(base,out)
h=out/'historical'/'immutable-base';h.mkdir(parents=True)
for p in list(out.iterdir()):
 if p.is_file():shutil.move(p,h/p.name)
shutil.move(out/'evidence',h/'evidence');e=out/'evidence';e.mkdir()
for label,root,report in [('admission',a,'REPORT.md'),('coalescence',b,'REPORT.md')]:
 dest=out/'historical'/label;dest.mkdir();
 for name in [report,'BASE-PINS.json','SOURCE-ARTIFACT-PINS.json','REVIEW-INPUT-PINS.json','RESULTS.json']:shutil.copy2(root/name,dest/name)
for label,root in [('admission-review',ra),('coalescence-review',rb)]:
 dest=out/'historical'/label;dest.mkdir()
 for p in root.iterdir():
  if p.is_file():shutil.copy2(p,dest/p.name)
production={'src/parts/10l-typed-recall-adapters.js':a,'src/parts/01f-lore-consolidation.js':b,'tools/runtime-factory-baseline-owner.source.js':b}
for rel,origin in production.items():shutil.copy2(origin/rel,out/rel)
test_rebases=['tools/checksum-use-order.test.cjs','tools/checksum-batch.test.cjs','tools/checksum-hook-parity.test.cjs']
for rel in test_rebases:
 # Coalescence review's BASE-PINS lookup resolves the identical restored input.
 shutil.copy2(b/rel,out/rel)
for rel in ['tools/proof-admission.test.cjs']:shutil.copy2(a/rel,out/rel)
for rel in ['tools/raw-coalescence.test.cjs','tools/raw-coalescence-support.cjs','tools/raw-coalescence-heap.cjs','tools/raw-coalescence-heap-assert.py']:shutil.copy2(b/rel,out/rel)
# Same explicit 530-file source/build/tool/artifact rebase, without historical metadata fabrication.
shutil.copy2(b/'BASE-PINS.json',out/'BASE-PINS.json')
write(e/'INPUT-MANIFESTS.json',{'roots':{'base':str(base),'admission':str(a),'coalescence':str(b),'admission-review':str(ra),'coalescence-review':str(rb)},'files':{'base':mp,'admission':files(a),'coalescence':files(b),'admission-review':files(ra),'coalescence-review':{str(p.relative_to(rb)):{'sha256':sha(p),'bytes':p.stat().st_size}for p in sorted(rb.iterdir())if p.is_file()}},'completeCandidateInputsVerified':True})
changed=[];unchanged=[]
for rel,v in mp.items():
 if not rel.startswith(('src/','tools/')):continue
 q=out/rel;assert q.exists(),rel
 (changed if sha(q)!=v['sha256']else unchanged).append(rel)
assert set(changed)==set(production)|set(test_rebases),changed
parts=json.loads((base/'src/build-manifest.json').read_text())['parts'];assert len(parts)==98
for part in parts:assert (out/'src'/part['file']).is_file()
for rel,origin in production.items():assert (out/rel).read_bytes()==(origin/rel).read_bytes()
write(e/'SOURCE-PRESERVATION.json',{'productionAllowlist':list(production),'productionOrigins':{p:{'root':str(origin),'sha256':sha(origin/p),'byteIdentical':True}for p,origin in production.items()},'changedExistingSourceToolFiles':changed,'unchangedExistingSourceToolFiles':unchanged,'unchangedCount':len(unchanged),'manifestPartCount':len(parts),'buildManifestUnchanged':True,'buildOverlayUnchanged':True,'newShippingExportsAdded':False,'note':'Exact disjoint reviewed production fragments copied, not reimplemented. Existing shipping export fragments are byte-identical to the base.'})
for filename,paths in [('PRODUCTION.patch',list(production)),('TEST-REFERENCE-REBASE.patch',test_rebases)]:
 patch=''.join(''.join(difflib.unified_diff((base/p).read_text().splitlines(True),(out/p).read_text().splitlines(True),fromfile='immutable-base/'+p,tofile='composed/'+p))for p in paths)
 (e/filename).write_text(patch)
write(e/'TEST-REBASE.json',{'files':test_rebases,'reference':str(base),'scope':'Byte-for-byte coalescence-reviewed path-only substitutions. Admission used equivalent absolute-path expressions; both resolve the same restored base. Assertions unchanged. No claim of a new comparison with the unavailable historical dispatch-repair artifact.'})
write(e/'ORIGIN.json',{'status':'UNADOPTED_COMPOSITION_PENDING_VERIFICATION_AND_REVIEW','base':str(base),'admission':str(a),'coalescence':str(b),'adoptionUnchanged':'oldrepair-fallback-r1','noOriginal97OrBenchmark':True,'missingHistoricalMetadata':'Original cap-reference location and historical CANDIDATE.json/PRODUCT-SUPPORT-FREEZE.json remain missing; no substitute freeze or evidence invented.'})
print(json.dumps({'candidate':str(out),'inputFileCounts':{k:len(v)for k,v in json.loads((e/'INPUT-MANIFESTS.json').read_text())['files'].items()},'productionFiles':list(production),'unchangedSourceToolFiles':len(unchanged)},indent=2))
