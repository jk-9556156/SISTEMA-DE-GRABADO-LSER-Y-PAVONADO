#!/usr/bin/env node
/**
 * Script para ejecutar LaserControl en desarrollo
 * Arranca el servidor y la UI Electron juntos
 * 
 * Uso: node start-laser-control.js
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const projectRoot = path.resolve(__dirname);
const port = 3000;
const desktopDir = path.join(projectRoot, 'desktop');

let serverProcess = null;
let electronProcess = null;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Función para esperar a que el servidor esté listo
function waitForServer(maxAttempts = 30) {
  return new Promise((resolve) => {
    let attempts = 0;
    const checkInterval = setInterval(() => {
      attempts++;
      http.get(`http://localhost:${port}/status`, (res) => {
        clearInterval(checkInterval);
        log('✓ Servidor listo en http://localhost:3000');
        resolve(true);
      }).on('error', () => {
        if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          log('✗ Servidor no respondió');
          resolve(false);
        }
      });
    }, 500);
  });
}

async function main() {
  log('🚀 LaserControl Control Panel - Desarrollo\n');

  // Step 1: Iniciar servidor
  log('1️⃣  Arrancando servidor Node...');
  serverProcess = spawn('node', ['server.js'], {
    cwd: projectRoot,
    stdio: 'inherit'
  });

  serverProcess.on('error', (err) => {
    log(`✗ Error en servidor: ${err.message}`);
  });

  serverProcess.on('exit', (code) => {
    log(`✗ Servidor terminado (código: ${code})`);
    if (electronProcess) electronProcess.kill();
    process.exit(code || 0);
  });

  // Step 2: Esperar a que el servidor esté listo
  log('2️⃣  Esperando que el servidor esté listo...');
  const ready = await waitForServer();
  
  if (!ready) {
    log('ERROR: El servidor no inició correctamente');
    process.exit(1);
  }

  // Step 3: Iniciar Electron
  log('3️⃣  Arrancando interfaz Electron...');
  electronProcess = spawn('npx', ['electron', '.'], {
    cwd: desktopDir,
    stdio: 'inherit'
  });

  electronProcess.on('error', (err) => {
    log(`✗ Error en Electron: ${err.message}`);
  });

  electronProcess.on('exit', (code) => {
    log('ℹ Interfaz cerrada');
    if (serverProcess && !serverProcess.killed) {
      log('Deteniendo servidor...');
      serverProcess.kill();
    }
    process.exit(code || 0);
  });

  // Manejo de cierre
  process.on('SIGINT', () => {
    log('\n🛑 Cerrando aplicación...');
    if (electronProcess && !electronProcess.killed) electronProcess.kill();
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    process.exit(0);
  });

  log('\n✅ LaserControl iniciado\n');
}

main().catch(err => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});
