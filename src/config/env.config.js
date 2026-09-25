import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar .env ubicado en la raíz del proyecto backend/
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Valida de forma defensiva la presencia y formato de variables de entorno críticas.
 * En caso de inconsistencias o ausencia de claves AppSec, aborta la ejecución inmediatamente (fail-fast).
 */
function validateEnv() {
  const missingVars = [];

  // 1. Claves críticas de Ciberseguridad (AppSec)
  if (!process.env.ENCRYPTION_KEY) {
    missingVars.push('ENCRYPTION_KEY (Cadena hexadecimal de 64 caracteres / 32 bytes para AES-256-GCM)');
  } else {
    const key = process.env.ENCRYPTION_KEY.trim();
    if (key.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(key)) {
      console.error('❌ [CONFIG ERROR] ENCRYPTION_KEY inválida. Debe ser una cadena hexadecimal de exactamente 64 caracteres (32 bytes).');
      process.exit(1);
    }
  }

  if (!process.env.SESSION_SECRET) {
    missingVars.push('SESSION_SECRET (Clave secreta para tokens y cookies de sesión)');
  }

  // 2. Base de datos
  if (!process.env.DATABASE_URL && (!process.env.POSTGRES_USER || !process.env.POSTGRES_DB)) {
    missingVars.push('DATABASE_URL o variables individuales (POSTGRES_USER, POSTGRES_DB)');
  }

  // 3. Handshake de Meta (Opcional: si no está definido en .env, usa fallback por defecto)
  // No bloquea el arranque para permitir configuración 100% manual desde el panel web.

  if (missingVars.length > 0) {
    console.error('❌ [CONFIG ERROR] Faltan variables de entorno obligatorias en el archivo backend/.env:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('Por favor, revisa backend/.env.example y completa la configuración.');
    process.exit(1);
  }
}


/**
 * Lista de orígenes autorizados para CORS y para el WebSocket.
 * En producción se define con ALLOWED_ORIGINS (separados por comas).
 * En desarrollo se permiten los puertos locales de Vite y del propio backend.
 */
function resolveAllowedOrigins() {
  const raw = (process.env.ALLOWED_ORIGINS || '').trim();

  if (raw) {
    return raw.split(',').map(o => o.trim()).filter(Boolean);
  }

  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  [CONFIG] ALLOWED_ORIGINS no está definida. Solo se aceptarán peticiones del mismo origen.');
    return [];
  }

  return [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];
}

// Ejecutar validación
validateEnv();

