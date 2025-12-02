const express = require('express');
const os = require('os');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
// const xlsx = require('xlsx'); // EXCEL writing removed - replaced by engrave JSON
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
// Registrar rejections globales para diagnóstico en tiempo de ejecución
process.on('unhandledRejection', (reason, promise) => {
    try { console.error('Unhandled Rejection at:', promise, 'reason:', reason); } catch (e) { /* noop */ }
});
// Configurar servidor web
// Evitar que express sirva automáticamente `index.html` como raíz para que usemos
// nuestro HTML principal del sistema de grabado.
// Usar ruta absoluta para evitar problemas si el proceso se inicia desde otro CWD.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Permitir payloads JSON grandes (imágenes en data URLs pueden ser grandes)
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ limit: '30mb', extended: true }));

// Manejar errores de body-parser (p.ej. PayloadTooLargeError) y devolver 413
app.use((err, req, res, next) => {
    if (!err) return next();
    try {
        if (err.type === 'entity.too.large' || err.status === 413) {
            console.error('PayloadTooLargeError:', err.message || err);
            return res.status(413).json({ error: 'Payload too large' });
        }
    } catch (e) {
        // ignore and pass to next
    }
    return next(err);
});

// Configurar WhatsApp
// Opciones robustas para puppeteer: permitir pasar CHROME_PATH por variable de entorno
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--single-process'
];
// Guardar TODO (incluyendo sesión de WhatsApp) en la ruta de red
// Se definirá después de TO_ENGRAVE_DIR, que está abajo en el código
let DEFAULT_WWEBJS_AUTH_PATH = null;

// Función para validar que podemos escribir en la ruta de red
function ensureWritableDir(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Prueba de escritura
        const testFile = path.join(dir, `.perm_test_${Date.now()}`);
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        return true;
    } catch (err) {
        console.error(`❌ No se puede escribir en la ruta requerida: ${dir}`);
        console.error('Error:', err && err.message ? err.message : err);
        return false;
    }
}

// El cliente de WhatsApp se crea DESPUÉS de definir TO_ENGRAVE_DIR
// Ver más abajo donde se inicializa después de cargar la configuración de rutas
let client = null;

// Función de inicialización con reintentos para reducir fallos por "Session closed"
async function safeInitialize(clientInstance, maxRetries = 3) {
    let attempt = 0;
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    while (attempt < maxRetries) {
        attempt++;
        try {
            await clientInstance.initialize();
            return;
        } catch (err) {
            console.error(`Error inicializando WhatsApp client (intento ${attempt}):`, err && err.message ? err.message : err);
            // Si la sesión se cerró, intentar reiniciar después de destruir la sesión
            try { clientInstance.destroy(); } catch (e) { /* noop */ }
            if (attempt < maxRetries) {
                // backoff exponencial pequeño
                await delay(1000 * attempt);
                continue;
            }
            // rethrow after exhausting retries
            throw err;
        }
    }
}

// Variables globales
let qrCode = null;
let isAuthenticated = false;
let registros = [];
// SSE clients (Server-Sent Events) para notificar al frontend en tiempo real
let sseClients = [];
// Guardar messageIds recientes para evitar procesar el mismo mensaje varias veces
// Clave: messageId (string) -> timestamp (ms)
const recentMessageIds = new Map();
const RECENT_ID_TTL_MS = 1000 * 60 * 5; // 5 minutos

function isDuplicateMessageId(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    // Eliminar entradas antiguas
    for (const [id, ts] of recentMessageIds.entries()) {
        if (now - ts > RECENT_ID_TTL_MS) recentMessageIds.delete(id);
    }
    if (recentMessageIds.has(messageId)) return true;
    recentMessageIds.set(messageId, now);
    return false;
}

// Prevención adicional de duplicados por contenido (firma simple)
// Evita crear varios archivos casi simultáneos con mismo numParte+numPiezas+imagen
const recentSavedSignatures = new Map();
const SIGNATURE_TTL_MS = 1000 * 15; // 15s

function makeSignature(numParte, numPiezas, imagen) {
    // Usar una porción de la imagen/data para la firma si existe
    let imgSig = 'NOIMG';
    try {
        if (imagen && typeof imagen === 'string') {
            imgSig = 'IMG:' + imagen.slice(0, 80);
        }
    } catch (e) { imgSig = 'IMGERR'; }
    return `${String(numParte)}|${String(numPiezas)}|${imgSig}`;
}

function getRecentSavedRutaForSignature(sig) {
    const now = Date.now();
    const entry = recentSavedSignatures.get(sig);
    if (!entry) return null;
    if (now - entry.ts > SIGNATURE_TTL_MS) {
        recentSavedSignatures.delete(sig);
        return null;
    }
    return entry.ruta;
}

function rememberSavedSignature(sig, ruta) {
    recentSavedSignatures.set(sig, { ruta, ts: Date.now() });
}
// Nota: la gestión de tokens/ALTA fue eliminada. No se almacenan ni gestionan tokens en el servidor.

// Número del bot (puede establecerse por env BOT_NUMBER o detectarse al ready)
let BOT_NUMBER = process.env.BOT_NUMBER || null;

