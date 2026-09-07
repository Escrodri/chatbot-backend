import { verifyHmacSha256 } from '../utils/index.js';
import { config } from '../config/index.js';

/**
 * Middleware de ciberseguridad AppSec:
 * Valida de forma estricta la firma criptográfica HMAC-SHA256 enviada por Meta en X-Hub-Signature-256.
 * Previene suplantación de eventos, inyección de mensajes falsos y ataques de temporización.
 */
export function verifyMetaSignature(req, res, next) {
  const signatureHeader = req.headers['x-hub-signature-256'];

  // En modo desarrollo, si no se ha configurado aún META_APP_SECRET y se recibe una petición sin firma, advertir
  if (config.isDev && (!config.meta.appSecret || config.meta.appSecret.includes('placeholder')) && !signatureHeader) {
    console.warn('⚠️ [DEV WARNING] Omitiendo validación HMAC de Meta porque META_APP_SECRET es un placeholder de desarrollo.');
    return next();
  }

  if (!signatureHeader) {
    console.warn('🚫 [SECURITY REJECTED] Webhook rechazado: Falta cabecera obligatoria X-Hub-Signature-256.');
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: Cabecera X-Hub-Signature-256 obligatoria ausente.',
      code: 'ERR_MISSING_META_SIGNATURE'
    });
  }

  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    console.error('🚫 [SECURITY REJECTED] Webhook rechazado: req.rawBody no está disponible como Buffer binario.');
    return res.status(500).json({
      success: false,
      error: 'Error interno: El cuerpo binario de la petición no fue preservado.',
      code: 'ERR_RAW_BODY_NOT_FOUND'
    });
  }

  const appSecret = config.meta.appSecret;
  const isValid = verifyHmacSha256(req.rawBody, signatureHeader, appSecret);

  if (!isValid) {
    console.warn('🚫 [SECURITY REJECTED] Webhook rechazado: La firma criptográfica HMAC-SHA256 no coincide con el App Secret.');
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: Firma criptográfica inválida o payload alterado.',
      code: 'ERR_INVALID_META_SIGNATURE'
    });
  }

  next();
}

export default verifyMetaSignature;
