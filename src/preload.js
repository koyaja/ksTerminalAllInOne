'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const on = (channel, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('kst', {
  invoke,
  on,
  write: (sessionId, data) => ipcRenderer.send('ssh:write', { sessionId, data }),
  resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', { sessionId, cols, rows }),
  answerHostKey: (reqId, ok) => ipcRenderer.send('hostkey:answer', { reqId, ok }),
  answerPrompt: (reqId, answers) => ipcRenderer.send('ssh:promptAnswer', { reqId, answers }),
  activity: () => ipcRenderer.send('app:activity'),
  platform: process.platform
});
