'use strict';
// Dependency injection for existing extracted-function tests. Values are evaluated
// from the deployed source, not a test copy of the engine's version predicate.
module.exports=function productionBindings(source,names=['LIBRARIAN_STAGE_ID','LIBRARIAN_ENGINE_VERSION','READABLE_UNIFIED_ENGINE_VERSIONS','isReadableUnifiedEngineVersion','UNIFIED_ARTIFACT_SCHEMA','UNIFIED_ARTIFACT_SCHEMA_V5','UNIFIED_READABLE_ARTIFACT_SCHEMAS','unifiedArtifactSchemaReadable']){
 const start=source.indexOf('  const LIBRARIAN_STAGE_ID ='),end=source.indexOf('  const LEGACY_MEMORY_STAGE_DEFS',start);
 if(start<0||end<start)throw Error('Librarian production declarations missing');
 // The schema constants and the readable predicate are taken from the deployed
 // source for the same reason as the engine-version predicate above: a test copy
 // could silently disagree with production about what is readable. Each piece is
 // extracted separately so a comment or reordering in the source cannot break it.
 const declarations=[];
 for (const pattern of [
   /const UNIFIED_ARTIFACT_SCHEMA = '[^']+';/,
   /const UNIFIED_ARTIFACT_SCHEMA_V5 = '[^']+';/,
   /const UNIFIED_READABLE_ARTIFACT_SCHEMAS = [^;]+;/,
   /const unifiedArtifactSchemaReadable = [^;]+;/
 ]) {
   const match=source.match(pattern)?.[0];
   if(!match)throw Error(`Production declaration missing: ${pattern}`);
   declarations.push(match);
 }
 // `unifiedArtifactSchemaReadable` closes over the production `string()` helper,
 // which lives outside this slice, so its definition is supplied here with the
 // same semantics (trim, coerce) the plugin uses.
 const preamble = "const string = value => String(value ?? '').trim();";
 return Function(preamble+'\n'+source.slice(start,end)+'\n'+declarations.join('\n')+'\nreturn {'+names.join(',')+'};')();
};
