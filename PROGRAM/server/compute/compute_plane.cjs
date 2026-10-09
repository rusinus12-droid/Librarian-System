'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { WorkerPool } = require('./worker_pool.cjs');
const { FairScheduler } = require('./fair_scheduler.cjs');
const { assertOperationAccess, capabilitiesForNamespace } = require('./registry.cjs');
const {
  COMPUTE_SCHEMA_PREFIX,
  digestJson,
  jsonBytes,
  computeError,
  normalizeLimits,
  validateLane,
  validateNamespace,
  validateOperationId,
  validateJobId
} = require('./contracts.cjs');

const terminalState = state => ['succeeded', 'failed', 'cancelled', 'expired'].includes(String(state || ''));

class ComputePlane {
  constructor(options = {}) {
    const parallelism = Math.max(1, Number(os.availableParallelism?.() || 1));
    this.configured = options.configured !== false;
    this.enabled = options.enabled !== false;
    this.allowTestOperations = options.allowTestOperations === true;
    this.searchCorpora = new Map();
    this.searchCorpusBytes = 0;
    this.limits = normalizeLimits(options.limits || {});
    this.poolSize = Math.max(1, Math.min(16, Math.floor(Number(options.poolSize) || Math.min(4, Math.max(1, parallelism - 1)))));
    this.pool = new WorkerPool({
      size: this.poolSize,
      workerPath: options.workerPath || path.join(__dirname, 'compute_worker.cjs'),
      allowTestOperations: this.allowTestOperations,
      ...(options.resourceLimits || {})
    });
    this.scheduler = new FairScheduler({
      poolSize: this.poolSize,
      maxQueueJobs: this.limits.maxQueueJobs,
      maxQueueBytes: this.limits.maxQueueBytes,
      agingThresholdMs: options.schedulerAgingThresholdMs
    });
    this.jobs = new Map();
    this.operationIndex = new Map();
    this.ewmaMs = new Map();
    this.activePromises = new Set();
    this.started = false;
    this.ready = false;
    this.startError = String(options.startupError || '');
    this.unavailableReason = this.startError || '';
    this.closing = false;
    this.closePromise = null;
    this.pruneTimer = null;
    this.pool.on('available', () => this._drain());
    this.pool.on('taskStarted', event => {
      const job = this.jobs.get(String(event.jobId || ''));
      if (!job || job.state !== 'running') return;
      job.workerIndex = event.workerIndex;
      job.startedAt = Number(event.startedAt || Date.now());
    });
    this.pool.on('poolError', error => {
      this.startError = String(error?.message || error);
      this.unavailableReason = 'compute_worker_pool_unavailable';
    });
  }

  async start() {
    if (!this.enabled) return this.stats();
    if (this.started) return this.stats();
    this.started = true;
    try {
      await this.pool.start();
      this.ready = true;
      this.startError = null;
      this.unavailableReason = '';
      this.pruneTimer = setInterval(() => this._prune(), Math.min(60000, this.limits.jobRetentionMs));
      this.pruneTimer.unref?.();
    } catch (error) {
      this.ready = false;
      this.startError = String(error?.message || error);
      this.unavailableReason = 'compute_worker_pool_unavailable';
    }
    return this.stats();
  }

  capabilities(namespace) {
    const ownerNamespace = validateNamespace(namespace);
    return {
      schema: `${COMPUTE_SCHEMA_PREFIX}.capabilities.v1`,
      configured: this.configured,
      enabled: this.enabled,
      ready: this.ready,
      workerPool: this.pool.stats(),
      lanes: ['interactive', 'background', 'maintenance'],
      durability: 'memory_only',
      operations: capabilitiesForNamespace(ownerNamespace, { allowTestOperations: this.allowTestOperations }),
      limits: { ...this.limits },
      ...(this.unavailableReason ? { unavailableReason: this.unavailableReason } : {})
    };
  }

  _assertAvailable() {
    if (!this.enabled) throw computeError('compute_disabled', 503, { retryAfterMs: 1000 });
    if (this.closing) throw computeError('compute_server_closing', 503, { retryAfterMs: 1000 });
    if (!this.ready) throw computeError('compute_unavailable', 503, { retryAfterMs: 250 });
  }

