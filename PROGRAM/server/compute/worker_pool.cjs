'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AsyncResource } = require('node:async_hooks');
const { Worker } = require('node:worker_threads');
const { computeError } = require('./contracts.cjs');

class ComputeTaskResource extends AsyncResource {
  constructor() {
    super('MemorySuiteComputeTask');
  }

  settle(callback, value) {
    try { this.runInAsyncScope(callback, null, value); }
    finally { this.emitDestroy(); }
  }
}

class WorkerPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.size = Math.max(1, Math.min(16, Math.floor(Number(options.size) || 1)));
    this.workerPath = path.resolve(options.workerPath || path.join(__dirname, 'compute_worker.cjs'));
    this.allowTestOperations = options.allowTestOperations === true;
    this.resourceLimits = {
      maxOldGenerationSizeMb: Math.max(32, Math.floor(Number(options.maxOldGenerationSizeMb) || 192)),
      maxYoungGenerationSizeMb: Math.max(8, Math.floor(Number(options.maxYoungGenerationSizeMb) || 32)),
      stackSizeMb: Math.max(1, Number(options.stackSizeMb) || 4)
    };
    this.slots = Array.from({ length: this.size }, (_, index) => ({
      index, generation: 0, worker: null, ready: false, busy: false, current: null,
      readyResolve: null, readyReject: null
    }));
    this.started = false;
    this.closing = false;
    this.closePromise = null;
  }

  async start() {
    if (this.started) return this.stats();
    if (this.closing) throw computeError('compute_pool_closing', 503);
    this.started = true;
    try {
      await Promise.all(this.slots.map(slot => this._spawn(slot)));
      return this.stats();
    } catch (error) {
      await this.close({ graceMs: 0 });
      throw error;
    }
  }

  _spawn(slot) {
    if (this.closing) return Promise.reject(computeError('compute_pool_closing', 503));
    slot.generation += 1;
    const generation = slot.generation;
    const worker = new Worker(this.workerPath, {
      name: `memory-suite-compute-${slot.index}`,
      workerData: { allowTestOperations: this.allowTestOperations },
      resourceLimits: this.resourceLimits
    });
    slot.worker = worker;
    slot.ready = false;
    slot.busy = false;
    slot.current = null;
    const readyPromise = new Promise((resolve, reject) => {
      slot.readyResolve = resolve;
      slot.readyReject = reject;
    });
    worker.on('message', message => this._onMessage(slot, worker, generation, message));
    worker.once('error', error => this._onFailure(slot, worker, generation, error));
    worker.once('exit', code => this._onExit(slot, worker, generation, code));
    return readyPromise;
  }

  _onMessage(slot, worker, generation, message) {
    if (slot.worker !== worker || slot.generation !== generation) return;
    if (message?.event === 'ready') {
      slot.ready = true;
      const resolve = slot.readyResolve;
      slot.readyResolve = null;
      slot.readyReject = null;
      resolve?.();
      this.emit('available');
      return;
    }
    const current = slot.current;
    if (!current || String(message?.jobId || '') !== current.jobId) return;
    if (message?.event === 'started') {
      this.emit('taskStarted', { jobId: current.jobId, workerIndex: slot.index, startedAt: Number(message.startedAt || Date.now()) });
      return;
    }
    if (message?.ok === true) {
      this._settle(slot, null, { result: message.result, timing: message.timing || {} });
      return;
    }
    const error = computeError(String(message?.error || 'compute_worker_failed'), Number(message?.statusCode || 500));
    error.code = String(message?.code || error.code);
    this._settle(slot, error);
  }

  _onFailure(slot, worker, generation, error) {
    if (slot.worker !== worker || slot.generation !== generation) return;
    slot.ready = false;
    const wrapped = computeError('compute_worker_crashed', 503, { cause: error });
    if (slot.readyReject) {
      const reject = slot.readyReject;
      slot.readyResolve = null;
      slot.readyReject = null;
      reject(wrapped);
    }
    if (slot.current) this._settle(slot, wrapped, null, { keepUnavailable: true });
  }

  _onExit(slot, worker, generation, code) {
    if (slot.worker !== worker || slot.generation !== generation) return;
    slot.ready = false;
    slot.worker = null;
    if (slot.readyReject) {
      const reject = slot.readyReject;
      slot.readyResolve = null;
      slot.readyReject = null;
      reject(computeError(`compute_worker_start_failed:${code}`, 503));
    }
    if (slot.current) this._settle(slot, computeError(`compute_worker_exit:${code}`, 503), null, { keepUnavailable: true });
    if (this.closing) return;
    this._spawn(slot).catch(error => this.emit('poolError', error));
  }

  _settle(slot, error, value, options = {}) {
    const current = slot.current;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    slot.current = null;
    slot.busy = false;
    if (!options.keepUnavailable) slot.ready = true;
    if (error) current.resource.settle(current.reject, error);
    else current.resource.settle(current.resolve, value);
    if (!options.keepUnavailable) this.emit('available');
  }

  dispatch(task) {
    if (!this.started || this.closing) return null;
    const slot = this.slots.find(item => item.ready && !item.busy && item.worker);
    if (!slot) return null;
    const deadlineMs = Math.max(1, Math.floor(Number(task.deadlineMs) || 1));
    const resource = new ComputeTaskResource();
    const promise = new Promise((resolve, reject) => {
      const current = {
        jobId: String(task.jobId), resolve, reject, resource,
        timer: setTimeout(() => {
          if (slot.current?.jobId !== String(task.jobId)) return;
          const error = computeError('compute_worker_deadline_exceeded', 504);
          this._retireCurrent(slot, error);
        }, deadlineMs)
      };
      current.timer.unref?.();
      slot.busy = true;
      slot.current = current;
      try {
        slot.worker.postMessage({ jobId: String(task.jobId), operation: String(task.operation), input: task.input });
      } catch (error) {
        this._retireCurrent(slot, computeError('compute_worker_dispatch_failed', 503, { cause: error }));
      }
    });
    return { workerIndex: slot.index, promise };
  }

  _retireCurrent(slot, error) {
    const worker = slot.worker;
    slot.ready = false;
    this._settle(slot, error, null, { keepUnavailable: true });
    if (worker) worker.terminate().catch(() => null);
  }

  cancel(jobId, reason = 'compute_job_cancelled') {
    const slot = this.slots.find(item => item.current?.jobId === String(jobId));
    if (!slot) return false;
    this._retireCurrent(slot, computeError(reason, 409));
    return true;
  }

  get idleCount() {
    return this.slots.filter(slot => slot.ready && !slot.busy && slot.worker).length;
  }

  get activeCount() {
    return this.slots.filter(slot => slot.busy).length;
  }

  stats() {
    return {
      size: this.size,
      ready: this.slots.filter(slot => slot.ready && !!slot.worker).length,
      active: this.activeCount,
      idle: this.idleCount,
      closing: this.closing
    };
  }

  close(options = {}) {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const graceMs = Math.max(0, Math.floor(Number(options.graceMs) || 0));
    this.closePromise = (async () => {
      if (graceMs > 0 && this.activeCount > 0) {
        await new Promise(resolve => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.off('available', onAvailable);
            resolve();
          };
          const timer = setTimeout(finish, graceMs);
          const onAvailable = () => {
            if (this.activeCount > 0) return;
            finish();
          };
          this.on('available', onAvailable);
        });
      }
      for (const slot of this.slots) {
        if (slot.current) this._settle(slot, computeError('compute_pool_shutdown', 503), null, { keepUnavailable: true });
      }
      const workers = this.slots.map(slot => slot.worker).filter(Boolean);
      await Promise.allSettled(workers.map(worker => worker.terminate()));
      for (const slot of this.slots) {
        slot.worker = null;
        slot.ready = false;
        slot.busy = false;
        slot.current = null;
      }
      this.emit('closed');
    })();
    return this.closePromise;
  }
}

module.exports = { WorkerPool };
