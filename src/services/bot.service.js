import { query } from '../database/index.js';
import { botRepository, messageRepository, conversationRepository } from '../repositories/index.js';
import { socketManager } from '../sockets/index.js';
import { graphApiService } from './graph-api.service.js';

// Mapa en memoria para el debouncing de mensajes en ráfaga (conversationId -> NodeJS.Timeout)
const pendingGreetings = new Map();

/**
 * Servicio del Chatbot de Bienvenida:
 * Gestiona el saludo automático inicial a nuevos clientes o tras inactividad prolongada,
 * respetando estrictamente el protocolo Handover, retardo natural de 10s y frecuencia de 1 saludo por sesión.
 */
export const botService = {
  /**
   * Procesa la posible auto-respuesta del bot ante un mensaje entrante de cliente.
   * Aplica retardo de 10s con debounce y valida no repetir saludos si ya se envió uno en la sesión.
   * 
   * @param {{
   *   channel: object,
   *   contact: object,
   *   conversation: object,
   *   inboundText: string
   * }} params
   * @returns {Promise<boolean>} Retorna true si se programó el saludo, false si no procede
   */
  async handleInboundMessage({ channel, contact, conversation, inboundText }) {
    // 1. Si el bot no está en estado 'active', no responder
    if (conversation.bot_status !== 'active') {
      return null;
    }

    // 2. Obtener configuración del bot para este canal
    const botConfig = await botRepository.getSettingsForChannel(channel.id);
    if (!botConfig || !botConfig.is_enabled) {
      return null;
    }

    // 3. Regla de negocio: Verificar si ya se envió un saludo de bienvenida en las últimas X horas
    const inactivityHours = parseInt(botConfig.inactivity_hours || 24, 10);
    const { rows: recentBotMsgs } = await query(
      `SELECT id FROM messages 
       WHERE conversation_id = $1 
         AND sender_type = 'bot' 
         AND timestamp > (NOW() - ($2 || ' hours')::INTERVAL)
       LIMIT 1`,
      [conversation.id, inactivityHours]
    );

    if (recentBotMsgs.length > 0) {
      // Ya se saludó al cliente dentro de la ventana de sesión actual. No enviar otro saludo repetido.
      return null;
    }

    // 4. Retardo natural de 10 segundos con Debounce:
    // Si el cliente envía varios mensajes seguidos, reiniciamos el temporizador para responder una sola vez tras la ráfaga
    if (pendingGreetings.has(conversation.id)) {
      clearTimeout(pendingGreetings.get(conversation.id));
    }

    const timer = setTimeout(async () => {
      pendingGreetings.delete(conversation.id);
      try {
        await this.dispatchGreeting({ channel, contact, conversationId: conversation.id, botConfig });
      } catch (dispatchErr) {
        console.error(`❌ [BOT DISPATCH ERROR] Error enviando saludo demorado a conv #${conversation.id}:`, dispatchErr);
      }
    }, 10000); // 10 segundos de retardo natural

    pendingGreetings.set(conversation.id, timer);
    return true;
  },

  /**
   * Ejecuta el despacho del saludo de bienvenida tras cumplirse los 10 segundos.
   * Valida en tiempo real que el operador no haya intervenido o cambiado el estado.
   */
  async dispatchGreeting({ channel, contact, conversationId, botConfig }) {
    // A. Re-verificar estado actual en BD
    const currentConv = await conversationRepository.findById(conversationId);
    if (!currentConv || currentConv.bot_status !== 'active') {
      return null;
    }

    // B. Re-verificar si no hubo intervención humana o bot durante los 10 segundos
    const inactivityHours = parseInt(botConfig.inactivity_hours || 24, 10);
    const { rows: checkAgain } = await query(
      `SELECT id FROM messages 
       WHERE conversation_id = $1 
         AND sender_type IN ('bot', 'agent') 
         AND timestamp > (NOW() - ($2 || ' hours')::INTERVAL)
       LIMIT 1`,
      [conversationId, inactivityHours]
    );

    if (checkAgain.length > 0) {
      return null;
    }

    // C. Renderizar plantilla con variables dinámicas
    const rawTemplate = botConfig.welcome_message || '¡Hola! Enseguida te atenderemos.';
    const renderedText = this.renderWelcomeMessage(rawTemplate, {
      cliente: contact.name || 'Cliente',
      canal: channel.name || 'nuestro canal'
    });

    // D. Despachar a Meta Graph API v21.0
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

    // E. Persistir el mensaje saliente del chatbot
    const botMessage = await messageRepository.insertMessage({
      conversationId,
      channelId: channel.id,
      metaMessageId,
      direction: 'outbound',
      senderType: 'bot',
      contentType: 'text',
      text: renderedText,
      status: deliveryStatus
    });

    // F. Actualizar cabecera de conversación
    await conversationRepository.updateOutboundMessage(conversationId, renderedText);

    // G. Notificar en tiempo real a los operadores vía WebSocket
    if (botMessage) {
      const summary = {
        ...currentConv,
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
