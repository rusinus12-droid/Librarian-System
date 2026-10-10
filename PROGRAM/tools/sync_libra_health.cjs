'use strict';
const fs=require('node:fs'),path=require('node:path'),P=path.resolve(__dirname,'..'),f=path.join(P,'plugins/LIBRA.js'),moduleText=fs.readFileSync(path.join(P,'sdk/MemorySuiteLibraHealth.source.js'),'utf8').trim();
let s=fs.readFileSync(f,'utf8');const a=s.indexOf('/* LIBRA READ-ONLY SCOPE HEALTH v'),b=s.indexOf('/* END LIBRA READ-ONLY SCOPE HEALTH */',a);
const next=a>=0?s.slice(0,a)+moduleText+s.slice(b+'/* END LIBRA READ-ONLY SCOPE HEALTH */'.length):s.replace('/* LIBRARIAN SYSTEM STORAGE SDK',moduleText+'\n\n/* LIBRARIAN SYSTEM STORAGE SDK');
if(process.argv.includes('--check')){if(s!==next)throw Error('libra_health_embed_mismatch');}else fs.writeFileSync(f,next);
console.log('LIBRA scope health '+(process.argv.includes('--check')?'checked':'synchronized'));
