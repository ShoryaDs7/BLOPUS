const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('blopus', {
  resize:     (height)     => ipcRenderer.send('resize', { height }),
  moveWindow: (dx, dy)     => ipcRenderer.send('move', { dx, dy }),
})
