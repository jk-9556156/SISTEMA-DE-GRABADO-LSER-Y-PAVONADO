#!/usr/bin/env node

/**
 * Script de Verificación de Cambios
 * Ejecutar en la consola del navegador para validar que los cambios funcionan
 */

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║  VERIFICACIÓN DE CORRECCIÓN: Indicadores de Piezas           ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

// 1. Obtener datos
const laserData = JSON.parse(localStorage.getItem('laserGrabadoData')) || {};

// 2. Contar piezas por estado
let sinProceso = 0;
let conProcesoLaser = 0;
let conProcessoPavonado = 0;
let conProcesoAmbos = 0;

const detalles = {
    sinProceso: [],
    laser: [],
    pavonado: [],
    ambos: []
};

Object.keys(laserData).forEach(lotKey => {
    const lot = laserData[lotKey];
    if (!lot || !Array.isArray(lot.pieces)) return;
    
    lot.pieces.forEach((p, idx) => {
        const proc = (p.proceso || '').toLowerCase().trim();
        const info = `${lotKey}[${idx}]: ${p.partNumber} (${p.quantity} pz)`;
        
        if (proc === '') {
            sinProceso++;
            detalles.sinProceso.push(info);
        } else if (proc === 'laser') {
            conProcesoLaser++;
            detalles.laser.push(info);
        } else if (proc === 'pavonado') {
            conProcessoPavonado++;
            detalles.pavonado.push(info);
        } else if (proc === 'ambos') {
            conProcesoAmbos++;
            detalles.ambos.push(info);
        }
    });
});

// 3. Mostrar resumen
console.log('📊 RESUMEN DE PIEZAS POR ESTADO:\n');
console.log(`  ❌ Sin proceso:      ${sinProceso} piezas`);
console.log(`  ✅ Proceso "Laser":  ${conProcesoLaser} piezas`);
console.log(`  ✅ Proceso "Pavonado": ${conProcessoPavonado} piezas`);
console.log(`  ✅ Proceso "Ambos":  ${conProcesoAmbos} piezas`);

// 4. Mostrar KPI actual
console.log('\n📈 KPI ACTUAL EN DASHBOARD:\n');
const totalPiecesEl = document.getElementById('total-pieces');
const desiredPercentageEl = document.getElementById('desired-percentage');
const reworkPiecesEl = document.getElementById('rework-pieces');
const maxKpiEl = document.getElementById('max-kpi');

console.log(`  Total de Piezas: ${totalPiecesEl ? totalPiecesEl.textContent : '?'}`);
console.log(`  Porcentaje Deseado: ${desiredPercentageEl ? desiredPercentageEl.textContent : '?'}`);
console.log(`  Piezas a Retrabajar: ${reworkPiecesEl ? reworkPiecesEl.textContent : '?'}`);
console.log(`  KPI Máximo: ${maxKpiEl ? maxKpiEl.textContent : '?'}`);

// 5. Validación
console.log('\n✔️ VALIDACIÓN:\n');
const expectedTotalPieces = conProcesoLaser + conProcesoAmbos;
const actualTotalPieces = parseInt(totalPiecesEl ? totalPiecesEl.textContent : '0');

if (actualTotalPieces === expectedTotalPieces) {
    console.log(`  ✅ CORRECTO: El KPI muestra ${actualTotalPieces} piezas (esperado)`);
    if (sinProceso > 0) {
        console.log(`  ✅ CORRECTO: Hay ${sinProceso} piezas sin proceso y NO aparecen en KPI`);
    }
} else {
    console.warn(`  ⚠️ DISCREPANCIA: KPI muestra ${actualTotalPieces} pero debería ser ${expectedTotalPieces}`);
}

// 6. Mostrar detalles si hay pocos
console.log('\n📋 DETALLES (primeras 3 de cada grupo):\n');
if (detalles.sinProceso.length > 0) {
    console.log('  Sin Proceso:');
    detalles.sinProceso.slice(0, 3).forEach(d => console.log(`    - ${d}`));
    if (detalles.sinProceso.length > 3) console.log(`    ... y ${detalles.sinProceso.length - 3} más`);
}
if (detalles.laser.length > 0) {
    console.log('\n  Con Proceso "Laser":');
    detalles.laser.slice(0, 3).forEach(d => console.log(`    - ${d}`));
    if (detalles.laser.length > 3) console.log(`    ... y ${detalles.laser.length - 3} más`);
}
if (detalles.pavonado.length > 0) {
    console.log('\n  Con Proceso "Pavonado":');
    detalles.pavonado.slice(0, 3).forEach(d => console.log(`    - ${d}`));
    if (detalles.pavonado.length > 3) console.log(`    ... y ${detalles.pavonado.length - 3} más`);
}
if (detalles.ambos.length > 0) {
    console.log('\n  Con Proceso "Ambos":');
    detalles.ambos.slice(0, 3).forEach(d => console.log(`    - ${d}`));
    if (detalles.ambos.length > 3) console.log(`    ... y ${detalles.ambos.length - 3} más`);
}

console.log('\n' + '═'.repeat(60) + '\n');
