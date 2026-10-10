'use strict';

// Fixture-only lifecycle join. Observe and await real work; never manufacture idle.
async function awaitScopeRetirement(runtime, scopeKey, timeoutMs = 5000) {
  if (!(runtime?.externalRetirementInFlight instanceof Map)
      && typeof runtime?.externalRetirementInFlight?.get !== 'function') {
    throw new Error('fixture_retirement_runtime_unavailable');
  }
  let timer;
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const pending = runtime.externalRetirementInFlight.get(scopeKey);
          if (!pending) return;
          await pending;
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_retirement_did_not_settle')), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { awaitScopeRetirement };