export const envConfig = Object.freeze({
  port: parseInt(process.env.PORT || '3000', 10),

  // Direccion publica de este backend. La usan Meta para bajar los adjuntos
  // y n8n para bajar la portada de los productos.
  publicUrl: (process.env.BACKEND_PUBLIC_URL || '').trim(),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',

  database: {
    url: process.env.DATABASE_URL || `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/${process.env.POSTGRES_DB}`,
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    name: process.env.POSTGRES_DB || 'chatbot_db',
  },

  security: {
    encryptionKey: process.env.ENCRYPTION_KEY.trim(),
    sessionSecret: process.env.SESSION_SECRET.trim(),
    allowedOrigins: Object.freeze(resolveAllowedOrigins()),
  },

  meta: {
    appId: (process.env.META_APP_ID || '').trim(),
    appSecret: (process.env.META_APP_SECRET || '').trim(),
    whatsappAppId: (process.env.META_WHATSAPP_APP_ID || '').trim(),
    whatsappAppSecret: (process.env.META_WHATSAPP_APP_SECRET || '').trim(),
    facebookAppId: (process.env.META_FACEBOOK_APP_ID || '').trim(),
    facebookAppSecret: (process.env.META_FACEBOOK_APP_SECRET || '').trim(),
    instagramAppId: (process.env.META_INSTAGRAM_APP_ID || '').trim(),
    instagramAppSecret: (process.env.META_INSTAGRAM_APP_SECRET || '').trim(),
    appSecrets: (process.env.META_APP_SECRETS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    verifyToken: (process.env.META_VERIFY_TOKEN || 'meta_webhook_verify_token_secure_2026').trim(),
    loginConfigId: (process.env.META_LOGIN_CONFIG_ID || '').trim(),
    apiVersion: (process.env.META_API_VERSION || 'v21.0').trim(),
  },

  // API de Conversiones: informarle a Meta las ventas que salen de una
  // conversación, para que los anuncios se optimicen con datos reales.
  // Opcional: sin estas variables la app funciona igual, solo que no informa.
  conversions: {
    datasetId: (process.env.META_DATASET_ID || '').trim(),
    accessToken: (process.env.META_CONVERSIONS_TOKEN || '').trim(),

    // Cada canal puede informar a un conjunto de datos distinto, y en la
    // práctica casi siempre lo hace: el de WhatsApp no es un píxel que uno
    // crea, sino el que Meta tiene atado a la cuenta de WhatsApp Business,
    // mientras que Messenger e Instagram usan un píxel del negocio. Si además
    // los negocios están en Business Managers separados, hasta el token cambia.
    // Lo que se define acá manda sobre los valores generales de arriba.
    porPlataforma: {
      whatsapp: {
        datasetId: (process.env.META_DATASET_ID_WHATSAPP || '').trim(),
        accessToken: (process.env.META_CONVERSIONS_TOKEN_WHATSAPP || '').trim(),
      },
      facebook: {
        datasetId: (process.env.META_DATASET_ID_MESSENGER || '').trim(),
        accessToken: (process.env.META_CONVERSIONS_TOKEN_MESSENGER || '').trim(),
      },
      instagram: {
        datasetId: (process.env.META_DATASET_ID_INSTAGRAM || '').trim(),
        accessToken: (process.env.META_CONVERSIONS_TOKEN_INSTAGRAM || '').trim(),
      }
    },

    // Código de prueba del Administrador de eventos. Con esto los eventos
    // aparecen en "Eventos de prueba" y no ensucian los datos reales.
    testEventCode: (process.env.META_TEST_EVENT_CODE || '').trim(),
  },

  // Automatización con n8n (opcional).
  //
  // Meta manda sus webhooks a UNA sola dirección y esa es este backend. Con la
  // automatización encendida, después de guardar el mensaje entrante se le
  // reenvía una copia a n8n, que arma la respuesta y la manda llamando de
  // vuelta a POST /api/conversations/:id/messages con serviceToken.
  //
  // Apagada (o sin webhookUrl), sigue contestando el bot de bienvenida interno.
  automation: {
    enabled: (process.env.AUTOMATION_ENABLED || '').trim().toLowerCase() === 'true',
    webhookUrl: (process.env.N8N_WEBHOOK_URL || '').trim(),
    serviceToken: (process.env.N8N_SERVICE_TOKEN || '').trim(),
    timeoutMs: parseInt(process.env.N8N_TIMEOUT_MS || '8000', 10),

    // Cuánto se espera antes de contestar, juntando mientras tanto lo que la
    // persona siga escribiendo. Casi nadie manda una sola línea: escriben
    // "hola", después "queria consultar", después la pregunta. Contestar cada
    // línea por separado es la marca más evidente de que hay una máquina.
    debounceMs: parseInt(process.env.AUTOMATION_DEBOUNCE_MS || '8000', 10),

    // Cuántas horas puede quedar un chat esperando a una persona antes de que
    // el bot lo retome.
    //
    // Pasarle un chat a un asesor era una puerta de una sola dirección: el bot
    // se callaba y no volvía a hablar nunca. De día está bien, porque hay
    // alguien mirando. Pero el que escribe un domingo a la madrugada se queda
    // sin respuesta hasta el lunes, y para entonces ya compró en otro lado.
    //
    // Doce horas es el número que cubre una noche entera sin pisarle el chat a
    // nadie que esté trabajando.
    reactivarTrasHoras: parseInt(process.env.AUTOMATION_REACTIVAR_HORAS || '12', 10),
  },

  // Entrega automática de madrugada.
  //
  // De día el pago lo confirma una persona mirando el banco, que es lo
  // correcto. De madrugada no hay nadie, y alguien que transfirió a las dos de
  // la mañana no va a esperar contento hasta las nueve: a esa hora ya escribió
  // tres veces preguntando si lo estafaron.
  //
  // Para un PDF de Gs. 19.000 la cuenta cierra: si un comprobante falso pasa,
  // se pierde una copia de un archivo que no tiene costo de producción. Hacer
  // esperar ocho horas a alguien que sí pagó cuesta bastante más que eso.
  //
  // Solo entrega sola cuando la lectura no deja dudas, y nunca por encima de
  // `montoMaximo`: de ahí para arriba el riesgo deja de ser simétrico y
  // conviene que lo mire una persona aunque tarde.
  entregaAutomatica: {
    habilitada: (process.env.ENTREGA_AUTO_NOCTURNA || 'true').trim().toLowerCase() !== 'false',
    desdeHora: parseInt(process.env.ENTREGA_AUTO_DESDE || '21', 10),
    hastaHora: parseInt(process.env.ENTREGA_AUTO_HASTA || '8', 10),
    montoMaximo: parseInt(process.env.ENTREGA_AUTO_MONTO_MAX || '50000', 10),

    // Cuántas entregas puede hacer el sistema solo en un día.
    //
    // Es la red que atrapa lo que ningún control individual puede ver: que
    // todos los comprobantes estén pasando. Si la lectura empieza a fallar de
    // forma sistemática —un banco nuevo cuyo formato confunde al modelo, una
    // captura que alguien descubrió que pasa siempre—, cada aprobación por
    // separado se ve perfecta y el problema recién se nota al contar.
    //
    // Llegado al tope no se rechaza nada: se manda a revisión humana, que es
    // lo que habría pasado si esto no existiera. Lo único que se pierde es la
    // inmediatez, y solo a partir del pedido número quince de un mismo día.
    maxPorDia: parseInt(process.env.ENTREGA_AUTO_MAX_DIA || '15', 10),

    // Cuántas horas de antigüedad se le acepta a un comprobante.
    //
    // Es el control que faltaba, y el que más fraude tapa. Todo lo demás mira
    // si el comprobante es COHERENTE —que el monto alcance, que el destino sea
    // nuestro, que ese número no se haya usado ya—, y una captura vieja y real
    // pasa las tres sin despeinarse. Cualquiera que alguna vez le haya
    // transferido plata a este negocio, por esto o por cualquier otra cosa, se
    // queda con una imagen que sirve para cobrar para siempre: nunca la usó
    // antes, así que tampoco figura repetida.
    //
    // Con un plazo, esa imagen sirve tres días y después es una foto vieja.
    // Obliga a que el comprobante sea de una transferencia que acaba de pasar,
    // que es exactamente lo que se está afirmando al mandarlo.
    //
    // Tres días y no uno porque hay quien transfiere el viernes a la noche y
    // escribe el lunes, y esa venta es buena. Vencido el plazo no se rechaza el
    // pago: lo revisa una persona.
    horasMaximasComprobante: parseInt(process.env.ENTREGA_AUTO_HORAS_MAX || '72', 10),
  },

  // Recuperación de abandonos: volver a escribirle al que se quedó a mitad.
  //
  // La gran mayoría de las conversaciones no terminan en "no": terminan en
  // nada. La persona mira el precio, dice que lo va a pensar, y se va. Nadie
  // vuelve solo. Insistir una vez es lo que separa una conversación perdida de
  // una venta, y es gratis mientras siga abierta la ventana de 24 horas de
  // Meta.
  //
  // Tres escalones y se termina. El cuarto mensaje ya no recupera a nadie: lo
  // único que consigue es que reporten el número, y un número reportado no
  // vende más nunca. La escalera se corta sola.
  //
  // `silencioDesde`/`silencioHasta` son horas de Paraguay: un recordatorio a
  // las tres de la mañana despierta a alguien para ofrecerle un PDF, y eso no
  // se perdona. Lo que cae en esa franja espera a la mañana, y si a la mañana
  // ya se venció la ventana gratuita, se descarta: no vale pagar una plantilla
  // de Gs. 300 a 900 por insistirle a alguien que se fue hace un día.
  recuperacion: {
    habilitada: (process.env.RECUPERACION_ACTIVA || 'true').trim().toLowerCase() !== 'false',

    // Cada cuánto se revisa quién quedó a mitad de camino.
    cadaMinutos: parseInt(process.env.RECUPERACION_CADA_MIN || '15', 10),

    // Los tres escalones, en minutos desde el último movimiento de la persona.
    escalones: Object.freeze([
      parseInt(process.env.RECUPERACION_PASO_1 || '120', 10),
      parseInt(process.env.RECUPERACION_PASO_2 || '480', 10),
      parseInt(process.env.RECUPERACION_PASO_3 || '1200', 10),
    ]),

    silencioDesde: parseInt(process.env.RECUPERACION_SILENCIO_DESDE || '21', 10),
    silencioHasta: parseInt(process.env.RECUPERACION_SILENCIO_HASTA || '8', 10),

    // Cuántos mensajes de recuperación se permiten por pasada. Es un freno,
    // no una cuota: si un día entran mil conversaciones, mandarlas todas de
    // golpe se ve como un envío masivo y Meta lo trata como tal.
    maxPorPasada: parseInt(process.env.RECUPERACION_MAX_POR_PASADA || '40', 10),
  },

  // Precios especiales: cuánto duran y cuánta tolerancia tienen.
  //
  // `recuperacionHoras` es cuánto vale el descuento que ofrece el seguimiento
  // desde que se manda. Antes no vencía nunca: quien recibía "te lo dejo en
  // 15 mil" un martes lo seguía teniendo tres meses después.
  //
  // `graciaHoras` es la tolerancia después de que una oferta vence, para las
  // que no traen la suya propia (las campañas la configuran cada una). Existe
  // por el que transfirió a las 23:50 del último día y manda la captura al
  // otro día a la mañana: pagó dentro de la promo y no tiene por qué perderla.
  // Al cliente no se le anuncia: se le dice la fecha de corte y la gracia es
  // una cortesía silenciosa.
  // Lectura del Administrador de anuncios: nombres y gasto por anuncio.
  // Solo lectura (ads_read). Sin estas variables el panel funciona igual.
  metaAds: {
    token: (process.env.META_ADS_TOKEN || '').trim(),
    cuentas: (process.env.META_AD_ACCOUNT_ID || '')
      .split(',')
      .map(s => s.trim().replace(/^act_/, ''))
      .filter(s => /^\d+$/.test(s)),
    appSecret: (process.env.META_ADS_APP_SECRET || '').trim(),
  },

  ofertas: {
    recuperacionHoras: parseInt(process.env.OFERTA_RECUPERACION_HORAS || '72', 10),
    graciaHoras: parseInt(process.env.OFERTA_GRACIA_HORAS || '24', 10),
  },

  // Números con los que se prueba el flujo.
  //
  // Reiniciar una conversación borra sus mensajes y su pedido, y eso no puede
  // existir para un cliente real: un clic de más y se pierde el chat que
  // originó una venta, junto con el comprobante que la respalda. Por eso el
  // reinicio solo se habilita para los números de esta lista, y el backend lo
  // verifica por su cuenta: esconder el botón en la pantalla no protege nada,
  // porque la dirección se puede llamar igual desde afuera.
  //
  // Varios números van separados por coma.
  pruebas: {
    telefonos: Object.freeze(
      (process.env.TEST_PHONES || '+595985816710')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    ),
  },

  // Almacenamiento externo de archivos (opcional).
  // Si no se configura, los archivos se guardan solo en el disco del servidor.
  cloudinary: {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY || '').trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
    folder: (process.env.CLOUDINARY_FOLDER || 'bandeja-unificada').trim(),
  }
});

