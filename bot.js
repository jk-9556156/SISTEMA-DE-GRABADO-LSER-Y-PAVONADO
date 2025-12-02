const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Carpeta para registrar piezas: forzamos la ruta de red solicitada.
// Si se necesita, puede sobrescribirse con la variable de entorno TO_ENGRAVE_DIR
const TO_ENGRAVE_DIR = (process.env.TO_ENGRAVE_DIR && process.env.TO_ENGRAVE_DIR.trim() !== '')
    ? path.resolve(process.env.TO_ENGRAVE_DIR)
    : "\\\\ociserver\\INNOVAX\\AREA DE TRABAJO\\6.- ENSAMBLE\\SISTEMA DE PAVONADO Y GRABADO LASER";

console.log(`📁 Bot TO_ENGRAVE_DIR en: ${TO_ENGRAVE_DIR}`);

// Función para validar que podemos escribir en la ruta de red
function ensureWritableDirBot(dir) {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

// Validar permisos en la ruta UNC antes de crear el cliente
if (!ensureWritableDirBot(TO_ENGRAVE_DIR)) {
    console.error('❌ CRÍTICO: No se puede escribir en la ruta UNC. Bot saliendo.');
    process.exit(1);
}

// LocalAuth se guarda en disco LOCAL (no UNC) para evitar I/O lenta sobre red durante inicialización
const DEFAULT_WWEBJS_AUTH_PATH = process.env.WWEBJS_AUTH_PATH || path.join(os.homedir(), '.wwebjs_auth_bot');
console.log(`📁 bot wwebjs auth path (disco local): ${DEFAULT_WWEBJS_AUTH_PATH}`);
console.log(`📁 bot colas en UNC: ${TO_ENGRAVE_DIR}`);
let ALLOWED_GROUPS = {};
try {
    const raw = fs.readFileSync(path.join(__dirname, 'allowed_groups.json'), 'utf8');
    ALLOWED_GROUPS = JSON.parse(raw || '{}');
} catch (e) {
    console.warn('⚠️ No se pudo leer allowed_groups.json, se permitirá todo por defecto.');
}
// URL del endpoint enqueue (configurable por entorno)
const ENQUEUE_URL = process.env.BOT_ENQUEUE_URL || 'http://localhost:3000/enqueue';

// Utilidad para obtener fetch de forma reutilizable.
// Si no existe global.fetch ni node-fetch instalado, ofrecemos un shim mínimo usando http/https.
function getFetch() {
    if (typeof global.fetch === 'function') return global.fetch.bind(global);
    try {
        const nf = require('node-fetch');
        return nf;
    } catch (e) {
        // shim
        const http = require('http');
        const https = require('https');
        const { URL } = require('url');
        return function (url, opts) {
            return new Promise((resolve, reject) => {
                try {
                    const u = new URL(url);
                    const isHttps = u.protocol === 'https:';
                    const transport = isHttps ? https : http;
                    const body = opts && opts.body ? Buffer.isBuffer(opts.body) ? opts.body : String(opts.body) : null;
                    const headers = Object.assign({}, opts && opts.headers ? opts.headers : {});
                    if (body && !headers['Content-Length'] && !headers['content-length']) headers['Content-Length'] = Buffer.byteLength(body);
                    const requestOptions = {
                        method: (opts && opts.method) || 'GET',
                        hostname: u.hostname,
                        port: u.port || (isHttps ? 443 : 80),
                        path: u.pathname + (u.search || ''),
                        headers
                    };
                    const req = transport.request(requestOptions, (res) => {
                        let chunks = [];
                        res.on('data', (c) => chunks.push(c));
                        res.on('end', () => {
                            const buf = Buffer.concat(chunks);
                            const text = buf.toString('utf8');
                            const response = {
                                status: res.statusCode,
                                ok: res.statusCode >= 200 && res.statusCode < 300,
                                text: async () => text,
                                json: async () => {
                                    try { return JSON.parse(text); } catch (err) { throw new Error('Invalid JSON'); }
                                }
                            };
                            resolve(response);
                        });
                    });
                    req.on('error', (err) => reject(err));
                    if (body) req.write(body);
                    req.end();
                } catch (err) {
                    reject(err);
                }
            });
        };
    }
}
// Use fetch to call server enqueue endpoint

// Configurar el cliente de WhatsApp con opciones de puppeteer más robustas
const PUPPETEER_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--single-process'
];

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: DEFAULT_WWEBJS_AUTH_PATH }),
    puppeteer: {
        headless: process.env.PUPPETEER_HEADLESS !== 'false',
        args: PUPPETEER_ARGS,
        executablePath: process.env.CHROME_PATH || undefined,
        defaultViewport: null,
        ignoreHTTPSErrors: true
    }
});

