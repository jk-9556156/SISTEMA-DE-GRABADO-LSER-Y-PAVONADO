// Script de Validación para los Cambios de Indicadores de Piezas
// Abre la consola del navegador (F12) y copia-pega este código

console.log('=== VALIDACIÓN DE CAMBIOS EN INDICADORES ===\n');

// 1. Verificar que el localStorage tiene los datos
console.log('1. Datos actuales en localStorage:');
const laserData = JSON.parse(localStorage.getItem('laserGrabadoData')) || {};
console.log('Lotes encontrados:', Object.keys(laserData));

// 2. Contar piezas por estado de proceso
console.log('\n2. Piezas por estado de proceso:');
let piecesByProcess = {
  'sin_proceso': [],
  'laser': [],
  'pavonado': [],
  'ambos': [],
  'otros': []
};

Object.keys(laserData).forEach(lotKey => {
  const lot = laserData[lotKey];
  if (!lot || !Array.isArray(lot.pieces)) return;
  
  lot.pieces.forEach((p, idx) => {
    const proc = (p.proceso || '').toLowerCase().trim();
    const info = `${lotKey}[${idx}]: ${p.partNumber} (${p.quantity} piezas)`;
    
    if (proc === '') {
      piecesByProcess['sin_proceso'].push(info);
    } else if (proc === 'laser') {
      piecesByProcess['laser'].push(info);
    } else if (proc === 'pavonado') {
      piecesByProcess['pavonado'].push(info);
    } else if (proc === 'ambos') {
      piecesByProcess['ambos'].push(info);
    } else {
      piecesByProcess['otros'].push(`${info} (proceso: "${proc}")`);
    }
  });
});

console.log(`Sin proceso: ${piecesByProcess['sin_proceso'].length} piezas`);
if (piecesByProcess['sin_proceso'].length > 0) console.log('  -', piecesByProcess['sin_proceso'].slice(0, 3).join('\n  - '));

console.log(`Con proceso 'laser': ${piecesByProcess['laser'].length} piezas`);
if (piecesByProcess['laser'].length > 0) console.log('  -', piecesByProcess['laser'].slice(0, 3).join('\n  - '));

console.log(`Con proceso 'pavonado': ${piecesByProcess['pavonado'].length} piezas`);
if (piecesByProcess['pavonado'].length > 0) console.log('  -', piecesByProcess['pavonado'].slice(0, 3).join('\n  - '));

console.log(`Con proceso 'ambos': ${piecesByProcess['ambos'].length} piezas`);
if (piecesByProcess['ambos'].length > 0) console.log('  -', piecesByProcess['ambos'].slice(0, 3).join('\n  - '));

// 3. Verificar que los indicadores muestran valores correctos
console.log('\n3. Valores actuales en el Dashboard:');
const totalPiecesEl = document.getElementById('total-pieces');
const desiredPercentageEl = document.getElementById('desired-percentage');
const reworkPiecesEl = document.getElementById('rework-pieces');
const maxKpiEl = document.getElementById('max-kpi');

if (totalPiecesEl) console.log(`Total de piezas (KPI): ${totalPiecesEl.textContent}`);
if (desiredPercentageEl) console.log(`Porcentaje deseado: ${desiredPercentageEl.textContent}`);
if (reworkPiecesEl) console.log(`Piezas a retrabajar: ${reworkPiecesEl.textContent}`);
if (maxKpiEl) console.log(`KPI máximo: ${maxKpiEl.textContent}`);

// 4. Simulación: verificar que loadDashboardData() calcula correctamente
console.log('\n4. Verificación de lógica de cálculo:');
let testTotalPieces = 0;
Object.keys(laserData).forEach(lotKey => {
  const lot = laserData[lotKey];
  if (!lot || !Array.isArray(lot.pieces)) return;
  
  lot.pieces.forEach(p => {
    const proc = (p.proceso || '').toLowerCase().trim();
    if (proc === 'laser' || proc === 'ambos') {
      testTotalPieces += Number(p.quantity || 0) || 0;
    }
  });
});

console.log(`Total de piezas con proceso 'laser' o 'ambos': ${testTotalPieces}`);
console.log(`Este valor debería coincidir con el KPI mostrado en el Dashboard.\n`);

// 5. Recomendaciones
console.log('5. Recomendaciones:');
if (piecesByProcess['sin_proceso'].length > 0 && testTotalPieces === 0) {
  console.log('✅ CORRECTO: Hay piezas sin proceso y el KPI de "Piezas a grabar" es 0');
} else if (piecesByProcess['sin_proceso'].length > 0 && testTotalPieces > 0) {
  console.warn('⚠️ POSIBLE ERROR: Hay piezas sin proceso pero el KPI muestra valores');
  console.warn('   Verifica que loadDashboardData() solo cuente piezas con proceso definido');
} else if (piecesByProcess['sin_proceso'].length === 0) {
  console.log('ℹ️ INFO: No hay piezas sin proceso. Todas tienen asignado un proceso.');
}

console.log('\n=== FIN DE LA VALIDACIÓN ===');
