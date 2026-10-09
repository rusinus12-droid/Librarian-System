const fs=require('node:fs'),path=require('node:path');
const create=require('./recall_keyword_features.cjs');
const check=process.argv.includes('--check');
const block=`  // BEGIN RECALL KEYWORD FEATURES\n  const RecallKeywordFeatures = (${create.toString()})();\n  // END RECALL KEYWORD FEATURES\n\n`;
for(const name of ['HAYAKU_Locator_Continuity.js','Flashback_Memory.js']){
 const p=path.join(__dirname,'../plugins',name);let src=fs.readFileSync(p,'utf8');const before=src;
 const marker=name.startsWith('HAYAKU')?'  const cleanSearchText = value =>':'  const normalizeForLexical = (value) =>';
 if(src.includes('// BEGIN RECALL KEYWORD FEATURES')){
   const start=src.indexOf('  // BEGIN RECALL KEYWORD FEATURES'),end=src.indexOf(marker,start);
   if(end<start)throw Error(marker);src=src.slice(0,start)+block+src.slice(end);
 } else {if(!src.includes(marker))throw Error(marker);src=src.replace(marker,()=>block+marker);}
 if(check){if(src!==before)throw Error('recall helper synchronization mismatch: '+name);}
 else if(src!==before){const temp=p+'.sync.tmp';fs.writeFileSync(temp,src);fs.renameSync(temp,p);}
}
console.log(check?'Recall helper embeddings match.':'Recall helper embeddings synchronized.');
