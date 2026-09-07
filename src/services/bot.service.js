import { botRepository, messageRepository, conversationRepository } from '../repositories/index.js';
import { socketManager } from '../sockets/index.js';
import { graphApiService } from './graph-api.service.js';

/**
 * Servicio del Chatbot de Bienvenida:
 * Gestiona el saludo automático inicial a nuevos clientes o tras inactividad prolongada,
 * respetando estrictamente el protocolo Handover y las variables dinámicas de plantilla.
 */
export const botService = {
  /**
   * Procesa la posible auto-respuesta del bot ante un mensaje entrante de cliente.
   * 
   * @param {{
   *   channel: object,
   *   contact: object,
   *   conversation: object,
   *   inboundText: string
   * }} params
   * @returns {Promise<object|null>} Mensaje del bot despachado o null si no debía responder
   */
  async handleInboundMessage({ channel, contact, conversation, inboundText }) {
    // 1. Si el bot está en estado 'handed_over' (pase a humano) o 'disabled', NO responder
    if (conversation.bot_status !== 'active') {
      return null;
    }

    // 2. Obtener configuración del bot para este canal
    const botConfig = await botRepository.getSettingsForChannel(channel.id);
    if (!botConfig || !botConfig.is_enabled) {
      return null;
    }

    // 3. Renderizar saludo con variables dinámicas
    const rawTemplate = botConfig.welcome_message || '¡Hola! Enseguida te atenderemos.';
    const renderedText = this.renderWelcomeMessage(rawTemplate, {
      cliente: contact.name || 'Cliente',
      canal: channel.name || 'nuestro canal'
    });

    // 4. Despachar a través de Meta Graph API v21.0
    let metaMessageId = `bot_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    let deliveryStatus = 'sent';

    try {
      if (graphApiService && typeof graphApiService.sendMessage === 'function') {
        const sendResult = await graphApiService.sendMessage({
          channel,
          recipientId: contact.platform_user_id,
          text: renderedText
        });
        if (sendResult?.metaMessageId) {
          metaMessageId = sendResult.metaMessageId;
        }
      }
    } catch (err) {
      console.warn('⚠️ [BOT DISPATCH WARNING] No se pudo despachar por Graph API externa:', err.message);
      deliveryStatus = 'failed';
    }

    // 5. Persistir el mensaje saliente del chatbot
    const botMessage = await messageRepository.insertMessage({
      conversationId: conversation.id,
      channelId: channel.id,
      metaMessageId,
      direction: 'outbound',
      senderType: 'bot',
      contentType: 'text',
      text: renderedText,
      status: deliveryStatus
    });

    // 6. Actualizar cabecera de conversación
    await conversationRepository.updateOutboundMessage(conversation.id, renderedText);

    // 7. Notificar en tiempo real a los operadores
    if (botMessage) {
      const summary = {
        ...conversation,
        last_message_text: renderedText,
        last_message_time: new Date()
      };
      socketManager.emitNewMessage(channel.id, botMessage, summary);
    }

    return botMessage;
  },

  /**
   * Reemplaza variables dinámicas en el mensaje del bot.
   * Soporta: {{cliente}}, {{canal}}
   * 
   * @param {string} template
   * @param {{ cliente: string, canal: string }} vars
   * @returns {string}
   */
  renderWelcomeMessage(template, vars = {}) {
    if (!template) return '';
    let rendered = template;
    if (vars.cliente) {
      rendered = rendered.replace(/\{\{\s*cliente\s*\}\}/gi, vars.cliente);
    }
    if (vars.canal) {
      rendered = rendered.replace(/\{\{\s*canal\s*\}\}/gi, vars.canal);
    }
    return rendered;
  }
};

export default botService;
