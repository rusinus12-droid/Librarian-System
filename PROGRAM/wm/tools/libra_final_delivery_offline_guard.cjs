'use strict';
// Test execution guard only. Local subprocesses are allowed for the repository suite;
// outbound sockets/fetch remain forbidden in every inheriting Node subprocess.
const attempts=[];globalThis.__finalDeliveryTransportAttempts=attempts;
const deny=name=>(...args)=>{attempts.push(name);throw Error('FINAL_DELIVERY_OFFLINE_ONLY:'+name)};
globalThis.fetch=deny('fetch');globalThis.WebSocket=deny('WebSocket');
for(const [name,keys]of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']]]){const mod=require(name);for(const key of keys)mod[key]=deny(name+'.'+key);}
require('node:net').Socket.prototype.connect=deny('Socket.connect');
process.on('exit',()=>{if(attempts.length)console.error('FINAL_DELIVERY_BLOCKED_TRANSPORTS '+JSON.stringify(attempts));});