/**
 * ¿Este número es uno de los de prueba?
 *
 * Compara solo los últimos ocho dígitos, y por eso no importa cómo esté
 * escrito el número: +595 985 816 710, 595985816710 y 0985816710 son la misma
 * línea, pero como texto no se parecen en nada. Meta entrega el número en
 * formato internacional y una persona lo carga como lo tiene agendado; si la
 * comparación fuera literal, el botón no aparecería nunca y nadie entendería
 * por qué.
 *
 * Ocho dígitos alcanzan: la lista la escribe una persona a mano y tiene dos o
 * tres números, así que la chance de que dos terminen igual es despreciable.
 *
 * @param {string|null|undefined} telefono
 * @returns {boolean}
 */
export function esTelefonoDePrueba(telefono) {
  const cola = (valor) => {
    const digitos = String(valor || '').replace(/[^0-9]/g, '');
    return digitos.length >= 8 ? digitos.slice(-8) : '';
  };

  const buscado = cola(telefono);
  if (!buscado) return false;

  return envConfig.pruebas.telefonos.some(p => cola(p) === buscado);
}

/**
 * Qué hora es en Paraguay, como número de 0 a 23.
 *
 * El servidor corre en UTC, así que preguntarle la hora al reloj del proceso
 * da una respuesta que no sirve para decidir nada que tenga que ver con la
 * gente: a las 3 de la mañana en Asunción son las 7 en el servidor, y un
 * "todavía es horario laboral" calculado así manda mensajes de madrugada.
 *
 * @param {Date} [fecha]
 * @returns {number}
 */