// helper de inicialización con reintentos
async function safeInitializeBot(clientInstance, maxRetries = 3) {
    let attempt = 0;
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    while (attempt < maxRetries) {
        attempt++;
        try {
            await clientInstance.initialize();
            return;
        } catch (err) {
            console.error(`Error inicializando WhatsApp client (bot) intento ${attempt}:`, err && err.message ? err.message : err);
            try { clientInstance.destroy(); } catch (e) { /* noop */ }
            if (attempt < maxRetries) await delay(1000 * attempt);
            else throw err;
        }
    }
}

// Generar QR para conectar
client.on('qr', (qr) => {
    console.log('🔸 ESCANEA este código QR con WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// Cuando esté listo
client.on('ready', () => {
    console.log('✅ WhatsApp conectado correctamente!');
    console.log('🤖 Bot listo para recibir mensajes...');
});

// Procesar mensajes entrantes
client.on('message', async (message) => {
    const mensaje = message && message.body ? message.body : '';
    const remitente = message && message.from ? message.from : null;

    console.log(`📩 Mensaje recibido de ${remitente}: ${mensaje}`);

    // Comprobar si el remitente (grupo o contacto) está autorizado
    if (remitente && Object.keys(ALLOWED_GROUPS).length > 0) {
        if (!ALLOWED_GROUPS[remitente]) {
            console.log(`⛔ Remitente no autorizado: ${remitente} — ignorando mensaje.`);
            return;
        }
    }

    // Verificar si es un formato válido: "101-583---4PZ"
    if (mensaje && mensaje.includes('---')) {
        await procesarMensajeExcel(message);
    }
});

// Función para procesar el mensaje y enviar al servidor (cola de grabado)
async function procesarMensajeExcel(message) {
    try {
        const mensaje = message && message.body ? message.body : '';
        const remitente = message && message.from ? message.from : null;

        // Extraer datos del mensaje
        const partes = mensaje.split('---');
        const numParte = (partes[0] || '').trim();
        const numPiezasTexto = (partes[1] || '').trim();

        // Extraer solo números de las piezas (quitar "PZ" si existe)
        const numPiezas = parseInt((numPiezasTexto || '').replace(/[^0-9]/g, ''));

        console.log(`📊 Procesando: ${numParte} - ${numPiezas} piezas`);

        // Verificar que los datos sean válidos
        if (!numParte || isNaN(numPiezas)) {
            if (remitente) await client.sendMessage(remitente, '❌ Formato incorrecto. Usa: NUMERO-PARTE---CANTIDAD\nEjemplo: 101-583---4PZ');
            return;
        }

        // Obtener messageId de forma segura
        let messageId = null;
        try {
            if (message.id) {
                messageId = message.id._serialized || message.id.id || null;
            }
        } catch (e) { /* noop */ }

        // Enviar al servidor como record en la cola de grabado (to_engrave)
        try {
            // Usar fetch disponible
            const fetchFn = getFetch();
            if (!fetchFn) {
                console.warn('⚠️ fetch no disponible en el entorno del bot. Saltando llamada a /enqueue.');
                // Si no hay fetch, registramos localmente en to_engrave
                crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
                const iso = new Date().toISOString();
                const safeParte = (numParte || 'parte').replace(/[^a-zA-Z0-9_-]/g, '_');
                const filename = `engrave_${iso}_${safeParte}.json`;
                const record = {
                    numParte: String(numParte),
                    numPiezas: String(numPiezas),
                    fecha: new Date().toLocaleString(),
                    imagen: null,
                    messageId: messageId || null,
                    from: remitente || null
                };
                try { fs.writeFileSync(path.join(TO_ENGRAVE_DIR, filename), JSON.stringify(record, null, 2), 'utf8'); console.log('💾 Guardado local en to_engrave (no hay fetch).', filename); } catch(e){ console.error('❌ Error guardando fallback local:', e); }
            } else {
                const response = await fetchFn(ENQUEUE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ numParte, numPiezas, messageId })
                });
                // Intentar parsear JSON de respuesta si está disponible
                try {
                    const result = await response.json();
                    if (result && result.ok) {
                        console.log(`✅ Encolado en servidor: ${numParte}`);
                    } else {
                        console.error('❌ Error encolando:', result);
                        // Si el servidor respondió con error, realizar fallback local
                        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
                        const iso = new Date().toISOString();
                        const safeParte = (numParte || 'parte').replace(/[^a-zA-Z0-9_-]/g, '_');
                        const filename = `engrave_${iso}_${safeParte}.json`;
                        const record = {
                            numParte: String(numParte),
                            numPiezas: String(numPiezas),
                            fecha: new Date().toLocaleString(),
                            imagen: null,
                            messageId: messageId || null,
                            from: remitente || null
                        };
                        try { fs.writeFileSync(path.join(TO_ENGRAVE_DIR, filename), JSON.stringify(record, null, 2), 'utf8'); console.log('💾 Fallback local guardado (respuesta no ok).', filename); } catch(e){ console.error('❌ Error guardando fallback local:', e); }
                    }
                } catch (e) {
                    console.log('ℹ️ Encolado (respuesta no JSON o no leída)');
                }
            }
        } catch (err) {
            console.error('❌ Error enviando a /enqueue:', err);
            // Si hay error de red o servidor apagado, registrar localmente en to_engrave
            try {
                crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
                const iso = new Date().toISOString();
                const safeParte = (numParte || 'parte').replace(/[^a-zA-Z0-9_-]/g, '_');
                const filename = `engrave_${iso}_${safeParte}.json`;
                const record = {
                    numParte: String(numParte),
                    numPiezas: String(numPiezas),
                    fecha: new Date().toLocaleString(),
                    imagen: null,
                    messageId: messageId || null,
                    from: remitente || null
                };
                fs.writeFileSync(path.join(TO_ENGRAVE_DIR, filename), JSON.stringify(record, null, 2), 'utf8');
                console.log('💾 Fallback local guardado (error de red).', filename);
            } catch (e) {
                console.error('❌ Error guardando fallback local tras fallo de /enqueue:', e);
            }
        }

        // Nota: intentos de sincronización de archivos pendientes se hacen en segundo plano

        // Enviar confirmación por WhatsApp
        if (remitente) {
            await client.sendMessage(remitente, `✅ Registrado exitosamente:\n📦 Parte: ${numParte}\n🔢 Piezas: ${numPiezas}`);
        }

    } catch (error) {
        console.error('❌ Error procesando mensaje:', error);
        try { if (message && message.from) await client.sendMessage(message.from, '❌ Error al procesar el mensaje. Verifica el formato.'); } catch(e){ /* noop */ }
    }
}

