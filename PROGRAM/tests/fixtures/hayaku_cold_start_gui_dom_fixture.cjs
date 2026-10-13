"use strict";
// Dedicated to the cold-start GUI guard test: real DOM parsing/selection and
// native event dispatch, with an awaitable result for existing async assertions.
const { JSDOM, VirtualConsole } = require('jsdom');
function createColdStartGuiDocument() {
  const errors=[];const console=new VirtualConsole();
  console.on('jsdomError',error=>{if(error.type!=='css-parsing')errors.push(error.message);});
  const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{pretendToBeVisual:true,virtualConsole:console});
  const add=dom.window.EventTarget.prototype.addEventListener;
  const remove=dom.window.EventTarget.prototype.removeEventListener;
  const wrappers=new WeakMap();let currentDispatch=null;
  dom.window.EventTarget.prototype.addEventListener=function(type,handler,options){
    if(!handler)return add.call(this,type,handler,options);
    let byTarget=wrappers.get(this);if(!byTarget){byTarget=new Map();wrappers.set(this,byTarget);}
    let byType=byTarget.get(type);if(!byType){byType=new Map();byTarget.set(type,byType);}
    let wrapped=byType.get(handler);
    if(!wrapped){wrapped=function(event){const result=typeof handler==='function'?handler.call(this,event):handler.handleEvent(event);if(currentDispatch)currentDispatch.push({target:this,promise:Promise.resolve(result)});return result;};byType.set(handler,wrapped);}
    return add.call(this,type,wrapped,options);
  };
  dom.window.EventTarget.prototype.removeEventListener=function(type,handler,options){return remove.call(this,type,wrappers.get(this)?.get(type)?.get(handler)||handler,options);};
  dom.window.Element.prototype.fire=async function(type,fields={}){
    if(type==='click'&&this.disabled)return;
    const records=[],previous=currentDispatch;currentDispatch=records;
    try{const event=new dom.window.Event(type,{bubbles:true,cancelable:true});for(const [key,value]of Object.entries(fields))Object.defineProperty(event,key,{value});this.dispatchEvent(event);}finally{currentDispatch=previous;}
    const results=await Promise.all(records.map(record=>record.promise));
    const targetIndex=records.findLastIndex(record=>record.target===this);return targetIndex<0?undefined:results[targetIndex];
  };
  return {dom,document:dom.window.document,errors};
}
module.exports={createColdStartGuiDocument};
