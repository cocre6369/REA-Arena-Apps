// Bridge between the renderer and the Electron main process.
// Exposes a tiny, explicit API — nothing else reaches into Node.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chroma', {
  desktop: true,
  /** Save a Uint8Array/ArrayBuffer to a real file via a native Save dialog. */
  saveBuffer: (data, defaultPath, filters) =>
    ipcRenderer.invoke('save-buffer', { data: new Uint8Array(data), defaultPath, filters }),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  pickOpen: () => ipcRenderer.invoke('pick-open'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),
});
