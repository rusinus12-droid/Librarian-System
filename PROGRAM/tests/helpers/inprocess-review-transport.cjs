'use strict';
const {PassThrough}=require('node:stream'),{EventEmitter}=require('node:events');
module.exports=function transport(app,calls=[]){return (target,init={})=>new Promise((resolve,reject)=>{
 const url=new URL(target); if(url.hostname!=='127.0.0.1')return reject(Error('REVIEW_EXTERNAL_TARGET_DISABLED'));
 const req=new PassThrough();req.url=url.pathname+url.search;req.method=init.method||'GET';req.headers=Object.fromEntries(Object.entries(init.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));req.socket={remoteAddress:'127.0.0.1'};req.aborted=false;
 const res=new EventEmitter();res.headers={};res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;};res.end=body=>{res.writableEnded=true;res.emit('finish');calls.push({method:req.method,path:url.pathname,status:res.statusCode});resolve(new Response(body,{status:res.statusCode,headers:res.headers}));};res.destroy=reject;app.server.emit('request',req,res);req.end(init.body||'');
 });};
