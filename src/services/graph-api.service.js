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
  async sendMessage({ channel, recipientId, text, lastCustomerInteraction = null, isHumanAgentTag = false, mediaUrl = null, contentType = 'text', fileName = null }) {
    const apiVersion = config.meta.apiVersion || 'v26.0';
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

    function resolveFullMediaUrl(mediaUrl) {
      if (!mediaUrl) return '';
      if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
      const baseUrl = (process.env.BACKEND_PUBLIC_URL || (config.isProd ? 'https://chatbot-backend-aq9n.onrender.com' : 'http://localhost:3000')).replace(/\/+$/, '');
      return `${baseUrl}${mediaUrl.startsWith('/') ? mediaUrl : `/${mediaUrl}`}`;
    }

    // 1. WHATSAPP CLOUD API
    if (channel.platform === 'whatsapp') {
      const url = `${META_API_BASE}/${apiVersion}/${channel.channel_identifier}/messages`;
      let payload;

      if (mediaUrl) {
        const fullMediaUrl = resolveFullMediaUrl(mediaUrl);
        const type = ['image', 'audio', 'video', 'document'].includes(contentType) ? contentType : 'document';
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipientId,
          type,
          [type]: {
            link: fullMediaUrl,
            ...(type === 'document' && fileName ? { filename: fileName } : {}),
            ...(type !== 'audio' && text ? { caption: text } : {})
          }
        };
      } else {
        payload = {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipientId,
          type: 'text',
          text: { preview_url: false, body: text }
        };
      }

      return this._postToMeta(url, accessToken, payload, channel, (data) => data.messages?.[0]?.id);
    }

    // 2. FACEBOOK MESSENGER
    if (channel.platform === 'facebook') {
      const url = `${META_API_BASE}/${apiVersion}/me/messages`;
      let messagePayload;

      if (mediaUrl) {
        const fullMediaUrl = resolveFullMediaUrl(mediaUrl);
        const attachmentType = contentType === 'document' ? 'file' : (['image', 'audio', 'video'].includes(contentType) ? contentType : 'file');
        messagePayload = {
          attachment: {
            type: attachmentType,
            payload: {
              url: fullMediaUrl,
              is_reusable: true
            }
          }
        };
      } else {
        messagePayload = { text };
      }

      const payload = {
        recipient: { id: recipientId },
        message: messagePayload
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
      let messagePayload;

      if (mediaUrl) {
        const fullMediaUrl = resolveFullMediaUrl(mediaUrl);
        messagePayload = {
          attachment: {
            type: 'image',
            payload: {
              url: fullMediaUrl
            }
          }
        };
      } else {
        messagePayload = { text };
      }

      const payload = {
        recipient: { id: recipientId },
        message: messagePayload
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

      // Si el canal tenía un error previo, limpiarlo porque el envío fue exitoso
      if (channel?.id) {
        try {
          await channelRepository.updateStatus(channel.id, 'active', null);
          socketManager.emitChannelStatus(channel.id, 'active', null);
        } catch (clearErr) {
          // No bloqueante
        }
      }

      return { metaMessageId, rawResponse: data };
    } catch (err) {
      console.error(`💥 [GRAPH API NETWORK FAILURE] ${url}:`, err.message);
      throw err;
    }
  }
};

export default graphApiService;