  _normalizeSubmission(principal, body, mode) {
    this._assertAvailable();
    const namespace = validateNamespace(body?.namespace);
    if (String(principal?.namespace || '') !== namespace || !Array.isArray(principal?.roles) || !principal.roles.includes('compute')) {
      throw computeError('compute_namespace_forbidden', 403);
    }
    const operation = String(body?.operation || '').trim();
    const algorithmFingerprint = String(body?.algorithmFingerprint || '').trim();
    const definition = assertOperationAccess(operation, namespace, algorithmFingerprint, { allowTestOperations: this.allowTestOperations });
    const operationId = validateOperationId(body?.operationId);
    if (!Object.prototype.hasOwnProperty.call(body || {}, 'input')) throw computeError('compute_input_required', 400);
    let input = body.input;
    let corpusId = '';
    const isSearch = /^(flashback|hayaku|libra)\.memory-search\.v1$/.test(operation);
    if (isSearch) {
      const prefix = namespace + '\u0000' + operation + '\u0000' + digestJson(body.binding || {}) + '\u0000';
      const current = Date.now();
      for (const [key, item] of this.searchCorpora) if (current - item.at > 300000) {
        this.searchCorpora.delete(key); this.searchCorpusBytes -= item.bytes;
      }
      if (input?.corpusId && !input.corpus) {
        const cached = this.searchCorpora.get(prefix + String(input.corpusId));
        if (!cached) throw computeError('compute_search_corpus_missing', 410);
        corpusId = String(input.corpusId);
        input = { ...input, corpus: cached.value }; delete input.corpusId;
        cached.at = current;
      } else if (input?.corpus) {
        corpusId = digestJson(input.corpus);
      }
      if (!corpusId) throw computeError('compute_search_corpus_invalid', 400);
    }
    const calculatedInputDigest = digestJson(input);
    const suppliedInputDigest = String(body?.inputDigest || '').trim();
    if (suppliedInputDigest && suppliedInputDigest !== calculatedInputDigest) throw computeError('compute_input_digest_mismatch', 409);
    const binding = body?.binding == null ? {} : body.binding;
    digestJson(binding);
    if (jsonBytes(binding) > 64 * 1024) throw computeError('compute_binding_too_large', 413);
    const lane = validateLane(body?.lane, mode === 'execute' ? 'interactive' : 'background');
    const maximum = Math.min(definition.maxDeadlineMs, mode === 'execute' ? this.limits.maxExecuteDeadlineMs : this.limits.maxJobDeadlineMs);
    const fallback = mode === 'execute' ? this.limits.defaultExecuteDeadlineMs : this.limits.defaultJobDeadlineMs;
    const deadlineMs = Math.min(maximum, Math.floor(Number(body?.deadlineMs) || fallback));
    if (deadlineMs < this.limits.minDeadlineMs) {
      throw computeError('compute_deadline_too_short', 429, { retryAfterMs: this.limits.minDeadlineMs });
    }
    const requestBytes = jsonBytes(body);
    if (requestBytes > this.limits.maxRequestBytes) throw computeError('compute_request_too_large', 413);
    if (isSearch) {
      if (jsonBytes(input) > this.limits.maxRequestBytes) throw computeError('compute_request_too_large', 413);
      const key = namespace + '\u0000' + operation + '\u0000' + digestJson(binding) + '\u0000' + corpusId;
      if (!this.searchCorpora.has(key)) {
        const bytes = jsonBytes(input.corpus);
        while (this.searchCorpusBytes + bytes > 32 * 1024 * 1024 || this.searchCorpora.size >= 32) {
          const first = this.searchCorpora.keys().next().value;
          if (first === undefined) break;
          this.searchCorpusBytes -= this.searchCorpora.get(first).bytes; this.searchCorpora.delete(first);
        }
        this.searchCorpora.set(key, {value: JSON.parse(JSON.stringify(input.corpus)), bytes, at: Date.now()});
        this.searchCorpusBytes += bytes;
      }
    }
    const executionFingerprint = digestJson({ namespace, operation, algorithmFingerprint, inputDigest: calculatedInputDigest, binding });
    return {
      namespace, operation, operationId, algorithmFingerprint, definition, input,
      inputDigest: calculatedInputDigest, binding, lane, deadlineMs, requestBytes: Math.max(requestBytes, jsonBytes(input)), executionFingerprint,
      corpusId
    };
  }