// Inicializar el bot
console.log('🚀 Iniciando bot de WhatsApp...');
// Inicializar con reintentos
safeInitializeBot(client).catch(err => console.error('Error inicializando WhatsApp client (bot):', err));

// Sincronizar archivos pendientes en `to_engrave` hacia el servidor cuando esté disponible
const SYNC_INTERVAL_MS = parseInt(process.env.BOT_SYNC_INTERVAL_MS || '30000', 10);
async function syncPendingToServer() {
    try {
        const fetchFn = getFetch();
        if (!fetchFn) return; // no hay fetch, no podemos sincronizar

        crearDirectorioSiNoExiste(TO_ENGRAVE_DIR);
        const files = fs.readdirSync(TO_ENGRAVE_DIR).filter(f => f.endsWith('.json'));
        if (!files.length) return;

        for (const f of files) {
            const full = path.join(TO_ENGRAVE_DIR, f);
            try {
                const raw = fs.readFileSync(full, 'utf8');
                let data = null;
                try { data = JSON.parse(raw); } catch (e) { data = null; }
                if (!data || !data.numParte) continue; // formato inesperado

                const payload = { numParte: data.numParte, numPiezas: data.numPiezas || null, messageId: data.messageId || null };
                const resp = await fetchFn(ENQUEUE_URL, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                });
                let result = null;
                try { result = await resp.json(); } catch (e) { /* ignore */ }
                if ((result && result.ok) || resp.status === 200) {
                    // Eliminamos el archivo fallback local — el servidor grabará su propia copia
                    try { fs.unlinkSync(full); console.log('♻️ Archivo pendiente sincronizado y eliminado:', f); } catch (e) { console.warn('⚠️ No se pudo eliminar archivo sincronizado:', f, e); }
                } else {
                    // Si no fue OK, dejar para el siguiente intento
                    console.log('ℹ️ No se pudo sincronizar (respuesta no ok):', f);
                }
            } catch (errFile) {
                console.error('❌ Error procesando archivo pendiente:', full, errFile);
            }
        }
    } catch (err) {
        // noop - falló la sincronización global
    }
}

// Ejecutar sincronización periódica
try { syncPendingToServer(); } catch (e) {}
setInterval(() => { try { syncPendingToServer(); } catch (e) {} }, SYNC_INTERVAL_MS);