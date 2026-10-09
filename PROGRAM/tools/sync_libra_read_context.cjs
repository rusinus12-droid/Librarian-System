'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'sdk/LibraReadonlySourceContext.source.js'),'utf8').trimEnd(),target=path.join(root,'plugins/LIBRA.js'),before=fs.readFileSync(target,'utf8');
const pattern=/\/\* LIBRA READONLY SOURCE CONTEXT v1[\s\S]*?\/\* END LIBRA READONLY SOURCE CONTEXT \*\//g;
const blocks=before.match(pattern)||[];if(blocks.length!==1)throw Error('libra_read_context_embed_ambiguous');
if(process.argv.includes('--check')){if(blocks[0]!==source)throw Error('libra_read_context_embed_stale');console.log('LIBRA readonly source context: exact source embed');}
else {const after=before.replace(pattern,()=>source);if(after!==before)fs.writeFileSync(target,after);console.log('LIBRA readonly source context: synchronized');}
