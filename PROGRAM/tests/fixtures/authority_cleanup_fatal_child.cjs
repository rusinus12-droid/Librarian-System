'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const program = process.env.LIB_AUTHORITY_REVIEW_PROGRAM || path.resolve(__dirname, '../..');
const { fixture, fresh } = require(path.join(program, 'tests/fixtures/authority_server_fixture.cjs'));
const f = fixture({ after() {} }); f.activate(); const repo = f.repositories.libra;
process.stdout.write(JSON.stringify({ root: f.root, dataDir: f.dataDir, filePath: repo.filePath }) + '\n');
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExec = DatabaseSync.prototype.exec;
const originalClose = DatabaseSync.prototype.close;
let cleanupStarted = false;
DatabaseSync.prototype.prepare = function(sql) {
  const statement = originalPrepare.call(this, sql);
  if (this === repo.database && sql === 'DELETE FROM operations WHERE created_at < ?') {
    const run = statement.run;
    statement.run = function(...args) { cleanupStarted = true; return run.apply(this, args); };
  }
  return statement;
};
DatabaseSync.prototype.exec = function(sql) {
  if (this === repo.database && cleanupStarted && ['COMMIT', 'ROLLBACK'].includes(sql)) throw Error('TASK4_FATAL_CLEANUP_END');
  return originalExec.call(this, sql);
};
DatabaseSync.prototype.close = function() {
  if (this === repo.database && cleanupStarted) throw Error('TASK4_FATAL_CLEANUP_CLOSE');
  return originalClose.call(this);
};
repo.applyConditionalBatch(Array.from({ length: 1000 }, (_, i) => fresh('libra:cleanup:fatal:' + i, i)), { operationId: 'fatal-cleanup-parent-batch' });
process.stdout.write('UNSAFE_SUCCESS_CONTINUATION\n');
process.exit(99);
