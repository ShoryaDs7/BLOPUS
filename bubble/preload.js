const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('blopus', {
  resize: (height) => ipcRenderer.send('resize', { height }),
})
