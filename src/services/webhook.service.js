import { channelRepository, contactRepository, conversationRepository, messageRepository, logRepository } from '../repositories/index.js';
import { normalizerService } from './normalizer.service.js';
import { socketManager } from '../sockets/index.js';

/**
 * Servicio de Ingesta y Procesamiento de Webhooks:
 * Ejecuta la lógica de persistencia, deduplicación y resolución de canales en segundo plano.
 */
export const webhookService = {
  /**
   * Procesa un payload crudo de Meta Webhook deserializado.
   * 
   * @param {object} rawPayload
   * @returns {Promise<void>}
   */
  async processPayload(rawPayload) {
    if (!rawPayload || typeof rawPayload !== 'object') return;

    // 1. Normalizar eventos multi-canal
    const events = normalizerService.normalizeWebhookPayload(rawPayload);
    if (events.length === 0) {
      // Registrar log informativo si no se detectaron eventos compatibles
      await logRepository.logEvent({
        platform: rawPayload.object || 'unknown',
        eventType: 'unrecognized_or_empty',
        rawPayload,
        status: 'IGNORED'
      });
      return;
    }

    for (const event of events) {
      try {
        await this._processSingleEvent(event, rawPayload);
      } catch (err) {
        console.error(`❌ [WEBHOOK PROCESS ERROR] Fallo procesando evento en canal ${event.channelIdentifier}:`, err);
        await logRepository.logEvent({
          platform: event.platform,
          channelIdentifier: event.channelIdentifier,
          eventType: event.eventType,
          rawPayload: { error: err.message, event },
          status: 'ERROR'
        });
      }
    }
  },

  /**
   * Procesa un evento atómico normalizado.
   * @private
   */
  async _processSingleEvent(event, rawPayload) {
    // 1. Localizar el canal registrado en el sistema
    const channel = await channelRepository.findByIdentifier(event.channelIdentifier);

    if (!channel) {
      console.warn(`⚠️ [WEBHOOK] Evento recibido para un canal no registrado: ${event.channelIdentifier} (${event.platform})`);
      await logRepository.logEvent({
        platform: event.platform,
        channelIdentifier: event.channelIdentifier,
        eventType: event.eventType,
        rawPayload,
        status: 'CHANNEL_NOT_FOUND'
      });
      return;
    }

    // 2. Manejar eventos de estado de entrega (delivery / read / failure)
    if (event.eventType === 'status' && event.statusUpdate) {
      const { metaMessageId, status, errors } = event.statusUpdate;
      if (metaMessageId) {
        await messageRepository.updateStatusByMetaId(metaMessageId, status, errors);
        socketManager.emitMessageStatus(channel.id, metaMessageId, status);
      }
      await logRepository.logEvent({
        platform: event.platform,
        channelIdentifier: event.channelIdentifier,
        eventType: 'status_update',
        rawPayload,
        status: 'PROCESSED'
      });
      return;
    }

    // 3. Manejar mensajes entrantes o ecos (message / echo)
    if (event.eventType === 'message' || event.eventType === 'echo') {
      // A. Buscar o crear el contacto
      const contact = await contactRepository.findOrCreate({
        channelId: channel.id,
        platform: event.platform,
        platformUserId: event.sender.id,
        name: event.sender.name || `Contacto ${event.sender.id.slice(-4)}`,
        phoneOrUsername: event.sender.phone || null
      });

      // B. Buscar o crear la conversación
      const conversation = await conversationRepository.findOrCreateByContact(channel.id, contact.id);

      // C. Si es un eco (el operador respondió desde WhatsApp Business móvil o Meta Business Suite):
      // Pausar inmediatamente el bot (Protocolo Handover: handed_over)
      if (event.isEcho) {
        await conversationRepository.updateBotStatus(conversation.id, 'handed_over');
        socketManager.emitBotStatus(channel.id, conversation.id, 'handed_over');
        console.log(`🤖 [HANDOVER] Bot pausado automáticamente para conversación #${conversation.id} por eco de operador.`);
      }

      // D. Insertar el mensaje con deduplicación estricta
      const insertedMessage = await messageRepository.insertMessage({
        conversationId: conversation.id,
        channelId: channel.id,
        metaMessageId: event.message.id,
        direction: event.message.direction,
        senderType: event.message.senderType,
        contentType: event.message.type,
        text: event.message.text,
        mediaUrl: event.message.mediaUrl || null,
        status: 'delivered',
        timestamp: event.message.timestamp
      });

      // Si es un duplicado, se descarta silenciosamente
      if (!insertedMessage) {
        await logRepository.logEvent({
          platform: event.platform,
          channelIdentifier: event.channelIdentifier,
          eventType: 'duplicate_message',
          rawPayload: { metaMessageId: event.message.id },
          status: 'DUPLICATE'
        });
        return;
      }

      // E. Si es entrante del cliente, actualizar ventana de 24h y contador
      if (!event.isEcho && event.message.direction === 'inbound') {
        await conversationRepository.touchCustomerInteraction(
          conversation.id,
          event.message.text,
          event.message.timestamp
        );
      } else if (event.isEcho) {
        await conversationRepository.updateOutboundMessage(
          conversation.id,
          event.message.text
        );
      }

      // F. Notificar a los navegadores conectados en tiempo real vía WebSocket
      const conversationSummary = {
        id: conversation.id,
        channel_id: channel.id,
        contact_id: contact.id,
        contact_name: contact.name,
        contact_avatar: contact.avatar_url,
        channel_name: channel.name,
        channel_color: channel.color_tag,
        platform: channel.platform,
        last_message_text: event.message.text,
        last_message_time: event.message.timestamp,
        bot_status: event.isEcho ? 'handed_over' : conversation.bot_status
      };
      socketManager.emitNewMessage(channel.id, insertedMessage, conversationSummary);

      // G. Registrar auditoría
      await logRepository.logEvent({
        platform: event.platform,
        channelIdentifier: event.channelIdentifier,
        eventType: event.eventType,
        rawPayload,
        status: 'PROCESSED'
      });
    }
  }
};

export default webhookService;
