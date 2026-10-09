
'use strict'; const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const server=fs.readFileSync(path.resolve(__dirname,'../server/server.cjs'),'utf8'); const retrace=fs.readFileSync(path.resolve(__dirname,'../plugins/RETRACE.js'),'utf8');
assert.match(server,/update_check\.cjs/); assert.match(retrace,/RETRACE_UPDATE_REPOSITORY/); assert.match(retrace,/RE:TRACE는 업데이트를 실행하지 않습니다/); assert.doesNotMatch(retrace,/data-update-start|server-update-start/i); console.log('remote_update_detection_contract_test: PASS');
