'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { createArchiveOwnerFixture, canonicalIdentity, plain }
  = require('./fixtures/archive_owner_fixture.cjs');
const artifacts = process.env.FLASHBACK_ARCHIVE_ARTIFACTS;

for (const kind of ['source', 'Full', 'Min']) {
  test(`${kind} registered archive GUI previews, cancels, then repairs only the selected response group`,
    { skip: kind !== 'source' && !artifacts, timeout: 45000 }, async () => {
      const f = await createArchiveOwnerFixture({ includeEpisode: true });
      let dom;
      try {
        if (kind !== 'source') {
          const scriptPath = path.join(artifacts, kind, 'plugins/Flashback_Memory.js');
          assert(fs.existsSync(scriptPath), `${kind} artifact must exist when explicitly requested`);
          await f.restart(scriptPath);
          assert.equal(f.api._test, undefined);
          assert.equal(f.context.__FlashbackEmbeddingAudit, undefined);
        }
        dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
          { url: 'https://archive-gui.invalid/', pretendToBeVisual: true });
        Object.assign(f.context, { document: dom.window.document, window: dom.window,
          MutationObserver: dom.window.MutationObserver,
          getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
        assert.equal(await f.api.showUi(), true, 'public showUi mounts production controls');
        await f.api.refreshUi('import');
        await f.quiesce();
        const doc = dom.window.document;
        const button = doc.getElementById('maintenanceArchiveRunBtn');
        assert(button, 'registered production archive button maintenanceArchiveRunBtn is required');
        assert.equal(button.textContent.trim(), '아카이브 응답 한 묶음 복구');
        const localMode = doc.getElementById('maintenanceMode');
        assert(localMode, 'original local repair control remains available');
        localMode.value = 'reembed';
        assert.equal(localMode.selectedOptions[0].textContent, '로컬 미완료 벡터 복구');
        assert.notEqual(button.id, 'maintenanceRunBtn', 'archive action has its own registered route');

        f.startObservation();
        const beforeOwner = JSON.stringify(f.physicalManifest(f.scope.scopeKey));
        const dialog = () => doc.querySelector('.vrmDialogMessage');
        button.click();
        const first = await f.waitFor(dialog, 'archive confirmation');
        assert.match(first.textContent, /아카이브/);
        assert.match(first.textContent, /선택/);
        assert.match(first.textContent, new RegExp(`${f.selectedRows.length}\\s*(?:개\\s*)?레코드|레코드\\s*${f.selectedRows.length}`));
        assert.match(first.textContent, /남은 응답 묶음[^\d]*1/);
        assert.match(first.textContent, /제외[^\d]*1/);
        assert.equal(f.requests, 0, 'confirmation preview cannot submit the provider request');
        assert.equal(f.observation.writes.length, 0, 'confirmation preview cannot write the owner or candidate');
        assert.equal(f.observation.removals.length, 0);
        doc.querySelector('.vrmDialogCancel').click();
        await f.waitFor(() => !dialog(), 'cancelled archive confirmation');
        assert.equal(f.requests, 0);
        assert.equal(JSON.stringify(f.physicalManifest(f.scope.scopeKey)), beforeOwner);
        f.assertProtectedUnchanged();

        button.click();
        const second = await f.waitFor(dialog, 'second archive confirmation');
        const confirmation = second.textContent;
        doc.querySelector('.vrmDialogOk').click();
        const result = await f.waitFor(() => {
          const current = dialog(); return current && current.textContent !== confirmation ? current : null;
        }, 'selected archive group result');
        assert.match(result.textContent, /선택한 아카이브 응답 묶음 완료/);
        assert.match(result.textContent, /남은 응답 묶음[^\d]*1/);
        assert.match(result.textContent, /제외[^\d]*1/);
        assert.doesNotMatch(result.textContent, /모든\s*아카이브.*완료|전체\s*아카이브.*(?:정상|복구\s*완료)|전체\s*(?:자료|데이터)\s*정상/);
        assert.equal(f.requests, 1, 'the actual registered event handler submits one complete group');
        const owner = f.physicalManifest(f.scope.scopeKey);
        assert.equal(owner.archiveRepairReceipt?.status, 'complete');
        assert.equal(owner.archiveRef.deltaCount, f.selectedRows.length);
        assert.equal(owner.count, 0);
        f.assertProtectedUnchanged();
        doc.querySelector('.vrmDialogOk').click();
        await f.waitFor(() => !dialog(), 'archive result dismissal');
        await f.api.closeUi();
        assert.equal(f.api.uiStatus().visible, false);
        dom.window.close(); dom = null;

        await f.restart();
        const chain = await f.readChain();
        assert.equal(chain.verified, true);
        assert.equal(chain.records, f.beforeRows.length);
        for (const before of f.selectedRows) {
          const row = chain.recordsList.find(item => canonicalIdentity(item) === canonicalIdentity(before));
          assert.deepEqual(Array.from(row.vector), [0, 1, 0, 0]);
        }
        for (const before of f.beforeRows.filter(row => row.sourceHash !== f.firstSourceHash)) {
          const row = chain.recordsList.find(item => canonicalIdentity(item) === canonicalIdentity(before));
          assert.deepEqual(plain(row), before, 'other response and derived episode remain unchanged');
        }
        assert.equal(f.requests, 0);
      } finally { await f.dispose(); dom?.window.close(); }
    });
}
