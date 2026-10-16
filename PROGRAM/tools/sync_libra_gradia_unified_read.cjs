'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const factory=require('./libra_gradia_unified_read.cjs');
const begin='  /* LIBRA GRADIA UNIFIED READ START */',end='  /* LIBRA GRADIA UNIFIED READ END */';
const block=begin+'\n  const createLibraGradiaUnifiedRead = ('+factory.toString()+');\n'+end;
let changed=false;
for(const name of ['LIBRA.js','GRADIA.js']){
 const p=path.join(root,'plugins',name),before=fs.readFileSync(p,'utf8');
 const start=before.indexOf(begin),last=before.indexOf(end);
 let after;
 if(start<0){const anchor='  const publicApi = Object.freeze({';if(!before.includes(anchor))throw Error('unified_read_anchor_missing');after=before.replace(anchor,block+'\n'+anchor);}
 else{if(last<start)throw Error('unified_read_block_invalid');after=before.slice(0,start)+block+before.slice(last+end.length);}
 if(after!==before){changed=true;if(!process.argv.includes('--check'))fs.writeFileSync(p,after);}
}
if(changed&&process.argv.includes('--check'))throw Error('unified_read_embed_stale');
console.log(JSON.stringify({changed,checked:process.argv.includes('--check'),sha256:crypto.createHash('sha256').update(factory.toString()).digest('hex')}));
