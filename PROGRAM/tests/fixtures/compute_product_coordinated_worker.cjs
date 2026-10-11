'use strict';
// Test-only wrapper around the unchanged production worker and product registry.
// The production worker timestamps start BEFORE executeOperation, so native
// workerMs honestly includes this bounded setup wait. No timestamps are replaced.
const { parentPort, threadId } = require('node:worker_threads');
const registry = require('../../server/compute/registry.cjs');
const execute = registry.executeOperation;
// Telemetry deliberately has NO protocol jobId: production WorkerPool ignores
// unmatched frames. The coordinator binds controlledJobId to actual HTTP jobs.
let gate = null, workerIndex = -1, currentJob = null;
// Register before requiring the production worker, preserving listener order.
parentPort.on('message', message => {
  if (message?.controlledProductGate) {
    gate = new Int32Array(message.buffer); workerIndex = message.workerIndex;
    parentPort.postMessage({ event: 'controlledGateReady', workerIndex, threadId });
  } else if (message?.jobId && message?.operation) currentJob = message.jobId;
});
registry.executeOperation = (...args) => {
  if (gate && Atomics.load(gate, 0) === 0) {
    const jobId = currentJob, enteredAt = Date.now();
    parentPort.postMessage({ event: 'controlledGateEntered', workerIndex, threadId, controlledJobId: jobId, enteredAt });
    // Every physical worker waits independently; a serialized pool cannot reach
    // a multi-worker entry floor. Five seconds is setup's upper bound, never a
    // change to the actual product job's deadline.
    const deadline = enteredAt + 5000;
    while (Atomics.load(gate, 0) === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw Error('CONTROLLED_PRODUCT_GATE_SETUP_TIMEOUT');
      Atomics.wait(gate, 0, 0, remaining);
    }
    parentPort.postMessage({ event: 'controlledGateExited', workerIndex, threadId, controlledJobId: jobId,
      gateWaitMs: Date.now() - enteredAt });
  }
  return execute(...args);
};
require('../../server/compute/compute_worker.cjs');
