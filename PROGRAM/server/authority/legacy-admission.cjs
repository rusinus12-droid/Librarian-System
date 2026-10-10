'use strict';
// Default-off exclusion only. This never initializes, repairs or enrolls DATA.
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const C = require('./contracts.cjs');
const { readActivationState, ownerFile } = require('./control-store.cjs');
function unavailable() { throw Object.assign(new Error('AUTHORITY_LIFECYCLE_UNAVAILABLE'), { code:'AUTHORITY_LIFECYCLE_UNAVAILABLE',statusCode:503 }); }
function assertLegacyAuthorityUnavailable({ dataDir, namespaces = C.OWNERS, database = null }) {
  if (readActivationState({dataDir}).status !== 'unavailable') unavailable();
  for (const namespace of namespaces) {
    const file = ownerFile(dataDir,namespace);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) continue;
    const db = database || new DatabaseSync(file,{readOnly:true});
    try {
      // Orphan guards remain protected even if both activation files vanished.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name GLOB 'authority_*' LIMIT 1").get()
        || Number(db.prepare('PRAGMA user_version').get().user_version) > 1) unavailable();
    } catch (error) {
      if (error.code === 'AUTHORITY_LIFECYCLE_UNAVAILABLE') throw error;
      throw Object.assign(new Error('AUTHORITY_QUARANTINED'),{code:'AUTHORITY_QUARANTINED',statusCode:503});
    } finally { if (!database) db.close(); }
  }
}
module.exports = { assertLegacyAuthorityUnavailable };
