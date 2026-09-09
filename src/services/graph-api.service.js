import { config } from '../config/index.js';
import { timeUtil } from '../utils/index.js';
import { channelRepository } from '../repositories/index.js';
import { socketManager } from '../sockets/index.js';

const META_API_BASE = 'https://graph.facebook.com';

/**
 * Servicio Oficial Meta Graph API v21.0:
 * Despacha mensajes salientes hacia WhatsApp Cloud API, Facebook Messenger e Instagram Direct.
 * Implementa la etiqueta HUMAN_AGENT (ventana de 7 días) y soporte de plantillas HSM para WhatsApp fuera de 24h.
 */
export const graphApiService = {
  /**
   * Envía un mensaje a través de Meta Graph API validando previamente la ventana de 24h / 7d.
   * 
   * @param {{
   *   channel: object,
   *   recipientId: string,
   *   text: string,
   *   lastCustomerInteraction?: Date|string|null,
   *   isHumanAgentTag?: boolean,
   *   mediaUrl?: string|null
   * }} params
   * @returns {Promise<{ metaMessageId: string }>}
   */
  async sendMessage({ channel, recipientId, text, lastCustomerInteraction = null, isHumanAgentTag = false, mediaUrl = null }) {
    const apiVersion = config.meta.apiVersion || 'v25.0';
    const accessToken = channel.accessToken;

    if (!accessToken) {
      throw new Error(`Canal ${channel.name} (#${channel.id}) no posee un access_token válido configurado.`);
    }

    // 0. Validación de Ventana de Mensajería (AppSec & Compliance de Meta)
    if (lastCustomerInteraction) {
      const windowStatus = timeUtil.checkMessagingWindow(lastCustomerInteraction, channel.platform);
      
      if (!windowStatus.canSendFreeText) {
        if (windowStatus.requiresTemplate) {
          const err = new Error('La ventana de 24 horas de WhatsApp ha expirado. Debe enviar una plantilla HSM aprobada.');
          err.code = 'ERR_WHATSAPP_24H_WINDOW_EXPIRED';
          throw err;
        }
        const err = new Error('La ventana de mensajería permitida por Meta ha expirado.');
        err.code = 'ERR_MESSAGING_WINDOW_EXPIRED';
        throw err;
      }

      // Si Messenger o Instagram están entre 24h y 7 días, activar automáticamente el tag oficial
      if (windowStatus.requiresHumanAgentTag) {
        isHumanAgentTag = true;
      }
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

      return this._postToMeta(url, accessToken, payload, channel, (data) => data.messages?.[0]?.id);
    }

    // 2. FACEBOOK MESSENGER
    if (channel.platform === 'facebook') {
      const url = `${META_API_BASE}/${apiVersion}/me/messages`;

      const payload = {
        recipient: { id: recipientId },
        message: { text }
      };

      if (isHumanAgentTag) {
        payload.messaging_type = 'MESSAGE_TAG';
        payload.tag = 'HUMAN_AGENT';
      } else {
        payload.messaging_type = 'RESPONSE';
      }

      return this._postToMeta(url, accessToken, payload, channel, (data) => data.message_id);
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

      return this._postToMeta(url, accessToken, payload, channel, (data) => data.message_id);
    }

    throw new Error(`Plataforma no compatible: ${channel.platform}`);
  },

  /**
   * Helper privado para peticiones HTTP a Meta con captura de errores de Graph API y revocación de tokens.
   * @private
   */
  async _postToMeta(url, accessToken, payload, channel, extractIdFn) {
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
        const errCode = errObj.code || response.status;
        const errMsg = errObj.message || `Error HTTP ${response.status} de Meta Graph API`;
        console.error('❌ [META GRAPH API ERROR]:', errObj);

        // Mitigación Error 190 (Token caducado o revocado)
        if (errCode === 190 && channel?.id) {
          console.warn(`🚨 [META AUTH ERROR 190] Token del canal #${channel.id} (${channel.name}) ha expirado.`);
          try {
            await channelRepository.updateStatus(channel.id, 'error', 'Token expirado o revocado en Meta (Error 190)');
            socketManager.emitChannelStatus(channel.id, 'error', 'Token expirado o revocado en Meta (Error 190)');
          } catch (dbErr) {
            console.error('Error actualizando estado del canal:', dbErr);
          }
        }

        const customErr = new Error(`[Meta Graph API Error ${errCode}] ${errMsg}`);
        customErr.code = `META_ERROR_${errCode}`;
        customErr.metaError = errObj;
        throw customErr;
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
