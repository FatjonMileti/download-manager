const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startDownload: (url) => ipcRenderer.invoke('start-download', url),
  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
});
