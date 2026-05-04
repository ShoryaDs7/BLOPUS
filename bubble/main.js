const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

let win = null

const COLLAPSED_H = 52
const WIDTH       = 320
const MARGIN      = 24

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width,
    height:      COLLAPSED_H,
    x:           width - WIDTH - MARGIN,
    y:           height - COLLAPSED_H - MARGIN,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    resizable:   false,
    skipTaskbar: true,
    hasShadow:   false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
}

// Resize while keeping bottom-right anchor fixed
ipcMain.on('resize', (_, { height }) => {
  if (!win) return
  const b = win.getBounds()
  const bottom = b.y + b.height
  win.setBounds({ x: b.x, y: bottom - height, width: WIDTH, height }, true)
})

// Manual drag — move window by delta
ipcMain.on('move', (_, { dx, dy }) => {
  if (!win) return
  const [x, y] = win.getPosition()
  win.setPosition(x + dx, y + dy)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
