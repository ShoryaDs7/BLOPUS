const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('blopus', {
  resize:              (height) => ipcRenderer.send('resize', { height }),
  moveWindow:          (dx, dy) => ipcRenderer.send('move', { dx, dy }),
  resetPosition:       ()       => ipcRenderer.send('reset-position'),
  hideForScreenshot:   ()       => ipcRenderer.send('hide-for-screenshot'),
  showAfterScreenshot: ()       => ipcRenderer.send('show-after-screenshot'),
})
