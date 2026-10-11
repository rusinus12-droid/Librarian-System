'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const workerPath = path.join(__dirname, 'compute_product_coordinated_worker.cjs');
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function createProductGate(app, expectedWorkers) {
  const control = new Int32Array(new SharedArrayBuffer(4));
  const ready = new Map(), entries = new Map(), exits = new Map(), active = new Set();
  let gatePeak = 0, releasedAt = null, setupDeadline = null;
  const listeners = [];
  const until = async (predicate, label) => {
    const deadline = setupDeadline || Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw Error(`CONTROLLED_PRODUCT_GATE_SETUP_TIMEOUT:${label}`);
      await pause();
    }
  };
  assert.equal(app.computePlane.pool.slots.length, expectedWorkers, 'all configured worker slots exist');
  for (const slot of app.computePlane.pool.slots) {
    assert(slot.worker && slot.ready, 'observe every owned ready worker');
    const worker = slot.worker;
    const observe = message => {
      if (!String(message?.event || '').startsWith('controlledGate')) return;
      assert.equal(Object.hasOwn(message, 'jobId'), false, 'observer frames cannot settle production jobs');
      assert.equal(message.workerIndex, slot.index, 'telemetry comes from the actual owned worker');
      assert.equal(message.threadId, worker.threadId, 'distinct actual physical thread identity');
      if (message.event === 'controlledGateReady') ready.set(slot.index, message.threadId);
      if (message.event === 'controlledGateEntered') {
        assert(message.controlledJobId, 'actual admitted product job entered the worker');
        assert(!entries.has(message.controlledJobId), 'one physical gate entry per product job');
        assert(!active.has(slot.index), 'worker never runs two jobs simultaneously');
        entries.set(message.controlledJobId, message); active.add(slot.index);
        gatePeak = Math.max(gatePeak, active.size);
      }
      if (message.event === 'controlledGateExited') { exits.set(message.controlledJobId, message); active.delete(slot.index); }
    };
    worker.on('message', observe); listeners.push([worker, observe]);
    worker.postMessage({ controlledProductGate: true, workerIndex: slot.index, buffer: control.buffer });
  }
  try {
    await until(() => ready.size === expectedWorkers, 'every worker ready acknowledgement');
    assert.equal(new Set(ready.values()).size, expectedWorkers, 'every owned worker has distinct thread identity');
  } catch (error) {
    Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    for (const [worker, observe] of listeners) worker.off('message', observe);
    throw error;
  }
  return {
    workerPath,
    arm() { assert.equal(setupDeadline, null, 'one controlled setup window'); setupDeadline = Date.now() + 5000; },
    async withinSetup(promise) {
      assert(setupDeadline, 'setup armed before public submissions');
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('CONTROLLED_PRODUCT_GATE_SETUP_TIMEOUT:public admission')), Math.max(1, setupDeadline - Date.now()));
      })]); } finally { clearTimeout(timer); }
    },
    async waitForEntries(floor, submissions) {
      assert(setupDeadline && Date.now() < setupDeadline, 'bounded coordinator setup window');
      const jobs = new Set(submissions.map(item => item.job.jobId));
      await until(() => active.size >= floor, 'physical entry floor');
      for (const row of entries.values()) assert(jobs.has(row.controlledJobId), 'gate entry belongs to a real HTTP-admitted product job');
      assert.equal(new Set([...entries.values()].map(row => row.threadId)).size, entries.size, 'held entries use distinct physical workers');
      assert(active.size >= floor && app.computePlane.pool.activeCount >= floor, 'actual occupied pool reaches floor');
    },
    release() { if (releasedAt === null) { releasedAt = Date.now(); setupDeadline = null; Atomics.store(control, 0, 1); Atomics.notify(control, 0); } },
    async report() {
      await until(() => exits.size === entries.size, 'all physical entries exited');
      return { mode: 'controlled_physical_worker_occupancy', setupBoundMs: 5000,
        ownedWorkers: expectedWorkers, readyPeak: ready.size, distinctReadyThreads: new Set(ready.values()).size,
        gatePeak, releasedAt, entries: [...entries.values()].map(row => ({ ...row, gateWaitMs: exits.get(row.controlledJobId).gateWaitMs })),
        timingPolicy: 'native worker/queue/total timings include coordinator wait; no subtraction',
        limitation: 'proves controlled physical slot occupancy, not unguarded product kernel CPU overlap or generalized throughput' };
    },
    close() { this.release(); for (const [worker, observe] of listeners) worker.off('message', observe); }
  };
}
module.exports = { workerPath, createProductGate };
