'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('the common core keeps its strict directive at the lexical factory boundary',()=>{
 const root=path.resolve(__dirname,'..'),source=fs.readFileSync(root+'/src/MemorySuiteSnapshotCache.cjs');assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'f3f08f23ef873a5c0bf561b85c3271459cf908275a7d6e19f0448fa00ce3e1cc');
 const full=fs.readFileSync(process.env.WM_CHECKSUM_DIST||root+'/dist/LIBRA World Manager Full.js','utf8');assert.ok(/const WmSharedCacheFactory = \(\) => \{\s*['"]use strict['"];/.test(full),'common core strict directive was displaced by wrapper declaration');
});
