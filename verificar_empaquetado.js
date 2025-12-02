#!/usr/bin/env node
/**
 * Script de validación pre-empaquetado
 * Verifica que todo esté en orden antes de ejecutar build-package.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname);
const desktopDir = path.resolve(projectRoot, 'desktop');

let hasErrors = false;

function check(condition, msg) {
  if (condition) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    hasErrors = true;
  }
}

console.log('🔍 Pre-Empaquetado: Verificación de requisitos\n');

// 1. Verificar archivos críticos
console.log('📋 Archivos:');
check(fs.existsSync(path.join(projectRoot, 'server.js')), 'server.js existe');
check(fs.existsSync(path.join(projectRoot, 'package.json')), 'package.json existe (raíz)');
check(fs.existsSync(path.join(desktopDir, 'main.js')), 'desktop/main.js existe');
check(fs.existsSync(path.join(desktopDir, 'renderer.js')), 'desktop/renderer.js existe');
check(fs.existsSync(path.join(desktopDir, 'package.json')), 'desktop/package.json existe');
check(fs.existsSync(path.join(desktopDir, 'build-package.js')), 'desktop/build-package.js existe');

// 2. Verificar directorios
console.log('\n📂 Directorios:');
check(fs.existsSync(path.join(projectRoot, 'node_modules')), 'node_modules (raíz) existe');
check(fs.existsSync(path.join(projectRoot, 'public')), 'public/ existe');
check(fs.existsSync(path.join(projectRoot, 'public', 'sistema_de_grabado_laserv1.html')), 'sistema_de_grabado_laserv1.html existe');
check(fs.existsSync(path.join(desktopDir, 'node_modules')), 'desktop/node_modules existe');

// 3. Verificar módulos críticos
console.log('\n📦 Módulos críticos:');
const criticalModules = ['express', 'whatsapp-web.js', 'qrcode', 'fs-extra'];
for (const mod of criticalModules) {
  const modPath = path.join(projectRoot, 'node_modules', mod);
  check(fs.existsSync(modPath), `  ${mod}`);
}

// 4. Verificar que server.js exporta funciones necesarias
console.log('\n🔧 Exportaciones de server.js:');
try {
  const serverCode = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
  check(serverCode.includes('module.exports'), 'module.exports definido');
  check(serverCode.includes('startServer'), 'startServer exportado');
  check(serverCode.includes('stopServer'), 'stopServer exportado');
  check(serverCode.includes('require.main === module'), 'Verificación de main module presente');
} catch (e) {
  console.error('✗ Error leyendo server.js:', e.message);
  hasErrors = true;
}

// 5. Verificar que no hay procesos bloqueantes
console.log('\n⚙️  Procesos:');
try {
  const output = execSync('tasklist', { encoding: 'utf8' });
  const hasLaserControl = output.includes('LaserControl.exe');
  const hasElectron = output.includes('electron.exe');
  const hasNodeExe = output.includes('node.exe');
  
  if (hasLaserControl || hasElectron || hasNodeExe) {
    console.warn('⚠️  Procesos activos detectados:');
    if (hasLaserControl) console.warn('   - LaserControl.exe');
    if (hasElectron) console.warn('   - electron.exe');
    if (hasNodeExe) console.warn('   - node.exe');
    console.warn('\n   Recomendación: Detén estos procesos antes de empaquetar');
    console.warn('   PowerShell: taskkill /IM LaserControl.exe /F; taskkill /IM electron.exe /F');
  } else {
    console.log('✓ No hay procesos bloqueantes');
  }
} catch (e) {
  console.warn('⚠️  No se pudo verificar procesos:', e.message);
}

// 6. Verificar espacio en disco
console.log('\n💾 Espacio en disco:');
try {
  // Aproximación: verificar que /dist tenga ~400 MB disponibles
  const distPath = path.join(projectRoot, 'dist');
  // Node.js no tiene built-in para espacio en disco, así que solo advertimos
  console.log('   (Necesitas ~500 MB de espacio libre para el empaquetado)');
} catch (e) {
  // Ignorar
}

// Resumen
console.log('\n' + '='.repeat(50));
if (hasErrors) {
  console.error('\n❌ Hay problemas. Soluciónalos antes de empaquetar.\n');
  process.exit(1);
} else {
  console.log('\n✅ ¡Todo listo! Puedes ejecutar:\n');
  console.log('   cd desktop');
  console.log('   node build-package.js\n');
  process.exit(0);
}
