'use strict';
// Fixed strict JSON codec. Unlike JSON.parse alone, rejects duplicate decoded
// keys and malformed Unicode before constructing the complete parsed value.
const C=require('./contracts.cjs'),M=require('./receipt-codec.cjs');
const MiB=1048576;
const malformed=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function unicode(value){if(typeof value!=='string'||malformed.test(value))C.fail('UNSUPPORTED_SOURCE_TEXT');return value;}
function scan(text,{maximum=MiB}={}){
 const {nodes,utf8Bytes}=M.scanResultJson(text,maximum);let i=0;
 const ws=()=>{while(i<text.length&&/[\x20\t\r\n]/.test(text[i]))i++;};
 function string(){const start=i++;while(i<text.length){const c=text[i++];if(c==='"')break;if(c==='\\'){if(text[i++]==='u')i+=4;}}return unicode(JSON.parse(text.slice(start,i)));}
 function value(){ws();const ch=text[i];if(ch==='"'){string();return;}if(ch==='{'||ch==='['){const object=ch==='{',end=object?'}':']',keys=object?new Set():null;i++;ws();if(text[i]===end){i++;return;}while(true){if(object){const key=string();if(keys.has(key))C.fail('SOURCE_PROFILE_UNAVAILABLE');keys.add(key);ws();i++;}value();ws();if(text[i++]===end)return;ws();}}
 else{while(i<text.length&&!/[\x20\t\r\n,\]}]/.test(text[i]))i++;}}
 value();return {nodes,utf8Bytes};
}
function parse(text){const facts=scan(text);return {value:JSON.parse(text),...facts};}
function decode(bytes,metadata=false){try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{C.fail(metadata?'AUTHORITY_QUARANTINED':'UNSUPPORTED_SOURCE_TEXT');}}
function plain(value){if(!value||typeof value!=='object'||Array.isArray(value))C.fail('SOURCE_PROOF_UNAVAILABLE');return value;}
function exact(value,fields){plain(value);if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)C.fail('SOURCE_PROOF_UNAVAILABLE');if(Object.getOwnPropertySymbols(value).length)C.fail('SOURCE_PROOF_UNAVAILABLE');const ds=Object.getOwnPropertyDescriptors(value);if(Object.keys(ds).sort().join('|')!==fields.slice().sort().join('|')||Object.values(ds).some(d=>!d.enumerable||!Object.hasOwn(d,'value')))C.fail('SOURCE_PROOF_UNAVAILABLE');return value;}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
module.exports={MiB,unicode,scan,parse,decode,plain,exact,freeze};
