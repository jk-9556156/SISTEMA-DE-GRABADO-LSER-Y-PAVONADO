const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// Child process that runs the server (node server.js)
let serverProcess = null; // can be child_process or { inProcess: true, stop: async fn }
let mainWindow = null;

// Evitar múltiples instancias y traer la ventana al frente si ya existe
const gotLock = app.requestSingleInstanceLock && app.requestSingleInstanceLock();
if (!gotLock) {
  // Otra instancia ya corre: salir
  try { app.quit(); } catch (e) { process.exit(0); }
}

app.on('second-instance', (event, argv, workingDirectory) => {
  // Si el usuario intenta abrir otra instancia, traer la ventana existente al frente
  if (mainWindow) {
    try {
      if (mainWindow.isMinimized && mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      // pequeño truco para asegurar que se muestre por encima en setups multi-monitor
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => { try { mainWindow.setAlwaysOnTop(false); } catch (e) {} }, 800);
    } catch (e) { console.warn('second-instance focus error', e); }
  }
});

function sendToWindow(channel, payload) {
  try {
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send(channel, payload);
  } catch (e) { console.warn('sendToWindow error', e); }
}

function createWindow() {
  const win = new BrowserWindow({
    // A larger default window so the control panel and logs are comfortable
    width: 1020,
    height: 540,
    resizable: true,
    minWidth: 700,
    minHeight: 360,
    center: true,
    show: false, // iniciar oculto y mostrar cuando esté listo
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Ajustar ruta para desarrollo y producción
  let indexPath;
  if (app.isPackaged) {
    // En empaquetado, el archivo está en resources/app/
    indexPath = path.join(__dirname, 'index.html');
  } else {
    // En desarrollo, __dirname es la carpeta desktop/
    indexPath = path.join(__dirname, 'index.html');
  }

  win.loadFile(indexPath);
  // Asegurarse que la ventana se muestre y enfoque correctamente
  win.once('ready-to-show', () => {
    try {
      win.show();
      win.focus();
      // Breve always-on-top para traer al frente en pantallas multi-monitor
      win.setAlwaysOnTop(true);
      setTimeout(() => { try { win.setAlwaysOnTop(false); } catch(e){} }, 700);
    } catch (e) { console.warn('show/focus error', e); }
  });
  // Mantener DevTools solo en desarrollo
  if (!app.isPackaged) win.webContents.openDevTools();
  mainWindow = win;
}

async function startServerInternal() {
  try {
    if (serverProcess && !serverProcess.killed) return { ok: false, message: 'Server already running' };

    const isPackaged = app.isPackaged;
    let projectRoot;
    if (isPackaged) projectRoot = path.resolve(__dirname, '../../..'); else projectRoot = path.resolve(__dirname, '..');
    const serverScript = path.join(projectRoot, 'server.js');

    if (isPackaged) {
      try {
        const serverModule = require(serverScript);
        if (serverModule && typeof serverModule.startServer === 'function') {
          await serverModule.startServer();
          serverProcess = { inProcess: true, stop: serverModule.stopServer };
          sendToWindow('server-log', { level: 'info', msg: 'Server started in-process (packaged)' });
        } else {
          sendToWindow('server-log', { level: 'error', msg: 'No startServer export found in server.js' });
          return { ok: false, message: 'No startServer export in server.js' };
        }
      } catch (e) {
        console.error('Error requiring server module in packaged app', e);
        return { ok: false, error: e.message };
      }
    } else {
      serverProcess = spawn('node', [serverScript], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      serverProcess.stdout.on('data', (data) => { sendToWindow('server-log', { level: 'info', msg: String(data).replace(/\r?\n$/, '') }); });
      serverProcess.stderr.on('data', (data) => { sendToWindow('server-log', { level: 'error', msg: String(data).replace(/\r?\n$/, '') }); });
      serverProcess.on('exit', (code, signal) => { sendToWindow('server-log', { level: 'info', msg: `Server exited code=${code} signal=${signal}` }); sendToWindow('server-status', { running: false }); serverProcess = null; });
    }

    sendToWindow('server-status', { running: true });
    return { ok: true };
  } catch (err) {
    console.error('startServerInternal error', err);
    return { ok: false, error: err.message };
  }
}

app.whenReady().then(async () => {
  createWindow();

  // Intentar arrancar el servidor automáticamente en el arranque de la app
  try { await startServerInternal(); } catch (e) { console.warn('auto-start server failed', e); }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// Intentar cerrar el proceso del servidor de forma ordenada
function killServerProcess() {
  return new Promise(async (resolve) => {
    if (!serverProcess) return resolve(true);

    // Si el servidor corre in-process, llamar a su stop()
    if (serverProcess.inProcess && typeof serverProcess.stop === 'function') {
      try {
        await serverProcess.stop();
      } catch (e) { console.warn('in-process kill error', e); }
      serverProcess = null;
      return resolve(true);
    }

    try {
      // Intento de terminación amable para proceso hijo
      serverProcess.kill('SIGTERM');
    } catch (e) {
      try { serverProcess.kill(); } catch (e2) {}
    }

    // Esperar un poco y forzar si sigue vivo
    const checkInterval = 250;
    let waited = 0;
    const maxWait = 3000;
    const iv = setInterval(() => {
      waited += checkInterval;
      // en Node, 'killed' puede ser true luego del evento 'exit'
      if (!serverProcess || serverProcess.killed) {
        clearInterval(iv);
        serverProcess = null;
        return resolve(true);
      }
      if (waited >= maxWait) {
        try { serverProcess.kill('SIGKILL'); } catch (e) {}
        clearInterval(iv);
        serverProcess = null;
        return resolve(false);
      }
    }, checkInterval);
  });
}

// IPC handlers for controlling server process
ipcMain.handle('start-server', async (evt) => {
  return await startServerInternal();
});

ipcMain.handle('stop-server', async (evt) => {
  try {
    if (!serverProcess) return { ok: false, message: 'Server not running' };
    sendToWindow('server-log', { level: 'info', msg: 'Server stop requested' });
    // Si está corriendo en proceso, llamar a su stop() si está disponible
    if (serverProcess.inProcess && typeof serverProcess.stop === 'function') {
      try {
        await serverProcess.stop();
      } catch (e) { console.warn('in-process stop error', e); }
      serverProcess = null;
      sendToWindow('server-status', { running: false });
      return { ok: true };
    }
    await killServerProcess();
    sendToWindow('server-status', { running: false });
    return { ok: true };
  } catch (err) {
    console.error('stop-server error', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('is-server-running', async () => {
  return !!(serverProcess && !serverProcess.killed);
});

// Asegurar que cuando la app se cierre, también terminamos el servidor
app.on('before-quit', (e) => {
  // Si hay un proceso del servidor, intentamos cerrarlo sin bloquear demasiado
  if (serverProcess) {
    // No bloqueamos el cierre por mucho tiempo, pero solicitamos el cierre
    killServerProcess().catch(() => {});
  }
});

// También manejar señales del proceso principal para evitar huérfanos
process.on('exit', () => { if (serverProcess) try { serverProcess.kill ? serverProcess.kill() : null; } catch (e) {} });
['SIGINT','SIGTERM','SIGHUP'].forEach(sig => {
  process.on(sig, () => {
    try { killServerProcess().catch(() => {}); } catch (e) {}
    // re-emit para permitir comportamiento por defecto
    try { process.exit(0); } catch (e) {}
  });
});
