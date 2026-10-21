'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const files = {
  libra: path.resolve(__dirname, "../plugins/LIBRA.js"),
  hayaku: path.resolve(__dirname, "../plugins/HAYAKU_Locator_Continuity.js"),
  flashback: path.resolve(__dirname, "../plugins/Flashback_Memory.js"),
};
const expected = {
  libra: [null, 'Libra', '__LIBRAPortableMemoryBackup'],
  hayaku: [null, 'Hayaku', '__HAYAKUPortableMemoryBackup'],
  flashback: [null, 'Flashback', '__FlashbackPortableMemoryBackup'],
};
for (const [id, file] of Object.entries(files)) {
  const source = fs.readFileSync(file, 'utf8');
  const [, marker, globalApi] = expected[id];
  const version = source.match(/const PLUGIN_VERSION = ["']([^"']+)/)[1];
  assert.match(source, /PORTABLE_BACKUP_CONFIG = Object\.freeze\([^\r\n]*"pluginVersion":PLUGIN_VERSION/);
  assert.match(source, new RegExp('^//@version\\s+' + version.replace(/\\./g, '\\.') + '$', 'm'));
  assert(source.includes('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: ' + marker + ' START'));
  assert(source.includes("memory-suite.portable-memory-backup.v1"));
  assert(source.includes("strict_same_scope_replace"));
  assert(source.includes("mergeSupported: false"));
  assert(source.includes("chatMutationAllowed: false"));
  assert(source.includes("portable_backup_envelope_digest_mismatch"));
  assert(source.includes("portable_backup_post_restore_mismatch"));
  assert(source.includes("PORTABLE_RESTORE_FAILED_ROLLED_BACK"));
  assert(source.includes("data-portable-backup"));
  assert(source.includes("data-portable-restore"));
  assert(source.includes(globalApi));
  assert(source.includes('pluginVersion'), `${id} portable backup exposes plugin version metadata`);
  assert.match(source, /pluginVersion\s*[:=]/, `${id} portable backup has a pluginVersion field`);
  assert(source.includes('const portableJsonWorkerSource ='), `${id} portable backup defines an off-main-thread JSON worker`);
  assert(source.includes("new Worker(workerUrl)"), `${id} portable backup creates a bounded JSON worker`);
  assert(source.includes("bytes.buffer, chars: json.length }, [bytes.buffer]"), `${id} transfers serialized JSON bytes without copying the full string back to the UI thread`);
  assert(source.includes('const parsePortableJson = async raw =>'), `${id} parses backup JSON off the UI thread with a safe fallback`);
  assert(source.includes('const downloadEnvelope = async envelope =>'), `${id} awaits worker-backed serialization before download`);
  if (id === 'libra') {
    const portableBlock = source.slice(
      source.indexOf('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: Libra START'),
      source.indexOf('LIBRARIAN SYSTEM PORTABLE MEMORY BACKUP v1 :: Libra END')
    );
    assert(/const SHARED_SETTINGS_HUB_SECTIONS = Object\.freeze\(\[[^\]]*'recovery'[^\]]*\]\);/.test(source), 'LIBRA exposes Recovery in the unified Settings Hub');
    assert(/if\s*\(\['recovery','memory_restore'\]\.includes\(requested\)\)\s*return\s*\{pageId:'settings',settingsHubSection:'recovery'\}/.test(source), 'LIBRA routes Memory Restore deep links into the Recovery settings section');
    // The approved GUI mounts settings destinations by group/section; Recovery lives in the Store group.
    assert(source.includes("if(groupId==='store'&&sectionId==='recovery')return guiEl('div',{class:'stack',dataset:{settingsCategory:'store'}},[buildLibraMemoryRestorePanel()]);"), 'LIBRA renders the Recovery panel from the unified Settings Hub');
    assert(/\{ id:'store',[^}]*sections:\[[^\]]*'recovery'[^\]]*\] \}/.test(source), 'LIBRA Settings Hub Store group contains the Recovery section');
    assert(/const buildLibraMemoryRestorePanel = \(\) => \{\s*const host = guiEl\('div', \{[^}]*dataset: \{ portableBackupHost: 'libra' \}/.test(source), 'LIBRA Recovery panel is the owner-scoped portable-memory host');
    assert(source.includes("portableBackupHost: 'libra'"), 'LIBRA renders an owner-scoped portable-memory host');
    assert(source.includes('현재 채팅의 영구 기억과 복원에 필요한 관련 데이터를 JSON 파일로 내려받습니다'), 'LIBRA explains the JSON backup and restore purpose');
    assert(source.includes('같은 채팅은 정확히 교체 · 다른 채팅은 검증 후 이사 또는 복사 복구'), 'LIBRA explains its three explicit restore boundaries');
    assert(source.includes("restore_same_scope"), 'LIBRA exposes exact same-chat replacement');
    assert(source.includes("import_as_predecessor_archive"), 'LIBRA exposes predecessor-archive migration');
    assert(source.includes("reconstruct_native_copy"), 'LIBRA exposes content-verified copied-chat reconstruction');
    assert(source.includes('portable_restore_startup_recovery_failed'), 'LIBRA recovers interrupted same-chat restores from a durable checkpoint');
    assert(source.includes('JSON 백업 다운로드'), 'LIBRA labels the JSON download action explicitly');
    assert(source.includes('JSON 백업에서 복원'), 'LIBRA labels the JSON restore action explicitly');
    assert(portableBlock.includes('mountUi: ensureUi'), 'LIBRA mounts portable controls through the explicit recovery host');
    assert(portableBlock.includes('syncPortableUiState();'), 'LIBRA synchronizes the shared busy state after a region remount');
    assert(portableBlock.includes('portableMemoryActiveOperationId'), 'LIBRA exposes a shared portable-memory operation gate');
    assert(portableBlock.includes("runPortableOperation('restore'"), 'LIBRA serializes restore through the shared gate');
    assert(portableBlock.includes('LIBRA_PORTABLE_MEMORY_BUSY'), 'LIBRA canonical mutations reject concurrent portable-memory work');
    assert(!portableBlock.includes('config.rootSelectors'), 'LIBRA no longer scans broad GUI roots for a mount point');
    assert(!portableBlock.includes('config.anchorSelectors'), 'LIBRA no longer injects into an arbitrary action row');
    assert(!portableBlock.includes('startUiObserver'), 'LIBRA no longer watches the complete document for portable UI mounting');
    assert(!portableBlock.includes('position:fixed;right:14px;bottom:14px'), 'LIBRA no longer falls back to a floating control');
  }
  if (id === 'flashback') {
    assert(source.includes("portable_restore_modes_v2"), 'Flashback advertises the three-mode portable restore policy');
    assert(source.includes("same_chat_replace"), 'Flashback exposes exact same-chat replacement');
    assert(source.includes("chat_migration_archive"), 'Flashback exposes immutable-archive chat migration');
    assert(source.includes("chat_copy_rebind"), 'Flashback exposes transcript-verified chat-copy rebinding');
    assert(source.includes("FLASHBACK_PORTABLE_TARGET_CHANGED"), 'Flashback revalidates an empty target at commit time');
    assert(source.includes('localVectorSidecars'), 'Flashback portable backup embeds local vector sidecars');
    assert(source.includes('portable_backup_vector_sidecar_bundle_missing'), 'Flashback rejects backups missing referenced sidecars');
    assert(source.includes('vectorSidecarsWritten'), 'Flashback restores sidecars transactionally');
    assert(source.includes('vector_rollback_readback_mismatch'), 'Flashback sidecar rollback is verified');
    assert(source.includes('data-portable-backup-host="flashback_memory"'), 'Flashback renders portable backup in an owner-scoped maintenance host');
    assert(source.includes('[data-flashback-memory="${config.pluginId}"]'), 'Flashback resolves its own GUI root before mounting portable controls');
    assert(source.includes('syncPortableUiState();'), 'Flashback synchronizes the shared busy state after a GUI remount');
    assert(source.includes('JSON 백업 다운로드'), 'Flashback labels the JSON download action explicitly');
    assert(source.includes('JSON 백업에서 복원'), 'Flashback labels the JSON restore action explicitly');
    assert(source.includes('portableMemoryActiveOperationId'), 'Flashback exposes a shared portable-memory operation gate');
    assert(source.includes("runPortableOperation('restore'"), 'Flashback serializes restore through the shared gate');
    assert(source.includes('FLASHBACK_PORTABLE_MEMORY_BUSY'), 'Flashback maintenance rejects concurrent portable-memory work');
  }
}
console.log('portable_memory_backup_contract_test: PASS');

