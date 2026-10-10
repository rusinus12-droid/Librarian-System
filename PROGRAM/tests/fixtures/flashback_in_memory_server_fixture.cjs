'use strict';
Error.stackTraceLimit=60;
const path=require('node:path'),{Readable}=require('node:stream'),{EventEmitter}=require('node:events');
const actual=require(path.resolve(__dirname,'../../server/server.cjs'));
const apps=new Map(),knownOrigins=new Set(),trace=[];let port=64500;
const deny=()=>{throw Error('FOLLOWUP_NETWORK_FORBIDDEN');};
require('node:net').Socket.prototype.connect=deny;require('node:net').Server.prototype.listen=deny;
require('node:http').request=deny;require('node:https').request=deny;
const mockFetch=async(url,init={})=>{
 const u=new URL(url),app=apps.get(u.origin);if(!app){if(knownOrigins.has(u.origin))throw Object.assign(new TypeError('fetch failed'),{code:'ECONNREFUSED'});throw Error('UNREGISTERED_OFFLINE_URL:'+u.origin);}
 if(init.signal?.aborted)throw Object.assign(Error('aborted'),{name:'AbortError'});
 const event={url:String(url),method:init.method||'GET'};trace.push(event); if(process.env.FOLLOWUP_STACKS && u.pathname.endsWith('/writer') && JSON.parse(init.body).action==='acquire')console.log('OFFLINE_STACK',JSON.stringify({owner:JSON.parse(init.body).owner,stack:new Error('offline writer call').stack}));
 return await new Promise((resolve,reject)=>{
  const req=Readable.from(init.body==null?[]:[Buffer.from(String(init.body))]);
  Object.assign(req,{url:u.pathname+u.search,method:init.method||'GET',headers:Object.fromEntries([...new Headers(init.headers).entries()]),socket:{remoteAddress:'127.0.0.1'},complete:true});
  const res=new EventEmitter();res.statusCode=200;res.headers={};
  res.writeHead=(status,headers)=>{res.statusCode=status;res.headers=headers;};
  res.setHeader=(key,value)=>res.headers[key]=value;res.getHeader=key=>res.headers[key];
  res.end=body=>{res.finished=true;event.status=res.statusCode;event.body=String(body||'');if(process.env.FLASHBACK_WRITER_TRACE && u.pathname.endsWith('/writer'))console.log('OFFLINE_WRITER',JSON.stringify({request:JSON.parse(init.body),status:event.status,reply:JSON.parse(event.body)}));res.emit('finish');resolve(new Response(res.statusCode===204?null:body,{status:res.statusCode,headers:res.headers}));};
  Promise.resolve(app.server.listeners('request')[0](req,res)).catch(reject);
 });
};
globalThis.fetch=mockFetch;
const createMemorySuiteServer=options=>{
 const app=actual.createMemorySuiteServer(options),p=Number(options?.port)>0?Number(options.port):port++,origin='http://127.0.0.1:'+p;
 app.server.address=()=>({address:'127.0.0.1',port:p,family:'IPv4'});
 app.listen=async()=>{knownOrigins.add(origin);if(apps.has(origin))throw Object.assign(Error('address in use'),{code:'EADDRINUSE'});apps.set(origin,app);return app.server.address();};
 const close=app.close;app.close=async()=>{await close();app.server.emit('close');if(apps.get(origin)===app)apps.delete(origin);};
 return app;
};
module.exports={createMemorySuiteServer,trace,mockFetch};
