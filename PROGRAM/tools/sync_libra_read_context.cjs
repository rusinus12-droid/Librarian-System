'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'sdk/LibraReadonlySourceContext.source.js'),'utf8').trimEnd(),target=path.join(root,'plugins/LIBRA.js'),before=fs.readFileSync(target,'utf8');
const pattern=/\/\* LIBRA READONLY SOURCE CONTEXT v1[\s\S]*?\/\* END LIBRA READONLY SOURCE CONTEXT \*\//g;
// tools/sync_gradia_ranked_evidence.cjs owns a component block placed inside this embed, just
// before the context factory. It is excluded from the comparison and kept in place on write, so
// this sync can never drop GRADIA's ranked-evidence components from LIBRA.
const nested=/\/\* GRADIA RANKED EVIDENCE V2 COMPONENTS BEGIN \*\/[\s\S]*?\/\* GRADIA RANKED EVIDENCE V2 COMPONENTS END \*\/\n\n?/g;
const anchor='function createLibraReadonlySourceContext(owner) {';
const blocks=before.match(pattern)||[];if(blocks.length!==1)throw Error('libra_read_context_embed_ambiguous');
const components=blocks[0].match(nested)||[];if(components.length>1)throw Error('libra_read_context_components_ambiguous');
if(source.match(nested))throw Error('libra_read_context_source_contains_components');
if(components.length&&source.split(anchor).length!==2)throw Error('libra_read_context_anchor_missing');
const expected=components.length?source.replace(anchor,()=>components[0]+anchor):source;
if(process.argv.includes('--check')){if(blocks[0].replace(nested,'')!==source||blocks[0]!==expected)throw Error('libra_read_context_embed_stale');console.log('LIBRA readonly source context: exact source embed'+(components.length?' (GRADIA components preserved)':''));}
else {const after=before.replace(pattern,()=>expected);if(after!==before)fs.writeFileSync(target,after);console.log('LIBRA readonly source context: synchronized');}
