'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function testMutualExclusivity() {
  console.log('[TEST] Starting libra_canonical_auxiliary_job_mutual_exclusivity_test...');
  const code = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');

  // 1. Verify helper functions exist and manage dismissals via set
  assert(code.includes('function isCanonicalJobDismissed(jobId)'), 'isCanonicalJobDismissed helper must exist');
  assert(code.includes('function dismissCanonicalJob(jobId)'), 'dismissCanonicalJob helper must exist');
  assert(code.includes('function undismissCanonicalJob(jobId)'), 'undismissCanonicalJob helper must exist');
  console.log('✓ Dismissal helpers verified');

  // 2. Verify Gui state initializes canonicalJobDismissedIds set
  assert(code.includes('canonicalJobDismissedIds: new Set()'), 'Gui must initialize canonicalJobDismissedIds set');
  console.log('✓ canonicalJobDismissedIds set verified');

  // 3. Verify renderCanonicalJobSurface enforces mutual exclusivity
  assert(code.includes('const auxIsActive = Boolean(activeAux && activeAux.jobId && !isCanonicalJobDismissed(activeAux.jobId));'),
    'renderCanonicalJobSurface must calculate auxIsActive');
  assert(code.includes('const canIsLive = Boolean(activeCan && activeCan.jobId && [\'preparing\', \'running\', \'cancel_requested\', \'adopting\', \'awaiting_edit\', \'awaiting_choice\'].includes(String(activeCan.state || \'\')) && !isCanonicalJobDismissed(activeCan.jobId));'),
    'renderCanonicalJobSurface must calculate canIsLive');
  assert(code.includes('if (auxIsActive && job.jobId !== activeAux.jobId && job.jobType !== \'micro\' && job.jobType !== \'lens\')'),
    'renderCanonicalJobSurface must reject canonical job overwrite when auxiliary job is active');
  assert(code.includes('if (canIsLive && job.jobId !== activeCan.jobId && (job.jobType === \'micro\' || job.jobType === \'lens\'))'),
    'renderCanonicalJobSurface must reject auxiliary job overwrite when canonical job is live');
  assert(code.includes('if (jobValue === null) {\n      if (auxIsActive || canIsLive) return;'),
    'renderCanonicalJobSurface must not clear surface on null probe if job is active');
  console.log('✓ renderCanonicalJobSurface mutual exclusivity guards verified');

  // 4. Verify renderSettingsGuiOnce checks auxIsActive
  assert(code.includes('const activeAux = LibraMemoryCore.state.activeAuxiliaryJob;\n    const auxIsActive = Boolean(activeAux && activeAux.jobId && !isCanonicalJobDismissed(activeAux.jobId));\n    if (auxIsActive) {\n      renderCanonicalJobSurface(activeAux);\n    } else {\n      renderCanonicalJobSurface(LibraMemoryCore.state.canonicalJob);\n    }'),
    'renderSettingsGuiOnce must prioritize active auxiliary job over canonical job');
  assert(code.includes('const curAux = LibraMemoryCore.state.activeAuxiliaryJob;\n        const curAuxActive = Boolean(curAux && curAux.jobId && !isCanonicalJobDismissed(curAux.jobId));\n        if (!curAuxActive) {\n          renderCanonicalJobSurface(job||null);\n        }'),
    'renderSettingsGuiOnce canonical probe must not clobber active auxiliary job');
  console.log('✓ renderSettingsGuiOnce auxiliary priority verified');

  // 5. Verify reanalyzeAuxiliaryRanges synchronously creates preparing job
  assert(code.includes('state: \'preparing\''), 'reanalyzeAuxiliaryRanges must initialize preparing state');
  assert(code.includes('if (typeof dismissCanonicalJob === \'function\' && state.canonicalJob?.jobId) {\n          dismissCanonicalJob(state.canonicalJob.jobId);\n        }'),
    'reanalyzeAuxiliaryRanges must dismiss old canonical job when starting');
  console.log('✓ reanalyzeAuxiliaryRanges synchronous preparing state verified');

  // 6. Verify runCanonicalGuiCommand does not wipe out dismissals
  assert(!code.includes('Gui.canonicalJobDismissedId = \'\';\n        Gui.canonicalJobLaunchPreviousId'),
    'runCanonicalGuiCommand must not clear dismissedId to prevent resurrecting old jobs');
  console.log('✓ runCanonicalGuiCommand dismissal preservation verified');

  // 7. Verify cross-job start prevention
  assert(code.includes('if (state.activeAuxiliaryJob && [\'preparing\', \'running\', \'cancel_requested\', \'adopting\'].includes(String(state.activeAuxiliaryJob.state || \'\')))')
    && code.includes('다른 미크로·렌즈 재분석 작업이 진행 중입니다.'),
    'startSelectedCanonicalBatches must reject starting while auxiliary job is running');
  assert(code.includes('if (state.canonicalJob && [\'preparing\', \'running\', \'cancel_requested\', \'adopting\'].includes(String(state.canonicalJob.state || \'\')))')
    && code.includes('다른 정본 작업이 진행 중입니다.'),
    'reanalyzeAuxiliaryRanges must reject starting while canonical job is running');
  console.log('✓ Cross-job execution guards verified');

  console.log('\n[TEST] PASS: All mutual exclusivity and flicker-prevention tests passed successfully!');
}

testMutualExclusivity().catch(err => {
  console.error(err);
  process.exit(1);
});
