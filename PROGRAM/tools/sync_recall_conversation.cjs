const fs=require('node:fs'),path=require('node:path');
const create=require('./recall_conversation.cjs');
const file=path.join(__dirname,'../plugins/Flashback_Memory.js');
let src=fs.readFileSync(file,'utf8');
const start='  // BEGIN RECALL CONVERSATION',end='  // END RECALL CONVERSATION';
const block=start+'\n  const RecallConversation = ('+create.toString()+')();\n'+end+'\n\n';
if(src.includes(start)){
  const a=src.indexOf(start),b=src.indexOf(end,a);
  if(b<a)throw Error('Missing context end marker');
  src=src.slice(0,a)+block+src.slice(b+end.length).replace(/^\r?\n\r?\n/,'');
}else src=src.replace('  const buildSceneContextQuery =',block+'  const buildSceneContextQuery =');
fs.writeFileSync(file,src);
