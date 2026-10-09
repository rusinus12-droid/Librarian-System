// Isolated browser host boundary for executing the real HAYAKU plugin. All
// storage is ephemeral; no external model response or user data is fabricated.
window.__hostCalls={llm:0,network:0,writes:0};
const createStore=()=>{const v=new Map();return {async getItem(k){return v.get(String(k))??null;},async setItem(k,x){__hostCalls.writes++;v.set(String(k),x);return true;},async removeItem(k){v.delete(String(k));return true;},async clear(){v.clear();return true;},async keys(){return [...v.keys()];},async key(i){return [...v.keys()][i]??null;},async length(){return v.size;}};};
window.__chat={id:'gui-chat-A',chatId:'gui-chat-A',name:'GUI 검증용 채팅',message:[],messages:[],bindedPersona:''};
window.__character={id:'gui-character',chaId:'gui-character',name:'GUI 검증용 캐릭터',chatPage:0,chats:[__chat]};
const args=new Map(Object.entries({memory_suite_server_mode:'plugin_only',hayaku_debug:'false',hayaku_background_auto_repair:'false',hayaku_after_request_auto_repair:'false',hayaku_native_auto_repair:'false'}));
const eventHandlers=new Map(),unloads=[];
const host={pluginStorage:createStore(),safeLocalStorage:createStore(),
 async getLocalPluginStorage(){return this.safeLocalStorage;},async getArgument(k){return args.get(k)??'';},async getArg(k){return args.get(k)??'';},async setArgument(k,v){args.set(k,v);return true;},async setArg(k,v){args.set(k,v);return true;},
 async nativeFetch(){__hostCalls.network++;throw Error('TEST_NETWORK_DISABLED');},async runLLMModel(){__hostCalls.llm++;throw Error('TEST_MODEL_DISABLED');},
 async getDatabase(fields){const db={characters:[__character],personas:[],selectedPersona:'',plugins:[],maxContext:128000,maxResponse:8192};return Array.isArray(fields)?Object.fromEntries(fields.map(k=>[k,db[k]??null])):db;},
 async setDatabase(){throw Error('TEST_DATABASE_WRITE_DISABLED');},async getCurrentCharacterIndex(){return 0;},async getCurrentChatIndex(){return 0;},
 async getCharacter(){return __character;},async getChar(){return __character;},async getCharacterFromIndex(){return __character;},async getChat(){return __chat;},async getCurrentChat(){return __chat;},async getChatFromIndex(){return __chat;},
 async getRuntimeInfo(){return {apiVersion:'3.0',platform:'web',saveMethod:'local'};},async showContainer(){return true;},async hideContainer(){return true;},
 async getRootDocument(){return document;},async getRootContainer(){return document.body;},async getPluginRoot(){return document.body;},
 async addPluginChannelListener(k,h){eventHandlers.set(k,h);return true;},async removePluginChannelListener(k){eventHandlers.delete(k);return true;},async unregisterPluginChannelListener(k){eventHandlers.delete(k);return true;},async postPluginChannelMessage(){return true;},
 async onUnload(h){unloads.push(h);return true;}
};
for(const m of ['registerSetting','registerButton','unregisterSetting','unregisterButton','unregisterUIPart','addRisuReplacer','removeRisuReplacer','addRisuScriptHandler','removeRisuScriptHandler','addRisuChatListener','removeRisuChatListener','registerBodyIntercepter','unregisterBodyIntercepter'])host[m]=async()=>true;
window.risuai=window.Risuai=window.RisuAI=host;
window.confirm=()=>false;window.prompt=()=>null;window.alert=()=>{};
window.__dispose=async()=>{for(const h of [...unloads].reverse())await h();};
