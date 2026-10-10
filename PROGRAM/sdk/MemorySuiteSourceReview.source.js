/* LIBRARIAN SYSTEM SOURCE REVIEW v1.0.0 START
 * Own-iframe diff and immutable, owner-scoped approved-input evidence.
 * Never writes chat messages, calls a model, or grants another owner's consent.
 */
function memorySuiteReviewFingerprint(value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  let a = 2166136261, b = 2246822507;
  for (let i=0;i<body.length;i++) { const c=body.charCodeAt(i); a=Math.imul(a^c,16777619); b=Math.imul(b^c,3266489909); }
  return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0')+':'+body.length;
}
function createMemorySuiteSourceEvidence(config) {
  'use strict';
  const SCHEMA='memory-suite.source-evidence.v1', REF='memory-suite.source-evidence-ref.v1';
  const flights=new Map(), copy=v=>JSON.parse(JSON.stringify(v));
  const owner=String(config.owner||'');
  if(!owner || typeof config.read!=='function'||typeof config.write!=='function'||typeof config.keyPrefix!=='function')throw Error('SOURCE_EVIDENCE_CONFIG_INVALID');
  const binding=(scope,u,original=false)=>({owner,scopeKey:String(scope||''),unitKey:String(u.key||''),start:Number(u.start),end:Number(u.end||u.start),identity:String(u.identity||''),sourceDigest:String(original?u.originalDigest:u.sourceDigest||u.digest||'')});
  const validBinding=b=>b.scopeKey && b.unitKey && b.identity && b.sourceDigest && Number.isInteger(b.start)&&b.start>0&&Number.isInteger(b.end)&&b.end>=b.start;
  const storageKey=b=>config.keyPrefix(b.scopeKey)+memorySuiteReviewFingerprint([b.owner,b.scopeKey,b.unitKey,b.identity,b.sourceDigest]);
  const refFor=(key,record)=>({schema:REF,owner,scopeKey:record.binding.scopeKey,key,payloadDigest:record.payloadDigest,sourceDigest:record.binding.sourceDigest,identity:record.binding.identity,normalizationVersion:record.normalizationVersion});
  function normalizeRows(rows,b) {
    if(!Array.isArray(rows)||rows.length!==b.end-b.start+1)throw Error('SOURCE_EVIDENCE_RANGE_INCOMPLETE');
    return rows.map((r,i)=>{
      if(Number(r.turn)!==b.start+i || typeof r.userText!=='string'||typeof r.assistantText!=='string'||!r.userMessageId||!r.assistantMessageId)throw Error('SOURCE_EVIDENCE_PAIR_INVALID');
      return {turn:b.start+i,userMessageId:String(r.userMessageId),assistantMessageId:String(r.assistantMessageId),userText:r.userText,assistantText:r.assistantText,
        userRaw:typeof r.userRaw==='string'?r.userRaw:r.userText,assistantRaw:typeof r.assistantRaw==='string'?r.assistantRaw:r.assistantText,
        rawAvailable:r.rawAvailable===true,projectionLabel:String(r.projectionLabel||'플러그인이 비교하는 전체 U+A 본문')};
    });
  }
  const payloadFor=record=>JSON.stringify({binding:record.binding,normalizationVersion:record.normalizationVersion,rows:record.rows});
  function inspect(raw,b) {
    if(raw==null||raw==='')return null;
    let record;try{record=typeof raw==='string'?JSON.parse(raw):copy(raw);}catch(_){throw Error('SOURCE_EVIDENCE_JSON_INVALID');}
    if(record.schema!==SCHEMA||JSON.stringify(record.binding)!==JSON.stringify(b)||typeof record.normalizationVersion!=='string')throw Error('SOURCE_EVIDENCE_BINDING_MISMATCH');
    normalizeRows(record.rows,b);
    if(record.payloadDigest!==memorySuiteReviewFingerprint(payloadFor(record)))throw Error('SOURCE_EVIDENCE_DIGEST_MISMATCH');
    return record;
  }
  async function get(scope,u,options={}) {
    const b=binding(scope,u,options.original!==false);
    if(!validBinding(b))throw Error('SOURCE_EVIDENCE_BINDING_INVALID');
    const key=storageKey(b),record=inspect(await config.read(key),b);
    if(!record)return {available:false,reason:'previous_source_unavailable',binding:b};
    return {available:true,rows:copy(record.rows),ref:refFor(key,record),binding:copy(b)};
  }
  async function put(scope,u,rows,options={}) {
    const b=binding(scope,u,false);if(!validBinding(b))throw Error('SOURCE_EVIDENCE_BINDING_INVALID');
    const safeRows=normalizeRows(rows,b),key=storageKey(b);
    const prev=flights.get(key)||Promise.resolve();
    const work=prev.catch(()=>{}).then(async()=>{
      const existing=inspect(await config.read(key),b);
      if(existing){
        // Cosmetic carriers can change raw bytes without changing approved input.
        // Keep the first captured raw copy, but reject an actual digest collision.
        const comparable=rs=>rs.map(r=>[r.turn,r.userMessageId,r.assistantMessageId,r.userText,r.assistantText]);
        if(JSON.stringify(comparable(existing.rows))!==JSON.stringify(comparable(safeRows)))throw Error('SOURCE_EVIDENCE_KEY_COLLISION');
        return refFor(key,existing);
      }
      const record={schema:SCHEMA,binding:b,normalizationVersion:String(options.normalizationVersion||'owner-comparison.v1'),rows:safeRows};
      record.payloadDigest=memorySuiteReviewFingerprint(payloadFor(record));
      const serialized=JSON.stringify(record);
      if(serialized.length>Number(config.maxChars||8*1024*1024))throw Error('SOURCE_EVIDENCE_CAPACITY_EXCEEDED');
      if(await config.write(key,serialized)===false)throw Error('SOURCE_EVIDENCE_WRITE_REJECTED');
      const readback=await config.read(key),actual=typeof readback==='string'?readback:JSON.stringify(readback);
      if(actual!==serialized)throw Error('SOURCE_EVIDENCE_READBACK_FAILED');
      return refFor(key,inspect(readback,b));
    });
    flights.set(key,work);try{return await work;}finally{if(flights.get(key)===work)flights.delete(key);}
  }
  return Object.freeze({get,put});
}
function memorySuiteSourceDiff(before,after) {
  // Linear-time changed span; no quadratic LCS or model call on a long message.
  // Slice only at Unicode scalar boundaries, not between surrogate pairs.
  const a=String(before??''),b=String(after??'');let left=0,right=0;
  while(left<a.length&&left<b.length&&a.charCodeAt(left)===b.charCodeAt(left))left++;
  if(left>0 && /[\uDC00-\uDFFF]/.test(a[left]||b[left]||''))left--;
  while(right<a.length-left&&right<b.length-left&&a.charCodeAt(a.length-1-right)===b.charCodeAt(b.length-1-right))right++;
  if(right>0 && /[\uDC00-\uDFFF]/.test(a[a.length-right]||b[b.length-right]||''))right--;
  return {before:[a.slice(0,left),a.slice(left,a.length-right),right?a.slice(-right):''],after:[b.slice(0,left),b.slice(left,b.length-right),right?b.slice(-right):''],removed:a.length-left-right,added:b.length-left-right};
}
/* LIBRARIAN SYSTEM SOURCE REVIEW v1.0.0 END */
