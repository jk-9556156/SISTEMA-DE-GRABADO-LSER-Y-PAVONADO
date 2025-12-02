#!/usr/bin/env node
/**
 * Script para empaquetar la app Electron correctamente
 * Copia los archivos necesarios de servidor a la carpeta de recursos
 * 
 * Requisitos:
 * - npm run package-win-base debe estar definido en desktop/package.json
 * - Los archivos de servidor deben existir en la raíz del proyecto
 * - node_modules debe estar presente (ejecutar npm install en raíz si no existe)
 */

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔨 Iniciando proceso de empaquetado Laser Control...\n');

const projectRoot = path.resolve(__dirname, '..');
const desktopDir = path.resolve(projectRoot, 'desktop');
const distDir = path.resolve(projectRoot, 'dist');
const appDir = path.resolve(distDir, 'LaserControl-win32-x64', 'resources', 'app');

// Archivos necesarios del servidor
const serverFiles = [
  'server.js',          // ⭐ Crítico: lógica principal
  'bot.js',             // Bot de WhatsApp
  'package.json',       // Dependencias
  'allowed_users.json', // Config de usuarios
  'tokens.json',        // Tokens
  'verificar_cambios.js', // Scripts auxiliares
  'validacion_indicadores.js'
];

// Directorios necesarios
const serverDirs = [
  'public',             // UI estática (sistema_de_grabado_laserv1.html)
  'logs',               // Directorio de logs
  'to_engrave',         // Cola de grabado
  'scripts',            // Scripts auxiliares
  'node_modules'        // ⭐ CRÍTICO: dependencias de runtime (express, whatsapp-web.js, etc.)
];

function validateEnvironment() {
  console.log('🔍 Validando entorno...');
  
  // Verificar que server.js exista
  if (!fs.existsSync(path.join(projectRoot, 'server.js'))) {
    console.error('❌ server.js no encontrado en raíz del proyecto');
    process.exit(1);
  }
  
  // Verificar que node_modules exista (si no, avisar al usuario)
  const nodeModulesRoot = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesRoot)) {
    console.warn('⚠️  node_modules no encontrado en raíz. Ejecuta: npm install');
    console.warn('   (En desktopDir también se necesita: cd desktop && npm install)');
  }
  
  // Verificar que desktop/node_modules exista para electron-packager
  const desktopNodeModules = path.join(desktopDir, 'node_modules');
  if (!fs.existsSync(desktopNodeModules)) {
    console.warn('⚠️  desktop/node_modules no encontrado. Ejecuta: cd desktop && npm install');
    process.exit(1);
  }
  
  console.log('✓ Entorno validado\n');
}

function packageApp() {
  console.log('📦 Empaquetando con electron-packager...');
  console.log('   (esto puede tardar 30-60 segundos)');
  
  try {
    execSync('npm run package-win-base', { cwd: desktopDir, stdio: 'inherit' });
    console.log('✓ Empaquetado completado\n');
  } catch (error) {
    console.error('❌ Error en electron-packager:', error.message);
    console.error('   Asegúrate de que desktop/package.json tiene el script "package-win-base"');
    process.exit(1);
  }
}

function copyServerFiles() {
  console.log('📁 Copiando archivos del servidor...\n');
  
  // Crear directorio de destino
  try {
    fs.ensureDirSync(appDir);
  } catch (e) {
    console.error('❌ No se pudo crear:', appDir);
    process.exit(1);
  }
  
  // Copiar archivos individuales (obligatorios)
  console.log('📄 Archivos:');
  let filesCopied = 0;
  for (const file of serverFiles) {
    const src = path.join(projectRoot, file);
    const dst = path.join(appDir, file);
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        console.log(`  ✓ ${file}`);
        filesCopied++;
      } else {
        console.log(`  - ${file} (no encontrado, saltando)`);
      }
    } catch (e) {
      console.warn(`  ⚠️  Error copiando ${file}:`, e.message);
    }
  }
  console.log(`  Total: ${filesCopied}/${serverFiles.length} archivos copiados\n`);
  
  // Copiar directorios (críticos)
  console.log('📂 Directorios:');
  let dirsCopied = 0;
  for (const dir of serverDirs) {
    const src = path.join(projectRoot, dir);
    const dst = path.join(appDir, dir);
    try {
      if (fs.existsSync(src)) {
        // Eliminar destino si existe para hacer copia limpia
        if (fs.existsSync(dst)) {
          fs.removeSync(dst);
        }
        fs.copySync(src, dst);
        
        // Contar items para feedback
        let itemCount = 0;
        try {
          itemCount = fs.readdirSync(dst).length;
        } catch (e) { /* noop */ }
        
        console.log(`  ✓ ${dir}/ (${itemCount} items)`);
        dirsCopied++;
      } else {
        console.log(`  - ${dir}/ (no encontrado, saltando)`);
      }
    } catch (e) {
      console.warn(`  ⚠️  Error copiando ${dir}/:`, e.message);
    }
  }
  console.log(`  Total: ${dirsCopied}/${serverDirs.length} directorios copiados\n`);
  
  // Verificar archivos críticos
  console.log('🔐 Validando archivos críticos en paquete:');
  const critical = ['server.js', 'node_modules/express'];
  let allPresent = true;
  for (const file of critical) {
    const checkPath = path.join(appDir, file);
    if (fs.existsSync(checkPath)) {
      console.log(`  ✓ ${file}`);
    } else {
      console.error(`  ✗ ${file} (FALTA - El .exe no funcionará)`);
      allPresent = false;
    }
  }
  
  if (!allPresent) {
    console.error('\n❌ Faltan archivos críticos en el paquete.');
    console.error('   Solución: Asegúrate de haber ejecutado "npm install" en la raíz del proyecto');
    process.exit(1);
  }
  
  console.log('\n');
}

function printSummary() {
  console.log('✅ Empaquetado completado exitosamente!\n');
  console.log('📍 Ubicación del .exe:');
  console.log(`   ${path.resolve(distDir, 'LaserControl-win32-x64', 'LaserControl.exe')}\n`);
  console.log('� Para ejecutar:');
  console.log('   1. Abre el .exe (la ventana debería aparecer en primer plano)');
  console.log('   2. Haz clic en "Iniciar Servidor" en el panel de control Electron');
  console.log('   3. El navegador debería abrir automáticamente http://localhost:3000\n');
  console.log('📋 Notas:');
  console.log('   - El .exe incluye Node.js y todas las dependencias (no necesita instalación)');
  console.log('   - Si la ventana aparece detrás de otras, haz clic en el .exe nuevamente');
  console.log('   - Los logs de servidor aparecerán en el panel de control Electron');
}

// Ejecutar
try {
  validateEnvironment();
  packageApp();
  copyServerFiles();
  printSummary();
} catch (error) {
  console.error('\n💥 Error inesperado:', error.message);
  process.exit(1);
}
