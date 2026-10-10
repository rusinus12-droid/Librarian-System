'use strict';

const crypto = require('node:crypto');

const COMPUTE_API_VERSION = 1;
const COMPUTE_SCHEMA_PREFIX = 'memory-suite.compute';
const COMPUTE_LANES = Object.freeze(['interactive', 'background', 'maintenance']);
const COMPUTE_NAMESPACES = Object.freeze(['flashback', 'hayaku', 'libra', 'lia', 'retrace']);

const DEFAULT_LIMITS = Object.freeze({
  maxRequestBytes: 8 * 1024 * 1024,
  maxResultBytes: 8 * 1024 * 1024,
  maxQueueJobs: 256,
  maxQueueBytes: 32 * 1024 * 1024,
  maxRetainedJobs: 1024,
  maxRetainedResultBytes: 64 * 1024 * 1024,
  jobRetentionMs: 15 * 60 * 1000,
  minDeadlineMs: 25,
  maxExecuteDeadlineMs: 30 * 1000,
  maxJobDeadlineMs: 5 * 60 * 1000,
  defaultExecuteDeadlineMs: 1500,
  defaultJobDeadlineMs: 60 * 1000,
  shutdownGraceMs: 1500
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function stableJson(value) {
  const seen = new Set();
  const visit = item => {
    if (item === null) return 'null';
    if (typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw computeError('compute_non_finite_number', 400);
      return Object.is(item, -0) ? '0' : JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw computeError('compute_cyclic_input', 400);
      seen.add(item);
      const encoded = `[${item.map(visit).join(',')}]`;
      seen.delete(item);
      return encoded;
    }
    if (typeof item === 'object') {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw computeError('compute_plain_json_required', 400);
      }
      if (seen.has(item)) throw computeError('compute_cyclic_input', 400);
      seen.add(item);
      const encoded = `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit(item[key])}`).join(',')}}`;
      seen.delete(item);
      return encoded;
    }
    throw computeError('compute_json_value_required', 400);
  };
  return visit(value);
}

function digestJson(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function computeError(code, statusCode = 500, details = {}) {
  const error = new Error(String(code || 'compute_error'));
  error.code = String(code || 'COMPUTE_ERROR').toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  error.statusCode = statusCode;
  error.compute = true;
  for (const [key, value] of Object.entries(details || {})) error[key] = value;
  return error;
}

function normalizeLimits(overrides = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const candidate = Number(overrides[key]);
    result[key] = Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : fallback;
  }
  return Object.freeze(result);
}

function validateLane(value, fallback = 'background') {
  const lane = String(value || fallback).trim().toLowerCase();
  if (!COMPUTE_LANES.includes(lane)) throw computeError('compute_invalid_lane', 400);
  return lane;
}

function validateNamespace(value) {
  const namespace = String(value || '').trim().toLowerCase();
  if (!COMPUTE_NAMESPACES.includes(namespace)) throw computeError('compute_invalid_namespace', 400);
  return namespace;
}

function validateOperationId(value) {
  const operationId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{12,240}$/.test(operationId)) {
    throw computeError('compute_invalid_operation_id', 400);
  }
  return operationId;
}

function validateJobId(value) {
  const jobId = String(value || '').trim();
  if (!/^cmp_[A-Za-z0-9_-]{16,80}$/.test(jobId)) throw computeError('compute_invalid_job_id', 400);
  return jobId;
}

function publicError(error) {
  const code = String(error?.code || 'COMPUTE_FAILED');
  const statusCode = Number(error?.statusCode || 500);
  const reason = String(error?.message || 'compute_failed');
  const retryAfterMs = Math.max(0, Number(error?.retryAfterMs || 0) || 0);
  return {
    ok: false,
    schema: `${COMPUTE_SCHEMA_PREFIX}.error.v1`,
    error: reason,
    code,
    fallback: {
      recommended: 'local',
      reason,
      ...(retryAfterMs ? { retryAfterMs } : {})
    }
  };
}

module.exports = {
  COMPUTE_API_VERSION,
  COMPUTE_SCHEMA_PREFIX,
  COMPUTE_LANES,
  COMPUTE_NAMESPACES,
  DEFAULT_LIMITS,
  sha256,
  stableJson,
  digestJson,
  jsonBytes,
  computeError,
  normalizeLimits,
  validateLane,
  validateNamespace,
  validateOperationId,
  validateJobId,
  publicError
};
