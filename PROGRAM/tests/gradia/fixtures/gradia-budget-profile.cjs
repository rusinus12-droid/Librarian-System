'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const MODEL = 'gpt-4o-mini-2024-07-18', ROUTE = 'https://api.openai.com/v1/chat/completions';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function createMeter(digest = sha) {
  const file = path.join(__dirname, '../../../sdk/GradiaEvidenceBudget.source.js');
  assert.ok(fs.existsSync(file), 'G2 named production budget factory must exist');
  const factory = new Function(`${fs.readFileSync(file, 'utf8')}\nreturn createGradiaEvidenceBudget;`)();
  assert.equal(typeof factory, 'function'); return factory({ digest });
}
function request(options = {}) {
  const evidence = options.evidence ?? 'COMPLETE_OWNER_ITEM: historical blue door.';
  const body = { model: MODEL, messages: [{ role: 'system', content: options.system ?? 'Keep native policy.' }, { role: 'user', content: options.user ?? 'Continue current scene.' }], temperature: 0.35, stream: false, max_completion_tokens: options.output ?? 16384 };
  const final = structuredClone(body); if (evidence) final.messages.at(-1).content += '\n\n' + evidence;
  return { providerId: 'openai', modelId: MODEL, routeIdentity: ROUTE, requestFormat: 'chat_completions', context: { source: 'configured', limit: options.context ?? 128000, sourceIdentity: 'configured:synthetic-preset-1', providerId: 'openai', modelId: MODEL, routeIdentity: ROUTE }, baseBody: JSON.stringify(body), finalBody: JSON.stringify(final), renderedEvidence: evidence, renderedByteLimit: 262144 };
}
function transformBoth(input, transform) { return { ...input, baseBody: JSON.stringify(transform(JSON.parse(input.baseBody))), finalBody: JSON.stringify(transform(JSON.parse(input.finalBody))) }; }
function envelope(input) { return { providerId: input.providerId, modelId: input.modelId, routeIdentity: input.routeIdentity, requestFormat: input.requestFormat, method: 'POST', body: input.finalBody }; }
module.exports = { createMeter, request, transformBoth, envelope, sha, MODEL, ROUTE };