// 🔒 CONFIGURACIÓN DE GRUPO WHITELIST
// Solo procesar mensajes de grupos específicos
// Puede configurarse por variable de entorno ALLOWED_GROUPS_JSON
// Ejemplo: ALLOWED_GROUPS_JSON='{"grupo1":"Nombre Grupo Recepción","grupo2":"Grupo Producción"}'
// O dejar vacío para ACEPTAR TODOS LOS GRUPOS
let ALLOWED_GROUPS = {};
let USE_GROUP_FILTER = false;

function loadGroupConfig() {
    // Intentar cargar desde archivo allowed_groups.json
    const configPath = path.join(__dirname, 'allowed_groups.json');
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            ALLOWED_GROUPS = JSON.parse(data);
            USE_GROUP_FILTER = Object.keys(ALLOWED_GROUPS).length > 0;
            if (USE_GROUP_FILTER) {
                console.log('🔒 Filtro de grupo ACTIVO. Grupos autorizados:');
                Object.entries(ALLOWED_GROUPS).forEach(([id, name]) => {
                    console.log(`   ✅ ${name} (${id})`);
                });
            } else {
                console.log('🟢 Filtro de grupo INACTIVO - Aceptando mensajes de cualquier grupo/contacto');
            }
        }
    } catch (err) {
        console.log('ℹ️ No se encontró allowed_groups.json, usando filtro predeterminado');
    }

    // Permitir sobrescribir por variable de entorno
    if (process.env.ALLOWED_GROUPS_JSON) {
        try {
            ALLOWED_GROUPS = JSON.parse(process.env.ALLOWED_GROUPS_JSON);
            USE_GROUP_FILTER = Object.keys(ALLOWED_GROUPS).length > 0;
            console.log('🔒 Filtro de grupo configurado por variable de entorno');
        } catch (err) {
            console.error('❌ Error parseando ALLOWED_GROUPS_JSON:', err);
        }
    }
}

// Nota: se eliminó la gestión de usuarios autorizados para permitir
// que el sistema acepte mensajes de cualquier remitente (si no hay filtro de grupo).
function normalizeNumber(jid) {
    if (!jid) return jid;
    return String(jid).replace(/@.*$/, '').trim();
}
let allowedUsers = []; // mantenemos la variable por compatibilidad (no usada)
// Carpeta para archivos del sistema de grabado
// Forzar uso de la ruta de red central (solicitada). Puede sobrescribirse con TO_ENGRAVE_DIR env si se desea.
const NETWORK_SAVE_DIR = "\\\\ociserver\\INNOVAX\\AREA DE TRABAJO\\6.- ENSAMBLE\\SISTEMA DE PAVONADO Y GRABADO LASER";
const TO_ENGRAVE_DIR = (process.env.TO_ENGRAVE_DIR && process.env.TO_ENGRAVE_DIR.trim() !== '')
    ? path.resolve(process.env.TO_ENGRAVE_DIR)
    : NETWORK_SAVE_DIR;

console.log(`📁 TO_ENGRAVE_DIR configurado en: ${TO_ENGRAVE_DIR}`);

// Ahora que tenemos TO_ENGRAVE_DIR, definir la ruta de auth
// IMPORTANTE: LocalAuth se guarda en disco LOCAL (no UNC) para evitar I/O lenta sobre la red
// que causa timeouts "Session closed" durante la inicialización de Puppeteer/CDP
DEFAULT_WWEBJS_AUTH_PATH = process.env.WWEBJS_AUTH_PATH || path.join(os.homedir(), '.wwebjs_auth_server');
console.log(`📁 wwebjs auth path (disco local): ${DEFAULT_WWEBJS_AUTH_PATH}`);

// Las colas de grabado SI están en la UNC (ya configurado en TO_ENGRAVE_DIR)
console.log(`📁 TO_ENGRAVE_DIR (colas en UNC): ${TO_ENGRAVE_DIR}`);

// Crear el cliente de WhatsApp con auth en disco LOCAL
client = new Client({
    authStrategy: new LocalAuth({ dataPath: DEFAULT_WWEBJS_AUTH_PATH }),
    puppeteer: {
        headless: process.env.PUPPETEER_HEADLESS !== 'false',
        args: PUPPETEER_ARGS,
        executablePath: process.env.CHROME_PATH || undefined,
        defaultViewport: null,
        ignoreHTTPSErrors: true
    }
});

console.log('✅ Cliente de WhatsApp creado (auth en DISCO LOCAL para rapidez)');

// Función para obtener la ruta del Excel mensual
// NOTE: Excel-based routing removed. Keep function placeholder for compatibility if needed.
function obtenerRutaExcel() {
    const rutaBase = TO_ENGRAVE_DIR;
    const nombreArchivo = 'to_engrave';
    return { rutaBase, rutaCompleta: rutaBase, nombreArchivo };
}

// Función para crear directorios si no existen
function crearDirectorioSiNoExiste(ruta) {
    if (!fs.existsSync(ruta)) {
        fs.mkdirSync(ruta, { recursive: true });
        console.log(`📁 Directorio creado: ${ruta}`);
    }
}

/* Excel writing removed - using engraving JSON in to_engrave instead */

