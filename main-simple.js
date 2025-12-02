const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;

// Evitar múltiples instancias
const gotLock = app.requestSingleInstanceLock && app.requestSingleInstanceLock();
if (!gotLock) {
  try { app.quit(); } catch (e) { process.exit(0); }
}

app.on('second-instance', (event, argv, workingDirectory) => {
  if (mainWindow) {
    try {
      if (mainWindow.isMinimized && mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => { try { mainWindow.setAlwaysOnTop(false); } catch (e) {} }, 800);
    } catch (e) { console.warn('second-instance focus error', e); }
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1020,
    height: 540,
    resizable: true,
    minWidth: 700,
    minHeight: 360,
    center: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  let indexPath = path.join(__dirname, 'index.html');
  win.loadFile(indexPath);
  
  win.once('ready-to-show', () => {
    try {
      win.show();
      win.focus();
      win.setAlwaysOnTop(true);
      setTimeout(() => { try { win.setAlwaysOnTop(false); } catch(e){} }, 700);
    } catch (e) { console.warn('show/focus error', e); }
  });
  
  if (!app.isPackaged) win.webContents.openDevTools();
  mainWindow = win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers - conectar con el UI del servidor que ya está corriendo
ipcMain.handle('start-server', async (evt) => {
  // En desarrollo, el servidor ya debe estar corriendo (iniciado por start-laser-control.js)
  return { ok: true, message: 'Server running externally' };
});

ipcMain.handle('stop-server', async (evt) => {
  return { ok: false, message: 'Cannot stop external server from UI' };
});

ipcMain.handle('is-server-running', async () => {
  // Verificar si el servidor responde en puerto 3000
  return new Promise((resolve) => {
    http.get('http://localhost:3000/status', (res) => {
      resolve(res.statusCode === 200);
    }).on('error', () => {
      resolve(false);
    });
  });
});
