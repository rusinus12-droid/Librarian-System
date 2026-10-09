'use strict';

const fs=require('node:fs');
const path=require('node:path');

const ACTIVE_NAMESPACES=Object.freeze(['flashback','hayaku','libra','lia','retrace']);
const PRIVATE_DATA_PATTERN=/(?:^|\/)(?:runtime-token\.txt|compute-(?:signing|pairing)-key\.txt|scope-catalog(?:\.[^/]*)?\.json|[^/]+\.(?:sqlite(?:-(?:wal|shm))?|db|jsonl|log))(?:$|\/)/i;

function listFiles(rootDir){const root=path.resolve(rootDir),rows=[];if(!fs.existsSync(root))return rows;const walk=current=>{for(const entry of fs.readdirSync(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isSymbolicLink())throw new Error(`distribution_symbolic_link_is_not_allowed:${full}`);if(entry.isDirectory())walk(full);else if(entry.isFile())rows.push(full);else throw new Error(`distribution_unsupported_file_type:${full}`)}};walk(root);return rows.sort((a,b)=>path.relative(root,a).localeCompare(path.relative(root,b),'en'));}

function assertPristineDistributionData(dataDir) {
  const root = path.resolve(dataDir);
  const files = listFiles(root);
  const allowed = new Set([
    'config/server-config.json',
    'data-layout.json',
    '이_DATA_폴더를_통째로_백업하세요.txt',
    'backups/auto/.keep.txt',
    'backups/manual/.keep.txt',
    'backups/pre-migration/.keep.txt',
    'backups/deleted-scopes/.keep.txt',
    'backups/recovery-quarantine/.keep.txt',
    'logs/.keep.txt',
    'migrations/.keep.txt',
    ...ACTIVE_NAMESPACES.map(namespace => `stores/${namespace}/.keep.txt`)
  ]);
  for (const filePath of files) {
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    if (PRIVATE_DATA_PATTERN.test(`/${relative}`)) throw new Error(`distribution_private_data_detected:${relative}`);
    if (!allowed.delete(relative)) throw new Error(`distribution_data_file_not_allowlisted:${relative}`);
  }
  if (allowed.size) throw new Error(`distribution_data_files_missing:${[...allowed].join(',')}`);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'server-config.json'), 'utf8'));
  const expectedConfigKeys = ['autoBackup', 'computeEnabled', 'computeWorkers', 'host', 'port', 'schema'];
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(expectedConfigKeys)
    || config.schema !== 'memory-suite.server-config.v1'
    || config.host !== '127.0.0.1'
    || config.port !== 47630
    || config.autoBackup !== true
    || config.computeEnabled !== true
    || config.computeWorkers !== 0) {
    throw new Error('distribution_server_config_is_not_pristine');
  }
  const layout = JSON.parse(fs.readFileSync(path.join(root, 'data-layout.json'), 'utf8'));
  const expectedLayoutKeys = [
    'backupRule', 'createdAt', 'dataFolder', 'lastPreparedAt', 'lastProgramVersion',
    'layoutVersion', 'portableRoot', 'programFolder', 'recoveryQuarantine',
    'restoreJournal', 'schema', 'scopeCatalogPrevious'
  ];
  if (JSON.stringify(Object.keys(layout).sort()) !== JSON.stringify(expectedLayoutKeys)
    || layout.schema !== 'memory-suite.data-layout.v1'
    || layout.layoutVersion !== 1
    || layout.portableRoot !== true
    || layout.programFolder !== 'PROGRAM'
    || layout.dataFolder !== 'DATA'
    || !/^\d+\.\d+\.\d+$/.test(String(layout.lastProgramVersion || ''))
    || !Number.isFinite(Date.parse(layout.createdAt))
    || !Number.isFinite(Date.parse(layout.lastPreparedAt))) {
    throw new Error('distribution_data_layout_is_not_pristine');
  }
  return { files: files.length };
}

module.exports={ACTIVE_NAMESPACES,PRIVATE_DATA_PATTERN,assertPristineDistributionData};
