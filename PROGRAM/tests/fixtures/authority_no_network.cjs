'use strict';
const fs = require('node:fs');
function blocked(kind) { return (...args) => {
  if (process.env.LIBRA_NETWORK_AUDIT) fs.appendFileSync(process.env.LIBRA_NETWORK_AUDIT, JSON.stringify({ kind, pid: process.pid, first: String(args[0] || '') })+'\n');
  throw Error('OFFLINE_QUERY_TEST_NETWORK_FORBIDDEN:' + kind);
}; }
global.fetch = blocked('fetch');
for (const [name, methods] of [['node:http',['request','get']],['node:https',['request','get']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dns',['lookup','resolve']],['node:dgram',['createSocket']]]) for (const m of methods) require(name)[m] = blocked(name+'.'+m);
require('node:net').Socket.prototype.connect = blocked('Socket.connect');
require('node:net').Server.prototype.listen = blocked('Server.listen');
for (const name of ['WebSocket','EventSource']) global[name] = class { constructor() { blocked(name)(); } };
require('node:module').syncBuiltinESMExports();