  _existingSubmission(normalized) {
    const operationKey = `${normalized.namespace}\u0000${normalized.operationId}`;
    const existingJobId = this.operationIndex.get(operationKey);
    if (!existingJobId) return null;
    const existing = this.jobs.get(existingJobId);
    if (!existing) {
      this.operationIndex.delete(operationKey);
      return null;
    }
    if (existing.executionFingerprint !== normalized.executionFingerprint) {
      throw computeError('compute_operation_id_payload_conflict', 409);
    }
    return existing;
  }

  _admit(normalized) {
    // Lower-priority backlog cannot delay a higher-priority job once a worker
    // becomes free, so it must not make interactive/background admission fail.
    const activeAndQueued = this.pool.activeCount + this.scheduler.queuedAheadForLane(normalized.lane);
    const averageMs = Math.max(5, Number(this.ewmaMs.get(normalized.operation) || 50));
    const predictedWaves = Math.floor(activeAndQueued / Math.max(1, this.poolSize));
    const predictedWaitMs = predictedWaves * averageMs;
    if (this.pool.idleCount === 0 && predictedWaitMs >= normalized.deadlineMs) {
      throw computeError('compute_deadline_would_expire', 429, { retryAfterMs: Math.ceil(averageMs) });
    }
  }

  _createJob(normalized) {
    this._admit(normalized);
    const createdAt = Date.now();
    const jobId = `cmp_${crypto.randomBytes(18).toString('base64url')}`;
    let complete;
    const completion = new Promise(resolve => { complete = resolve; });
    const job = {
      schema: `${COMPUTE_SCHEMA_PREFIX}.job.v1`,
      jobId,
      operationKey: `${normalized.namespace}\u0000${normalized.operationId}`,
      namespace: normalized.namespace,
      operation: normalized.operation,
      operationId: normalized.operationId,
      algorithmFingerprint: normalized.algorithmFingerprint,
      executionFingerprint: normalized.executionFingerprint,
      inputDigest: normalized.inputDigest,
      binding: normalized.binding,
      lane: normalized.lane,
      deadlineMs: normalized.deadlineMs,
      deadlineAt: createdAt + normalized.deadlineMs,
      requestBytes: normalized.requestBytes,
      input: normalized.corpusId ? {...normalized.input, _corpusId: normalized.corpusId} : normalized.input,
      state: 'queued',
      createdAt,
      queuedAt: createdAt,
      startedAt: 0,
      completedAt: 0,
      workerIndex: null,
      result: undefined,
      resultDigest: '',
      resultBytes: 0,
      error: '',
      errorCode: '',
      completion,
      complete,
      deadlineTimer: null
    };
    this.scheduler.enqueue(job);
    this.jobs.set(jobId, job);
    this.operationIndex.set(job.operationKey, jobId);
    job.deadlineTimer = setTimeout(() => this._expire(job), normalized.deadlineMs);
    job.deadlineTimer.unref?.();
    this._prune();
    this._drain();
    return job;
  }

  _submit(principal, body, mode) {
    const normalized = this._normalizeSubmission(principal, body, mode);
    const existing = this._existingSubmission(normalized);
    return existing || this._createJob(normalized);
  }

  async execute(principal, body) {
    const job = this._submit(principal, body, 'execute');
    await job.completion;
    if (job.state !== 'succeeded') throw this._jobError(job);
    return this._publicResult(job);
  }

  submitJob(principal, body) {
    return this._publicJob(this._submit(principal, body, 'job'));
  }

  _jobError(job) {
    const statusCode = job.state === 'expired' ? 504 : job.state === 'cancelled' ? 409 : Number(job.failureStatusCode || 500);
    const error = computeError(job.error || `compute_job_${job.state}`, statusCode);
    error.code = job.errorCode || error.code;
    return error;
  }

  _expire(job) {
    if (terminalState(job.state)) return;
    if (job.state === 'queued') {
      this.scheduler.cancelQueued(job.jobId);
      this._finishFailure(job, computeError('compute_job_deadline_expired', 504), 'expired');
      this._drain();
      return;
    }
    if (job.state === 'running') this.pool.cancel(job.jobId, 'compute_job_deadline_expired');
  }

