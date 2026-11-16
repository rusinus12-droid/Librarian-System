'use strict';
// One pure implementation is embedded in the owners and executed by server workers.
module.exports = function createMemorySuiteSearchKernel() {
  const terms = value => {
    const result=[];
    for(const word of String(value||'').normalize('NFKC').toLocaleLowerCase('und').match(/[\p{L}\p{N}_]+/gu)||[]){
      result.push('w:'+word); const letters=Array.from(word);
      for(let i=1;i<letters.length;i++)result.push('g:'+letters[i-1]+letters[i]);
    }
    return result;
  };
  return input => {
    const corpus=input?.corpus, queries=input?.queries;
    if(!corpus || !Array.isArray(queries) || queries.length>128)throw Error('search_input_invalid');
    if(input.kind==='vectors'){
      if(!Array.isArray(corpus.vectors)||corpus.vectors.length>20000)throw Error('search_vectors_invalid');
      let cost=0;
      const values=corpus.vectors.map(vector=>queries.map(query=>{
        if(!Array.isArray(vector)||!Array.isArray(query)||vector.length>16384||query.length>16384)throw Error('search_vector_invalid');
        if(!query.length||query.length!==vector.length)return 0;
        cost+=query.length;if(cost>2000000)throw Error('search_cost_limit');
        let dot=0,a=0,b=0;
        for(let i=0;i<query.length;i++){
          const x=Number(query[i]),y=Number(vector[i]);
          if(!Number.isFinite(x)||!Number.isFinite(y))return 0;
          dot+=x*y;a+=x*x;b+=y*y;
        }
        const denominator=input.owner==='libra'?Math.sqrt(a*b):Math.sqrt(a)*Math.sqrt(b);
        return a>0&&b>0?dot/denominator:0;
      }));
      return {kind:input.kind,values};
    }
    if(input.kind!=='lexical'||!Array.isArray(corpus.documents)||corpus.documents.length>20000)throw Error('search_corpus_invalid');
    const evidenceRanking=corpus.rankingPolicy==='hayaku.evidence-lexical.v1';
    if(corpus.rankingPolicy!=null&&!evidenceRanking)throw Error('search_ranking_policy_invalid');
    if(evidenceRanking&&input.owner!=='hayaku')throw Error('search_ranking_owner_invalid');
    const identityText = value => {
      const parts = [];
      for (const match of String(value || '').matchAll(/^(?:name|title|subject|speaker|owner|holder|location|place|scene|character|entity|target)\s*:\s*(.+)$/gimu)) {
        const lineValue = match[1].trim();
        if (lineValue) parts.push(lineValue);
      }
      return parts.join('\n');
    };
    let totalChars=0;
    const docs=corpus.documents.map((item,index)=>{
      if(typeof item.body!=='string'||typeof item.key!=='string')throw Error('search_document_invalid');
      totalChars+=item.body.length;if(totalChars>2000000)throw Error('search_text_limit');
      if(evidenceRanking&&(typeof item.evidenceBody!=='string'||!item.body.startsWith(item.evidenceBody)))throw Error('search_evidence_body_invalid');
      const tokens=terms(evidenceRanking?item.evidenceBody:item.body),evidenceTf=new Map();
      for(const t of tokens)evidenceTf.set(t,(evidenceTf.get(t)||0)+1);
      const tf=new Map(evidenceTf),identityTf=new Map(),aliasTf=new Map();
      let identityLength=0;
      if(evidenceRanking){
        const idText=identityText(item.evidenceBody),idTerms=idText?terms(idText):[];
        identityLength=idTerms.length;
        for(const t of idTerms)identityTf.set(t,(identityTf.get(t)||0)+1);
        const aliasSource=item.body.slice(item.evidenceBody.length);
        if(aliasSource){for(const term of terms(aliasSource))if(!evidenceTf.has(term)){aliasTf.set(term,1);tf.set(term,1);}}
        for(const [t,c] of identityTf)if(!tf.has(t))tf.set(t,c);
      }
      return {index,key:item.key,tf,evidenceTf,identityTf,aliasTf,length:tokens.length,identityLength,aliasLength:aliasTf.size};
    });
    const df=new Map();docs.forEach(doc=>doc.tf.forEach((_,term)=>df.set(term,(df.get(term)||0)+1)));
    const average=docs.reduce((sum,doc)=>sum+doc.length,0)/Math.max(1,docs.length);
    let identityTotal=0,identityCount=0,aliasTotal=0,aliasCount=0;
    if(evidenceRanking){
      for(const doc of docs){
        if(doc.identityLength>0){identityTotal+=doc.identityLength;identityCount++;}
        if(doc.aliasLength>0){aliasTotal+=doc.aliasLength;aliasCount++;}
      }
    }
    const identityAverage=identityCount?identityTotal/identityCount:1;
    const aliasAverage=aliasCount?aliasTotal/aliasCount:1;
    const bodyNorms=evidenceRanking?docs.map(doc=>.25+.75*doc.length/Math.max(1,average)):null;
    const identityNorms=evidenceRanking?docs.map(doc=>.70+.30*doc.identityLength/Math.max(1,identityAverage)):null;
    const aliasNorms=evidenceRanking?docs.map(doc=>.65+.35*doc.aliasLength/Math.max(1,aliasAverage)):null;
    const evidenceDf=new Map();
    if(evidenceRanking)docs.forEach(doc=>doc.evidenceTf.forEach((_,term)=>evidenceDf.set(term,(evidenceDf.get(term)||0)+1)));
    const information=docs.map(doc=>{
      if(!evidenceRanking)return 0;
      let sum=0,count=0;
      for(const term of doc.evidenceTf.keys()){
        if(!term.startsWith('w:')||/\p{N}/u.test(term))continue;
        const frequency=evidenceDf.get(term)||0;
        sum+=Math.log(1+(docs.length-frequency+.5)/(frequency+.5));count++;
      }
      return count?sum/count:0;
    });
    const rankings=queries.map(inputs=>{
      if(!Array.isArray(inputs)||inputs.length>128)throw Error('search_query_invalid');
      const best=new Map();
      for(const input of new Set(inputs.map(v=>String(v||'').trim()).filter(Boolean))){
        if(input.length>100000)throw Error('search_query_too_long');
        const query=[...new Set(terms(input))];
        const wordFrequencies=query.filter(term=>term.startsWith('w:')).map(term=>df.get(term)||0).filter(Boolean);
        const broadness=wordFrequencies.length?Math.min(...wordFrequencies)/Math.max(1,docs.length):0;
        const ranked=docs.map(doc=>{
          let score=0,wordScore=0;
          if(evidenceRanking){
            for(const term of query){
              const bodyTf=doc.evidenceTf.get(term)||0,idTf=doc.identityTf.get(term)||0,alTf=doc.aliasTf.get(term)||0;
              const weightedTf=(bodyTf?bodyTf/bodyNorms[doc.index]:0)+(idTf?1.5*(idTf/identityNorms[doc.index]):0)+(!bodyTf&&alTf?0.85*(alTf/aliasNorms[doc.index]):0);
              if(!(weightedTf>0))continue;
              const idf=Math.log(1+(docs.length-(df.get(term)||0)+.5)/((df.get(term)||0)+.5));
              const contribution=idf*(weightedTf*2.2)/(weightedTf+1.2);
              score+=contribution;if(term.startsWith('w:'))wordScore+=contribution;
            }
          }else{
            for(const term of query){const tf=doc.tf.get(term)||0;if(!tf)continue;
              const idf=Math.log(1+(docs.length-(df.get(term)||0)+.5)/((df.get(term)||0)+.5));
              const contribution=idf*(tf*2.2)/(tf+1.2*(.25+.75*doc.length/Math.max(1,average)));
              score+=contribution;if(term.startsWith('w:'))wordScore+=contribution;
            }
          }
          return {index:doc.index,key:doc.key,score,...(evidenceRanking?{lexical:wordScore*(1+broadness*information[doc.index])}:{})};
        }).filter(hit=>hit.score>0).sort((a,b)=>(evidenceRanking?b.lexical-a.lexical:0)||b.score-a.score||a.key.localeCompare(b.key));
        ranked.forEach((hit,index)=>{const rank=index+1;if(!best.has(hit.key)||best.get(hit.key).rank>rank)best.set(hit.key,{...hit,rank});});
      }
      return [...best.values()].sort((a,b)=>a.rank-b.rank||a.key.localeCompare(b.key));
    });
    return {kind:input.kind,rankings};
  };
};
