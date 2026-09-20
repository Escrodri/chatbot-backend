import { config } from '../config/index.js';

/**
 * Puente hacia n8n.
 *
 * Meta manda sus webhooks a UNA sola dirección, y esa dirección es este backend:
 * acá viven la validación de firma, la deduplicación por meta_message_id, el
 * cifrado de los tokens de canal y la bandeja que ven los asesores. Nada de eso
 * se mueve. Lo que hace este servicio es reenviarle a n8n una copia ya limpia
 * del mensaje entrante, para que arme la respuesta.
 *
 * n8n no le habla a Meta: contesta llamando de vuelta a
 * POST /api/conversations/:id/messages con la cabecera x-service-token. Así la
 * respuesta del bot queda guardada, aparece en la bandeja y reutiliza el token
 * cifrado del canal como cualquier otro mensaje.
 *
 * El reenvío nunca puede tumbar la recepción del webhook: si n8n está caído o
 * tarda, se registra el problema y el mensaje del cliente queda guardado igual.
 */
export const automationService = {
  /**
   * ¿Está la automatización configurada y encendida?
   */
  estaActiva() {
    return Boolean(config.automation?.webhookUrl && config.automation?.enabled);
  },

  /**
   * Reenvía un mensaje entrante a n8n.
   *
   * @param {{
   *   conversation: object,
   *   contact: object,
   *   channel: object,
   *   message: object
   * }} params
   * @returns {Promise<boolean>} true si n8n aceptó el evento
   */
  async reenviarMensajeEntrante({ conversation, contact, channel, message }) {
    if (!this.estaActiva()) return false;

    // El bot solo habla cuando la conversación está en su turno. Si un asesor
    // tomó el chat, n8n no se entera del mensaje y no puede pisarlo.
    if (conversation.bot_status !== 'active') {
      return false;
    }

    const payload = {
      conversation_id: conversation.id,
      channel_id: channel.id,
      platform: channel.platform,
      contact: {
        id: contact.id,
        name: contact.name || null,
        phone: contact.platform_user_id || contact.phone_or_username || null
      },
      message: {
        id: message.id,
        type: message.content_type || 'text',
        text: message.text || '',
        media_url: message.media_url || null,
        meta_media_id: message.meta_media_id || null
      },
      bot_status: conversation.bot_status,
      enviado_en: new Date().toISOString()
    };

    const controlador = new AbortController();
    const corte = setTimeout(() => controlador.abort(), config.automation.timeoutMs);

    try {
      const respuesta = await fetch(config.automation.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-token': config.automation.serviceToken || ''
        },
        body: JSON.stringify(payload),
        signal: controlador.signal
      });

      if (!respuesta.ok) {
        console.warn(
          `⚠️ [AUTOMATION] n8n respondió ${respuesta.status} para la conversación #${conversation.id}`
        );
        return false;
      }

      return true;
    } catch (err) {
      const motivo = err.name === 'AbortError'
        ? `no respondió en ${config.automation.timeoutMs}ms`
        : err.message;
      console.warn(`⚠️ [AUTOMATION] No se pudo avisar a n8n (${motivo}). El mensaje quedó guardado igual.`);
      return false;
    } finally {
      clearTimeout(corte);
    }
  }
};

export default automationService;
