'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createDataCheckpoint } = require('../../../UPDATER/core/checkpoint.cjs');
const { dataInstanceId } = require('../../../UPDATER/core/program-only.cjs');
const identity = require('../../../UPDATER/core/data-identity.cjs');
async function fixture() {
  // Keep this directory name ASCII. On Windows, Node v22.23.2 crashes with an access violation
  // (0xC0000005, exit 139, zero bytes of output) when fs.cpSync copies into a tree whose path holds
  // non-ASCII characters - measured with a standalone probe using only node:fs/node:os, no product
  // code. Suites that call fs.cpSync against this fixture (launchers contract, real-server runtime,
  // standalone recovery) died at 39ms with nothing printed, or failed with ENOENT for files the
  // fixture never got to create. The name is an internal fixture label and is asserted nowhere, so
  // spelling it in ASCII costs no coverage.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian recovery boundary '));
  const p = rel => path.join(root, rel);
  for (const dir of ['PROGRAM', 'DATA/config', 'UPDATER', '.update/PROGRAM.next', '.rollback/case']) fs.mkdirSync(p(dir), {recursive:true});
  fs.writeFileSync(p('PROGRAM/VERSION.txt'), '0.3.51\n');
  fs.writeFileSync(p('PROGRAM/old.txt'), 'OLD');
  fs.writeFileSync(p('.update/PROGRAM.next/VERSION.txt'), '0.3.52\n');
  fs.writeFileSync(p('.update/PROGRAM.next/new.txt'), 'NEW');
  fs.writeFileSync(p('DATA/runtime-token.txt'), 'a'.repeat(64));
  fs.writeFileSync(p('DATA/config/server-config.json'), JSON.stringify({schema:'memory-suite.server-config.v1', host:'127.0.0.1', port:65531}));
  fs.writeFileSync(p('DATA/value'), 'BEFORE');
  identity.ensureDataInstanceIdentity(p('DATA'));
  const journal = {schema:'librarian.update-state.v1', engineRevision:identity.engineRevision, dataIdentityContract:identity.contract, dataIdentity:identity.capture(p('DATA')), operationId:'case', status:'running', phase:'init', policy:'program_only', fromVersion:'0.3.51', toVersion:'0.3.52', serverWasRunning:false,
    dataInstanceId:dataInstanceId(p('DATA')), flags:{checkpointCreated:false,programOldRenamed:false,programNewActivated:false,candidateServerAttempted:false},
    paths:{rollbackRoot:'.rollback/case',rollbackProgram:'.rollback/case/PROGRAM',checkpointRoot:'.rollback/case/DATA-checkpoint',programNext:'.update/PROGRAM.next'}};
  const save = () => fs.writeFileSync(p('UPDATER/update-state.json'), JSON.stringify(journal));
  const checkpoint = async () => {await createDataCheckpoint({dataDir:p('DATA'),checkpointDir:p(journal.paths.checkpointRoot)});journal.checkpointDataIdentity=identity.capture(p(journal.paths.checkpointRoot+'/DATA'));journal.flags.checkpointCreated=true;};
  const activate = () => {fs.renameSync(p('PROGRAM'),p(journal.paths.rollbackProgram));fs.renameSync(p('.update/PROGRAM.next'),p('PROGRAM'));journal.flags.programOldRenamed=true;journal.flags.programNewActivated=true;};
  const dirty = () => {journal.flags.candidateServerAttempted=true;fs.writeFileSync(p('DATA/value'),'CANDIDATE');};
  const quarantine = rel => {fs.mkdirSync(p('.update/failed-case'),{recursive:true});if(rel==='DATA'){journal.dataMoves={restore:identity.planMove(p(journal.paths.checkpointRoot+'/DATA'),p('DATA')),quarantine:identity.planMove(p('DATA'),p('.update/failed-case/DATA'))};save();}fs.renameSync(p(rel),p('.update/failed-case/'+rel));};
  return {root,p,journal,save,checkpoint,activate,dirty,quarantine,receipt:{updatePolicy:'program_only',targetVersion:'0.3.52',programNext:p('.update/PROGRAM.next')},cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
module.exports={fixture};
