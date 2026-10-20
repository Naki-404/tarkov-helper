'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  setManual: (taskId, status) => ipcRenderer.invoke('setManual', taskId, status),
  setManualMany: (ids, status) => ipcRenderer.invoke('setManualMany', ids, status),
  toggleObjective: (id, done) => ipcRenderer.invoke('toggleObjective', id, done),
  setLevel: (lvl) => ipcRenderer.invoke('setLevel', lvl),
  setWipe: (ts) => ipcRenderer.invoke('setWipe', ts),
  setWipeIgnore: (on) => ipcRenderer.invoke('setWipeIgnore', on),
  setCounter: (id, n) => ipcRenderer.invoke('setCounter', id, n),
  setTracked: (id, on) => ipcRenderer.invoke('setTracked', id, on),
  setHideout: (id, lvl) => ipcRenderer.invoke('setHideout', id, lvl),
  setOwned: (id, n) => ipcRenderer.invoke('setOwned', id, n),
  getMapDefs: () => ipcRenderer.invoke('getMapDefs'),
  getLabelsRu: () => ipcRenderer.invoke('getLabelsRu'),
  resetAll: () => ipcRenderer.invoke('resetAll'),
  clearWiki: () => ipcRenderer.invoke('clearWiki'),
  getSvg: (url) => ipcRenderer.invoke('getSvg', url),
  resetProfile: () => ipcRenderer.invoke('resetProfile'),
  rescan: () => ipcRenderer.invoke('rescan'),
  refreshData: () => ipcRenderer.invoke('refreshData'),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  browseFolder: (title) => ipcRenderer.invoke('browseFolder', title),
  detectLogs: () => ipcRenderer.invoke('detectLogs'),
  win: (action) => ipcRenderer.invoke('win', action),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  getWiki: (id) => ipcRenderer.invoke('getWiki', id),
  getMapWiki: (id) => ipcRenderer.invoke('getMapWiki', id),
  prefetchWiki: (ids) => ipcRenderer.invoke('prefetchWiki', ids),
  onWiki: on('wiki'),
  onState: on('state'),
  onData: on('data'),
  onDataError: on('dataError'),
  onEvent: on('event'),
  onToast: on('toast'),
  onMapChanged: on('mapChanged'),
  onPosition: on('position'),
  onShowTab: on('showTab'),
  onClickThrough: on('clickThrough'),
  onCompact: on('compact'),
  onDebugSide: on('debugSide'),
});
