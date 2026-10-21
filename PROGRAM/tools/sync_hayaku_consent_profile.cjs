'use strict';
// The per-owner Source Edit Consent embed was retired: source edits now go through the shared
// LIBRA source input policy (tools/sync_source_edit_consent.cjs). The HAYAKU profile under
// sdk/MemorySuiteSourceEditConsent.hayaku.source.js is an inert compatibility artifact. This check
// keeps the old embed from coming back and never writes.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
if(process.argv.slice(2).some(value=>value!=='--check'))throw Error('unknown_hayaku_consent_argument');
const source=fs.readFileSync(path.join(root,'plugins/HAYAKU_Locator_Continuity.js'),'utf8');
if(source.includes('/* Librarian System Source Edit Consent '))throw Error('retired_hayaku_consent_embedded');
console.log('HAYAKU source-edit consent profile: retired (shared source input policy in use)');
