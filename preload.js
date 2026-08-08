const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cue', {
  getPlatform: () => ipcRenderer.invoke('platform'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  shortcutsChanged: () => ipcRenderer.send('settings:changed'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle'),
  captureState: () => ipcRenderer.invoke('capture:state'),
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),
  passthroughToggle: () => ipcRenderer.invoke('passthrough:toggle'),
  passthroughState: () => ipcRenderer.invoke('passthrough:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  log: (msg) => ipcRenderer.send('log', msg),
  meetingsList: () => ipcRenderer.invoke('meetings:list'),
  meetingsGet: (id) => ipcRenderer.invoke('meetings:get', id),
  meetingsSearch: (q) => ipcRenderer.invoke('meetings:search', q),
  meetingsUpdate: (id, patch) => ipcRenderer.invoke('meetings:update', id, patch),
  meetingsRemove: (id) => ipcRenderer.invoke('meetings:remove', id),
  meetingsNotes: (id) => ipcRenderer.invoke('meetings:notes', id),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'passthrough:state', 'hide:toggle', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript'];
    if (!allowed.includes(channel)) return;
    const wrapper = (_e, data) => cb(data);
    ipcRenderer.on(channel, wrapper);
    return () => ipcRenderer.removeListener(channel, wrapper);
  }
});