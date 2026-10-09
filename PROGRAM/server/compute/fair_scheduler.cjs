'use strict';

const { COMPUTE_LANES, computeError } = require('./contracts.cjs');

class FairScheduler {
  constructor(options = {}) {
    this.poolSize = Math.max(1, Math.floor(Number(options.poolSize) || 1));
    this.maxQueueJobs = Math.max(1, Math.floor(Number(options.maxQueueJobs) || 256));
    this.maxQueueBytes = Math.max(1024, Math.floor(Number(options.maxQueueBytes) || (32 * 1024 * 1024)));
    this.agingThresholdMs = Math.max(1000, Math.floor(Number(options.agingThresholdMs) || 15000));
    this.queues = new Map(COMPUTE_LANES.map(lane => [lane, new Map()]));
    this.cursors = new Map(COMPUTE_LANES.map(lane => [lane, 0]));
    this.activeByNamespace = new Map();
    this.activeByLane = new Map(COMPUTE_LANES.map(lane => [lane, 0]));
    this.queuedJobs = 0;
    this.queuedBytes = 0;
    this.accepting = true;
    this.lastDispatchWasAged = false;
  }

  enqueue(job) {
    if (!this.accepting) throw computeError('compute_scheduler_closed', 503);
    if (this.queuedJobs >= this.maxQueueJobs || this.queuedBytes + job.requestBytes > this.maxQueueBytes) {
      throw computeError('compute_overloaded', 429, { retryAfterMs: 50 });
    }
    const laneQueues = this.queues.get(job.lane);
    if (!laneQueues.has(job.namespace)) laneQueues.set(job.namespace, []);
    if (!Number.isFinite(Number(job.queuedAt)) || Number(job.queuedAt) <= 0) job.queuedAt = Date.now();
    laneQueues.get(job.namespace).push(job);
    this.queuedJobs += 1;
    this.queuedBytes += job.requestBytes;
  }

  _waitingNamespaces() {
    const waiting = new Set();
    for (const laneQueues of this.queues.values()) {
      for (const [namespace, queue] of laneQueues) if (queue.length) waiting.add(namespace);
    }
    return waiting;
  }

  queuedAheadForLane(lane) {
    const laneIndex = COMPUTE_LANES.indexOf(String(lane || 'background'));
    if (laneIndex < 0) return this.queuedJobs;
    let queued = 0;
    for (let index = 0; index <= laneIndex; index += 1) {
      const laneQueues = this.queues.get(COMPUTE_LANES[index]);
      for (const queue of laneQueues.values()) queued += queue.length;
    }
    return queued;
  }

  _oldestQueuedAt(lane) {
    const laneQueues = this.queues.get(lane);
    let oldest = Number.POSITIVE_INFINITY;
    for (const queue of laneQueues.values()) {
      if (!queue.length) continue;
      oldest = Math.min(oldest, Math.max(0, Number(queue[0]?.queuedAt || 0) || 0));
    }
    return Number.isFinite(oldest) ? oldest : 0;
  }

  _laneDispatchOrder(now = Date.now()) {
    const strict = COMPUTE_LANES.map((lane, index) => ({ lane, index, aged: false }));
    if (this.lastDispatchWasAged) return strict;
    const promoted = strict
      .map(entry => {
        const oldestQueuedAt = this._oldestQueuedAt(entry.lane);
        if (!oldestQueuedAt || entry.index === 0) return null;
        const waitMs = Math.max(0, now - oldestQueuedAt);
        const promotionSteps = Math.min(entry.index, Math.floor(waitMs / this.agingThresholdMs));
        if (promotionSteps <= 0) return null;
        return { ...entry, aged: true, waitMs, effectiveIndex: entry.index - promotionSteps };
      })
      .filter(Boolean)
      .sort((left, right) => (
        left.effectiveIndex - right.effectiveIndex
        || right.waitMs - left.waitMs
        || left.index - right.index
      ));
    const candidate = promoted[0];
    if (!candidate) return strict;
    return [candidate, ...strict.filter(entry => entry.lane !== candidate.lane)];
  }

