'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemorySuiteServer } = require('../server/server.cjs');

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'server.cjs'), 'utf8');
assert.match(serverSource, /const KV_KEYS_PAGE_DEFAULT = 400;/);
assert.match(serverSource, /const KV_KEYS_PAGE_MAX = 1000;/);
assert.match(serverSource, /const KV_GET_MANY_RESPONSE_BYTES_DEFAULT = 4 \* 1024 \* 1024;/);
assert.match(serverSource, /const KV_GET_MANY_RESPONSE_BYTES_MIN = 256 \* 1024;/);
assert.match(serverSource, /const KV_GET_MANY_RESPONSE_BYTES_MAX = 8 \* 1024 \* 1024;/);
const getManyStart = serverSource.indexOf('const getMany =');
const getManyEnd = serverSource.indexOf('const operation =', getManyStart);
assert.notEqual(getManyStart, -1);
assert.notEqual(getManyEnd, -1);
const getManySource = serverSource.slice(getManyStart, getManyEnd);
assert.ok(getManySource.indexOf('row?.value_bytes') < getManySource.indexOf('decodeRow(row)'),
  'oversized rows must be classified from SQLite byte metadata before JSON.parse/decodeRow');

async function readJson(response) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch (_) { throw new Error(`invalid_json_response:${response.status}:${text.slice(0, 200)}`); }
  return { response, payload };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-pagination-budget-'));
  const app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false, computeEnabled: false });
  const address = await app.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bootstrap = await readJson(await fetch(`${baseUrl}/bootstrap`, {
      headers: {
        'X-Memory-Suite-Plugin': 'flashback_memory',
        'X-Memory-Suite-Plugin-Version': '1.0.18'
      }
    }));
    assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.payload));
    assert.equal(bootstrap.payload.capabilities['keys-pagination.v1'], true);
    assert.equal(bootstrap.payload.capabilities['server-batch-read-budget.v1'], true);
    assert.equal(bootstrap.payload.capabilities['interactive-storage-soft-cap.v1'], true);

    const headers = {
      Authorization: `Bearer ${bootstrap.payload.token}`,
      'Content-Type': 'application/json',
      'X-Memory-Suite-Plugin': 'flashback_memory',
      'X-Memory-Suite-Plugin-Version': '1.0.18'
    };
    const request = async (method, route, body) => readJson(await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    let operation = 0;
    const setValue = async (key, value) => {
      operation += 1;
      const result = await request('POST', '/v1/kv/set', {
        namespace: 'flashback',
        operationId: `pagination_budget_set_${String(operation).padStart(6, '0')}`,
        space: 'plugin',
        key,
        value
      });
      assert.equal(result.response.status, 200, `${key}:${JSON.stringify(result.payload).slice(0, 500)}`);
      assert.equal(result.payload.result.verified, true);
      return result.payload.result;
    };

    const literalPrefix = 'flashback:literal%_\\:';
    const expectedKeys = [];
    for (let index = 0; index < 17; index += 1) {
      const key = `${literalPrefix}${String(index).padStart(2, '0')}`;
      expectedKeys.push(key);
      await setValue(key, { index, payload: `row-${index}` });
    }

    const collected = [];
    let cursor = '';
    let pageCount = 0;
    do {
      const query = new URLSearchParams({
        namespace: 'flashback',
        space: 'plugin',
        prefix: literalPrefix,
        paged: '1',
        limit: '5',
        ...(cursor ? { cursor } : {})
      });
      const page = await request('GET', `/v1/kv/keys?${query.toString()}`);
      assert.equal(page.response.status, 200, JSON.stringify(page.payload));
      assert.equal(page.payload.result.page.schema, 'memory-suite.storage-key-page.v1');
      assert.ok(page.payload.result.records.length <= 5);
      collected.push(...page.payload.result.keys);
      cursor = page.payload.result.nextCursor || '';
      pageCount += 1;
      assert.ok(pageCount < 20, 'key pagination must terminate');
    } while (cursor);
    assert.equal(pageCount, 4);
    assert.deepEqual(collected, expectedKeys);
    assert.equal(new Set(collected).size, expectedKeys.length);

    const firstPageQuery = new URLSearchParams({
      namespace: 'flashback', space: 'plugin', prefix: literalPrefix, paged: '1', limit: '2'
    });
    const firstPage = await request('GET', `/v1/kv/keys?${firstPageQuery.toString()}`);
    const mismatchQuery = new URLSearchParams({
      namespace: 'flashback', space: 'plugin', prefix: 'flashback:different:', paged: '1', limit: '2', cursor: firstPage.payload.result.nextCursor
    });
    const mismatch = await request('GET', `/v1/kv/keys?${mismatchQuery.toString()}`);
    assert.equal(mismatch.response.status, 400);
    assert.equal(mismatch.payload.error, 'storage_cursor_prefix_mismatch');

    const spaceMismatchQuery = new URLSearchParams({
      namespace: 'flashback', space: 'local', prefix: literalPrefix, paged: '1', limit: '2', cursor: firstPage.payload.result.nextCursor
    });
    const spaceMismatch = await request('GET', `/v1/kv/keys?${spaceMismatchQuery.toString()}`);
    assert.equal(spaceMismatch.response.status, 400);
    assert.equal(spaceMismatch.payload.error, 'storage_cursor_scope_mismatch');

    const hayakuBootstrap = await readJson(await fetch(`${baseUrl}/bootstrap`, {
      headers: {
        'X-Memory-Suite-Plugin': 'hayaku_locator_continuity',
        'X-Memory-Suite-Plugin-Version': '3.0.26'
      }
    }));
    assert.equal(hayakuBootstrap.response.status, 200, JSON.stringify(hayakuBootstrap.payload));
    const namespaceMismatch = await readJson(await fetch(`${baseUrl}/v1/kv/keys?${new URLSearchParams({
      namespace: 'hayaku', space: 'plugin', prefix: literalPrefix, paged: '1', limit: '2', cursor: firstPage.payload.result.nextCursor
    }).toString()}`, {
      headers: {
        Authorization: `Bearer ${hayakuBootstrap.payload.token}`,
        'X-Memory-Suite-Plugin': 'hayaku_locator_continuity',
        'X-Memory-Suite-Plugin-Version': '3.0.26'
      }
    }));
    assert.equal(namespaceMismatch.response.status, 400);
    assert.equal(namespaceMismatch.payload.error, 'storage_cursor_scope_mismatch');

    const pageKeys = [];
    for (let index = 0; index < 3; index += 1) {
      const key = `flashback:page-value:${index}`;
      pageKeys.push(key);
      await setValue(key, { index, text: 'p'.repeat(180 * 1024) });
    }
    const pagedValues = {};
    let valueCursor = 0;
    let valuePages = 0;
    do {
      const page = await request('POST', '/v1/kv/get-many', {
        namespace: 'flashback',
        space: 'plugin',
        keys: pageKeys,
        paged: true,
        cursor: valueCursor,
        maxResponseBytes: 256 * 1024
      });
      assert.equal(page.response.status, 200, JSON.stringify(page.payload).slice(0, 500));
      Object.assign(pagedValues, page.payload.result.values);
      assert.equal(page.payload.result.continuation.schema, 'memory-suite.storage-get-many-continuation.v1');
      assert.ok(page.payload.result.continuation.estimatedResponseBytes <= 256 * 1024);
      valueCursor = page.payload.result.continuation.nextCursor;
      valuePages += 1;
      assert.ok(valuePages < 10, 'get-many pagination must terminate');
    } while (valueCursor != null);
    assert.equal(valuePages, 3);
    assert.deepEqual(Object.keys(pagedValues), pageKeys);
    for (const key of pageKeys) assert.equal(pagedValues[key].value.text.length, 180 * 1024);

    const oversizedKey = 'flashback:oversized-page-value';
    await setValue(oversizedKey, { text: 'o'.repeat(300 * 1024) });
    const oversizedPage = await request('POST', '/v1/kv/get-many', {
      namespace: 'flashback',
      space: 'plugin',
      keys: [oversizedKey],
      paged: true,
      maxResponseBytes: 256 * 1024
    });
    assert.equal(oversizedPage.response.status, 200);
    assert.deepEqual(oversizedPage.payload.result.oversizedKeys, [oversizedKey]);
    assert.deepEqual(oversizedPage.payload.result.values, {});
    assert.equal(oversizedPage.payload.result.continuation.complete, true);

    const bulkKeys = [];
    for (let index = 0; index < 3; index += 1) {
      const key = `flashback:bulk-value:${index}`;
      bulkKeys.push(key);
      await setValue(key, { index, text: 'b'.repeat(1536 * 1024) });
    }
    const defaultBudgetWithinLimit = await request('POST', '/v1/kv/get-many', {
      namespace: 'flashback',
      space: 'plugin',
      keys: bulkKeys.slice(0, 2)
    });
    assert.equal(defaultBudgetWithinLimit.response.status, 200,
      'two 1.5 MiB records must fit inside the 4 MiB default batch-response budget');
    assert.deepEqual(Object.keys(defaultBudgetWithinLimit.payload.result.values), bulkKeys.slice(0, 2));

    const unpagedTooLarge = await request('POST', '/v1/kv/get-many', {
      namespace: 'flashback',
      space: 'plugin',
      keys: bulkKeys
    });
    assert.equal(unpagedTooLarge.response.status, 413,
      'three 1.5 MiB records must exceed the 4 MiB default batch-response budget');
    assert.equal(unpagedTooLarge.payload.error, 'kv_get_many_response_too_large_use_pagination');

    const raisedBudget = await request('POST', '/v1/kv/get-many', {
      namespace: 'flashback',
      space: 'plugin',
      keys: bulkKeys,
      paged: true,
      maxResponseBytes: 8 * 1024 * 1024
    });
    assert.equal(raisedBudget.response.status, 200);
    assert.deepEqual(Object.keys(raisedBudget.payload.result.values), bulkKeys);
    assert.equal(raisedBudget.payload.result.continuation.maxResponseBytes, 8 * 1024 * 1024);
    assert.equal(raisedBudget.payload.result.continuation.complete, true);

    const clampedMinimumBudget = await request('POST', '/v1/kv/get-many', {
      namespace: 'flashback',
      space: 'plugin',
      keys: [oversizedKey],
      paged: true,
      maxResponseBytes: 1
    });
    assert.equal(clampedMinimumBudget.response.status, 200);
    assert.equal(clampedMinimumBudget.payload.result.continuation.maxResponseBytes, 256 * 1024);
    assert.deepEqual(clampedMinimumBudget.payload.result.oversizedKeys, [oversizedKey]);

    const hugeBody = JSON.stringify({
      namespace: 'flashback',
      operationId: 'pagination_budget_huge_000001',
      space: 'plugin',
      key: 'flashback:huge-single-value',
      value: { text: 'x'.repeat(4608 * 1024) }
    });
    const huge = await readJson(await fetch(`${baseUrl}/v1/kv/set`, {
      method: 'POST',
      headers,
      body: hugeBody
    }));
    assert.equal(huge.response.status, 413);
    assert.equal(huge.payload.error, 'interactive_storage_request_too_large_use_shards');
    assert.ok(Number(huge.payload.maxBytes || 0) >= 4 * 1024 * 1024);

    console.log('storage pagination and byte-budget contract passed');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
