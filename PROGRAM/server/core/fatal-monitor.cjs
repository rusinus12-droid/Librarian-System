"use strict";
// Observes fatal exceptions without handling them or keeping the process alive.
// No async recovery, model call, DB write, new backup or normal service continuation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function installFatalMonitor({ dataDir, version = '' } = {}) {
  if (!dataDir) throw new Error('fatal_monitor_data_dir_required');
  const log = path.join(path.resolve(dataDir), 'logs', 'fatal-error.log');
  const monitor = (error, origin) => {
    try {
      // Avoid dumping RP text, credentials or arbitrary exception values.
      const event = {schema:'memory-suite.fatal-diagnostic.v1',at:new Date().toISOString(),pid:process.pid,
        version:String(version),origin:origin==='unhandledRejection'?'unhandledRejection':'uncaughtException',
        errorClass:['Error','TypeError','RangeError','SyntaxError'].includes(error?.name)?error.name:'Error',
        errorFingerprint:crypto.createHash('sha256').update(String(error?.stack||error)).digest('hex')};
      const line=JSON.stringify(event)+'\n';
      fs.writeSync(2,'[LIBRARIAN SYSTEM] 치명 오류로 종료합니다. 다음 실행에서 복원 저널을 확인합니다.\n');
      fs.mkdirSync(path.dirname(log),{recursive:true});
      // A bounded two-file history prevents an unbounded restart-error log.
      try { if(fs.statSync(log).size>1048576) fs.renameSync(log,log+'.previous'); } catch (_) {}
      const fd=fs.openSync(log,'a',0o600);
      try { fs.writeSync(fd,line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (_) { /* Never replace the original fatal exception. */ }
  };
  process.on('uncaughtExceptionMonitor',monitor);
  return () => process.removeListener('uncaughtExceptionMonitor',monitor);
}
module.exports={installFatalMonitor};