export function horaEnParaguay(fecha = new Date()) {
  const crudo = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Asuncion',
      hour: '2-digit',
      hour12: false
    }).format(fecha),
    10
  );

  // `hour12: false` en en-US devuelve 24 a la medianoche, no 0. Para el rango
  // nocturno da lo mismo, pero cualquier cuenta que reste horas se va un día
  // entero de largo justo en el borde.
  return Number.isFinite(crudo) ? crudo % 24 : 12;
}

/** Hora y minuto en Paraguay, para las cuentas que no toleran redondeo. */
function relojParaguay(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Asuncion',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(fecha);

  const leer = (tipo, porDefecto) => {
    const p = partes.find(x => x.type === tipo);
    const n = p ? parseInt(p.value, 10) : NaN;
    return Number.isFinite(n) ? n : porDefecto;
  };

  return { hora: leer('hour', 12) % 24, minuto: leer('minute', 0) };
}

/**
 * ¿Estamos en la franja en la que no hay nadie atendiendo?
 *
 * @param {Date} [fecha]
 * @returns {boolean}
 */
export function esHorarioNocturno(fecha = new Date()) {
  const h = horaEnParaguay(fecha);
  const { desdeHora, hastaHora } = envConfig.entregaAutomatica;

  // La franja cruza la medianoche (21 a 8), así que no se puede comparar como
  // un rango normal: a las 23 hay que dar verdadero, y 23 no está "entre" 21 y 8.
  return desdeHora > hastaHora
    ? (h >= desdeHora || h < hastaHora)
    : (h >= desdeHora && h < hastaHora);
}

