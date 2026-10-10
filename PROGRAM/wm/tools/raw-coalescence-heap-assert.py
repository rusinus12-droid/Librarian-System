from pathlib import Path
import json,re,sys
e=Path(sys.argv[1]);control=json.loads((e/'PRIVATE-SNAPSHOT-LOCATION.json').read_text());private=Path(control['snapshot']);assert str(private).startswith('/tmp/wm-private-heap-d09f18a13aaa/')
h=json.loads(private.read_text());meta=h['snapshot']['meta'];nf=meta['node_fields'];ef=meta['edge_fields'];nw=len(nf);ew=len(ef);ns=h['nodes'];es=h['edges'];ss=h['strings'];types=meta['node_types'][0];ets=meta['edge_types'][0];ni={k:nf.index(k)for k in ['type','name','self_size','edge_count']};ei={k:ef.index(k)for k in ['type','name_or_index','to_node']}
def typ(i):return types[ns[i*nw+ni['type']]]
def val(i):return ss[ns[i*nw+ni['name']]]
def sz(i):return ns[i*nw+ni['self_size']]
def name(e):
 t=ets[es[e*ew+ei['type']]]
 return ss[es[e*ew+ei['name_or_index']]]if t not in ['element','hidden']else''
def to(e):return es[e*ew+ei['to_node']]//nw
n=len(ns)//nw;starts=[0];off=0
for i in range(n):off+=ns[i*nw+ni['edge_count']];starts.append(off)
def props(i):return {name(e):to(e)for e in range(starts[i],starts[i+1])if ets[es[e*ew+ei['type']]]=='property'}
def backing(i):
 seen=set();stack=[i];leaves=[];links=[]
 while stack:
  v=stack.pop()
  if v in seen:continue
  seen.add(v);t=typ(v)
  if t=='string':leaves.append({'node':v,'selfBytes':sz(v)});continue
  for edge in range(starts[v],starts[v+1]):
   label=name(edge);dest=to(edge)
   if label in ['parent','first','second']and typ(dest)in ['string','sliced string','concatenated string']:
    links.append({'from':v,'fromType':t,'edge':label,'to':dest,'toType':typ(dest),'toSelfBytes':sz(dest)});stack.append(dest)
 return {'rootNode':i,'rootType':typ(i),'rootSelfBytes':sz(i),'backingLeaves':leaves,'backingSelfBytes':sum(x['selfBytes']for x in leaves),'links':links}
equality=json.loads((e/'RAW-EQUALITY.json').read_text());lengths={m['label']:g['logicalChars']for g in equality['groups']for m in g['members']}
rows=[]
for i in range(n):
 if typ(i)!='object':continue
 p=props(i)
 if not {'label','value','category'}.issubset(p):continue
 label=val(p['label'])
 if not re.fullmatch(r'baseline_before|baseline_post|readonly_raw|last_view_raw|storage_\d+',label):continue
 raw=p['value'];category=val(p['category']);assert category in ['owner','canonical_storage','other_storage']
 length=lengths[label];rows.append({'label':label,'category':category,'logicalChars':length,'logicalUtf16Bytes':2*length,'markerNode':i,**backing(raw)})
rows.sort(key=lambda x:x['label']);equality=json.loads((e/'RAW-EQUALITY.json').read_text());bylabel={r['label']:r for r in rows};groups=[]
for group in equality['groups']:
 labels=[x['label']for x in group['members']];members=[bylabel[l]for l in labels]
 roots={m['rootNode']for m in members};leafnodes={v['node']:v['selfBytes']for m in members for v in m['backingLeaves']}
 if len(members)>1 or any(m['category']=='owner'for m in members):groups.append({'group':group['group'],'members':labels,'logicalChars':group['logicalChars'],'exactValueEqual':True,'distinctRootNodes':sorted(roots),'distinctBackingLeafNodes':list(leafnodes),'backingSelfBytesUnion':sum(leafnodes.values())})
result={'privacy':'No string values or value hashes emitted. Labels are fixed diagnostic labels.','snapshotBeforeComparisons':True,'rows':rows,'equalityGroups':groups,'notes':['Backing sizes are reachable self-size, not exclusive dominator retained size.','Sliced siblings may share the same backing parent; do not sum their parent bytes repeatedly.']}
(e/'RAW-BACKING-STRUCTURE.json').write_text(json.dumps(result,indent=2)+'\n')
pair=[bylabel['baseline_post'],bylabel['readonly_raw']];shared=pair[0]['rootNode']==pair[1]['rootNode'];print(json.dumps({'sharedRoot':shared,'ownerRows':rows},indent=2));assert shared,'equal post/read-proof must share the actual backing root'
