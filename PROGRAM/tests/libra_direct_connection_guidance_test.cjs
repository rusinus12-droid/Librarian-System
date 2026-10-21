'use strict';
// RED/GREEN guard for the direct-connection guidance in the connection settings UI.
//
// WHY THIS EXISTS
//
// LIBRA's built-in connection is the RisuAI auxiliary model, routed through the host's
// runLLMModel({ mode:'otherAx' }). That route is deliberately locked (it cannot be renamed, deleted
// or given credentials) and it is the fallback that lets a fresh install analyse memory with no
// setup at all. It is worth keeping for exactly that reason.
//
// But the host owns the generation parameters on that route. LIBRA cannot set an output-token
// budget, cannot enable streaming, and cannot choose the timeout: `invocationPlan` reports
// { outputCap: null, owner: 'host-managed' } and `callRisuAuxiliary` sends only
// { messages, mode, allowPlugins } to runLLMModel. Measured consequence: a five-turn batch asks the
// host for output it cannot bound, and the host's own 100-second upstream ceiling is what the user
// sees as a gateway timeout.
//
// A user who configures a DIRECT connection gets all of it back — LIBRA then sets maxTokens from
// the generation policy, streams when the route validates a stream protocol, and owns the timeout.
// None of that is discoverable today: the settings card describes what the auxiliary route IS, and
// never says what the user gives up by staying on it.
//
// WHAT IS ASSERTED
//
//   1. The RisuAI auxiliary card states that the host owns output parameters on that route.
//   2. It states the concrete remedy: a direct connection restores streaming, the output budget
//      and the timeout.
//   3. The claim is TRUE of the shipped code — the route really does omit those parameters and the
//      direct route really does send them — so the UI cannot drift into advertising a capability
//      the code does not have.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

(async () => {
  // ------------------------------------------------------------------------------------
  // 3. Ground the claim in the code first: what does each route actually send?
  // ------------------------------------------------------------------------------------
  // The auxiliary route must NOT send generation parameters.
  const auxiliaryCall = PLUGIN.match(/const response = await resolution\.api\.runLLMModel\(\{[\s\S]{0,320}?\}\);/);
  assert.ok(auxiliaryCall, 'the auxiliary route call must exist');
  assert.ok(!/maxTokens|max_tokens|stream/.test(auxiliaryCall[0]),
    'the auxiliary route must not pass generation parameters (the guidance says the host owns them)');

  // The direct route must send maxTokens, so "a direct connection restores the output budget" holds.
  assert.match(PLUGIN, /maxTokens: options\.maxTokens \|\| stageOutputTokenBudget/,
    'the direct route must compute an output budget the plugin owns');

  // Streaming must be validated per route, so "restores streaming" is conditional on the route.
  assert.match(PLUGIN, /streamingValidated:\s*!otherAx/,
    'streaming must be route-validated, so the guidance may promise it only for direct routes');

  // ------------------------------------------------------------------------------------
  // 1 + 2. The UI must say so.
  // ------------------------------------------------------------------------------------
  assert.match(PLUGIN, /RisuAI 보조 모델/,
    'the auxiliary connection card must still exist');

  // The card's note must carry the trade-off and the remedy, in Korean, near the card.
  // The approved GUI renders this card in buildApprovedAuxiliaryConnection (the old h2/sga-note card
  // was replaced); the card body runs to the next top-level builder.
  const card = PLUGIN.match(/const buildApprovedAuxiliaryConnection = [\s\S]*?(?=\n  const buildApproved)/);
  assert.ok(card, 'the auxiliary card body must be locatable');
  const cardText = card[0];

  assert.match(cardText, /호스트|RisuAI가|RisuAI 쪽|출력 토큰[^']*RisuAI 설정을 사용/,
    'the card must attribute output parameters to the host on this route');
  assert.match(cardText, /출력|토큰|budget/i,
    'the card must name the output budget as host-owned here');
  assert.match(cardText, /직접 연결/,
    'the card must name the direct connection as the remedy');
  assert.match(cardText, /스트리밍|stream/i,
    'the card must say a direct connection restores streaming');
  assert.match(cardText, /타임아웃|시간|timeout/i,
    'the card must say a direct connection restores the timeout');

  console.log(JSON.stringify({
    test: 'libra_direct_connection_guidance',
    auxiliaryOmitsGenerationParams: true,
    directRouteSetsOutputBudget: true,
    streamingIsRouteValidated: true,
    cardStatesHostOwnership: true,
    cardNamesDirectConnectionRemedy: true,
    cardNamesStreamingAndTimeout: true
  }, null, 1));
  process.stdout.write('libra_direct_connection_guidance_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
