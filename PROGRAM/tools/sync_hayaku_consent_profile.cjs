'use strict';
// HAYAKU's preserve-until-replacement profile is intentionally separate from
// the unchanged LIBRA/Flashback controller; this sync never edits other owners.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'plugins/HAYAKU_Locator_Continuity.js');
const profile=fs.readFileSync(path.join(root,'sdk/MemorySuiteSourceEditConsent.hayaku.source.js'),'utf8').trimEnd();
const source=fs.readFileSync(file,'utf8');
const a=source.indexOf('/* Librarian System Source Edit Consent ');
const b=source.indexOf('\n\n  const hayakuPendingSourceTask',a);
if(a<0||b<=a||source.indexOf('/* Librarian System Source Edit Consent ',a+1)>=0)throw Error('ambiguous_hayaku_consent_source');
const updated=source.slice(0,a)+profile+source.slice(b);
if(updated.split(profile).length!==2)throw Error('hayaku_consent_sync_failed');
fs.writeFileSync(file,updated,'utf8');
console.log('HAYAKU source-edit preservation profile: synchronized');
