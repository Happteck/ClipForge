const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  importFiles: () => ipcRenderer.invoke('import'),
  saveProject: (o) => ipcRenderer.invoke('saveProject', o),
  openProject: () => ipcRenderer.invoke('openProject'),
  asrPort: () => ipcRenderer.invoke('asrPort'),
  extractAudio: (o) => ipcRenderer.invoke('extractAudio', o),
  autosaveWrite: (o) => ipcRenderer.invoke('autosaveWrite', o),
  autosaveRead: () => ipcRenderer.invoke('autosaveRead'),
  autosaveClear: () => ipcRenderer.invoke('autosaveClear'),
  recentList: () => ipcRenderer.invoke('recentList'),
  recentAdd: (r) => ipcRenderer.invoke('recentAdd', r),
  recentRemove: (f) => ipcRenderer.invoke('recentRemove', f),
  recentClear: () => ipcRenderer.invoke('recentClear'),
  readProject: (f) => ipcRenderer.invoke('readProject', f),
  pickSave: () => ipcRenderer.invoke('pickSave'),
  exportVideo: (opts) => ipcRenderer.invoke('export', opts),
  cancelExport: () => ipcRenderer.invoke('cancelExport'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, v) => cb(v)),
  pathFor: (file) => webUtils.getPathForFile(file)
});