// Función de respaldo local - VERSIÓN MEJORADA
// Respaldo local: guarda un JSON local en root si todo falla
async function guardarRespaldoLocal(numParte, numPiezas, imagen) {
    try {
        const ahora = new Date();
        const mes = String(ahora.getMonth() + 1).padStart(2, '0');
        const año = ahora.getFullYear();
        const nombreMes = ahora.toLocaleString('es-ES', { month: 'long' }).toUpperCase();
        
    const nombreArchivo = `REGISTRO_${nombreMes}_GRABADO_LASER_RESpaldo.json`;
    const rutaLocal = nombreArchivo;
        
        let workbook;
        let datos = [];
        
        console.log(`📂 Intentando respaldo local: ${rutaLocal}`);
        
        if (fs.existsSync(rutaLocal)) {
            try {
                datos = JSON.parse(fs.readFileSync(rutaLocal, 'utf8')) || [];
                console.log(`📊 Respaldo existente: ${datos.length} registros`);
            } catch (error) {
                console.log('⚠️ Error leyendo respaldo JSON, creando nuevo...');
                datos = [];
            }
        } else {
            datos = [];
        }
        
        const fecha = new Date().toLocaleString('es-ES');
        const filaExistente = datos.findIndex(row => row['NUM PARTE'] === numParte);
        
        if (filaExistente !== -1) {
            datos[filaExistente]['NUM DE PIEZAS'] = numPiezas;
            datos[filaExistente]['FECHA'] = fecha;
            datos[filaExistente]['IMAGEN'] = imagen ? 'SI' : 'NO';
        } else {
            const nuevaFila = {
                'ORDEN NUM': datos.length + 1,
                'NUM PARTE': numParte,
                'NUM DE PIEZAS': numPiezas,
                'IMAGEN': imagen ? 'SI' : 'NO',
                'FECHA': fecha
            };
            datos.push(nuevaFila);
        }
        
        // Crear hoja simple
        // Guardar como JSON simple
        fs.writeFileSync(rutaLocal, JSON.stringify(datos, null, 2), 'utf8');
        
        console.log(`✅ Respaldo local guardado: ${rutaLocal}`);
        console.log(`📊 Registros en respaldo: ${datos.length}`);
        
    return rutaLocal;
        
    } catch (error) {
        console.error('❌ Error crítico en respaldo local:', error);
        // Último intento - guardar en archivo simple
        await guardarUltimoRespaldo(numParte, numPiezas, imagen);
    }
}

// Guardar en el sistema de grabado (JSON files en carpeta to_engrave)
async function guardarEnSistemaGrabado(numParte, numPiezas, imagen, messageId) {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        // Directorio para imágenes asociadas
        const IMAGES_DIR = path.join(TO_ENGRAVE_DIR, 'images');
        crearDirectorioSiNoExiste(IMAGES_DIR);

        const fecha = new Date();
        const fechaTexto = fecha.toLocaleString('es-ES');

        // Preparar identificadores seguros para archivos
        const iso = fecha.toISOString().replace(/:/g, '-');
        const safeParte = String(numParte).replace(/[^a-zA-Z0-9\-]/g, '_');

        const objeto = {
            numParte: numParte,
            numPiezas: (numPiezas !== undefined && numPiezas !== null && numPiezas !== '') ? String(numPiezas) : null,
            fecha: fechaTexto,
            // imagen almacenará una ruta relativa (images/...) si se guardó como archivo,
            // o null si no se proporcionó.
            imagen: null,
            // si se recibe messageId desde WhatsApp, guardarlo para evitar duplicados
            messageId: messageId || null
        };

        // Si se recibió una imagen en formato data URL (base64), convertirla a archivo
        if (imagen && typeof imagen === 'string' && imagen.startsWith('data:')) {
            try {
                // data:<mime>;base64,<data>
                const matches = imagen.match(/^data:(.+);base64,(.*)$/);
                if (matches) {
                    const mime = matches[1];
                    const data = matches[2];
                    const ext = mime.split('/')[1] ? mime.split('/')[1].split('+')[0] : 'jpg';
                    const imageFilename = `engrave_${iso}_${safeParte}.${ext}`;
                    const imagePath = path.join(IMAGES_DIR, imageFilename);
                    const buffer = Buffer.from(data, 'base64');
                    fs.writeFileSync(imagePath, buffer, { encoding: 'binary' });
                    // Guardar ruta relativa para el JSON
                    objeto.imagen = path.join('images', imageFilename);
                    console.log(`🖼️ Imagen guardada en: ${imagePath}`);
                } else {
                    console.log('⚠️ Formato de imagen base64 no reconocido');
                }
            } catch (imgErr) {
                console.error('❌ Error guardando imagen:', imgErr);
                objeto.imagen = null;
            }
        } else {
            objeto.imagen = imagen || null;
        }

        // Prevención: si ya guardamos recientemente una entrada con la misma firma,
        // devolvemos la ruta ya guardada para evitar duplicados casi simultáneos.
        try {
            const signature = makeSignature(numParte, numPiezas, imagen);
            const existing = getRecentSavedRutaForSignature(signature);
            if (existing) {
                console.log(`⚠️ Evitado duplicado cercano por firma, reusando: ${existing}`);
                return existing;
            }
        } catch (e) { /* noop */ }

        // Nombre de archivo: engrave_<ISO>_<numParte>.json (reemplazar ':' para Windows)
        const filename = `engrave_${iso}_${safeParte}.json`;
        const ruta = path.join(TO_ENGRAVE_DIR, filename);

        fs.writeFileSync(ruta, JSON.stringify(objeto, null, 2), { encoding: 'utf8' });
        // Recordar firma para evitar writes duplicados en ventana corta
        try { rememberSavedSignature(makeSignature(numParte, numPiezas, imagen), ruta); } catch (e) {}
        console.log(`✳️ Guardado en sistema de grabado: ${ruta}`);

        return ruta;
    } catch (err) {
        console.error('❌ Error guardando en sistema de grabado:', err);
        throw err;
    }
}

