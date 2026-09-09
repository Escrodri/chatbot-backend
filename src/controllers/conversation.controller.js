import { conversationRepository } from '../repositories/conversation.repository.js';
import { messageRepository } from '../repositories/message.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { graphApiService } from '../services/graph-api.service.js';
import { timeUtil } from '../utils/index.js';
import { socketManager } from '../sockets/index.js';
import { mediaService } from '../services/media.service.js';

export const conversationController = {
  /**
   * Lista conversaciones con filtros, búsqueda y aislamiento IDOR.
   */
  async list(req, res) {
    try {
      const { platform, channel_id, search, limit = 50, offset = 0 } = req.query;

      let assignedChannelIds = null;
      // Control de acceso IDOR: operadores estándar solo ven sus canales
      if (req.user.role === 'agent') {
        assignedChannelIds = await userRepository.getAssignedChannelIds(req.user.id);
      }

      const conversations = await conversationRepository.listWithFilters({
        platform: platform || null,
        channelId: channel_id ? parseInt(channel_id, 10) : null,
        search: search || null,
        assignedChannelIds,
        limit: Math.min(parseInt(limit, 10) || 50, 100),
        offset: parseInt(offset, 10) || 0
      });

      // Añadir cálculo en vivo de ventana de mensajería (24h/7d)
      const mapped = conversations.map(conv => ({
        ...conv,
        window_status: timeUtil.checkMessagingWindow(conv.last_customer_interaction, conv.platform)
      }));

      return res.json(mapped);
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar conversaciones: ' + error.message });
    }
  },

  /**
   * Obtiene los detalles de una conversación por su ID.
   */
  async getById(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Verificación IDOR
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (!assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      conv.window_status = timeUtil.checkMessagingWindow(conv.last_customer_interaction, conv.platform);
      return res.json(conv);
    } catch (error) {
      return res.status(500).json({ error: 'Error al consultar conversación: ' + error.message });
    }
  },

  /**
   * Obtiene el historial de mensajes con paginación por cursor (Keyset Pagination) y resetea no leídos.
   */
  async getMessages(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Verificación IDOR
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (!assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      const beforeId = req.query.before_id ? parseInt(req.query.before_id, 10) : null;
      const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);

      // Keyset pagination: solicitamos limit + 1 para saber si hay más registros anteriores
      const fetched = await messageRepository.getHistoryKeyset(id, beforeId, limit + 1);
      const hasMore = fetched.length > limit;
      const messages = hasMore ? fetched.slice(fetched.length - limit) : fetched;

      // Reseteo atómico de mensajes no leídos al abrir el chat
      if (conv.unread_count > 0 && !beforeId) {
        await conversationRepository.resetUnreadCount(id);
        socketManager.emitMessageStatusUpdated(conv.channel_id, {
          conversationId: id,
          status: 'read'
        });
      }

      return res.json({
        conversation_id: id,
        messages,
        has_more: hasMore
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al obtener mensajes: ' + error.message });
    }
  },

  /**
   * Envía un mensaje como operador humano, aplica Protocolo Handover y despacha a Meta.
   */
  async sendMessage(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const { text, fileBase64, fileName, mimeType } = req.body;

      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      if ((!text || !text.trim()) && !fileBase64) {
        return res.status(400).json({ error: 'El mensaje debe contener texto o un archivo adjunto' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Verificación IDOR
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (!assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      // 0. Si se adjuntó un archivo, procesarlo y guardarlo
      let savedMedia = null;
      if (fileBase64) {
        try {
          savedMedia = mediaService.saveBase64Media({ fileBase64, fileName, mimeType });
        } catch (mediaErr) {
          return res.status(400).json({ error: 'Error al procesar archivo adjunto: ' + mediaErr.message });
        }
      }

      const contentType = savedMedia ? savedMedia.contentType : 'text';
      const mediaUrl = savedMedia ? savedMedia.localUrl : null;
      const messageText = (text || (savedMedia ? `[Archivo: ${savedMedia.fileName}]` : '')).trim();

      // 1. Persistir mensaje en base de datos
      const inserted = await messageRepository.insertMessage({
        conversationId: conv.id,
        channelId: conv.channel_id,
        direction: 'outbound',
        senderType: 'agent',
        senderUserId: req.user.id,
        contentType,
        text: messageText,
        mediaUrl,
        status: 'pending'
      });

      // 2. Protocolo Handover: Pausar el bot para este chat
      await conversationRepository.updateBotStatus(conv.id, 'handed_over', req.user.id);
      await conversationRepository.updateOutboundMessage(conv.id, messageText);

      // 3. Despacho hacia Meta Graph API.
      let metaMessageId = null;
      let sendError = null;

      const fullChannel = await channelRepository.findById(conv.channel_id);

      if (!fullChannel) {
        sendError = {
          code: 'ERR_CHANNEL_NOT_FOUND',
          message: 'El canal de este chat ya no existe. Volvé a conectarlo en Configuración.'
        };
      } else if (!fullChannel.accessToken) {
        sendError = {
          code: 'ERR_NO_ACCESS_TOKEN',
          message: `El canal "${fullChannel.name}" no tiene token de Meta configurado, así que el mensaje no salió.`
        };
      } else {
        try {
          const sendResult = await graphApiService.sendMessage({
            channel: fullChannel,
            recipientId: conv.platform_user_id || conv.contact_phone,
            text: (text || '').trim(),
            mediaUrl,
            contentType,
            fileName: savedMedia?.fileName,
            lastCustomerInteraction: conv.last_customer_interaction
          });
          metaMessageId = sendResult?.metaMessageId || null;

          if (!metaMessageId) {
            sendError = {
              code: 'ERR_NO_META_ID',
              message: 'Meta aceptó la petición pero no devolvió un identificador de mensaje.'
            };
          }
        } catch (graphErr) {
          console.error('❌ [ENVÍO FALLIDO] No se pudo entregar el mensaje a Meta:', graphErr.message);
          sendError = {
            code: graphErr.code || 'ERR_META_SEND_FAILED',
            message: graphErr.message || 'No se pudo entregar el mensaje a Meta.'
          };
        }
      }

      // 4. Reflejar en la base de datos lo que pasó de verdad
      if (sendError) {
        const fallido = await messageRepository.markFailed(inserted.id, sendError);
        if (fallido) Object.assign(inserted, fallido);
        inserted.status = 'failed';
        inserted.error_details = sendError;
      } else {
        await messageRepository.updateStatus(inserted.id, 'sent', metaMessageId);
        inserted.meta_message_id = metaMessageId;
        inserted.status = 'sent';
      }

      // 5. Emitir eventos por WebSocket en tiempo real
      socketManager.emitMessageSent(conv.channel_id, inserted);
      socketManager.emitConversationUpdated(conv.channel_id, {
        id: conv.id,
        last_message_text: text.trim(),
        last_message_time: new Date(),
        bot_status: 'handed_over'
      });

      return res.status(201).json({
        success: true,
        delivered: !sendError,
        message: inserted,
        error: sendError || undefined
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al enviar mensaje: ' + error.message });
    }
  },

  /**
   * Conmuta el estado del bot (Protocolo Handover: active / handed_over / disabled).
   */
  async toggleBot(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const { botStatus } = req.body;

      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      if (!['active', 'handed_over', 'disabled'].includes(botStatus)) {
        return res.status(400).json({ error: 'botStatus inválido. Debe ser active, handed_over o disabled' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      await conversationRepository.updateBotStatus(id, botStatus, req.user.id);

      socketManager.emitConversationUpdated(conv.channel_id, {
        id,
        bot_status: botStatus
      });

      return res.json({ success: true, botStatus });
    } catch (error) {
      return res.status(500).json({ error: 'Error al cambiar estado del bot: ' + error.message });
    }
  }
};

export default conversationController;
