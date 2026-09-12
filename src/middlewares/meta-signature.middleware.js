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

  const objectType = req.body?.object;
  const isWhatsApp = objectType === 'whatsapp_business_account';
  const isFacebookOrInstagram = objectType === 'page' || objectType === 'instagram';

  // 1. Recolectar candidatos según plataforma y variables de entorno
  const candidateSecrets = new Set();

  if (isWhatsApp && config.meta.whatsappAppSecret) {
    candidateSecrets.add(config.meta.whatsappAppSecret);
  }
  if (isFacebookOrInstagram && config.meta.facebookAppSecret) {
    candidateSecrets.add(config.meta.facebookAppSecret);
  }

  // App Secret general (.env)
  if (config.meta.appSecret) {
    candidateSecrets.add(config.meta.appSecret);
  }

  // Secretos de la otra plataforma en .env si existen
  if (config.meta.whatsappAppSecret) candidateSecrets.add(config.meta.whatsappAppSecret);
  if (config.meta.facebookAppSecret) candidateSecrets.add(config.meta.facebookAppSecret);

  // Lista de secretos en META_APP_SECRETS
  if (Array.isArray(config.meta.appSecrets)) {
    for (const sec of config.meta.appSecrets) {
      if (sec) candidateSecrets.add(sec);
    }
  }

  // Probar candidatos de variables de entorno
  let isValid = false;
  for (const secret of candidateSecrets) {
    if (verifyHmacSha256(req.rawBody, signatureHeader, secret)) {
      isValid = true;
      break;
    }
  }

  // 2. Si no validó con env, intentar con el secreto específico del canal en base de datos
  if (!isValid && req.body && typeof req.body === 'object') {
    try {
      const entry = req.body.entry?.[0];
      const identifiers = [];

      if (entry?.changes?.[0]?.value?.metadata?.phone_number_id) {
        identifiers.push(String(entry.changes[0].value.metadata.phone_number_id).trim());
      }
      if (entry?.id) {
        identifiers.push(String(entry.id).trim());
      }
      if (entry?.messaging?.[0]?.recipient?.id) {
        identifiers.push(String(entry.messaging[0].recipient.id).trim());
      }
      if (entry?.messaging?.[0]?.sender?.id) {
        identifiers.push(String(entry.messaging[0].sender.id).trim());
      }

      for (const id of identifiers) {
        const channel = await channelRepository.findAnyByIdentifier(id);
        if (channel?.app_secret) {
          if (verifyHmacSha256(req.rawBody, signatureHeader, channel.app_secret)) {
            isValid = true;
            console.log(`✅ [META SIGNATURE] Firma validada exitosamente con el App Secret del canal "${channel.name}" (${id}).`);
            break;
          }
        }
      }
    } catch {
      // Ignorar errores de BD para continuar al fallback general
    }
  }

  // 3. Fallback omnicanal: probar contra todos los App Secrets guardados en canales de la BD
  if (!isValid) {
    try {
      const allDbSecrets = await channelRepository.getAllAppSecrets();
      for (const dbSecret of allDbSecrets) {
        if (dbSecret && verifyHmacSha256(req.rawBody, signatureHeader, dbSecret)) {
          isValid = true;
          console.log('✅ [META SIGNATURE] Firma validada exitosamente con el App Secret de un canal registrado en BD.');
          break;
        }
      }
    } catch {
      // Ignorar
    }
  }

  // 4. Si ninguna firma coincide, rechazar con código 403 y diagnóstico explicativo
  if (!isValid) {
    const maskedSecret = config.meta.appSecret
      ? `${config.meta.appSecret.slice(0, 4)}...${config.meta.appSecret.slice(-4)}`
      : '(no configurado)';

    console.warn('🚫 [SECURITY REJECTED] Webhook rechazado: La firma criptográfica HMAC-SHA256 no coincide con ningún App Secret.');
    console.warn(`ℹ️ [DIAGNÓSTICO META WEBHOOK]:`);
    console.warn(`   • Plataforma en webhook: ${objectType || 'desconocida'}`);
    console.warn(`   • App ID general en backend: ${config.meta.appId || 'No definido'}`);
    console.warn(`   • META_APP_SECRET actual: ${maskedSecret}`);
    console.warn(`   • META_WHATSAPP_APP_SECRET: ${config.meta.whatsappAppSecret ? 'Configurado' : 'No configurado'}`);
    console.warn(`   • META_FACEBOOK_APP_SECRET: ${config.meta.facebookAppSecret ? 'Configurado' : 'No configurado'}`);
    console.warn(`   • ¿Por qué se repite este mensaje en el servidor?`);
    console.warn(`     Meta reintenta enviar el webhook automáticamente varias veces cuando el servidor responde con 403.`);
    console.warn(`   • ¿Cómo solucionarlo si tienes dos aplicativos de Meta (WhatsApp y Facebook)?:`);
    console.warn(`     1. Ingresa a tu panel de hosting (Render > Environment) o a tu archivo .env.`);
    console.warn(`     2. Agrega los App Secrets individuales según corresponda:`);
    console.warn(`        • META_WHATSAPP_APP_SECRET="tu_app_secret_de_whatsapp"`);
    console.warn(`        • META_FACEBOOK_APP_SECRET="tu_app_secret_de_facebook"`);
    console.warn(`        • o META_APP_SECRETS="secreto1,secreto2"`);
    console.warn(`     3. Alternativamente, en Ajustes > Canales de tu panel web, edita el canal e ingresa su "Clave secreta de la app".`);

    return res.status(403).json({
      success: false,
      error: 'Acceso denegado: Firma criptográfica inválida o payload alterado.',
      code: 'ERR_INVALID_META_SIGNATURE'
    });
  }

  next();
}

export default verifyMetaSignature;
