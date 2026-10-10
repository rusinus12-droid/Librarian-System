'use strict';
const { releaseVersion, releaseText, releasePattern } = require('./fixtures/release_versions.cjs');


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

assert.match(source, releasePattern("\\/\\/@version {libra}\\b", ""));
assert.match(source, /schema:\s*'libra\.provider_retry_governor\.v1'/);
assert.match(source, /maxCorrectiveRetries:[\s\S]{0,160}\b1\b/);
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'prompt_cache_unsupported'\)/, 'phase 10 disallows hidden prompt_cache_unsupported retries');
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'thinking_unsupported'\)/, 'phase 10 disallows hidden thinking_unsupported retries');
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'native_json_unsupported'\)/, 'phase 10 disallows hidden native_json_unsupported retries');
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'context_fit'\)/, 'phase 10 disallows hidden context_fit retries');
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'transient_error'\)/, 'phase 10 disallows hidden transient_error retries');
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'length_limit'\)/, 'phase 10 disallows hidden length_limit retries');
assert.doesNotMatch(source, /claimProviderCorrectiveRetry\(options,\s*'thinking_only'\)/, 'phase 10 disallows hidden thinking_only retries');

assert.match(source, /schema:\s*'libra\.canonical_provider_budget\.v2'/);
assert.match(source, /reserveVisibleRepairTokens:\s*librarianOnly\s*\?\s*0\s*:\s*canonicalBudgetNumber\([^,]+,\s*1200/);
assert.match(source, /reserveRepairCalls:\s*librarianOnly\s*\?\s*0\s*:\s*canonicalBudgetNumber\([^,]+,\s*1/);
assert.match(source, /Math\.ceil\(estimateContextTokensFromText\(`\$\{systemPrompt\}\\n\$\{userPrompt\}`\) \* 1\.15\)/);
assert.doesNotMatch(source, /maxInputTokens\s*=\s*Math\.max\(estimatedInputTokens/,
  'a single oversized prompt must not redefine and bypass the configured input-token ceiling');
assert.match(source, /reasoningBudgetCapTokens:\s*reservation\.reasoningBudgetTokens/);
assert.match(source, /remainingPhysicalCallSlots/);
assert.match(source, /effectiveReasoningBudgetTokens/);
assert.match(source, /profileBudget\s*=\s*\{\s*input:\s*activeStageCount\s*\*\s*120000,\s*output:\s*activeStageCount\s*\*\s*65536,[\s\S]{0,180}total:\s*activeStageCount\s*\*\s*185536/);
assert.match(source, /totalTokensReported/);
for (const field of ['inputTokens','outputTokens','thinkingTokens','cachedInputTokens','totalTokens']) {
  assert.match(source, new RegExp(`data\\.${field}\\b`),
    `Provider Manager normalized usage field ${field} must be recognized`);
}
assert.match(source, /postflight_\$\{breaches\.join\('_'\)\}_token_budget/);

assert.doesNotMatch(source, /type:\s*'authoritative_repair'/, 'retired memory ito cannot retain an automatic repair dispatch');
assert.match(source, /maxPhysicalCalls:\s*librarianOnly\s*\?\s*\(explicitRecovery\?2:1\)/);
assert.match(source, /maxCorrectiveAttemptsPerStage:\s*librarianOnly\s*\?\s*\(explicitRecovery\?1:0\)/);

assert.match(source, /schema:\s*'libra\.sga_provider_budget\.v2'/);
assert.match(source, /maxInputTokens/);
assert.match(source, /maxOutputTokens/);
assert.match(source, /maxReasoningTokens/);
assert.match(source, /maxTotalTokens/);
assert.match(source, /retryLedger:\s*\{\}/);
assert.match(source, /maxCorrectiveAttemptsPerCall:\s*1/);
assert.match(source, /sga_provider_retry_budget_exhausted/);
assert.match(source, /defaultInputTokens[\s\S]{0,400}defaultReasoningTokens[\s\S]{0,300}defaultTotalTokens/);
assert.match(source, /reasoningBudgetCapTokens:\s*reservation\.reasoningBudgetTokens/);

console.log('LIBRA canonical/SGA inference budget and single-repair contract passed');
