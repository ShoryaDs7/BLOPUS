const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs   = require('fs')

let win        = null
let brainServer = null

function startBrainServer() {
  const blopusDir = path.resolve(__dirname, '..')
  // Kill anything already on port 3847 (stale process from previous run)
  try { require('child_process').execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3847\') do taskkill /F /PID %a', { shell: true, stdio: 'ignore' }) } catch {}

  brainServer = spawn('npx', ['tsx', path.join(__dirname, 'server.ts')], {
    cwd:   blopusDir,
    env:   { ...process.env, BLOPUS_DIR: blopusDir },
    shell: true,
  })
  brainServer.stdout.on('data', d => process.stdout.write(`[brain] ${d}`))
  brainServer.stderr.on('data', d => process.stderr.write(`[brain] ${d}`))
  brainServer.on('exit', code => console.log(`[brain] exited ${code}`))
}

const COLLAPSED_H = 110
const EXPANDED_H  = 560
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

ipcMain.on('hide-for-screenshot', () => { if (win) win.setOpacity(0) })
ipcMain.on('show-after-screenshot', () => { if (win) win.setOpacity(1) })

// Safety reset — double-click tray or call from renderer if bubble goes missing
ipcMain.on('reset-position', () => {
  if (!win) return
  const { width, height } = workArea()
  anchorX      = width - WIDTH - MARGIN
  anchorBottom = height - MARGIN
  currentH     = COLLAPSED_H
  applyBounds()
})

app.whenReady().then(() => {
  startBrainServer()
  createWindow()
})

app.on('window-all-closed', () => {
  brainServer?.kill()
  app.quit()
})
