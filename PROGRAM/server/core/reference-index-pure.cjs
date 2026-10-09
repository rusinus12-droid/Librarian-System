"use strict";
// Preserved pure ranking helpers. No storage discovery, credentials, sockets,
// workers, environment configuration or implicit data authority are allowed here.
const TOKEN_RE = /[\p{L}\p{N}_'-]+/gu;
function normalize(s) { return String(s ?? "").normalize("NFC").toLowerCase().replace(/\s+/gu," ").trim(); }
function tokenize(s) {
  const n = normalize(s); const out=[];
  for (const m of n.matchAll(TOKEN_RE)) out.push(m[0]);
  const chars=[...n.replace(/\s+/gu,"")];
  for(let i=0;i+1<chars.length;i++) out.push(chars[i]+chars[i+1]);
  if(chars.length<=96) for(let i=0;i+2<chars.length;i++) out.push(chars[i]+chars[i+1]+chars[i+2]);
  return [...new Set(out)].slice(0,4096);
}
function tokenCounts(s){ const m=new Map(); for(const t of tokenize(s)) m.set(t,(m.get(t)||0)+1); return m; }
function overlap(q, doc){ let n=0; for(const [t,c] of q){ const d=doc.get(t)||0; if(d) n += Math.min(c,d); } return n; }
function clamp(n,a,b){ return Math.max(a,Math.min(b,n)); }
function recencyValue(v){
  const candidates=[v?.updatedAt,v?.createdAt,v?.timestamp,v?.turnEnd,v?.endTurn,v?.turn,v?.index];
  for(const x of candidates){ const n=Number(x); if(Number.isFinite(n)) return n; }
  return 0;
}
function isObj(v){ return !!v && typeof v === "object" && !Array.isArray(v); }
function textify(v, depth=0){
  if(depth>8 || v==null) return "";
  if(typeof v === "string") return v;
  if(typeof v === "number" || typeof v === "boolean") return String(v);
  if(Array.isArray(v)) return v.slice(0,2048).map(x=>textify(x,depth+1)).filter(Boolean).join("\n");
  if(isObj(v)) return Object.entries(v).filter(([k])=>!/(vector|embedding|digest|hash|signature|raw_html|blob)/i.test(k)).slice(0,512).map(([k,x])=>`${k}: ${textify(x,depth+1)}`).filter(x=>x.length>2).join("\n");
  return "";
}
function packetMarkerScore(v){
  if(!isObj(v)) return 0; let s=0;
  const keys=new Set(Object.keys(v).map(x=>x.toLowerCase()));
  for(const k of ["hayaku_packet_v1","packet_schema_rev","hidden_packet_ledger_v2","summary_memory","speaker_boundaries","pattern_guard","overpromotion_risks"]) if(keys.has(k)) s+=3;
  for(const k of ["summary","entity","entities","world","narrative","planner","identity","canonical","association","locator"]) if(keys.has(k)) s+=1;
  if(typeof v.packet_schema_rev === "number") s+=2;
  return s;
}
function packetId(v, fallback){
  for(const k of ["id","packetId","packet_id","recordId","record_id","chunkId","chunk_id","key","rangeId","range_id"]){ const x=v?.[k]; if(typeof x==="string"&&x) return x; if(typeof x==="number") return String(x); }
  const a=v?.turnStart??v?.startTurn??v?.start, b=v?.turnEnd??v?.endTurn??v?.end;
  if(a!=null||b!=null) return `T${a??"?"}-T${b??"?"}`;
  return fallback;
}
function collectPackets(root, sourceKey, out, seen, pathParts=[], depth=0){
  if(depth>12 || root==null) return;
  if(typeof root !== "object") return;
  if(seen.has(root)) return; seen.add(root);
  if(isObj(root) && packetMarkerScore(root)>=4){
    const id=packetId(root,`${sourceKey}#${pathParts.join("/")||"root"}`);
    if(!out.has(id)) out.set(id,{id,sourceKey,packet:root,recency:recencyValue(root)});
  }
  if(Array.isArray(root)){
    for(let i=0;i<Math.min(root.length,100000);i++) collectPackets(root[i],sourceKey,out,seen,[...pathParts,String(i)],depth+1);
  }else{
    for(const [k,v] of Object.entries(root)){
      if(/^(vectors?|embeddings?|dense|binary|blob)$/i.test(k)) continue;
      collectPackets(v,sourceKey,out,seen,[...pathParts,k],depth+1);
    }
  }
}
function fieldsForPacket(p){
  const v=p.packet||{};
  const pick=(...ks)=>ks.map(k=>textify(v[k])).filter(Boolean).join("\n");
  return {
    identity: pick("identity","speaker_boundaries","characters","character","persons","entity","entities"),
    canonical: pick("canonical","summary","summary_memory","memory","facts","continuity"),
    association: pick("association","relations","relationships","links","entity","entities"),
    locator: pick("locator","location","locations","world","timeline","time","scene"),
    narrative: pick("narrative","plot","events","arc","planner"),
    full: textify(v)
  };
}
function buildHayakuIndex(packets){
  const docs=[];
  for(const p of packets.values()){
    const fields=fieldsForPacket(p), counts={};
    for(const [k,v] of Object.entries(fields)) counts[k]=tokenCounts(v);
    docs.push({...p,fields,counts});
  }
  docs.sort((a,b)=>a.id.localeCompare(b.id));
  return docs;
}
function rankBy(docs, scoreFn){
  return docs.map(d=>({d,score:scoreFn(d)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||b.d.recency-a.d.recency||a.d.id.localeCompare(b.d.id));
}
function hayakuSearch(docs, query, topK=12){
  const q=tokenCounts(query); const weights={identity:2.8,canonical:2.4,association:1.9,locator:1.6,narrative:1.25,full:0.45};
  const lists={};
  for(const k of Object.keys(weights)) lists[k]=rankBy(docs,d=>overlap(q,d.counts[k])*weights[k]);
  const recent=[...docs].sort((a,b)=>b.recency-a.recency||a.id.localeCompare(b.id));
  const fused=new Map(); const k0=60;
  for(const [name,list] of Object.entries(lists)){
    for(let i=0;i<list.length;i++){
      const x=list[i], cur=fused.get(x.d.id)||{doc:x.d,rrf:0,signals:{}};
      cur.rrf += weights[name]/(k0+i+1); cur.signals[name]=x.score; fused.set(x.d.id,cur);
    }
  }
  for(let i=0;i<Math.min(recent.length,256);i++){
    const d=recent[i],cur=fused.get(d.id)||{doc:d,rrf:0,signals:{}};
    cur.rrf += .35/(k0+i+1); cur.signals.recency=i+1; fused.set(d.id,cur);
  }
  const arr=[...fused.values()].sort((a,b)=>b.rrf-a.rrf||b.doc.recency-a.doc.recency||a.doc.id.localeCompare(b.doc.id)).slice(0,clamp(Number(topK)||12,1,64));
  return arr.map((x,i)=>({id:x.doc.id,score:x.rrf,rank:i+1,signals:x.signals,packet:x.doc.packet,sourceKey:x.doc.sourceKey}));
}

module.exports=Object.freeze({tokenize,collectPackets,buildHayakuIndex,hayakuSearch,fieldsForPacket});
