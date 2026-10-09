'use strict';
// Flashback's diff-selection/preserve-until-replacement profile. No other owner is modified.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'plugins/Flashback_Memory.js');
const profile=fs.readFileSync(path.join(root,'sdk/MemorySuiteSourceEditConsent.flashback.source.js'),'utf8').trimEnd();
const source=fs.readFileSync(file,'utf8');
const a=source.indexOf('/* Librarian System Source Edit Consent ');
const b=source.indexOf('\n\n  let flashbackSourceEdits',a);
if(a<0||b<=a||source.indexOf('/* Librarian System Source Edit Consent ',a+1)>=0)throw Error('ambiguous_flashback_consent_source');
const updated=source.slice(0,a)+profile+source.slice(b);
if(updated.split(profile).length!==2)throw Error('flashback_consent_sync_failed');
fs.writeFileSync(file,updated,'utf8');
console.log('Flashback source-edit review profile: synchronized');
