import { config } from '../config/index.js';
import { queueService, webhookService } from '../services/index.js';

/**
 * Controlador de Webhooks de Meta (WhatsApp, Messenger, Instagram).
 * Maneja el handshake inicial de verificación y la ingesta de eventos entrantes.
 */
export const webhookController = {
  /**
   * Endpoint GET /api/webhook: Handshake oficial de Meta Graph API.
   * Valida hub.mode === 'subscribe' y hub.verify_token coincidente con META_VERIFY_TOKEN.
   * Retorna directamente el valor de hub.challenge con HTTP 200.
   */
  handleVerification(req, res) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (!mode || !token) {
      return res.status(400).json({
        success: false,
        error: 'Parámetros de verificación incompletos. Se requiere hub.mode y hub.verify_token.'
      });
    }

    if (mode === 'subscribe' && token === config.meta.verifyToken) {
      console.log('✅ [META WEBHOOK] Handshake de verificación completado con éxito.');
      return res.status(200).send(challenge);
    }

    console.warn('🚫 [META WEBHOOK] Handshake rechazado: Token de verificación incorrecto.');
    return res.status(403).json({
      success: false,
      error: 'Token de verificación de webhook inválido.',
      code: 'ERR_INVALID_VERIFY_TOKEN'
    });
  },

  /**
   * Endpoint POST /api/webhook: Ingesta multi-canal asíncrona.
   * Encola la tarea en P-Queue y responde HTTP 200 OK inmediatamente (< 50ms) para cumplir
   * con las exigencias estrictas de tiempo de respuesta de Meta Graph API.
   */
  async handleInbound(req, res) {
    // 1. Encolar procesamiento en segundo plano (no bloqueante)
    queueService.enqueue(async () => {
      await webhookService.processPayload(req.body);
    });

    // 2. Retornar inmediatamente HTTP 200 a Meta
    return res.status(200).json({ status: 'EVENT_RECEIVED' });
  }
};

export default webhookController;