// Endpoint para listar archivos en la cola de grabado
app.get('/engrave-list', (req, res) => {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        const data = files.map(f => {
            const raw = fs.readFileSync(path.join(TO_ENGRAVE_DIR, f), 'utf8');
            try {
                return { filename: f, content: JSON.parse(raw) };
            } catch (parseErr) {
                return { filename: f, content: raw };
            }
        });
        res.json(data);
    } catch (error) {
        console.error('Error leyendo cola de grabado:', error);
        res.status(500).json({ error: 'No se pudo leer la cola de grabado' });
    }
});

// Endpoint para servir un archivo de la cola (raw)
app.get('/engrave/:file', (req, res) => {
    try {
        const file = req.params.file;
        const ruta = path.join(TO_ENGRAVE_DIR, file);
        if (!fs.existsSync(ruta)) return res.status(404).send('Not found');
        res.sendFile(ruta);
    } catch (error) {
        res.status(500).send('Error');
    }
});

// Último respaldo de emergencia
async function guardarUltimoRespaldo(numParte, numPiezas, imagen) {
    try {
        const fecha = new Date().toLocaleString('es-ES');
        const registro = `${fecha} - ${numParte} - ${numPiezas} piezas - ${imagen ? 'CON IMAGEN' : 'SIN IMAGEN'}\n`;
        
        fs.appendFileSync('registro_emergencia.txt', registro);
        console.log(`📝 Registro de emergencia guardado en: registro_emergencia.txt`);
    } catch (error) {
        console.error('💥 Error crítico - No se pudo guardar ningún registro:', error);
    }
}

