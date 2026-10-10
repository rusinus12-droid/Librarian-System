#!/usr/bin/env python3
"""Restore the packaged reference into NEW directories; never edits the input package."""
from pathlib import Path,PurePosixPath
import argparse,hashlib,json,os,shutil,stat,subprocess,sys

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def safe(root,rel):
 p=PurePosixPath(rel)
 if p.is_absolute() or '\\' in rel or ':' in rel or not p.parts or any(x in ('','..','.') for x in p.parts):raise ValueError('Unsafe path: '+rel)
 q=root.joinpath(*p.parts)
 if not q.resolve().is_relative_to(root.resolve()):raise ValueError('Escaping path: '+rel)
 return q
def files(root):
 out={}
 for p in sorted(root.rglob('*')):
  if p.is_symlink():raise ValueError('Symlink not allowed: '+str(p))
  if p.is_file():out[p.relative_to(root).as_posix()]=p
 return out
def verify(p,row):
 if not p.is_file() or p.stat().st_size!=row['bytes'] or sha(p)!=row['sha256']:raise ValueError('Byte identity mismatch: '+str(p))
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--package-root',required=True);ap.add_argument('--output-dir',required=True);ap.add_argument('--quarantine-dir',required=True);a=ap.parse_args();src=Path(a.package_root).resolve();out=Path(a.output_dir).resolve();quar=Path(a.quarantine_dir).resolve();bundle=src/'PROGRAM/docs/development-package/reference-restore';plan=json.loads((bundle/'REFERENCE-RESTORE-PLAN.json').read_text())
 if out.exists() or quar.exists():raise ValueError('Output and quarantine must both be new directories')
 if any(x.is_relative_to(y) for x,y in [(out,src),(quar,src),(out,quar),(quar,out)]):raise ValueError('Directories must not contain one another')
 if not out.parent.is_dir() or not quar.parent.is_dir():raise ValueError('Output parents must already exist')
 actual=files(src);checks={}
 for line in (src/'SHA256SUMS.txt').read_text().splitlines():
  h,sep,rel=line.partition('  ./')
  if not sep or len(h)!=64 or rel in checks:raise ValueError('Invalid checksum row')
  p=safe(src,rel)
  if sha(p)!=h:raise ValueError('Package checksum mismatch: '+rel)
  checks[rel]=h
 if set(checks)!=set(actual)-{'SHA256SUMS.txt'}:raise ValueError('Incomplete package checksum inventory')
 for row in plan['candidateSourceFiles']:
  if row['path'] not in plan['builderGeneratedMetadataPaths']:verify(safe(src,row['path']),row)
 patch=bundle/'candidate-to-reference.patch';verify(patch,plan['patch'])
 for row in plan['referencePreimages']:verify(safe(bundle,row['object']),row)
 shutil.copytree(src,out);quar.mkdir()
 # Keep the candidate metadata and all candidate-only files; never delete originals.
 def quarantine(rel,group):
  p=safe(out,rel)
  if p.exists():q=safe(quar,group+'/'+rel);q.parent.mkdir(parents=True,exist_ok=True);shutil.move(str(p),str(q))
 for rel in plan['builderGeneratedMetadataPaths']:quarantine(rel,'candidate-metadata')
 env=dict(os.environ)
 for k in ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE']:env.pop(k,None)
 env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_SYSTEM=os.devnull,GIT_CEILING_DIRECTORIES=str(out.parent))
 commands=[]
 for args in [['git','apply','--check',str(patch)],['git','apply',str(patch)]]:
  r=subprocess.run(args,cwd=out,env=env,capture_output=True,text=True);commands.append({'argv':args[:-1]+['packaged candidate-to-reference.patch'],'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
  if r.returncode:raise ValueError('Packaged reverse patch failed: '+r.stderr)
 for row in plan['candidateOnlyFiles']:
  verify(safe(out,row['path']),row);quarantine(row['path'],'candidate-only')
 for row in plan['referencePreimages']:
  p=safe(out,row['path']);p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(safe(bundle,row['object']),p)
 # Keep the candidate-specific provenance separate from the restored reference.
 quarantine('PROGRAM/docs/development-package','candidate-provenance')
 expected={x['path']:x for x in plan['referenceSourceFiles']}
 for rel,row in expected.items():verify(safe(out,rel),row);os.chmod(safe(out,rel),row['mode'])
 retained_scaffold={k for k in actual if k.startswith('DATA/')}
 if set(files(out))!=set(expected)|retained_scaffold:raise ValueError('Reference path closure mismatch')
 for rel,row in expected.items():
  if stat.S_IMODE(safe(out,rel).stat().st_mode)!=row['mode']:raise ValueError('Exact-reference mode mismatch: '+rel)
 exact={'schema':'librarian.exact-reference-source-verification.v1','referenceCommit':plan['referenceCommit'],'candidateSourceId':plan['candidateSourceId'],'status':'EXACT_REQUIRED_REFERENCE_SOURCE_VERIFIED_BEFORE_REGENERATION','referenceFiles':len(expected),'allExpectedBytesPathsModesVerified':True,'retainedCleanDataScaffoldFiles':len(retained_scaffold),'sourceScope':plan['sourceScope'],'historicalTreeComplete':False,'integrityMetadataRegeneratedYet':False,'noGitRepositoryOrOldZipUsed':True,'productTestsRun':False}
 (quar/'EXACT-REFERENCE-BEFORE-REGENERATION.json').write_text(json.dumps(exact,indent=2)+'\n')
 # Preserve exact historical metadata, then regenerate only the two integrity inventories.
 for rel in ['PROGRAM/program-manifest.json','SHA256SUMS.txt']:
  p=safe(out,rel);q=safe(quar,'historical-reference-metadata/'+rel);q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)
 manifest=json.loads((out/'PROGRAM/program-manifest.json').read_text());manifest['qualification']={'status':'offline_candidate','referenceRestore':'SOURCE_BYTES_RESTORED_NOT_RELEASE_QUALIFIED','referenceCommit':plan['referenceCommit'],'publicationGate':'NOT_RUN','actualHost':'NOT_RUN','updaterEligible':False,'publicationReady':False,'referenceSafetyLimits':plan.get('referenceSafetyLimits',[])};manifest['files']={rel:{'sha256':sha(p),'bytes':p.stat().st_size} for rel,p in files(out/'PROGRAM').items() if rel!='program-manifest.json'};(out/'PROGRAM/program-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
 sums=[sha(p)+'  ./'+rel for rel,p in files(out).items() if rel!='SHA256SUMS.txt'];(out/'SHA256SUMS.txt').write_text('\n'.join(sums)+'\n')
 for rel,row in expected.items():
  if rel not in ['PROGRAM/program-manifest.json','SHA256SUMS.txt']:verify(safe(out,rel),row)
  if stat.S_IMODE(safe(out,rel).stat().st_mode)!=row['mode']:raise ValueError('Reference mode mismatch: '+rel)
 report={'schema':'librarian.standalone-reference-restore.v1','referenceCommit':plan['referenceCommit'],'candidateSourceId':plan['candidateSourceId'],'status':'DERIVED_USABLE_REFERENCE_EXPORT_VERIFIED','exactBeforeRegenerationReceipt':'EXACT-REFERENCE-BEFORE-REGENERATION.json','referenceSourceFiles':len(expected),'exactSourceFilesAfterIntegrityRegeneration':len(expected)-2,'regeneratedMetadata':['PROGRAM/program-manifest.json','SHA256SUMS.txt'],'historicalMetadataPreservedInQuarantine':True,'candidateOnlyFilesPreserved':len(plan['candidateOnlyFiles']),'sourceModes':'Exact reference Git regular-file/executable modes','noGitRepositoryOrOldZipUsed':True,'gitCommands':commands,'productTestsRun':False,'releaseQualification':False,'referenceSafetyLimits':plan.get('referenceSafetyLimits',[]),'outputRoot':str(out),'quarantineRoot':str(quar)};(quar/'REFERENCE-RESTORE-RESULT.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
