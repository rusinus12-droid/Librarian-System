'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const {STORAGE_VARIANTS,extractStorageSdk,expectedStorageSdk}=require('./lib/sdk_variants.cjs');
const computeSdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteComputeClient.source.js'), 'utf8').trimEnd();
const hostLineageSdk = fs.readFileSync(path.join(root, 'sdk', 'MemorySuiteHostLineage.source.js'), 'utf8').trimEnd();
const norm = s => String(s || '').replace(/\r\n/g, '\n');
let failed = false;
for (const [name, {variant,embedsCompute}] of Object.entries(STORAGE_VARIANTS)) {
  const file = path.join(root, 'plugins', name);
  const text = fs.readFileSync(file, 'utf8');
  let sdk, embedded;
  try { sdk=expectedStorageSdk(root,name,text); embedded=extractStorageSdk(text,name); }
  catch(error){process.stdout.write(`${name}: ${error.message}\n`);failed=true;continue;}
  const count = text.split(sdk).length - 1;
  const computeCount = text.split(computeSdk).length - 1;
  const computeMarkerCount = (text.match(/\/\* LIBRARIAN SYSTEM COMPUTE SDK v/g) || []).length;
  const expected = crypto.createHash('sha256').update(sdk).digest('hex');
  const expectedCompute = crypto.createHash('sha256').update(computeSdk).digest('hex');
  const version = text.match(/^\/\/@version\s+(.+)$/m)?.[1]?.trim() || '?';
  const namespace = text.match(/createMemorySuiteStorageBridge\(\{[\s\S]{0,1200}?namespace:\s*['\"]([^'\"]+)['\"]/m)?.[1] || '?';
  const ok = count === 1 && embedded === sdk;
  const computeOk = embedsCompute ? computeCount === 1 && computeMarkerCount === 1 : computeCount === 0 && computeMarkerCount === 0;
  const computeLabel = embedsCompute
    ? (computeOk ? `OK:${expectedCompute.slice(0,12)}` : `MISMATCH(source=${computeCount},markers=${computeMarkerCount})`)
    : (computeOk ? 'NOT_EMBEDDED' : `UNEXPECTED(source=${computeCount},markers=${computeMarkerCount})`);
  process.stdout.write(`${name}: plugin=${version} namespace=${namespace} sdk=${ok ? 'OK' : `MISMATCH(count=${count})`} compute=${computeLabel} variant=${variant} sha256=${expected.slice(0,12)}\n`);
  const lineageOk = norm(text).split(norm(hostLineageSdk)).length - 1 === 1;
  process.stdout.write(`${name}: hostLineage=${lineageOk ? 'OK' : 'MISMATCH'}\n`);
  let consentOk = true;
  if (['LIBRA.js','Flashback_Memory.js','HAYAKU_Locator_Continuity.js'].includes(name)) {
    const consentFile = 'MemorySuiteSourceInput.libra.source.js';
    const consentSource = fs.readFileSync(path.join(root,'sdk',consentFile),'utf8').trimEnd();
    consentOk = norm(text).split(norm(consentSource)).length - 1 === 1;
    process.stdout.write(`${name}: consentProfile=${consentOk ? 'OK' : 'MISMATCH'}:${consentFile}\n`);
  }
  if (!ok || !computeOk || !lineageOk || !consentOk) failed = true;
}
if (failed) process.exitCode = 1;

require('node:child_process').execFileSync(process.execPath,[require('node:path').join(__dirname,'sync_source_review.cjs'),'--check'],{stdio:'inherit'});
require('./sync_chat_status.cjs').sync({ check:true });
require('./sync_current_status.cjs').sync({ check:true });
require('./sync_source_input_controls.cjs').sync({ check:true });