// Servir la página principal
app.get('/', (req, res) => {
    // Servir directamente el archivo principal del Sistema de Grabado Láser
    // Apuntar al archivo HTML correcto del sistema de grabado
    const mainPage = path.join(__dirname, 'public', 'sistema_de_grabado_laserv1.html');
    if (fs.existsSync(mainPage)) {
        res.sendFile(mainPage);
    } else {
        // Fallback a index si el archivo no existe
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Obtener QR code
app.get('/qr', async (req, res) => {
    if (qrCode) {
        res.json({ qr: qrCode });
    } else {
        res.json({ qr: null });
    }
});

// Endpoint /generate-qr eliminado (funcionalidad de autorizaciones removida).

// Endpoint /qr-reg/:token eliminado (funcionalidad de autorizaciones removida).

// Obtener estado de conexión
app.get('/status', (req, res) => {
    let engraveCount = 0;
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        engraveCount = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json')).length;
    } catch (e) { /* ignore */ }

    res.json({ 
        authenticated: isAuthenticated,
        registros: registros,
        engraveCount: engraveCount
    });
});

// Endpoint SSE: emitir eventos en tiempo real al frontend
app.get('/events', (req, res) => {
    // Cabeceras necesarias para SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();

    // Limitar cantidad de clientes SSE para evitar DoS accidental
    const MAX_SSE_CLIENTS = 200;
    if (sseClients.length >= MAX_SSE_CLIENTS) {
        console.warn('Demasiados clientes SSE conectados, rechazando nueva conexión');
        res.status(503).end('Too many SSE clients');
        return;
    }

    const clientId = Date.now();
    const newClient = {
        id: clientId,
        res
    };

    sseClients.push(newClient);
    console.log(`🔔 SSE client connected: ${clientId} (total: ${sseClients.length})`);

    // Enviar un evento de bienvenida/estado inicial opcional
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'connected', time: new Date().toISOString() })}\n\n`);

    // Cuando el cliente cierre la conexión, eliminarlo
    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
        console.log(`🔕 SSE client disconnected: ${clientId} (total: ${sseClients.length})`);
    });
});

// Función para emitir un nuevo registro a todos los clientes SSE conectados
function broadcastNewRegistro(registro) {
    try {
        const payload = JSON.stringify({ type: 'nuevo-registro', registro });
        console.log(`📡 broadcastNewRegistro: enviando a ${sseClients.length} clientes, parte:`, registro.numeroParte || registro.numParte);
        // Escribir a cada cliente; si falla la escritura eliminar al cliente
        sseClients = sseClients.filter(client => {
            try {
                // Si la respuesta está cerrada ya, filtrar fuera
                if (client.res.writableEnded || client.res.closed) {
                    console.warn(`⚠️ Cliente SSE ${client.id} tiene writableEnded/closed, filtrando`);
                    return false;
                }
                client.res.write(`data: ${payload}\n\n`);
                console.debug(`✅ SSE enviado a cliente ${client.id}`);
                return true;
            } catch (e) {
                console.warn('⚠️ SSE write failed, removing client', client.id, e && e.message);
                try { client.res.end(); } catch (ee) { /* noop */ }
                return false;
            }
        });
        console.log(`📣 Broadcast completado: ${sseClients.length} clientes conectados después del envío`);
    } catch (err) {
        console.error('❌ Error broadcasting registro:', err);
    }
}

// Al iniciar el servidor, escanear la carpeta TO_ENGRAVE_DIR y cargar
// cualquier archivo JSON pendiente en memoria (registros[]) y emitirlos
// a los clientes SSE para que el front-end los vea como registros nuevos.
function importPendingFilesAtStartup() {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        if (!files || files.length === 0) {
            console.log('📦 No hay archivos pendientes en to_engrave al iniciar');
            return;
        }

        console.log(`📥 Importando ${files.length} archivos pendientes desde: ${TO_ENGRAVE_DIR}`);

        const importedMessageIds = new Set();

        // Si ya hay registros en memoria, recopilar messageIds para evitar duplicados
        registros.forEach(r => { if (r && r.messageId) importedMessageIds.add(r.messageId); });

        // Importar de más reciente a más antiguo para mantener orden similar al resto
        files.sort().reverse();

        for (const file of files) {
            try {
                const fullPath = path.join(TO_ENGRAVE_DIR, file);
                const raw = fs.readFileSync(fullPath, 'utf8');
                let obj = null;
                try { obj = JSON.parse(raw); } catch (e) { obj = null; }
                // Si el archivo no es JSON válido, omitir
                if (!obj) {
                    console.warn(`⚠️ Archivo pendiente no JSON omitido: ${file}`);
                    continue;
                }

                const messageId = obj.messageId || null;
                if (messageId && importedMessageIds.has(messageId)) {
                    // Ya importado según messageId
                    console.log(`↩️ Omitiendo duplicado por messageId: ${messageId} (${file})`);
                    continue;
                }

                // Crear estructura de registro compatible con el resto del sistema
                const nuevoRegistro = {
                    numeroParte: obj.numParte || obj.numParte || '',
                    piezas: obj.numPiezas || obj.numPiezas || null,
                    imagen: obj.imagen || null,
                    timestamp: obj.fecha || new Date().toLocaleString('es-ES'),
                    rutaBackup: null,
                    rutaEngrave: file,
                    messageId: messageId
                };

                // Añadir a la cabeza de registros (mostramos lo más nuevo primero)
                registros.unshift(nuevoRegistro);
                if (registros.length > 20) registros.pop();

                if (messageId) importedMessageIds.add(messageId);

                // Emitir al front-end
                try { broadcastNewRegistro(nuevoRegistro); } catch (e) { console.warn('⚠️ Error broadcast al importar:', e); }

                console.log(`✅ Importado pendiente: ${file} -> parte=${nuevoRegistro.numeroParte}`);
            } catch (errFile) {
                console.error('❌ Error importando archivo pendiente', file, errFile);
            }
        }
    } catch (err) {
        console.error('❌ Error escaneando TO_ENGRAVE_DIR al iniciar:', err);
    }
}

// Obtener información del archivo Excel actual
// Endpoint legacy: info-excel — ahora devuelve info sobre la cola de grabado
app.get('/info-excel', (req, res) => {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        res.json({
            archivo: 'to_engrave',
            ruta: TO_ENGRAVE_DIR,
            existe: true,
            registros: files.length
        });
    } catch (error) {
        res.json({ archivo: 'No disponible', ruta: 'Error', existe: false, registros: 0 });
    }
});

// Inventario: devuelve lista formateada (similar estructura a inventario.xlsx)
app.get('/inventario', (req, res) => {
    try {
        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        const data = files.map((f, idx) => {
            const raw = fs.readFileSync(path.join(TO_ENGRAVE_DIR, f), 'utf8');
            const obj = JSON.parse(raw);
            return {
                'ORDEN NUM': idx + 1,
                'NUM PARTE': obj.numParte || '',
                'NUM DE PIEZAS': obj.numPiezas || '',
                'IMAGEN': obj.imagen ? 'SI' : 'NO',
                'FECHA': obj.fecha || ''
            };
        });
        res.json(data);
    } catch (error) {
        console.error('Error leyendo inventario (engrave):', error);
        res.status(500).json([]);
    }
});

// Eventos de WhatsApp
client.on('qr', async (qr) => {
    console.log('🔸 QR generado - Escanear en: http://localhost:3000');
    qrCode = await qrcode.toDataURL(qr);
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado!');
    console.log('🤖 Bot listo - Envía mensajes como: "888-999 4pz"');
    
    // Mostrar información del sistema de grabado al iniciar
    console.log(`📁 Carpeta to_engrave: ${TO_ENGRAVE_DIR}`);
    
    isAuthenticated = true;
    qrCode = null;
    // Intentar detectar número del bot
    try {
        // client.info may contain phone info depending on the lib version
        if (client.info && client.info.wid) {
            const wid = client.info.wid; // could be string or object
            if (typeof wid === 'string') {
                BOT_NUMBER = wid.split('@')[0];
            } else if (wid && wid._serialized) {
                BOT_NUMBER = String(wid._serialized).split('@')[0];
            }
        }
    } catch (e) { /* ignore */ }
    if (BOT_NUMBER) console.log(`🤖 Bot number detected: ${BOT_NUMBER}`);
});

// Manejar fallos de autenticación y desconexiones para depuración
client.on('auth_failure', (msg) => {
    // msg puede contener información sobre el fallo (por ejemplo, invalid session)
    console.error('❌ auth_failure:', msg);
    isAuthenticated = false;
    qrCode = null;
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ WhatsApp client disconnected:', reason);
    isAuthenticated = false;
    qrCode = null;
    // Intento de reiniciar el cliente tras un pequeño retraso
    try {
        client.destroy();
    } catch (e) { /* ignore */ }
    setTimeout(() => {
        // Usar safeInitialize con reintentos
        safeInitialize(client).catch(e => console.error('Error re-inicializando client:', e));
    }, 1500);
});

// Función para procesar mensajes - CORREGIDA
async function procesarMensaje(mensaje, remitente, messageObj) {
    try {
    // Extraer número de parte (aceptamos sufijo opcional '-ZP', p. ej. 888-999-ZP)
    const numParteMatch = mensaje.match(/(\d{3}-\d{3}(?:-ZP)?)/i);
        if (!numParteMatch) {
            await client.sendMessage(remitente, '❌ Formato incorrecto. Usa: "888-999 4pz"');
            return;
        }
        const numParte = numParteMatch[1];
        
    // Extraer cantidad (opcional). Soporta formatos como "4pz" o "8PZ" después del número de parte
    const cantidadMatch = mensaje.match(/\d{3}-\d{3}(?:-ZP)?\D*(\d+)/i);
        // Si no se encuentra cantidad, permitimos registrar con numPiezas = null
        const numPiezas = cantidadMatch ? parseInt(cantidadMatch[1]) : null;
        
        // Obtener image id (para deduplicación) y obtener imagen si existe
        let messageId = null;
        try {
            if (messageObj && messageObj.id) {
                // whatsapp-web.js message id puede estar en _serialized o id
                messageId = messageObj.id._serialized || messageObj.id.id || null;
            }
        } catch (e) { messageId = null; }

        // Si ya procesamos este messageId recientemente, evitar duplicado
        if (messageId && isDuplicateMessageId(messageId)) {
            console.log('↩️ Mensaje duplicado detectado (omitiendo):', messageId, numParte);
            // enviar confirmación corta para evitar confusión en origen
            try { await client.sendMessage(remitente, `✅ Registro ya procesado: ${numParte}`); } catch (e) { /* noop */ }
            return;
        }

        // Obtener imagen si existe
        let imagenBase64 = null;
        if (messageObj.hasMedia) {
            try {
                const media = await messageObj.downloadMedia();
                if (media) {
                    imagenBase64 = `data:${media.mimetype};base64,${media.data}`;
                }
            } catch (mediaError) {
                console.log('⚠️ Error descargando imagen:', mediaError);
            }
        }
        
        // Validar datos mínimos: numParte es obligatorio, numPiezas es opcional
        if (!numParte) {
            await client.sendMessage(remitente, '❌ Error. No se encontró el número de parte. Usa: "888-999 4pz" o "888-999"');
            return;
        }
        
        console.log(`📊 Procesando: ${numParte} - ${numPiezas} piezas`);
        
        // Guardar en el sistema de grabado - si falla, caemos a Excel/respaldo local
    let rutaEngrave = null;
    let rutaBackup = null;
        try {
            rutaEngrave = await guardarEnSistemaGrabado(numParte, numPiezas, imagenBase64, messageId);
        } catch (engraveError) {
            console.log('🔄 Error guardando en sistema de grabado, realizando respaldo local...');
            try {
                rutaBackup = await guardarRespaldoLocal(numParte, numPiezas, imagenBase64);
            } catch (backupErr) {
                console.log('⚠️ No se pudo guardar respaldo local, registrando de emergencia...');
                await guardarUltimoRespaldo(numParte, numPiezas, imagenBase64);
            }
        }
        
        // Agregar a registros en tiempo real
        const nuevoRegistro = {
            numeroParte: numParte,
            piezas: numPiezas,
            imagen: imagenBase64,
            timestamp: new Date().toLocaleString('es-ES'),
            rutaBackup: rutaBackup ? path.basename(rutaBackup) : null,
            rutaEngrave: rutaEngrave ? path.basename(rutaEngrave) : null,
            messageId: messageId || null
        };
        
        registros.unshift(nuevoRegistro);
        if (registros.length > 20) registros.pop();
        // Emitir el nuevo registro a clientes conectados (SSE)
        try {
            broadcastNewRegistro(nuevoRegistro);
        } catch (e) {
            console.log('⚠️ Error emitiendo SSE:', e);
        }
        
        // Confirmación - si faltan piezas indicar claramente
        let respuesta = `✅ REGISTRADO EXITOSAMENTE\n📦 Parte: ${numParte}`;
        if (numPiezas !== null && !isNaN(numPiezas)) {
            respuesta += `\n🔢 Piezas: ${numPiezas}`;
        } else {
            respuesta += `\n🔢 Piezas: (FALTA) — por favor confirma la cantidad cuando puedas.`;
        }
        
        if (rutaEngrave) {
            respuesta += `\n🖨️ Guardado en: SISTEMA DE GRABADO (${path.basename(rutaEngrave)})`;
        } else if (rutaBackup) {
            respuesta += `\n📂 Guardado en: RESPALDO LOCAL (${path.basename(rutaBackup)})`;
        } else {
            respuesta += '\n⚠️ No se guardó registro en sistema ni respaldo';
        }
        
        if (imagenBase64) {
            respuesta += '\n📷 Imagen recibida';
        }
        
        await client.sendMessage(remitente, respuesta);
        
    } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
        await client.sendMessage(remitente, 
            '❌ Error al procesar. Se guardó en respaldo.\n' +
            'El sistema sigue funcionando para nuevos registros.'
        );
    }
}

// Evento de mensajes de WhatsApp - CORREGIDO
client.on('message', async (message) => {
    const mensaje = (message.body || '').trim();
    const remitenteRaw = message.from;
    const remitente = normalizeNumber(remitenteRaw);

    console.log(`📩 Mensaje de ${remitente}: ${mensaje}`);

    // El comando ALTA y la gestión de tokens/autorizaciones fueron eliminados.

    // 🔒 FILTRO DE GRUPO: Si el filtro está activo, validar que el mensaje venga del grupo autorizado
    if (USE_GROUP_FILTER) {
        const senderJid = message.from || '';
        const isFromGroup = senderJid.includes('@g.us');
        const senderNumber = normalizeNumber(senderJid); // número sin sufijo

        // Comprobar autorizaciones posibles:
        // 1) JID de grupo (12036...@g.us)
        // 2) JID de contacto (5214428750295@c.us)
        // 3) Número limpio (5214428750295)
        const authorizedName = ALLOWED_GROUPS[senderJid] || ALLOWED_GROUPS[`${senderNumber}@c.us`] || ALLOWED_GROUPS[senderNumber];

        if (!isFromGroup && !authorizedName) {
            // No es grupo y tampoco está autorizado como contacto -> rechazar sin responder
            console.log(`⛔ Mensaje rechazado: No viene de un grupo (es mensaje privado de ${remitente}) - no se enviará respuesta`);
            return;
        }

        if (!authorizedName) {
            // Es un grupo pero no está en la lista -> rechazar sin responder
            const groupId = senderJid;
            const groupNameGuess = senderJid.substring(0, senderJid.indexOf('@g.us')) || 'desconocido';
            console.log(`⛔ Mensaje rechazado: Grupo no autorizado (${groupId} - ${groupNameGuess}) - no se enviará respuesta`);
            return;
        }

        // Si llegamos aquí, está autorizado (ya sea grupo o contacto)
        console.log(`✅ Mensaje autorizado de: ${authorizedName} (${senderJid})`);
    }

    // Ya no se exige autorización por lista; aceptar mensajes de cualquier remitente (si no hay filtro de grupo).

    // ✅ FORMATOS ACEPTADOS: ahora aceptamos al menos el número de parte (ej. 888-999) y variantes con sufijo -ZP
    if (mensaje.match(/\d{3}-\d{3}(?:-ZP)?/i)) {
        await procesarMensaje(mensaje, remitenteRaw, message);
    }
});

// Iniciar servidor y capturar la instancia para ajustes y manejo de errores
let server = null;

async function startServer() {
    if (server) return server;
    
    // Cargar configuración de grupos autorizados
    loadGroupConfig();
    
    server = app.listen(PORT, () => {
        try {
            // Ensure to_engrave directory exists at startup
            crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
            console.log(`🌐 Servidor activo: http://localhost:${PORT}`);
            console.log(`📱 Abre esa URL en el navegador para escanear QR`);
            // Importar archivos pendientes (si los hay) para que el UI los vea
            try {
                importPendingFilesAtStartup();
            } catch (impErr) {
                console.error('❌ Error importando pendientes al iniciar:', impErr);
            }
            // Inicializar el cliente con reintentos y capturar rechazos asíncronos
            safeInitialize(client).catch(initErr => console.error('Error inicializando WhatsApp client:', initErr));
        } catch (e) {
            console.error('Error en startup:', e);
        }
    });

    // Ajustes de timeouts para mejorar estabilidad en algunas plataformas
    try {
        server.keepAliveTimeout = 65000; // 65s
        server.headersTimeout = 70000; // 70s
    } catch (e) { /* ignore if not supported */ }

    server.on('error', (err) => {
        console.error('❌ Server error:', err);
    });

    return server;
}

