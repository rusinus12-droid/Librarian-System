'use strict';
/**
 * RisuAI Compatibility Contract Verifier
 *
 * Verifies:
 * 1. upstream-lock.json against a checked-out RisuAI upstream directory (repository, commit, SHA-256 hashes)
 * 2. Librarian RisuAI API usage inventory against reviewed api-surface.json (and live upstream dtsSurface)
 *    - Fails with UNMAPPED_RISUAI_API_USAGE if a plugin uses an unmapped RisuAI API
 *    - Fails with RISUAI_API_SIGNATURE_INCOMPATIBLE if upstream removes or breaks a used API signature
 * 3. Runtime semantic fingerprints against runtime-semantics.json
 *    - Fails with RISUAI_UPSTREAM_SEMANTIC_DRIFT if any tracked implementation fingerprint changes
 * 4. Plugin loader header contract & minified release artifact directive preservation
 *    - Fails with MINIFICATION_DIRECTIVE_LOSS if any directive is lost or corrupted in release artifacts
 * 5. Bidirectional IPC allowed-ipc contract across all peer plugins
 *    - Fails with IPC_ALLOWED_IPC_MISMATCH if sender/receiver directives are missing or asymmetric
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  TRACKED_UPSTREAM_FILES,
  sha256File,
  extractUpstreamContracts
} = require('./risu_contract_extractor.cjs');
const {
  SHIPPED_PLUGINS,
  analyzePluginSource,
  buildRisuApiUsageInventory
} = require('./risu_api_usage_inventory.cjs');

const programDir = path.resolve(__dirname, '..');
const defaultContractsDir = path.join(programDir, 'contracts', 'risuai');

function createVerificationError(code, message, details = {}) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  err.details = details;
  return err;
}

function loadCompatibilityPack(contractsDir = defaultContractsDir) {
  const dir = path.resolve(contractsDir);
  const readJson = name => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      throw createVerificationError('CONTRACT_PACK_FILE_MISSING', `Missing contract file: ${name}`, { file });
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  return {
    upstreamLock: readJson('upstream-lock.json'),
    apiSurface: readJson('api-surface.json'),
    runtimeSemantics: readJson('runtime-semantics.json'),
    pluginLoaderContract: readJson('plugin-loader-contract.json'),
    storageContract: readJson('storage-contract.json'),
    ipcContract: readJson('ipc-contract.json')
  };
}

function verifyUpstreamLock(upstreamLock, upstreamDir, options = {}) {
  if (upstreamLock.schema !== 'librarian.risu-upstream-lock.v1') {
    throw createVerificationError('INVALID_UPSTREAM_LOCK_SCHEMA', `Unexpected schema: ${upstreamLock.schema}`);
  }
  if (options.expectedRepository && upstreamLock.repository !== options.expectedRepository) {
    throw createVerificationError(
      'UPSTREAM_LOCK_REPOSITORY_MISMATCH',
      `Expected repository ${options.expectedRepository}, got ${upstreamLock.repository}`
    );
  }
  if (options.expectedCommit && upstreamLock.commit !== options.expectedCommit) {
    throw createVerificationError(
      'UPSTREAM_LOCK_COMMIT_MISMATCH',
      `Expected commit ${options.expectedCommit}, got ${upstreamLock.commit}`
    );
  }

  const verifiedFiles = {};
  if (upstreamDir) {
    const root = path.resolve(upstreamDir);
    for (const rel of TRACKED_UPSTREAM_FILES) {
      const expectedHash = upstreamLock.files?.[rel];
      if (!expectedHash) {
        throw createVerificationError('UPSTREAM_LOCK_FILE_ENTRY_MISSING', `Missing hash entry for ${rel}`);
      }
      const fullPath = path.join(root, ...rel.split('/'));
      if (!fs.existsSync(fullPath)) {
        throw createVerificationError('UPSTREAM_FILE_MISSING', `Upstream file missing: ${rel}`, { file: rel });
      }
      const actualHash = sha256File(fullPath);
      if (actualHash !== expectedHash) {
        throw createVerificationError(
          'UPSTREAM_HASH_MISMATCH',
          `Tracked file hash mismatch for ${rel}: expected ${expectedHash}, got ${actualHash}`,
          { file: rel, expectedHash, actualHash }
        );
      }
      verifiedFiles[rel] = actualHash;
    }
  } else {
    for (const rel of TRACKED_UPSTREAM_FILES) {
      const expectedHash = upstreamLock.files?.[rel];
      if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw createVerificationError('UPSTREAM_LOCK_HASH_INVALID', `Invalid hash entry for ${rel}`);
      }
      verifiedFiles[rel] = expectedHash;
    }
  }

  return {
    ok: true,
    repository: upstreamLock.repository,
    commit: upstreamLock.commit,
    files: verifiedFiles
  };
}

function compareApiEntryCompatibility(apiName, expected, actual) {
  if (!actual) {
    return { compatible: false, reason: `API '${apiName}' is missing from upstream surface` };
  }
  if (expected.kind !== actual.kind) {
    return { compatible: false, reason: `API '${apiName}' kind changed from '${expected.kind}' to '${actual.kind}'` };
  }
  if (expected.declaredInDts && !actual.declaredInDts) {
    return { compatible: false, reason: `API '${apiName}' was removed from risuai.d.ts` };
  }
  if (expected.implementedInV3 && !actual.implementedInV3) {
    return { compatible: false, reason: `API '${apiName}' implementation was removed from v3.svelte.ts` };
  }
  if (expected.kind === 'method') {
    if (actual.requiredArgs > expected.requiredArgs) {
      return {
        compatible: false,
        reason: `API '${apiName}' required argument count increased from ${expected.requiredArgs} to ${actual.requiredArgs}`
      };
    }
    const expectedTotal = (expected.requiredArgs || 0) + (expected.optionalArgs || 0);
    const actualTotal = (actual.requiredArgs || 0) + (actual.optionalArgs || 0);
    if (actualTotal < expected.requiredArgs) {
      return {
        compatible: false,
        reason: `API '${apiName}' total accepted arguments (${actualTotal}) is less than required (${expected.requiredArgs})`
      };
    }
    if (Boolean(expected.returnsPromise) !== Boolean(actual.returnsPromise)) {
      return {
        compatible: false,
        reason: `API '${apiName}' Promise return contract changed from ${expected.returnsPromise} to ${actual.returnsPromise}`
      };
    }
    if (expected.returnType !== actual.returnType) {
      return {
        compatible: false,
        reason: `API '${apiName}' returnType changed from '${expected.returnType}' to '${actual.returnType}'`
      };
    }
    if (!expected.deprecated && actual.deprecated) {
      return {
        compatible: false,
        reason: `API '${apiName}' became newly deprecated upstream`
      };
    }
    const expParams = expected.parameters || [];
    const actParams = actual.parameters || [];
    for (let i = 0; i < Math.min(expParams.length, actParams.length); i++) {
      if (expParams[i].type !== actParams[i].type) {
        return {
          compatible: false,
          reason: `API '${apiName}' parameter #${i + 1} ('${expParams[i].name}') type changed from '${expParams[i].type}' to '${actParams[i].type}'`
        };
      }
      if (expParams[i].callbackShape && expParams[i].callbackShape !== actParams[i].callbackShape) {
        return {
          compatible: false,
          reason: `API '${apiName}' parameter #${i + 1} callback shape changed from '${expParams[i].callbackShape}' to '${actParams[i].callbackShape}'`
        };
      }
    }
  }
  return { compatible: true };
}

function verifyApiSurfaceContract(apiSurfaceContract, usageInventory, extractedUpstream = null) {
  const contractedApis = apiSurfaceContract.apis || {};
  const allowlistedProbes = apiSurfaceContract.allowlistedOptionalProbes || {};

  // 1. Check that every API used by Librarian is mapped in api-surface.json
  for (const [apiName, info] of Object.entries(usageInventory.apis || {})) {
    if (!Object.prototype.hasOwnProperty.call(contractedApis, apiName)) {
      throw createVerificationError(
        'UNMAPPED_RISUAI_API_USAGE',
        `Unmapped RisuAI API '${apiName}' used by owner(s): ${(info.owners || []).join(', ')}`,
        { apiName, owners: info.owners }
      );
    }
  }

  // 2. Check that every optional probe is in allowlistedOptionalProbes
  for (const [probeName, info] of Object.entries(usageInventory.allowlistedOptionalProbes || {})) {
    if (!Object.prototype.hasOwnProperty.call(allowlistedProbes, probeName)) {
      throw createVerificationError(
        'UNMAPPED_RISUAI_API_USAGE',
        `Unallowlisted optional probe '${probeName}' used by owner(s): ${(info.owners || []).join(', ')}`,
        { apiName: probeName, owners: info.owners }
      );
    }
  }

  // 3. Validate each contracted API's own structure (and against live upstream extraction when available)
  const upstreamSurface = extractedUpstream ? extractedUpstream.dtsSurface : (apiSurfaceContract.hostSurface || contractedApis);
  for (const [apiName, expectedDef] of Object.entries(contractedApis)) {
    const actualDef = upstreamSurface?.[apiName];
    const check = compareApiEntryCompatibility(apiName, expectedDef, actualDef);
    if (!check.compatible) {
      throw createVerificationError(
        'RISUAI_API_SIGNATURE_INCOMPATIBLE',
        check.reason,
        { apiName, expected: expectedDef, actual: actualDef || null }
      );
    }
  }

  return {
    ok: true,
    verifiedApiCount: Object.keys(contractedApis).length,
    verifiedOptionalProbeCount: Object.keys(allowlistedProbes).length
  };
}

function verifyRuntimeSemantics(runtimeSemanticsContract, extractedUpstream = null) {
  const contractedMethods = runtimeSemanticsContract.methods || {};
  const driftCode = runtimeSemanticsContract.driftFailureCode || 'RISUAI_UPSTREAM_SEMANTIC_DRIFT';

  for (const [methodName, expected] of Object.entries(contractedMethods)) {
    if (!expected.implementationFingerprint || !/^[a-f0-9]{64}$/.test(expected.implementationFingerprint)) {
      throw createVerificationError(
        driftCode,
        `Missing or invalid implementationFingerprint for '${methodName}'`,
        { methodName }
      );
    }
    if (!Array.isArray(expected.semanticContract) || expected.semanticContract.length === 0) {
      throw createVerificationError(
        driftCode,
        `Missing semanticContract clauses for '${methodName}'`,
        { methodName }
      );
    }
    if (extractedUpstream) {
      const actual = extractedUpstream.runtimeSemantics?.[methodName];
      if (!actual) {
        throw createVerificationError(
          driftCode,
          `Tracked semantic method '${methodName}' missing in upstream extraction`,
          { methodName }
        );
      }
      if (actual.implementationFingerprint !== expected.implementationFingerprint) {
        throw createVerificationError(
          driftCode,
          `Upstream implementation fingerprint drifted for '${methodName}': expected ${expected.implementationFingerprint}, got ${actual.implementationFingerprint}`,
          {
            methodName,
            expectedFingerprint: expected.implementationFingerprint,
            actualFingerprint: actual.implementationFingerprint
          }
        );
      }
    }
  }

  return {
    ok: true,
    verifiedMethodCount: Object.keys(contractedMethods).length
  };
}

function parsePluginHeader(sourceText, fileLabel = 'plugin.js') {
  const text = String(sourceText || '').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  let name = '';
  let displayName = undefined;
  let apiVersion = '2.0';
  let versionOfPlugin = '';
  let versionBytesBefore = null;
  let updateURL = '';
  const args = {};
  const argMeta = {};
  const customLink = [];
  const allowedIPC = [];
  const rawDirectives = [];

  for (const line of lines) {
    if (/^[ \t]*\/\/(?:@|!)[^\r\n]*$/.test(line)) {
      rawDirectives.push(line.trim());
    }
    if (line.startsWith('//@name')) {
      const provided = line.slice(7);
      if (provided === '') {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: plugin name must be longer than 0`);
      }
      name = provided.trim();
    }
    if (line.startsWith('//@api')) {
      const versions = line.slice(6).trim().split(' ');
      const supported = ['2.0', '2.1', '3.0'];
      for (const ver of versions) {
        if (supported.includes(ver)) {
          apiVersion = ver;
          break;
        }
      }
    }
    if (line.startsWith('//@display-name')) {
      const provided = line.slice('//@display-name'.length + 1);
      if (provided === '') {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: display-name must be longer than 0`);
      }
      displayName = provided.trim();
    }
    if (line.startsWith('//@link')) {
      const link = line.split(' ')[1];
      if (!link || !link.startsWith('https')) {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: //@link must start with https`);
      }
      const hoverText = line.split(' ').slice(2).join(' ').trim();
      customLink.push({ link, hoverText: hoverText || undefined });
    }
    if (line.startsWith('//@risu-arg') || line.startsWith('//@arg')) {
      const parts = line.trim().split(' ');
      if (parts.length < 3) {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: malformed //@arg line: ${line}`);
      }
      const argKey = parts[1];
      const argType = parts[2];
      if (argType !== 'int' && argType !== 'string') {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: unsupported //@arg type '${argType}' for '${argKey}'`);
      }
      args[argKey] = argType;
      if (parts.length > 3) {
        argMeta[argKey] = { description: parts.slice(3).join(' ').trim() };
      }
    }
    if (line.startsWith('//@update-url')) {
      updateURL = line.split(' ')[1] || '';
      let parsed;
      try {
        parsed = new URL(updateURL);
      } catch (_) {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: invalid //@update-url '${updateURL}'`);
      }
      if (parsed.protocol !== 'https:') {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: //@update-url must use https:`);
      }
    }
    if (line.startsWith('//@version')) {
      versionOfPlugin = line.split(' ').slice(1).join(' ').trim();
      const versionLocation = text.indexOf('//@version');
      versionBytesBefore = Buffer.byteLength(text.slice(0, versionLocation) + line, 'utf8');
      if (versionBytesBefore > 500) {
        throw createVerificationError(
          'PLUGIN_VERSION_OFFSET_EXCEEDED',
          `${fileLabel}: //@version declaration ends at byte ${versionBytesBefore} (must be <= 500 bytes per RisuAI importPlugin)`
        );
      }
    }
    if (line.startsWith('//@allowed-ipc')) {
      const parts = line.trim().split(' ');
      if (parts.length < 2 || !parts[1]) {
        throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: empty //@allowed-ipc declaration`);
      }
      allowedIPC.push(...parts.slice(1).filter(Boolean));
    }
  }

  if (!name) {
    throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: //@name not found`);
  }
  if (apiVersion !== '3.0') {
    throw createVerificationError('PLUGIN_API_VERSION_UNSUPPORTED', `${fileLabel}: //@api must be 3.0 (got ${apiVersion})`);
  }
  if (updateURL && !versionOfPlugin) {
    throw createVerificationError('PLUGIN_HEADER_INVALID', `${fileLabel}: //@version is required when //@update-url is present`);
  }

  return {
    name,
    displayName,
    apiVersion,
    versionOfPlugin,
    versionBytesBefore,
    updateURL,
    arguments: args,
    argMeta,
    customLink,
    allowedIPC,
    rawDirectives
  };
}

function verifyLoaderAndIpcContracts(loaderContract, ipcContract, options = {}) {
  const sourcePluginDir = options.sourcePluginDir
    ? path.resolve(options.sourcePluginDir)
    : path.join(programDir, 'plugins');
  const artifactPluginDir = options.artifactPluginDir
    ? path.resolve(options.artifactPluginDir)
    : null;

  const parsedSourceHeaders = {};
  const parsedArtifactHeaders = {};

  for (const item of SHIPPED_PLUGINS) {
    const sourcePath = path.join(sourcePluginDir, item.file);
    if (!fs.existsSync(sourcePath)) {
      throw createVerificationError('PLUGIN_SOURCE_MISSING', `Missing source plugin: ${item.file}`);
    }
    const sourceText = fs.readFileSync(sourcePath, 'utf8');
    const sourceHeader = parsePluginHeader(sourceText, `source/${item.file}`);
    parsedSourceHeaders[item.owner] = sourceHeader;

    const expectedPlugin = loaderContract.shippedPlugins?.[item.owner];
    if (expectedPlugin) {
      if (sourceHeader.name !== expectedPlugin.pluginName) {
        throw createVerificationError(
          'PLUGIN_NAME_MISMATCH',
          `${item.owner}: expected //@name '${expectedPlugin.pluginName}', got '${sourceHeader.name}'`
        );
      }
    }

    if (artifactPluginDir) {
      const artifactPath = path.join(artifactPluginDir, item.file);
      if (!fs.existsSync(artifactPath)) {
        throw createVerificationError('RELEASE_ARTIFACT_MISSING', `Missing release artifact: ${item.file}`);
      }
      const artifactText = fs.readFileSync(artifactPath, 'utf8');
      let artifactHeader;
      try {
        artifactHeader = parsePluginHeader(artifactText, `artifact/${item.file}`);
      } catch (err) {
        throw createVerificationError(
          'MINIFICATION_DIRECTIVE_LOSS',
          `Release artifact ${item.file} failed header validation: ${err.message}`,
          { owner: item.owner, cause: err.code }
        );
      }
      parsedArtifactHeaders[item.owner] = artifactHeader;

      // Multiset directive comparison between source and minified artifact
      const remaining = [...artifactHeader.rawDirectives];
      const missingDirectives = [];
      for (const directive of sourceHeader.rawDirectives) {
        const idx = remaining.indexOf(directive);
        if (idx >= 0) remaining.splice(idx, 1);
        else missingDirectives.push(directive);
      }
      if (missingDirectives.length > 0 || artifactHeader.rawDirectives.length !== sourceHeader.rawDirectives.length) {
        throw createVerificationError(
          'MINIFICATION_DIRECTIVE_LOSS',
          `${item.owner} (${item.file}) lost ${missingDirectives.length} directive(s) during build: ${missingDirectives.slice(0, 5).join(', ')}`,
          {
            owner: item.owner,
            sourceCount: sourceHeader.rawDirectives.length,
            artifactCount: artifactHeader.rawDirectives.length,
            missingDirectives
          }
        );
      }

      // Also verify AST API usage on the minified artifact itself
      const artifactUsage = analyzePluginSource(artifactText, { owner: item.owner, filePath: artifactPath });
      for (const apiName of artifactUsage.apis) {
        if (!loaderContract || !options.apiSurfaceContract) continue;
        if (!Object.prototype.hasOwnProperty.call(options.apiSurfaceContract.apis || {}, apiName)) {
          throw createVerificationError(
            'UNMAPPED_RISUAI_API_USAGE',
            `Release artifact ${item.file} uses unmapped RisuAI API '${apiName}'`,
            { owner: item.owner, apiName }
          );
        }
      }
    }
  }

  // Verify IPC symmetry across all plugins in ipcContract and parsed headers
  const activeHeaders = artifactPluginDir ? parsedArtifactHeaders : parsedSourceHeaders;
  const byPluginName = {};
  for (const header of Object.values(activeHeaders)) {
    byPluginName[header.name] = header;
  }

  for (const [pluginName, contractEntry] of Object.entries(ipcContract.plugins || {})) {
    const header = byPluginName[pluginName];
    if (!header) {
      throw createVerificationError('IPC_ALLOWED_IPC_MISMATCH', `Plugin '${pluginName}' missing from active headers`);
    }
    const actualUnique = [...new Set(header.allowedIPC)];
    const expectedUnique = [...new Set(contractEntry.allowedIPC || [])];
    for (const peer of expectedUnique) {
      if (!actualUnique.includes(peer)) {
        throw createVerificationError(
          'IPC_ALLOWED_IPC_MISMATCH',
          `Plugin '${pluginName}' is missing required //@allowed-ipc directive for peer '${peer}'`,
          { pluginName, missingPeer: peer }
        );
      }
      const peerHeader = byPluginName[peer];
      if (!peerHeader) {
        throw createVerificationError(
          'IPC_ALLOWED_IPC_MISMATCH',
          `Plugin '${pluginName}' declares //@allowed-ipc for unknown peer '${peer}'`,
          { pluginName, unknownPeer: peer }
        );
      }
      if (!peerHeader.allowedIPC.includes(pluginName)) {
        throw createVerificationError(
          'IPC_ALLOWED_IPC_MISMATCH',
          `Asymmetric //@allowed-ipc: '${pluginName}' allows '${peer}', but '${peer}' does not allow '${pluginName}'`,
          { sender: pluginName, receiver: peer }
        );
      }
    }
  }

  return {
    ok: true,
    verifiedPlugins: Object.keys(activeHeaders).length,
    artifactVerified: Boolean(artifactPluginDir)
  };
}

function runContractVerification(options = {}) {
  const contractsDir = options.contractsDir || defaultContractsDir;
  const pack = loadCompatibilityPack(contractsDir);
  const lockResult = verifyUpstreamLock(pack.upstreamLock, options.upstreamDir, {
    expectedRepository: 'kwaroran/Risuai'
  });

  const extractedUpstream = options.upstreamDir
    ? extractUpstreamContracts(options.upstreamDir, {
        repository: pack.upstreamLock.repository,
        commit: pack.upstreamLock.commit
      })
    : null;

  if (extractedUpstream) {
    if (extractedUpstream.loaderFingerprint !== pack.pluginLoaderContract.implementationFingerprint) {
      throw createVerificationError(
        'RISUAI_UPSTREAM_SEMANTIC_DRIFT',
        `Plugin loader implementation fingerprint drifted: expected ${pack.pluginLoaderContract.implementationFingerprint}, got ${extractedUpstream.loaderFingerprint}`
      );
    }
    for (const [key, expectedFp] of Object.entries(pack.storageContract.implementationFingerprints || {})) {
      const actualFp = extractedUpstream.storageFingerprints?.[key];
      if (actualFp !== expectedFp) {
        throw createVerificationError(
          'RISUAI_UPSTREAM_SEMANTIC_DRIFT',
          `Storage class '${key}' implementation fingerprint drifted: expected ${expectedFp}, got ${actualFp}`
        );
      }
    }
  }

  const usageInventory = options.usageInventory || buildRisuApiUsageInventory({
    pluginDir: options.sourcePluginDir
  });

  const apiSurfaceResult = verifyApiSurfaceContract(pack.apiSurface, usageInventory, extractedUpstream);
  const semanticResult = verifyRuntimeSemantics(pack.runtimeSemantics, extractedUpstream);
  const loaderAndIpcResult = verifyLoaderAndIpcContracts(pack.pluginLoaderContract, pack.ipcContract, {
    sourcePluginDir: options.sourcePluginDir,
    artifactPluginDir: options.artifactPluginDir,
    apiSurfaceContract: pack.apiSurface
  });

  return {
    ok: true,
    upstreamLock: lockResult,
    apiSurface: apiSurfaceResult,
    runtimeSemantics: semanticResult,
    loaderAndIpc: loaderAndIpcResult
  };
}

function checkUpstreamDrift(options = {}) {
  const contractsDir = options.contractsDir || defaultContractsDir;
  const pack = loadCompatibilityPack(contractsDir);
  if (!options.upstreamDir) {
    throw new Error('checkUpstreamDrift requires --upstream-dir');
  }
  const root = path.resolve(options.upstreamDir);
  const changedFiles = [];
  for (const rel of TRACKED_UPSTREAM_FILES) {
    const full = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(full)) {
      changedFiles.push({ file: rel, status: 'missing', lockedHash: pack.upstreamLock.files?.[rel] || null, currentHash: null });
      continue;
    }
    const currentHash = sha256File(full);
    const lockedHash = pack.upstreamLock.files?.[rel];
    if (currentHash !== lockedHash) {
      changedFiles.push({ file: rel, status: 'modified', lockedHash, currentHash });
    }
  }

  const missingUsedApis = [];
  const signatureChanges = [];
  const semanticDrift = [];

  let verificationFailed = false;
  try {
    runContractVerification({
      contractsDir,
      upstreamDir: options.upstreamDir
    });
  } catch (err) {
    verificationFailed = true;
    if (err.code === 'UNMAPPED_RISUAI_API_USAGE') {
      missingUsedApis.push(err.details || { code: err.code, message: err.message });
    } else if (err.code === 'RISUAI_API_SIGNATURE_INCOMPATIBLE') {
      signatureChanges.push(err.details || { code: err.code, message: err.message });
    } else if (err.code === 'RISUAI_UPSTREAM_SEMANTIC_DRIFT') {
      semanticDrift.push(err.details || { code: err.code, message: err.message });
    } else {
      semanticDrift.push({ code: err.code || 'DRIFT_DETECTED', message: err.message, details: err.details || null });
    }
  }

  const isCurrent = changedFiles.length === 0 && !verificationFailed;

  return {
    schema: 'librarian.risu-upstream-drift-report.v1',
    status: isCurrent ? 'compatible_pin_current' : 'upstream_review_required',
    lockedCommit: pack.upstreamLock.commit,
    pinnedCommit: pack.upstreamLock.commit,
    headCommit: options.headCommit || (isCurrent ? pack.upstreamLock.commit : 'HEAD'),
    changedFiles,
    missingUsedApis,
    signatureChanges,
    semanticDrift
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    contractsDir: defaultContractsDir,
    upstreamDir: null,
    sourcePluginDir: null,
    artifactPluginDir: null,
    driftCheck: false,
    headCommit: null
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--contracts-dir') out.contractsDir = path.resolve(argv[++i]);
    else if (arg === '--upstream-dir') out.upstreamDir = path.resolve(argv[++i]);
    else if (arg === '--source-plugin-dir') out.sourcePluginDir = path.resolve(argv[++i]);
    else if (arg === '--artifact-dir') out.artifactPluginDir = path.resolve(argv[++i]);
    else if (arg === '--drift-check') out.driftCheck = true;
    else if (arg === '--head-commit') out.headCommit = String(argv[++i]);
    else throw new Error(`unknown_argument:${arg}`);
  }
  return out;
}

if (require.main === module) {
  try {
    const args = parseArgs();
    if (args.driftCheck) {
      const drift = checkUpstreamDrift(args);
      process.stdout.write(JSON.stringify(drift, null, 2) + '\n');
    } else {
      const result = runContractVerification(args);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createVerificationError,
  loadCompatibilityPack,
  verifyUpstreamLock,
  compareApiEntryCompatibility,
  verifyApiSurfaceContract,
  verifyRuntimeSemantics,
  parsePluginHeader,
  verifyLoaderAndIpcContracts,
  runContractVerification,
  checkUpstreamDrift
};
