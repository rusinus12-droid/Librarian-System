#!/usr/bin/env python3
"""Restore captured original source from a builder package, without modifying it."""
import argparse,hashlib,json,os,pathlib,shutil,stat
CAPSULE='PROGRAM/docs/regression-checkpoints/20261010T1700Z'
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
def safe(s):
 p=pathlib.PurePosixPath(s)
 if not s or p.is_absolute() or '..' in p.parts or '\\' in s or ':' in s or str(p)!=s:raise ValueError('unsafe relative path')
 return p
p=argparse.ArgumentParser();p.add_argument('--package-root',required=True);p.add_argument('--output',required=True);a=p.parse_args()
root=pathlib.Path(a.package_root).resolve(strict=True);cap=root/CAPSULE
manifest=json.loads((cap/'ACTIVE-SOURCE-MANIFEST.json').read_text());mapping=json.loads((cap/'SOURCE-PRESERVATION-MAP.json').read_text())
assert mapping['manifestSha256']==sha(cap/'ACTIVE-SOURCE-MANIFEST.json')
out=pathlib.Path(a.output).absolute()
assert out.parent.resolve(strict=True)==out.parent and not out.exists() and not out.is_relative_to(root) and not root.is_relative_to(out)
rows=manifest['tree'];assert mapping['sourceFiles']==sum(r['kind']=='file'for r in rows.values())
size=sum(r.get('bytes',0)for r in rows.values());assert shutil.disk_usage(out.parent).free>=size+5*1024**3
sources={}
for rel,row in rows.items():
 safe(rel);assert row['kind']in('file','dir') and 0<=row['mode']<=0o777
 if row['kind']!='file':continue
 src=root/safe(mapping['overrides'].get(rel,rel))
 assert src.resolve(strict=True)==src and src.is_file() and not src.is_symlink()
 assert src.stat().st_size==row['bytes'] and sha(src)==row['sha256'];sources[rel]=src
out.mkdir(mode=0o700)
for rel,row in rows.items():
 if row['kind']=='dir':(out/rel).mkdir(parents=True,exist_ok=True)
for rel,src in sources.items():
 dest=out/rel;dest.parent.mkdir(parents=True,exist_ok=True)
 with src.open('rb') as f,dest.open('xb')as g:shutil.copyfileobj(f,g)
 os.chmod(dest,rows[rel]['mode'])
for rel,row in sorted(rows.items(),key=lambda x:len(x[0]),reverse=True):
 if row['kind']=='dir':os.chmod(out/rel,row['mode'])
os.chmod(out,manifest['rootMode'])
actual={}
for target in sorted(out.rglob('*')):
 rel=str(target.relative_to(out));s=target.lstat();assert not target.is_symlink()
 if target.is_file():actual[rel]={'kind':'file','bytes':s.st_size,'mode':stat.S_IMODE(s.st_mode),'sha256':sha(target)}
 elif target.is_dir():actual[rel]={'kind':'dir','mode':stat.S_IMODE(s.st_mode)}
 else:raise ValueError('unexpected special restored entry')
assert actual==rows and stat.S_IMODE(out.stat().st_mode)==manifest['rootMode']
assert all(sha(src)==rows[rel]['sha256']for rel,src in sources.items())
print(json.dumps({'status':'verified','files':len(sources),'bytes':size,'pathHashBytesModesEqual':True,'sourcePackageUnchangedByOperation':True,'restoredRoot':str(out),'manifestSha256':sha(cap/'ACTIVE-SOURCE-MANIFEST.json')}))