async function stopServer() {
    try {
        if (client) {
            try { await client.destroy(); } catch (e) { /* noop */ }
        }
    } catch (e) { /* ignore */ }

    return new Promise((resolve) => {
        try {
            if (!server) return resolve(true);
            server.close(() => {
                console.log('Servidor cerrado');
                server = null;
                resolve(true);
            });
            // forzar después de 3s
            setTimeout(() => {
                try { server && server.close && server.close(); } catch (e) {}
                server = null;
                resolve(true);
            }, 3000);
        } catch (e) {
            server = null;
            resolve(false);
        }
    });
}

// Si el archivo se ejecuta directamente, iniciar el servidor
if (require.main === module) {
    startServer().catch(err => console.error('Error arrancando servidor:', err));
}

// Exportar funciones para ser controladas por Electron u otros wrappers
module.exports = { startServer, stopServer };

// Manejo de excepciones no capturadas para registrar y continuar cuando sea posible
process.on('unhandledRejection', (reason, promise) => {
    console.error('❗ Unhandled Rejection at:', promise, 'reason:', reason);
    // No terminar el proceso automáticamente; logueamos para investigar.
});

process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    // Try to perform a graceful shutdown; if not possible, exit
    try {
        server.close(() => {
            console.log('Servidor cerrado tras excepción no capturada');
            process.exit(1);
        });
    } catch (e) {
        console.error('Error durante shutdown tras uncaughtException:', e);
        process.exit(1);
    }
});

