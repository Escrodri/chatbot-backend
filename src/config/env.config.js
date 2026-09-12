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

  // 3. Handshake de Meta
  if (!process.env.META_VERIFY_TOKEN) {
    missingVars.push('META_VERIFY_TOKEN (Token secreto para verificación de webhook Meta)');
  }

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
    appId: (process.env.META_APP_ID || '2381150255623992').trim(),
    appSecret: (process.env.META_APP_SECRET || '').trim(),
    whatsappAppId: (process.env.META_WHATSAPP_APP_ID || '').trim(),
    whatsappAppSecret: (process.env.META_WHATSAPP_APP_SECRET || '').trim(),
    facebookAppId: (process.env.META_FACEBOOK_APP_ID || '').trim(),
    facebookAppSecret: (process.env.META_FACEBOOK_APP_SECRET || '').trim(),
    appSecrets: (process.env.META_APP_SECRETS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    verifyToken: (process.env.META_VERIFY_TOKEN || '').trim(),
    loginConfigId: (process.env.META_LOGIN_CONFIG_ID || '').trim(),
    apiVersion: (process.env.META_API_VERSION || 'v26.0').trim(),
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

  // Almacenamiento externo de archivos (opcional).
  // Si no se configura, los archivos se guardan solo en el disco del servidor.
  cloudinary: {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME || '').trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY || '').trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
    folder: (process.env.CLOUDINARY_FOLDER || 'bandeja-unificada').trim(),
  }
});

export default envConfig;