/**
 * ¿Es hora de no escribirle a nadie?
 *
 * Es la misma franja de la entrega automática de madrugada pero al revés de
 * propósito: de noche el bot *entrega* solo, porque quien pagó está esperando
 * despierto; de noche el bot *no insiste*, porque quien no compró está
 * durmiendo. Son dos decisiones distintas sobre la misma franja horaria y por
 * eso cada una tiene su propia configuración.
 *
 * @param {Date} [fecha]
 * @returns {boolean}
 */
export function enHorarioDeSilencio(fecha = new Date()) {
  const h = horaEnParaguay(fecha);
  const { silencioDesde, silencioHasta } = envConfig.recuperacion;

  return silencioDesde > silencioHasta
    ? (h >= silencioDesde || h < silencioHasta)
    : (h >= silencioDesde && h < silencioHasta);
}

/**
 * El próximo momento en que se puede volver a escribir.
 *
 * Si ya se puede, devuelve la misma fecha. Si estamos en la franja de
 * silencio, devuelve la hora de apertura más cercana.
 *
 * @param {Date} [fecha]
 * @returns {Date}
 */
export function proximoHorarioParaEscribir(fecha = new Date()) {
  if (!enHorarioDeSilencio(fecha)) return fecha;

  const { hora, minuto } = relojParaguay(fecha);
  const objetivo = envConfig.recuperacion.silencioHasta * 60;
  let faltan = objetivo - (hora * 60 + minuto);
  if (faltan <= 0) faltan += 24 * 60;

  return new Date(fecha.getTime() + faltan * 60000);
}

export default envConfig;
