const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

let win = null

const COLLAPSED_H = 52
const WIDTH       = 320
const MARGIN      = 24

// Track anchor separately — never read from getBounds() for resize
// because getBounds() returns stale values during rapid resizes
let anchorX      = 0
let anchorBottom = 0
let currentH     = COLLAPSED_H

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  anchorX      = width - WIDTH - MARGIN
  anchorBottom = height - MARGIN   // fixed bottom edge

  win = new BrowserWindow({
    width:       WIDTH,
    height:      COLLAPSED_H,
    x:           anchorX,
    y:           anchorBottom - COLLAPSED_H,
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

// Resize — always anchored to tracked bottom, never reads getBounds()
ipcMain.on('resize', (_, { height }) => {
  if (!win) return
  currentH = height
  win.setBounds({ x: anchorX, y: anchorBottom - height, width: WIDTH, height })
})

// Drag — move window and update anchor
ipcMain.on('move', (_, { dx, dy }) => {
  if (!win) return
  anchorX      += dx
  anchorBottom += dy
  const [x, y]  = win.getPosition()
  win.setPosition(x + dx, y + dy)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
