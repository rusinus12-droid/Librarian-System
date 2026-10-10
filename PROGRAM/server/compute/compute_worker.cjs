'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { executeOperation } = require('./registry.cjs');

if (!parentPort) throw new Error('compute_worker_requires_parent_port');

const allowTestOperations = workerData?.allowTestOperations === true;

parentPort.on('message', message => {
  const jobId = String(message?.jobId || '');
  const operation = String(message?.operation || '');
  if (!jobId || !operation) {
    parentPort.postMessage({ jobId, ok: false, code: 'COMPUTE_WORKER_MESSAGE_INVALID', error: 'compute_worker_message_invalid' });
    return;
  }
  const startedAt = Date.now();
  parentPort.postMessage({ jobId, event: 'started', startedAt });
  try {
    const result = executeOperation(operation, message.input, { allowTestOperations });
    parentPort.postMessage({
      jobId,
      ok: true,
      result,
      timing: { startedAt, completedAt: Date.now(), workerMs: Date.now() - startedAt }
    });
  } catch (error) {
    parentPort.postMessage({
      jobId,
      ok: false,
      code: String(error?.code || 'COMPUTE_WORKER_FAILED'),
      statusCode: Number(error?.statusCode || 500),
      error: String(error?.message || 'compute_worker_failed').slice(0, 240),
      timing: { startedAt, completedAt: Date.now(), workerMs: Date.now() - startedAt }
    });
  }
});

parentPort.postMessage({ event: 'ready' });