  _drain() {
    if (!this.ready || this.closing) return;
    while (this.pool.idleCount > 0) {
      const job = this.scheduler.takeNext();
      if (!job) return;
      const remainingMs = job.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        this._finishFailure(job, computeError('compute_job_deadline_expired', 504), 'expired');
        continue;
      }
      job.state = 'running';
      job.startedAt = Date.now();
      this.scheduler.markActive(job);
      const dispatched = this.pool.dispatch({ jobId: job.jobId, operation: job.operation, input: job.input, deadlineMs: remainingMs });
      if (!dispatched) {
        job.state = 'queued';
        this.scheduler.markFinished(job);
        this.scheduler.enqueue(job);
        return;
      }
      job.workerIndex = dispatched.workerIndex;
      const active = dispatched.promise
        .then(value => this._finishSuccess(job, value))
        .catch(error => this._finishFailure(job, error, String(error?.message || '').includes('deadline') ? 'expired' : undefined))
        .finally(() => {
          this.scheduler.markFinished(job);
          this.activePromises.delete(active);
          this._drain();
        });
      this.activePromises.add(active);
    }
  }

  _finishSuccess(job, value) {
    if (terminalState(job.state)) return;
    const resultBytes = jsonBytes(value?.result);
    if (resultBytes > this.limits.maxResultBytes) {
      this._finishFailure(job, computeError('compute_result_too_large', 413));
      return;
    }
    const completedAt = Date.now();
    job.state = 'succeeded';
    job.completedAt = completedAt;
    job.result = value.result;
    job.resultDigest = digestJson(value.result);
    job.resultBytes = resultBytes;
    job.workerTiming = value.timing || {};
    delete job.input;
    this._complete(job);
    const workerMs = Math.max(0, Number(job.workerTiming?.workerMs || completedAt - job.startedAt));
    const prior = Number(this.ewmaMs.get(job.operation) || workerMs || 1);
    this.ewmaMs.set(job.operation, (prior * 0.75) + (workerMs * 0.25));
    this._prune();
  }

  _finishFailure(job, error, forcedState) {
    if (terminalState(job.state)) return;
    const message = String(error?.message || 'compute_job_failed');
    const cancelled = forcedState === 'cancelled' || message.includes('cancel');
    job.state = forcedState || (cancelled ? 'cancelled' : 'failed');
    job.completedAt = Date.now();
    job.error = message.slice(0, 240);
    job.errorCode = String(error?.code || 'COMPUTE_JOB_FAILED');
    job.failureStatusCode = Number(error?.statusCode || 500);
    delete job.input;
    this._complete(job);
    this._prune();
  }

  _complete(job) {
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    job.deadlineTimer = null;
    const complete = job.complete;
    job.complete = null;
    complete?.(this._publicJob(job));
  }

  _ownedJob(principal, jobId) {
    const normalized = validateJobId(jobId);
    const job = this.jobs.get(normalized);
    if (!job) throw computeError('compute_job_not_found', 404);
    if (String(principal?.namespace || '') !== job.namespace || !Array.isArray(principal?.roles) || !principal.roles.includes('compute')) {
      throw computeError('compute_job_not_found', 404);
    }
    return job;
  }

  status(principal, jobId) {
    return this._publicJob(this._ownedJob(principal, jobId));
  }

  result(principal, jobId) {
    const job = this._ownedJob(principal, jobId);
    if (job.state === 'succeeded') return this._publicResult(job);
    if (!terminalState(job.state)) throw computeError('compute_job_not_ready', 425, { retryAfterMs: 25 });
    throw this._jobError(job);
  }

  cancel(principal, jobId) {
    const job = this._ownedJob(principal, jobId);
    if (terminalState(job.state)) return { ...this._publicJob(job), cancelAccepted: false };
    if (job.state === 'queued') {
      this.scheduler.cancelQueued(job.jobId);
      this._finishFailure(job, computeError('compute_job_cancelled', 409), 'cancelled');
    } else {
      this.pool.cancel(job.jobId, 'compute_job_cancelled');
    }
    return { ...this._publicJob(job), cancelAccepted: true };
  }

  cancelOperation(principal, operationId) {
    const normalizedOperationId = validateOperationId(operationId);
    const operationKey = `${String(principal?.namespace || '')}\u0000${normalizedOperationId}`;
    const jobId = this.operationIndex.get(operationKey);
    if (!jobId) return false;
    const job = this.jobs.get(jobId);
    if (!job || terminalState(job.state)) return false;
    this.cancel(principal, jobId);
    return true;
  }

  _publicJob(job) {
    return {
      schema: `${COMPUTE_SCHEMA_PREFIX}.job.v1`,
      jobId: job.jobId,
      namespace: job.namespace,
      operation: job.operation,
      operationId: job.operationId,
      algorithmFingerprint: job.algorithmFingerprint,
      inputDigest: job.inputDigest,
      binding: job.binding,
      lane: job.lane,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      deadlineMs: job.deadlineMs,
      ...(job.resultDigest ? { resultDigest: job.resultDigest, resultBytes: job.resultBytes } : {}),
      ...(job.error ? { error: job.error, code: job.errorCode } : {})
    };
  }

  _publicResult(job) {
    return {
      schema: `${COMPUTE_SCHEMA_PREFIX}.result.v1`,
      jobId: job.jobId,
      operationId: job.operationId,
      namespace: job.namespace,
      operation: job.operation,
      algorithmFingerprint: job.algorithmFingerprint,
      inputDigest: job.inputDigest,
      binding: job.binding,
      result: job.result,
      resultDigest: job.resultDigest,
      timing: {
        queueMs: Math.max(0, job.startedAt - job.createdAt),
        workerMs: Math.max(0, Number(job.workerTiming?.workerMs || 0)),
        totalMs: Math.max(0, job.completedAt - job.createdAt)
      }
    };
  }

  _prune() {
    const now = Date.now();
    const terminal = Array.from(this.jobs.values())
      .filter(job => terminalState(job.state))
      .sort((left, right) => left.completedAt - right.completedAt);
    let retainedResultBytes = terminal.reduce((sum, job) => sum + Math.max(0, Number(job.resultBytes || 0)), 0);
    for (const job of terminal) {
      const expired = now - job.completedAt > this.limits.jobRetentionMs;
      const tooMany = this.jobs.size > this.limits.maxRetainedJobs;
      const tooLarge = retainedResultBytes > this.limits.maxRetainedResultBytes;
      if (!expired && !tooMany && !tooLarge) continue;
      this.jobs.delete(job.jobId);
      if (this.operationIndex.get(job.operationKey) === job.jobId) this.operationIndex.delete(job.operationKey);
      retainedResultBytes = Math.max(0, retainedResultBytes - Math.max(0, Number(job.resultBytes || 0)));
    }
  }

  stats() {
    const states = {};
    for (const job of this.jobs.values()) states[job.state] = Number(states[job.state] || 0) + 1;
    return {
      schema: `${COMPUTE_SCHEMA_PREFIX}.stats.v1`,
      configured: this.configured,
      enabled: this.enabled,
      started: this.started,
      ready: this.ready,
      closing: this.closing,
      pool: this.pool.stats(),
      scheduler: this.scheduler.stats(),
      jobs: states,
      retainedJobs: this.jobs.size,
      retainedResultBytes: Array.from(this.jobs.values()).reduce((sum, job) => sum + Math.max(0, Number(job.resultBytes || 0)), 0),
      ...(this.unavailableReason ? { unavailableReason: this.unavailableReason } : {})
    };
  }

  close(options = {}) {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.ready = false;
    this.scheduler.stopAccepting();
    for (const job of this.scheduler.drainQueued()) this._finishFailure(job, computeError('compute_pool_shutdown', 503), 'cancelled');
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.closePromise = (async () => {
      await this.pool.close({ graceMs: Number(options.graceMs ?? this.limits.shutdownGraceMs) });
      await Promise.allSettled(Array.from(this.activePromises));
      this.searchCorpora.clear(); this.searchCorpusBytes = 0;
    })();
    return this.closePromise;
  }
}

function createComputePlane(options = {}) {
  return new ComputePlane(options);
}

module.exports = { ComputePlane, createComputePlane };
