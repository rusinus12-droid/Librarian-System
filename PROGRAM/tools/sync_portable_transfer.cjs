'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),sdk=fs.readFileSync(path.join(root,'sdk/MemorySuitePortableTransfer.source.js'),'utf8').trimEnd(),file=path.join(root,'plugins/RETRACE.js'),s=fs.readFileSync(file,'utf8');
const re=/\/\* LIBRARIAN PORTABLE TRANSFER SDK v[\s\S]*?\/\* END LIBRARIAN PORTABLE TRANSFER SDK \*\//;
const next=re.test(s)?s.replace(re,sdk):s.replace('/* LIBRARIAN SYSTEM STORAGE SDK v',sdk+'\n\n/* LIBRARIAN SYSTEM STORAGE SDK v');
if((next.split(sdk).length-1)!==1)throw Error('portable_transfer_embed_ambiguous');
if(process.argv.includes('--check')){if(next!==s)throw Error('portable_transfer_embed_diverged');}else fs.writeFileSync(file,next);
console.log('RETRACE portable transfer SDK '+(process.argv.includes('--check')?'verified':'synchronized'));
