'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),check=process.argv.includes('--check');
const sdk=fs.readFileSync(path.join(root,'sdk/MemorySuiteSourceReview.source.js'),'utf8').trimEnd();
for(const name of ['LIBRA.js','HAYAKU_Locator_Continuity.js','Flashback_Memory.js']){
 const file=path.join(root,'plugins',name),s=fs.readFileSync(file).toString('latin1');
 const embeddedSdk=Buffer.from(sdk,'utf8').toString('latin1');
 const a=s.indexOf('/* LIBRARIAN SYSTEM SOURCE REVIEW v'),b=s.indexOf('/* LIBRA SOURCE INPUT POLICY v1',a);
 if(a<0||b<a||s.indexOf('/* LIBRARIAN SYSTEM SOURCE REVIEW v',a+1)!==s.indexOf('/* LIBRARIAN SYSTEM SOURCE REVIEW v1.0.0 END */',a))throw Error('source_review_embed_ambiguous:'+name);
 if(s.slice(a,b).trimEnd()!==embeddedSdk){if(check)throw Error('source_review_embed_diverged:'+name);fs.writeFileSync(file,Buffer.from(s.slice(0,a)+embeddedSdk+'\n'+s.slice(b),'latin1'));}
 console.log(name+': source review '+(check?'verified':'synchronized'));
}
