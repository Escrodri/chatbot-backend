import { queueService, webhookService } from '../services/index.js';
import { config } from '../config/index.js';

/**
 * Controlador de Pruebas y Simulador Local (Solo disponible en desarrollo/testing).
 * Permite simular la recepción de mensajes de WhatsApp, Facebook e Instagram sin túnel ngrok.
 */
export const testController = {
  /**
   * Endpoint POST /api/test/simulate-inbound
   * Inyecta un payload simulado directamente al servicio de webhooks.
   */
  async simulateInbound(req, res) {
    if (config.isProd) {
      return res.status(403).json({
        success: false,
        error: 'El simulador de eventos no está disponible en entorno de producción.',
        code: 'ERR_SIMULATOR_DISABLED'
      });
    }

    const {
      platform = 'whatsapp',
      channelIdentifier,
      senderId = '5491199998888',
      senderName = 'Cliente de Prueba',
      text = 'Hola, mensaje de prueba local',
      type = 'text'
    } = req.body;

    if (!channelIdentifier) {
      return res.status(400).json({
        success: false,
        error: 'channelIdentifier es obligatorio (phone_number_id o page_id).'
      });
    }

    // Construir estructura según plataforma
    let mockPayload;
    const metaMessageId = `mock_${platform}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    if (platform === 'whatsapp') {
      mockPayload = {
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            field: 'messages',
            value: {
              metadata: { phone_number_id: channelIdentifier },
              contacts: [{ profile: { name: senderName }, wa_id: senderId }],
              messages: [{
                from: senderId,
                id: metaMessageId,
                timestamp: Math.floor(Date.now() / 1000).toString(),
                text: { body: text },
                type
              }]
            }
          }]
        }]
      };
    } else {
      // Facebook o Instagram
      mockPayload = {
        object: platform === 'instagram' ? 'instagram' : 'page',
        entry: [{
          id: channelIdentifier,
          messaging: [{
            sender: { id: senderId },
            recipient: { id: channelIdentifier },
            timestamp: Date.now(),
            message: {
              mid: metaMessageId,
              text
            }
          }]
        }]
      };
    }

    // Encolar tarea de procesamiento en la cola asíncrona
    queueService.enqueue(async () => {
      await webhookService.processPayload(mockPayload);
    });

    return res.status(200).json({
      success: true,
      message: 'Evento simulado encolado exitosamente.',
      simulated: {
        platform,
        channelIdentifier,
        metaMessageId,
        senderId,
        text
      }
    });
  }
};

export default testController;
