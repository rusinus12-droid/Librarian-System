'use strict';
// Exact shared work-state race and panel lifecycle controls migrated from the
// retired GRADIA contract. Only helper-specific result acknowledgement is gone.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),acorn=require('acorn');
const source=fs.readFileSync(path.resolve(__dirname,'../plugins/LIBRA.js'),'utf8'),all=[],parents=new WeakMap();
function visit(n,p){if(!n?.type)return;all.push(n);parents.set(n,p);for(const[k,v]of Object.entries(n)){if(Array.isArray(v))for(const c of v)visit(c,n);else if(v?.type)visit(v,n);}}visit(acorn.parse(source,{ecmaVersion:'latest'}));
const extractConst=name=>{const found=all.filter(n=>n.type==='VariableDeclarator'&&n.id.name===name);assert.equal(found.length,1,name);const declaration=parents.get(found[0]);return source.slice(declaration.start,declaration.end);};
const section=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert(start>=0&&end>start);return source.slice(start,end);};
(async()=>{
const updateContext = {
    Runtime: { pipelineWorkStatus: { requestId: 7, busy: true, phase: 'old', source: "memory", stagePlan: [] } },
    text: value => String(value ?? ''),
    panelCalls: [],
    setPipelineWorkPanel: async (...args) => { updateContext.panelCalls.push(args); return true; }
  };
  vm.createContext(updateContext);
  vm.runInContext(`${extractConst('updatePipelineWorkPanel')}\nthis.updatePipelineWorkPanel = updatePipelineWorkPanel;`, updateContext);
  assert.equal(await updateContext.updatePipelineWorkPanel('stale', 'wrong', { expectedRequestId: 6 }), false);
  assert.equal(updateContext.Runtime.pipelineWorkStatus.phase, 'old');
  assert.equal(updateContext.panelCalls.length, 0);
  const issued = await updateContext.updatePipelineWorkPanel('new', 'started', { begin: true, source: 'normal_input', scopeKey: 'scope:a' });
  assert.equal(issued, 8);
  assert.equal(updateContext.Runtime.pipelineWorkStatus.scopeKey, 'scope:a');

  // Simulate an asynchronous old host write resolving after a newer generation
  // has already taken Runtime. The actual update helper must repaint the newest
  // message and return the old token so its caller remains safely stale-guarded.
  const raceContext = {
    Runtime: { pipelineWorkStatus: { requestId: 3, busy: false, phase: 'idle', source: '', stagePlan: [] } },
    text: value => String(value ?? ''),
    calls: [],
    setPipelineWorkPanel: async (message, state, autoClearMs, requestId) => {
      raceContext.calls.push({ message, state, autoClearMs, requestId });
      if (message === 'old begin') {
        raceContext.Runtime.pipelineWorkStatus = {
          requestId: 5, busy: true, phase: 'newer', source: "memory", scopeKey: 'scope:new',
          message: 'new begin', ok: null, stagePlan: [], startedStages: [], completedStages: [], currentStage: ''
        };
      }
      return true;
    }
  };
  vm.createContext(raceContext);
  vm.runInContext(`${extractConst('updatePipelineWorkPanel')}\nthis.updatePipelineWorkPanel = updatePipelineWorkPanel;`, raceContext);
  assert.equal(await raceContext.updatePipelineWorkPanel('old begin', 'old', { begin: true, source: "memory" }), 4);
  assert.equal(raceContext.Runtime.pipelineWorkStatus.requestId, 5);
  assert.deepEqual(raceContext.calls.map(call => [call.message, call.requestId]), [['old begin', 4], ['new begin', 5]]);

  const sameRequestRace = {
    Runtime: { pipelineWorkStatus: { requestId: 8, updateSerial: 3, busy: true, phase: 'stage', source: 'normal_input', message: 'stage old', stagePlan: [] } },
    text: value => String(value ?? ''),
    calls: [],
    setPipelineWorkPanel: async (message, state, autoClearMs, requestId) => {
      sameRequestRace.calls.push({ message, state, autoClearMs, requestId });
      if (message === 'stage old') {
        sameRequestRace.Runtime.pipelineWorkStatus = {
          ...sameRequestRace.Runtime.pipelineWorkStatus,
          requestId: 8, updateSerial: 5, busy: false, ok: false,
          phase: 'failed', message: 'failed', panelDismissed: true
        };
      }
      return true;
    }
  };
  vm.createContext(sameRequestRace);
  vm.runInContext(`${extractConst('updatePipelineWorkPanel')}\nthis.updatePipelineWorkPanel = updatePipelineWorkPanel;`, sameRequestRace);
  assert.equal(await sameRequestRace.updatePipelineWorkPanel('stage old', 'stage_analysis', { expectedRequestId: 8 }), false);
  assert.deepEqual(sameRequestRace.calls.map(call => [call.message, call.requestId]), [['stage old', 8], ['', 8]],
    'a later failure update from the same request must clear a stale stage panel that resolves last');

  const reportContext = { Runtime: { pipelineWorkStatus: { requestId: 10, busy: true } } };
  vm.createContext(reportContext);
  vm.runInContext(`${extractConst('reportPipelineStageProgress')}\nthis.reportPipelineStageProgress = reportPipelineStageProgress;`, reportContext);
  assert.equal(await reportContext.reportPipelineStageProgress("librarian", 'analysis', 9), false);

  const finishContext = {
    Runtime: {
      pipelineWorkStatus: { requestId: 12, busy: true, currentStage: "librarian", completedStages: [], scopeKey: 'scope:g' },
      lastSga: { pipelineRequestId: 12, scope: { scopeKey: 'scope:g' }, ok: true }
    },
    text: value => String(value ?? ''),
    pipelineWorkResultSummary: () => 'done',
    updatePipelineWorkPanel: async (...args) => { finishContext.updateArgs = args; return 12; },
    Gui: { visible: false, gradiaResultPending: null },
    activeGuiResponseFamily: () => 'libra',
    queueGuiRender: () => { finishContext.renderCalls += 1; },
    panelClears: [],
    setPipelineWorkPanel: async (...args) => { finishContext.panelClears.push(args); return true; },
    warn: () => {},
    renderCalls: 0,
    updateArgs: null
  };
  vm.createContext(finishContext);
  vm.runInContext(`${extractConst('finishPipelineWorkStatus')}\nthis.finishPipelineWorkStatus = finishPipelineWorkStatus;`, finishContext);
  assert.equal(await finishContext.finishPipelineWorkStatus('stale', false, 0, "memory_failed", 11), false);
  assert.equal(finishContext.updateArgs, null);
  assert.equal(await finishContext.finishPipelineWorkStatus('done', true, 2600, "memory_completed", 12), true);
  assert.equal(finishContext.updateArgs[2].autoClearMs, 2600, 'terminal success must preserve its caller-provided auto-clear delay');
  assert.equal(finishContext.updateArgs[2].panelDismissed, false, 'delayed terminal success must remain visible only until its timer expires');



  finishContext.Runtime.pipelineWorkStatus = { requestId: 13, busy: true, currentStage: "librarian", completedStages: [], scopeKey: 'scope:g' };
  finishContext.Runtime.lastSga = { pipelineRequestId: 13, scope: { scopeKey: 'scope:g' }, ok: false };
  assert.equal(await finishContext.finishPipelineWorkStatus('failed', false, 0, "memory_failed", 13), true);
  assert.equal(finishContext.Runtime.pipelineWorkStatus.busy, true, 'the test update stub deliberately leaves runtime ownership unchanged');
  assert.equal(finishContext.updateArgs[2].panelDismissed, true, 'a zero-delay terminal result must be dismissed immediately');

  const panelContext = {
    Runtime: { pipelineWorkStatus: { requestId: 31, busy: false, ok: true, resultAvailable: true, message: 'done', panelDismissed: false } },
    PIPELINE_WORK_PANEL_ID: 'libra-pipeline-work-status',
    panelCalls: [],
    scheduled: null,
    getLiveApi: () => ({ setChatPanel: async (...args) => { panelContext.panelCalls.push(args); return true; } }),
    clearTimeout: () => {},
    setTimeout: (handler, delay) => { panelContext.scheduled = { handler, delay }; return 1; },
    text: value => String(value ?? ''),
    pipelineWorkResultSummary: () => 'done',
    activeGuiResponseFamily: () => 'libra',
    warn: () => {}
  };
  vm.createContext(panelContext);
  const panelHelper = section('const setPipelineWorkPanel =', 'const pipelineWorkStagePlan =');
  vm.runInContext(`let PipelineWorkPanelTimer = null;\n${panelHelper}\nthis.setPipelineWorkPanel = setPipelineWorkPanel;`, panelContext);
  assert.equal(await panelContext.setPipelineWorkPanel('완료', 'done', 2600, 31), true);
  assert.equal(panelContext.scheduled.delay, 2600, 'terminal work panels must schedule their requested removal');
  panelContext.scheduled.handler();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panelContext.Runtime.pipelineWorkStatus.panelDismissed, true, 'auto-clear must seal the completed generation as dismissed');
  assert.equal(panelContext.panelCalls.at(-1)[0], null, 'auto-clear must remove the host chat panel');

  assert.match(source, /const failedTerminal = String\(job\.state \|\| ''\) === 'failed'[\s\S]*?Gui\.canonicalJobDismissedId = job\.jobId;[\s\S]*?return;/,
    'failed canonical jobs must automatically dismiss the central portal and header chip');


console.log('libra_memory_work_status_runtime_test: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
