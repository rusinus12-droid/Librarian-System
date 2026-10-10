'use strict';

const assert = require('node:assert/strict');
const { FairScheduler } = require('../server/compute/fair_scheduler.cjs');

const job = (jobId, lane, namespace, queuedAt) => ({
  jobId,
  lane,
  namespace,
  queuedAt,
  requestBytes: 128
});

const now = Date.now();
const scheduler = new FairScheduler({
  poolSize: 4,
  maxQueueJobs: 64,
  maxQueueBytes: 1024 * 1024,
  agingThresholdMs: 1000
});

scheduler.enqueue(job('maintenance-aged-1', 'maintenance', 'flashback', now - 5000));
scheduler.enqueue(job('interactive-fresh-1', 'interactive', 'libra', now));

const first = scheduler.takeNext();
assert.equal(first.jobId, 'maintenance-aged-1', 'an aged lower-priority lane must eventually receive a dispatch slot');
const second = scheduler.takeNext();
assert.equal(second.jobId, 'interactive-fresh-1', 'an aged dispatch must not starve the interactive lane on the next slot');

scheduler.enqueue(job('background-aged-1', 'background', 'hayaku', now - 8000));
scheduler.enqueue(job('interactive-fresh-2', 'interactive', 'libra', now));
scheduler.enqueue(job('interactive-fresh-3', 'interactive', 'lia', now));

const third = scheduler.takeNext();
assert.equal(third.jobId, 'background-aged-1');
const fourth = scheduler.takeNext();
assert.match(fourth.jobId, /^interactive-fresh-/);
const fifth = scheduler.takeNext();
assert.match(fifth.jobId, /^interactive-fresh-/);

scheduler.enqueue(job('background-waiting', 'background', 'flashback', Date.now() - 2500));
const stats = scheduler.stats();
assert.equal(stats.agingThresholdMs, 1000);
assert.equal(stats.lanes.background.queued, 1);
assert.ok(stats.lanes.background.oldestWaitMs >= 2000);

console.log('compute scheduler aging and interactive anti-starvation passed');
