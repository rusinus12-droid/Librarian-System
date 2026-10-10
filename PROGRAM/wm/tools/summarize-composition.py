from pathlib import Path
import hashlib,json,re
r=Path(__file__).resolve().parent.parent;e=r/'evidence';inputs=json.loads((e/'INPUT-MANIFESTS.json').read_text());component=Path(inputs['roots']['coalescence']);records=[]
def exit0(name):assert (e/(name+'.exit')).read_text().strip()=='0',name
def pin(p):return {'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size}
exit0('RUN-SUMMARY');exit0('COMPOSED-BUILD')
for flavor in ['Full','Min']:
 groups={}
 for name,expected in [('ADMISSION',30),('COALESCENCE',13),('CRITICAL',70)]:
  exit0(name+'-'+flavor);log=e/(name+'-'+flavor+'.log');text=log.read_text();totals={k:int(re.search(r'^.*?'+k+r' (\d+)\s*$',text,re.M)[1])for k in ['tests','pass','fail','cancelled','skipped','todo']};assert totals=={'tests':expected,'pass':expected,'fail':0,'cancelled':0,'skipped':0,'todo':0},totals
  groups[name.lower()]={**totals,'leafCases':29 if name=='ADMISSION'else expected,'exit':0,'log':pin(log)}
 critical=(e/('CRITICAL-'+flavor+'.log')).read_text();hooks=[json.loads(x)for x in re.findall(r'EXACT_HOOK_PARITY (\{.*\})',critical)];orders=[json.loads(x)for x in re.findall(r'ORDER_PARITY (\{.*\})',critical)];assert len(hooks)==3 and len(orders)==2
 assert {h['outputSha256']for h in hooks}=={'6f3f7a7c03aef1c43a497d910524d6f24fb30aaf67adbd8a0d58b05dc1115056'}
 for suffix in ['HEAP-'+flavor,'HEAP-ASSERT-'+flavor]:exit0(suffix)
 folder=e/('HEAP-COMPOSED-'+flavor);structure=json.loads((folder/'RAW-BACKING-STRUCTURE.json').read_text());rows={x['label']:x for x in structure['rows']};assert rows['baseline_post']['rootNode']==rows['readonly_raw']['rootNode'];assert rows['baseline_before']['rootNode']!=rows['readonly_raw']['rootNode'];pair=next(x for x in structure['equalityGroups']if set(x['members'])=={'baseline_post','readonly_raw'});assert pair['backingSelfBytesUnion']==1136696
 parity=json.loads((folder/'READ-PARITY.json').read_text());assert parity==json.loads((component/'evidence'/('HEAP-GREEN-'+flavor)/'READ-PARITY.json').read_text());assert parity['physicalReads']==3 and parity['parses']==1
 records.append({'flavor':flavor,'groups':groups,'hookParity':hooks,'callbackOrderParity':orders,'heap':{'sharedPostReadRoot':True,'beforeRawSeparate':True,'pairBackingSelfBytesUnion':pair['backingSelfBytesUnion'],'readParity':parity,'scope':'Synthetic 568340-character two-byte canonical value through actual shipped paths. Structural aliasing only; no total-process memory or latency acceptance.'}})
for log in e.rglob('*.log'):assert 'FINAL_DELIVERY_BLOCKED_TRANSPORTS'not in log.read_text(errors='replace'),log
summary={'status':'UNADOPTED_COMPOSITION_SCOPED_VERIFICATION_PASS_PENDING_INDEPENDENT_COMPOSITION_REVIEW','artifacts':json.loads((e/'ARTIFACT-COMPOSITION.json').read_text())['artifacts'],'checks':records,'countsNote':'Each artifact has 70 existing cases + 29 admission leaf cases + 13 coalescence cases = 112 leaf cases, 113 Node-reported tests including the admission parent. The 52 shared critical cases are counted once inside 70, not added again. Full and Min repeat the same case set; this is not 224 independent scenarios. Reviewer-only supplemental 7/3/4 controls from the component reviews were not rerun here.','baseFreshRedRerun':False,'baseRedEvidence':'Component causal RED logs remain pinned; this composition did not repeat them.','adoption':'unchanged oldrepair-fallback-r1','original97Run':False,'latencyAcceptance':False,'totalHeapAcceptance':False,'rawHeapIncluded':False,'externalModelsOrNetworkUsed':False,'noBlockedTransportLogged':True}
(r/'RESULTS.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({'status':summary['status'],'artifacts':summary['artifacts'],'countsNote':summary['countsNote']},indent=2))
