'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),acorn=require('acorn');
for(const file of ['LIBRA World Manager Full.js','LIBRA World Manager.js']){
 const code=fs.readFileSync(path.join(__dirname,'../dist',file),'utf8');const ast=acorn.parse(code,{ecmaVersion:'latest'});const call=ast.body.find(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression').expression;const fn=call.callee;assert.equal(fn.id.name,'createLibraRuntime');const expr=fn.params[0].right;
 const host={name:'uppercase-host'},context={Risuai:host,setTimeout,clearTimeout,setInterval,clearInterval};const env=vm.runInNewContext('('+code.slice(expr.start,expr.end)+')',context);
 assert.equal(env.host,host,file+': uppercase-only host works');assert.equal(env.window,undefined);assert.equal(env.document,undefined);assert.equal(env.fetch,undefined);
}
console.log(JSON.stringify({passed:2,failed:0}));
