import { verifyHmacSha256 } from '../utils/index.js';
import { config } from '../config/index.js';

/**
 * Middleware de ciberseguridad AppSec:
 * Valida de forma estricta la firma criptográfica HMAC-SHA256 enviada por Meta en X-Hub-Signature-256.
 * Previene suplantación de eventos, inyección de mensajes falsos y ataques de temporización.
 */
export function verifyMetaSignature(req, res, next) {
  const signatureHeader = req.headers['x-hub-signature-256'];

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
    const isTest = Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' || process.argv.some(a => a.includes('test')));
    // Si estamos en desarrollo local (no en tests automáticos) y el secret es un placeholder, permitir para pruebas de Meta
    if (!isTest && config.isDev && (!appSecret || appSecret.includes('placeholder'))) {
      console.warn('⚠️ [DEV WARNING] Firma HMAC de Meta no coincide con META_APP_SECRET local (placeholder). Permitido en desarrollo.');
      return next();
    }

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
