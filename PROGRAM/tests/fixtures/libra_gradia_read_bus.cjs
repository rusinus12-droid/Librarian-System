'use strict';
module.exports = function createBus() {
  const listeners = new Map(), messages = [];
  const key = (id, channel) => JSON.stringify([id, channel]);
  return { messages, api(id) { return {
    async addPluginChannelListener(channel, handler) { const name = key(id, channel); if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); return true; },
    async removePluginChannelListener(channel, handler) { listeners.get(key(id, channel))?.delete(handler); return true; },
    async postPluginChannelMessage(target, channel, message) {
      const body = JSON.parse(JSON.stringify(message)); messages.push({ sender: id, target, channel, body });
      for (const handler of [...(listeners.get(key(target, channel)) || [])]) await handler(JSON.parse(JSON.stringify(body)), { sender: id });
    }
  }; } };
};
