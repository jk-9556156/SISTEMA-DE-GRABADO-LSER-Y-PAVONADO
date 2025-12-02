// --- Dashboard KPIs y Cards ---
// Simulación de datos reales (puedes reemplazar por fetch o IPC)
function updateDashboardKPIs(data) {
  document.getElementById('total-pieces').textContent = data.totalPieces;
  document.getElementById('desired-percentage').textContent = data.desiredPercentage + '%';
  document.getElementById('rework-pieces').textContent = data.reworkPieces;
  document.getElementById('max-kpi').textContent = data.maxKpi;
}

// Ejemplo: actualizar cada 10s con datos simulados
setInterval(() => {
  // Aquí podrías hacer fetch o IPC para datos reales
  const simulated = {
    totalPieces: Math.floor(1200 + Math.random() * 100),
    desiredPercentage: Math.floor(90 + Math.random() * 10),
    reworkPieces: Math.floor(10 + Math.random() * 10),
    maxKpi: Math.floor(95 + Math.random() * 5)
  };
  updateDashboardKPIs(simulated);
}, 10000);
const SERVER_URL = 'http://localhost:3000';

const { ipcRenderer, shell } = require('electron');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');

function appendLog(msg) {
  const d = new Date().toLocaleTimeString();
  // Append as new line
  logEl.textContent = `${d} - ${msg}\n` + logEl.textContent;
}

async function checkServerProcess() {
  try {
    const running = await ipcRenderer.invoke('is-server-running');
    if (running) {
      statusEl.textContent = 'Servidor: EN EJECUCIÓN';
      // toggle vision classes
      statusEl.classList.add('running');
      statusEl.classList.remove('stopped');
    } else {
      statusEl.textContent = 'Servidor: DETENIDO';
      statusEl.classList.add('stopped');
      statusEl.classList.remove('running');
    }
    return running;
  } catch (e) {
    statusEl.textContent = 'Error checking server';
    statusEl.style.color = '#e74c3c';
    appendLog('Error checking server: ' + e.message);
    return false;
  }
}

document.getElementById('btn-on').addEventListener('click', async () => {
  try {
  const btn = document.getElementById('btn-on');
  btn.classList.add('loading');
  btn.setAttribute('disabled', 'disabled');
    appendLog('Start command requested');
    const res = await ipcRenderer.invoke('start-server');
    if (res && res.ok) appendLog('Server start requested'); else appendLog('Start failed: ' + (res && res.message ? res.message : res.error));
  setTimeout(() => { btn.classList.remove('loading'); btn.removeAttribute('disabled'); checkServerProcess(); }, 1000);
  } catch (e) { appendLog('Error ON: ' + e.message); }
});

document.getElementById('btn-off').addEventListener('click', async () => {
  try {
    const confirmStop = confirm('Detener el proceso Node (servidor)?');
    if (!confirmStop) return;
  const btn = document.getElementById('btn-off');
  btn.classList.add('loading');
  btn.setAttribute('disabled', 'disabled');
    appendLog('Stop command requested');
    const res = await ipcRenderer.invoke('stop-server');
    if (res && res.ok) appendLog('Server stop requested'); else appendLog('Stop failed: ' + (res && res.message ? res.message : res.error));
  setTimeout(() => { btn.classList.remove('loading'); btn.removeAttribute('disabled'); checkServerProcess(); }, 800);
  } catch (e) { appendLog('Error OFF: ' + e.message); }
});

document.getElementById('btn-open').addEventListener('click', () => {
  try {
    shell.openExternal(SERVER_URL);
    appendLog('Abriendo UI en navegador');
  } catch (e) { appendLog('Error al abrir UI: ' + e.message); }
});

// receive logs from main
ipcRenderer.on('server-log', (evt, data) => {
  const prefix = data.level === 'error' ? '[ERR]' : '[OUT]';
  appendLog(`${prefix} ${data.msg}`);
});

ipcRenderer.on('server-status', (evt, info) => {
  try {
    if (info && info.running) {
      statusEl.textContent = 'Servidor: EN EJECUCIÓN';
      statusEl.classList.add('running'); statusEl.classList.remove('stopped');
      // update button visuals
      try { document.getElementById('btn-on').setAttribute('disabled','disabled'); document.getElementById('btn-off').removeAttribute('disabled'); } catch(e){}
    } else {
      statusEl.textContent = 'Servidor: DETENIDO';
      statusEl.classList.add('stopped'); statusEl.classList.remove('running');
      try { document.getElementById('btn-on').removeAttribute('disabled'); document.getElementById('btn-off').setAttribute('disabled','disabled'); } catch(e){}
    }
  } catch (e) { /* noop */ }
});

// Poll inicial
checkServerProcess();
setInterval(checkServerProcess, 5000);
