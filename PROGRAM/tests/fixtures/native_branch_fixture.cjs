"use strict";
const clone = value => JSON.parse(JSON.stringify(value));
function parent(id='parent', count=10) {
 const chat={id,chatId:id,name:'Parent::name',fmIndex:0,message:[]};
 for(let i=1;i<=count;i++)chat.message.push({role:'user',chatId:'u'+i,data:'User '+i},{role:'char',chatId:'a'+i,data:'Assistant '+i});
 return chat;
}
function branch(source, pairs=5, id='branch') {
 const chat=clone(source); chat.id=id;chat.chatId=id;chat.name='Branch';
 chat.message=chat.message.slice(0,pairs*2);
 const fork=chat.message.at(-1).chatId;
 chat.message.push({role:'char',isComment:true,disabled:true,chatId:'marker-'+id,data:`{{specialcomment::branchedfrom::${source.id}::${source.name}::${fork}::}}`});
 return chat;
}
function character(chats) {return {id:'character',chaId:'character',name:'Character',chatPage:0,chats};}
module.exports={clone,parent,branch,character};