// Gestión de usuarios autorizados removida (aceptar mensajes de cualquier remitente).

// Endpoint útil para forzar re-conexión / reautenticación y obtener un nuevo QR
app.post('/force-reconnect', async (req, res) => {
    try {
        // Intentar destruir y re-inicializar el cliente para forzar generación de QR
        try { await client.destroy(); } catch (e) { /* ignore */ }
        qrCode = null;
        isAuthenticated = false;
        // Re-inicializar
    // Inicializar el cliente tras force-reconnect usando safeInitialize
    safeInitialize(client).catch(initErr => console.error('Error inicializando client tras force-reconnect:', initErr));
        return res.json({ ok: true, message: 'Intentando reconectar. Revisa los logs del servidor para ver QR o errores.' });
    } catch (err) {
        console.error('Error en /force-reconnect:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Endpoint para agregar un registro a la cola (usable por bots o scripts)
app.post('/enqueue', async (req, res) => {
    try {
        const { numParte, numPiezas, imagen, clientId, messageId } = req.body || {};
        // numParte es obligatorio; numPiezas es opcional (permitir registro sin cantidad)
        if (!numParte) return res.status(400).json({ error: 'numParte es requerido' });
        // Si se proporcionó messageId y ya lo procesamos, evitar crear duplicado
        if (messageId && isDuplicateMessageId(messageId)) {
            console.log('➡️ /enqueue recibido pero messageId ya procesado, omitiendo creación:', messageId, numParte);
            return res.json({ ok: true, skippedDuplicate: true, messageId });
        }
        const ruta = await guardarEnSistemaGrabado(numParte, numPiezas !== undefined ? numPiezas : null, imagen || null, messageId || null);
        // También agregamos a registros en memoria y emitimos SSE para actualizar frontends
        const nuevoRegistro = {
            numeroParte: numParte,
            piezas: (numPiezas !== undefined && numPiezas !== null && numPiezas !== '') ? Number(numPiezas) : null,
            imagen: imagen || null,
            timestamp: new Date().toLocaleString('es-ES'),
            rutaEngrave: ruta ? require('path').basename(ruta) : null,
            clientId: clientId || null,
            messageId: messageId || null
        };
        registros.unshift(nuevoRegistro);
        if (registros.length > 20) registros.pop();
        try {
            console.log(`➡️ /enqueue guardado: parte=${nuevoRegistro.numeroParte} piezas=${nuevoRegistro.piezas} clientId=${nuevoRegistro.clientId}`);
            broadcastNewRegistro(nuevoRegistro);
        } catch (e) { console.log('⚠️ Error emitiendo SSE desde /enqueue', e); }

        // Devolver también el clientId para confirmación (si fue enviado)
        res.json({ ok: true, ruta, clientId: clientId || null });
    } catch (error) {
        console.error('Error en /enqueue:', error);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Handler de errores genérico de Express (último middleware)
app.use((err, req, res, next) => {
    try {
        console.error('Express error handler:', err && err.stack ? err.stack : err);
        if (res.headersSent) return next(err);
        res.status(err && err.status ? err.status : 500).json({ error: err && err.message ? err.message : 'Internal Server Error' });
    } catch (e) {
        console.error('Error en error-handler:', e);
        try { res.status(500).json({ error: 'Internal Server Error' }); } catch (ee) { /* noop */ }
    }
});

// Endpoint para limpiar el campo numParte dentro de un archivo de la cola `to_engrave`
app.post('/engrave/clear-part', async (req, res) => {
    try {
        const { filename } = req.body || {};
        if (!filename) return res.status(400).json({ ok: false, error: 'filename requerido' });

        // Asegurar que filename sea solo basename para evitar traversal
        const safeName = path.basename(String(filename));
        if (!safeName.endsWith('.json')) return res.status(400).json({ ok: false, error: 'archivo no válido' });

        const filePath = path.join(TO_ENGRAVE_DIR, safeName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'archivo no encontrado' });

        // Leer y modificar
        const raw = fs.readFileSync(filePath, 'utf8');
        let obj;
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            return res.status(500).json({ ok: false, error: 'JSON inválido' });
        }

        // Limpiar numParte (o propiedad análoga)
        if (Object.prototype.hasOwnProperty.call(obj, 'numParte')) {
            obj.numParte = null;
        } else if (Object.prototype.hasOwnProperty.call(obj, 'numeroParte')) {
            obj.numeroParte = null;
        } else if (Object.prototype.hasOwnProperty.call(obj, 'part')) {
            obj.part = null;
        } else {
            // Si no existe la propiedad esperada, devolver ok (no bloquear)
        }

        // Reescribir el archivo
        fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');

        console.log(`✳️ numParte limpiado en: ${filePath}`);
        return res.json({ ok: true, file: safeName });
    } catch (err) {
        console.error('Error en /engrave/clear-part:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// Endpoint para detener el cliente WhatsApp sin cerrar el proceso Node
app.post('/stop-client', async (req, res) => {
    try {
        try {
            // Intentar destruir el cliente si existe
            if (client) {
                try { await client.destroy(); } catch (e) { console.warn('Error destruyendo client en stop-client:', e); }
            }
        } catch (e) { /* noop */ }

        // Actualizar estado
        isAuthenticated = false;
        qrCode = null;

        console.log('🛑 stop-client: cliente WhatsApp detenido (si existía)');
        return res.json({ ok: true, message: 'Client stopped (if it was running)' });
    } catch (err) {
        console.error('Error en /stop-client:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
});