'use strict';

const http = require('node:http');
const fs = require('node:fs');

const mode = String(process.argv[2] || 'fake');
const dataInstanceId = String(process.argv[3] || 'fixture-data-instance');
const capturePath = String(process.argv[4] || '');
const server = http.createServer((request, response) => {
  if (capturePath) {
    fs.appendFileSync(capturePath, `${JSON.stringify({ url: request.url, authorization: String(request.headers.authorization || '') })}\n`, 'utf8');
  }
  if (mode === 'hang') return;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.url === '/health' && mode === 'memory-suite') {
    response.end(JSON.stringify({
      ok: true,
      name: 'Librarian System Data Server',
      version: '0.2.28',
      protocol: { major: 1, minor: 7 },
      dataInstanceId
    }));
    return;
  }
  response.end(JSON.stringify({
    ok: true,
    name: 'Not Librarian System',
    version: 'fixture',
    protocol: { major: 1, minor: 7 }
  }));
});

server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
const close = () => server.close(() => process.exit(0));
process.on('SIGTERM', close);
process.on('SIGINT', close);
