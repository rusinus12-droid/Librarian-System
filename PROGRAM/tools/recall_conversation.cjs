// Context supplied to a semantic embedding model. No language-specific target
// extraction or relevance filtering takes place here.
module.exports=function createRecallConversation(){
  const version='recall_conversation_v1';
  const build=(current,rows=[],options={})=>{
    const maxMessages=Math.max(0,Math.min(20,Number(options.maxMessages??5)||0));
    const maxChars=Math.max(0,Math.min(12000,Number(options.maxChars??6000)||0));
    const selected=[];let used=0,truncated=false;
    for(let i=rows.length-1;i>=0&&selected.length<maxMessages;i--){
      const row=rows[i];if(!row||!['user','assistant'].includes(row.role))continue;
      let body=String(row.body??row.text??'').trim();if(!body)continue;
      const prefix=row.role.toUpperCase()+': ';
      let line=prefix+body,partial=false;
      if(used+line.length+1>maxChars){
        truncated=true;
        if(selected.length)break;
        const marker='[Earlier part omitted]\n';
        const room=maxChars-prefix.length-marker.length-1;
        if(room<=0)break;
        body=marker+body.slice(-room);line=prefix+body;partial=true;
      }
      selected.push({...row,body,line,partial});used+=line.length+1;
    }
    selected.reverse();
    const recent=selected.map(row=>row.line).join('\n');
    const input=String(current??'').trim().slice(-6000);
    return {version,recent,entries:selected,truncated,
      text:recent?'RECENT CONVERSATION (chronological):\n'+recent+'\n\nCURRENT USER INPUT:\n'+input:input};
  };
  return Object.freeze({version,build});
};
