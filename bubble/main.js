const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

let win = null

const COLLAPSED_H = 52
const WIDTH       = 320
const MARGIN      = 24

let anchorX      = 0
let anchorBottom = 0
let currentH     = COLLAPSED_H

function workArea() {
  return screen.getPrimaryDisplay().workAreaSize
}

function clamp() {
  const { width: sw, height: sh } = workArea()
  anchorX      = Math.max(0, Math.min(sw - WIDTH, anchorX))
  anchorBottom = Math.max(currentH + 10, Math.min(sh, anchorBottom))
}

function applyBounds() {
  clamp()
  win.setBounds({ x: anchorX, y: anchorBottom - currentH, width: WIDTH, height: currentH })
}

function createWindow() {
  const { width, height } = workArea()

  anchorX      = width - WIDTH - MARGIN
  anchorBottom = height - MARGIN

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

ipcMain.on('resize', (_, { height }) => {
  if (!win) return
  currentH = height
  applyBounds()
})

ipcMain.on('move', (_, { dx, dy }) => {
  if (!win) return
  anchorX      += dx
  anchorBottom += dy
  applyBounds()
})

// Safety reset — double-click tray or call from renderer if bubble goes missing
ipcMain.on('reset-position', () => {
  if (!win) return
  const { width, height } = workArea()
  anchorX      = width - WIDTH - MARGIN
  anchorBottom = height - MARGIN
  currentH     = COLLAPSED_H
  applyBounds()
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
