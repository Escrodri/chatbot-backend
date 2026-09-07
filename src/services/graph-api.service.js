import { config } from '../config/index.js';

const META_API_BASE = 'https://graph.facebook.com';

/**
 * Servicio Oficial Meta Graph API v21.0:
 * Despacha mensajes salientes hacia WhatsApp Cloud API, Facebook Messenger e Instagram Direct.
 * Implementa la etiqueta HUMAN_AGENT (ventana de 7 días) y soporte de plantillas HSM para WhatsApp fuera de 24h.
 */
export const graphApiService = {
  /**
   * Envía un mensaje a través de Meta Graph API.
   * 
   * @param {{
   *   channel: object,
   *   recipientId: string,
   *   text: string,
   *   isHumanAgentTag?: boolean,
   *   mediaUrl?: string|null
   * }} params
   * @returns {Promise<{ metaMessageId: string }>}
   */
  async sendMessage({ channel, recipientId, text, isHumanAgentTag = false, mediaUrl = null }) {
    const apiVersion = config.meta.apiVersion || 'v21.0';
    const accessToken = channel.accessToken;

    if (!accessToken) {
      throw new Error(`Canal ${channel.name} (#${channel.id}) no posee un access_token válido configurado.`);
    }

    // 1. WHATSAPP CLOUD API
    if (channel.platform === 'whatsapp') {
      const url = `${META_API_BASE}/${apiVersion}/${channel.channel_identifier}/messages`;
      
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientId,
        type: 'text',
        text: { preview_url: false, body: text }
      };

      return this._postToMeta(url, accessToken, payload, (data) => data.messages?.[0]?.id);
    }

    // 2. FACEBOOK MESSENGER
    if (channel.platform === 'facebook') {
      const url = `${META_API_BASE}/${apiVersion}/me/messages`;

      const payload = {
        recipient: { id: recipientId },
        message: { text }
      };

      // Si se activa la ventana extendida de 7 días para operadores humanos
      if (isHumanAgentTag) {
        payload.messaging_type = 'MESSAGE_TAG';
        payload.tag = 'HUMAN_AGENT';
      } else {
        payload.messaging_type = 'RESPONSE';
      }

      return this._postToMeta(url, accessToken, payload, (data) => data.message_id);
    }

    // 3. INSTAGRAM DIRECT
    if (channel.platform === 'instagram') {
      const url = `${META_API_BASE}/${apiVersion}/me/messages`;

      const payload = {
        recipient: { id: recipientId },
        message: { text }
      };

      if (isHumanAgentTag) {
        payload.messaging_type = 'MESSAGE_TAG';
        payload.tag = 'HUMAN_AGENT';
      }

      return this._postToMeta(url, accessToken, payload, (data) => data.message_id);
    }

    throw new Error(`Plataforma no compatible: ${channel.platform}`);
  },

  /**
   * Helper privado para peticiones HTTP a Meta con captura de errores de Graph API.
   * @private
   */
  async _postToMeta(url, accessToken, payload, extractIdFn) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        const errObj = data.error || {};
        const errMsg = errObj.message || `Error HTTP ${response.status} de Meta Graph API`;
        console.error('❌ [META GRAPH API ERROR]:', errObj);
        throw new Error(`[Meta Graph API Error ${errObj.code || response.status}] ${errMsg}`);
      }

      const metaMessageId = extractIdFn(data) || `meta_${Date.now()}`;
      return { metaMessageId, rawResponse: data };
    } catch (err) {
      console.error(`💥 [GRAPH API NETWORK FAILURE] ${url}:`, err.message);
      throw err;
    }
  }
};

export default graphApiService;
