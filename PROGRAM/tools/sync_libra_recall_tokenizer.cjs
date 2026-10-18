'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),factory=require('./libra_recall_tokenizer.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const factorySource=factory.toString();
const descriptor='libra/recall-bm25f/v3:tokenizer-sha256:'+hash(factorySource)+':fields-v1:weights-v1:length-norm-v1:k1-1.2:evidence-strong-word-cjk-exp1:stable-input-position';
const fingerprint=hash(descriptor),check=process.argv.includes('--check');
for(const [file,indent,name] of [['plugins/LIBRA.js','    ','tokenStream'],['tests/fixtures/retired_compute_reference_kernels.cjs','','libraTokenStream']]){
 const target=path.join(root,file),before=fs.readFileSync(target,'utf8');
 const block=`${indent}// BEGIN LIBRA RECALL TOKENIZER\n${indent}const ${name} = (${factorySource})();\n${indent}// END LIBRA RECALL TOKENIZER`;
 let after=before.replace(/^[ \t]*\/\/ BEGIN LIBRA RECALL TOKENIZER[\s\S]*?^[ \t]*\/\/ END LIBRA RECALL TOKENIZER/m,()=>block);
 if(file.startsWith('plugins'))after=after.replace(/const LIBRA_RECALL_BM25F_COMPUTE_FINGERPRINT = '[a-f0-9]+';/,`const LIBRA_RECALL_BM25F_COMPUTE_FINGERPRINT = '${fingerprint}';`);
 else after=after.replace(/fingerprint: descriptorFingerprint\('libra\/recall-bm25f\/[^']+'\)/,`fingerprint: descriptorFingerprint('${descriptor}')`);
 if(!after.includes(block)||!after.includes(file.startsWith('plugins')?fingerprint:descriptor))throw Error('tokenizer markers missing: '+file);
 if(check){if(after!==before)throw Error('tokenizer synchronization mismatch: '+file);}
 else if(after!==before){const temp=target+'.sync.tmp';fs.writeFileSync(temp,after);fs.renameSync(temp,target);}
}
console.log(JSON.stringify({tokenizer:hash(factorySource),fingerprint,checked:check}));
