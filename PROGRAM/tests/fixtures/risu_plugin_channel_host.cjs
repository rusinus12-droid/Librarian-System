'use strict';
// Execute upstream RisuAI's channel functions, including both allowlists and fire-and-forget callbacks.
// This exercises host routing; it is not a claim that a user's installed RisuAI was launched.
const source = "        addPluginChannelListener: (channelName: string, callback: Function) => {\n            pluginChannel.set(plugin.name + channelName, callback);\n            addPluginUnloadCallback(plugin.name, () => {\n                pluginChannel.delete(plugin.name + channelName);\n            })\n        },\n        postPluginChannelMessage: (pluginName: string, channelName: string, message: any) => {\n\n            const currentPluginName = plugin.name;\n            const receiverPlugin = DBState.db.plugins.find(p => p.name === pluginName);\n\n            if(!receiverPlugin){\n                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`);\n                return;\n            }\n\n            if(!receiverPlugin.allowedIPC?.includes(currentPluginName)){\n                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`);\n                return;\n            }\n\n            if(!plugin.allowedIPC?.includes(receiverPlugin.name)){\n                console.warn(`[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`);\n                return;\n            }\n\n\n            const callback = pluginChannel.get(pluginName + channelName);\n            if(callback){\n                callback(message, {\n                    sender: currentPluginName,\n                    channel: channelName\n                });\n            }\n        },\n";
const commit = "02a83695d81eb4e083453c4524b8c7d463df95aa";
module.exports = function createRisuChannelHost(sources) {
  const pluginChannel = new Map(), messages = [], warnings = [], unload = [];
  const plugins = Object.entries(sources).map(([name, source]) => ({name,allowedIPC:[...source.matchAll(/^\/\/@allowed-ipc\s+(\S+)/gm)].map(m=>m[1])}));
  const DBState={db:{plugins}}, console={warn:message=>warnings.push(message)};
  const addPluginUnloadCallback=(_name,fn)=>unload.push(fn);
  const executable=source.replace(/: (?:string|Function|any)(?=[,)])/g,'');
  return {commit,messages,warnings,plugins,dispose(){for(const fn of unload)fn();},api(name){
    const plugin=plugins.find(p=>p.name===name);if(!plugin)throw Error('unknown plugin '+name);
    const api=Function('plugin','pluginChannel','DBState','console','addPluginUnloadCallback','return ({'+executable+'});')(plugin,pluginChannel,DBState,console,addPluginUnloadCallback);
    return {...api,postPluginChannelMessage(target,channel,body){messages.push({sender:name,target,channel,body:JSON.parse(JSON.stringify(body))});return api.postPluginChannelMessage(target,channel,body);}};
  }};
};
module.exports.commit=commit;
