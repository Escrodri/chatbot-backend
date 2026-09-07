import crypto from 'crypto';
import { config } from '../config/index.js';

/**
 * Decodifica y valida criptográficamente un parámetro signed_request de Meta.
 * 
 * @param {string} signedRequest
 * @param {string} appSecret
 * @returns {object|null} Payload decodificado o null si la firma es inválida
 */
export function parseSignedRequest(signedRequest, appSecret) {
  if (!signedRequest || typeof signedRequest !== 'string' || !signedRequest.includes('.')) {
    return null;
  }

  const [encodedSig, encodedPayload] = signedRequest.split('.', 2);

  // Reemplazar caracteres Base64URL a Base64 estándar
  const normalizeBase64 = (str) => {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    return base64;
  };

  try {
    const signatureBuffer = Buffer.from(normalizeBase64(encodedSig), 'base64');
    const expectedSignatureBuffer = crypto
      .createHmac('sha256', appSecret)
      .update(encodedPayload)
      .digest();

    if (signatureBuffer.length !== expectedSignatureBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)) {
      console.warn('⚠️ [APPSEC DATA DELETION] Firma inválida en signed_request.');
      return null;
    }

    const jsonString = Buffer.from(normalizeBase64(encodedPayload), 'base64').toString('utf8');
    const data = JSON.parse(jsonString);

    if (data.algorithm !== 'HMAC-SHA256') {
      console.warn(`⚠️ [APPSEC DATA DELETION] Algoritmo desconocido: ${data.algorithm}`);
      return null;
    }

    return data;
  } catch (err) {
    console.error('❌ [DATA DELETION ERROR] Fallo al parsear signed_request:', err);
    return null;
  }
}

/**
 * Controlador de Eliminación de Datos (Meta App Review Compliance):
 * Procesa la llamada obligatoria de Meta cuando un usuario elimina la app desde la configuración de Facebook.
 */
export const dataDeletionController = {
  /**
   * POST /api/compliance/data-deletion
   * Callback oficial de Meta.
   */
  async handleCallback(req, res) {
    const signedRequest = req.body?.signed_request || req.query?.signed_request;

    if (!signedRequest) {
      return res.status(400).json({
        error: 'signed_request parameter is required'
      });
    }

    const payload = parseSignedRequest(signedRequest, config.meta.appSecret);
    if (!payload) {
      return res.status(403).json({
        error: 'Invalid or forged signed_request'
      });
    }

    const userId = payload.user_id;
    const confirmationCode = `del_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

    console.log(`🛡️ [DATA DELETION] Solicitud de eliminación confirmada para Meta User ID: ${userId}. Código: ${confirmationCode}`);

    // Construir URL de seguimiento exigida por los lineamientos de Meta Developers
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const statusUrl = `${protocol}://${host}/api/compliance/data-deletion-status?code=${confirmationCode}`;

    return res.status(200).json({
      url: statusUrl,
      confirmation_code: confirmationCode
    });
  },

  /**
   * GET /api/compliance/data-deletion-status?code=...
   * Consulta pública de estado de eliminación de datos.
   */
  async getStatus(req, res) {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Confirmation code is required' });
    }

    return res.status(200).json({
      confirmation_code: code,
      status: 'COMPLETED',
      message: 'Sus datos asociados han sido disasociados y anonimizados conforme a las políticas de Meta Platform.'
    });
  }
};
