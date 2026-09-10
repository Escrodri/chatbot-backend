import { verifyHmacSha256 } from '../utils/index.js';
import { config } from '../config/index.js';
import { channelRepository } from '../repositories/index.js';

/**
 * Middleware de ciberseguridad AppSec:
 * Valida de forma estricta la firma criptográfica HMAC-SHA256 enviada por Meta en X-Hub-Signature-256.
 * Previene suplantación de eventos, inyección de mensajes falsos y ataques de temporización.
 * 
 * Verifica primero contra META_APP_SECRET del entorno (.env) y, si no coincide, intenta validar
 * contra el app_secret específico del canal registrado en la base de datos si existe.
 */
export async function verifyMetaSignature(req, res, next) {
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

  // 1. Intentar validar con META_APP_SECRET global del archivo .env
  let isValid = false;
  if (appSecret) {
    isValid = verifyHmacSha256(req.rawBody, signatureHeader, appSecret);
  }

  // 2. Si falló y el payload contiene un identificador de canal, intentar con el secreto del canal
  if (!isValid && req.body && typeof req.body === 'object') {
    try {
      let identifier = null;
      const entry = req.body.entry?.[0];
      if (entry?.changes?.[0]?.value?.metadata?.phone_number_id) {
        identifier = String(entry.changes[0].value.metadata.phone_number_id).trim();
      } else if (entry?.id) {
        identifier = String(entry.id).trim();
      }

      if (identifier) {
        const channel = await channelRepository.findAnyByIdentifier(identifier);
        if (channel?.app_secret) {
          isValid = verifyHmacSha256(req.rawBody, signatureHeader, channel.app_secret);
          if (isValid) {
            console.log(`✅ [META SIGNATURE] Firma validada exitosamente con el App Secret del canal "${channel.name}" (${identifier}).`);
          }
        }
      }
    } catch {
      // Ignorar errores de consulta a BD para que la verificación continúe normalmente
    }
  }

  // 3. Si ninguna firma coincide, rechazar con código 403
  if (!isValid) {
    const maskedSecret = appSecret
      ? `${appSecret.slice(0, 4)}...${appSecret.slice(-4)}`
      : '(no configurado)';

    console.warn('🚫 [SECURITY REJECTED] Webhook rechazado: La firma criptográfica HMAC-SHA256 no coincide con el App Secret.');
    console.warn(`ℹ️ [DIAGNÓSTICO META WEBHOOK]:`);
    console.warn(`   • App ID en backend: ${config.meta.appId || 'No definido'}`);
    console.warn(`   • META_APP_SECRET actual en backend: ${maskedSecret}`);
    console.warn(`   • ¿Qué verificar?:`);
    console.warn(`     1. Ingresa a https://developers.facebook.com/apps/`);
    console.warn(`     2. Selecciona la App que configuró este webhook.`);
    console.warn(`     3. Ve a "Configuración de la app" > "Básica".`);
    console.warn(`     4. Copia la "Clave secreta de la app" (App Secret) y pégala en META_APP_SECRET de tu archivo backend/.env.`);
    console.warn(`     5. Reinicia el backend.`);

    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: Firma criptográfica inválida o payload alterado.',
      code: 'ERR_INVALID_META_SIGNATURE'
    });
  }

  next();
}

export default verifyMetaSignature;
