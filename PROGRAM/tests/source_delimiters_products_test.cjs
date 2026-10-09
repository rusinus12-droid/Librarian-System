'use strict';
// The same production commit/ledger/source-diff assertions, using asymmetric delimiters.
const fs=require('fs'),path=require('path'),Module=require('module');
const file=path.join(__dirname,'source_rules_products_test.cjs');let source=fs.readFileSync(file,'utf8');
source=source.replace("unwrapTags:['wrapper'],sourceTags:['original']","unwrapTags:[{open:'[WRAP BEGIN]',close:'[WRAP END]'}],sourceTags:[{open:'[SOURCE START]',close:'[SOURCE END]'}]");
source=source.replaceAll('<original>','[SOURCE START]').replaceAll('</original>','[SOURCE END]').replaceAll('<wrapper>','[WRAP BEGIN]').replaceAll('</wrapper>','[WRAP END]');
const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source,file);