  takeNext() {
    const waiting = this._waitingNamespaces();
    for (const dispatch of this._laneDispatchOrder()) {
      const lane = dispatch.lane;
      if (lane === 'maintenance' && this.poolSize > 1 && Number(this.activeByLane.get(lane) || 0) >= this.poolSize - 1) continue;
      const laneQueues = this.queues.get(lane);
      const namespaces = Array.from(laneQueues.keys()).filter(namespace => laneQueues.get(namespace)?.length);
      if (!namespaces.length) continue;
      let cursor = Number(this.cursors.get(lane) || 0) % namespaces.length;
      let selected = '';
      for (let offset = 0; offset < namespaces.length; offset += 1) {
        const namespace = namespaces[(cursor + offset) % namespaces.length];
        const ownActive = Number(this.activeByNamespace.get(namespace) || 0);
        const foreignNeedsFirstSlot = Array.from(waiting).some(other => other !== namespace && Number(this.activeByNamespace.get(other) || 0) === 0);
        if (ownActive > 0 && foreignNeedsFirstSlot) continue;
        selected = namespace;
        cursor = (cursor + offset + 1) % namespaces.length;
        break;
      }
      if (!selected) continue;
      this.cursors.set(lane, cursor);
      const queue = laneQueues.get(selected);
      const job = queue.shift();
      if (!queue.length) laneQueues.delete(selected);
      this.queuedJobs -= 1;
      this.queuedBytes = Math.max(0, this.queuedBytes - job.requestBytes);
      this.lastDispatchWasAged = dispatch.aged === true;
      return job;
    }
    return null;
  }

  markActive(job) {
    this.activeByNamespace.set(job.namespace, Number(this.activeByNamespace.get(job.namespace) || 0) + 1);
    this.activeByLane.set(job.lane, Number(this.activeByLane.get(job.lane) || 0) + 1);
  }

  markFinished(job) {
    const namespaceCount = Math.max(0, Number(this.activeByNamespace.get(job.namespace) || 0) - 1);
    if (namespaceCount) this.activeByNamespace.set(job.namespace, namespaceCount);
    else this.activeByNamespace.delete(job.namespace);
    this.activeByLane.set(job.lane, Math.max(0, Number(this.activeByLane.get(job.lane) || 0) - 1));
  }

  cancelQueued(jobId) {
    for (const laneQueues of this.queues.values()) {
      for (const [namespace, queue] of laneQueues) {
        const index = queue.findIndex(job => job.jobId === String(jobId));
        if (index < 0) continue;
        const [job] = queue.splice(index, 1);
        if (!queue.length) laneQueues.delete(namespace);
        this.queuedJobs -= 1;
        this.queuedBytes = Math.max(0, this.queuedBytes - job.requestBytes);
        return job;
      }
    }
    return null;
  }

  stopAccepting() {
    this.accepting = false;
  }

  drainQueued() {
    const jobs = [];
    for (const laneQueues of this.queues.values()) {
      for (const queue of laneQueues.values()) jobs.push(...queue);
      laneQueues.clear();
    }
    this.queuedJobs = 0;
    this.queuedBytes = 0;
    return jobs;
  }

  stats() {
    const now = Date.now();
    const lanes = {};
    for (const [lane, laneQueues] of this.queues) {
      const oldestQueuedAt = this._oldestQueuedAt(lane);
      lanes[lane] = {
        queued: Array.from(laneQueues.values()).reduce((sum, queue) => sum + queue.length, 0),
        active: Number(this.activeByLane.get(lane) || 0),
        oldestWaitMs: oldestQueuedAt ? Math.max(0, now - oldestQueuedAt) : 0
      };
    }
    return {
      accepting: this.accepting,
      queuedJobs: this.queuedJobs,
      queuedBytes: this.queuedBytes,
      agingThresholdMs: this.agingThresholdMs,
      lanes,
      activeByNamespace: Object.fromEntries(Array.from(this.activeByNamespace.entries()).sort())
    };
  }
}

module.exports = { FairScheduler };
