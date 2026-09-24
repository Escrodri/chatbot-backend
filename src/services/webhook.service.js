import { channelRepository, contactRepository, conversationRepository, messageRepository, logRepository } from '../repositories/index.js';
import { normalizerService } from './normalizer.service.js';
import { socketManager } from '../sockets/index.js';
import { botService } from './bot.service.js';
import { automationService, alAvisarAveria } from './automation.service.js';
import { mediaService } from './media.service.js';
import { graphApiService } from './graph-api.service.js';
import { pool } from '../database/pool.js';
import { detectarCampana } from './precio.service.js';

/**
 * Cuando n8n no contesta, que se note en la bandeja.
 *
 * El aviso se registra y se emite desde acá, pero lo dispara el propio
 * servicio de automatización en el momento en que la llamada falla.
 *
 * Antes esto se decidía mirando lo que devolvía `reenviarMensajeEntrante`, y
 * dejó de funcionar el día que se agregó la cola de espera: desde entonces esa
 * función ya no hace el POST a n8n —contesta "en cola" y el envío ocurre ocho
 * segundos más tarde—, así que ninguna avería llegaba nunca al que miraba. Con
 * n8n caído, el cliente escribía, nadie le contestaba, y la bandeja no decía
 * absolutamente nada: el silencio se veía igual que una conversación normal.
 */
alAvisarAveria(async (salida) => {
  try {
    const conv = salida.conversationId
      ? await conversationRepository.findById(salida.conversationId)
      : null;
    if (!conv) return;

    await logRepository.logEvent({
      platform: 'automation',
      channelIdentifier: String(conv.channel_id),
      eventType: 'automation_unreachable',
      rawPayload: {
        conversationId: conv.id,
        motivo: salida.motivo,
        detalle: salida.detalle
      },
      status: 'ERROR'
    });

    socketManager.emitAutomationAlert(conv.channel_id, {
      conversationId: conv.id,
      motivo: salida.motivo,
      mensaje: salida.mensaje,
      detalle: salida.detalle,
      en: salida.en
    });
  } catch (err) {
    console.warn('⚠️ [AUTOMATION] No se pudo registrar el aviso de avería:', err.message);
  }
});

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
      try {
        await logRepository.logEvent({
          platform: rawPayload.object || 'unknown',
          eventType: 'unrecognized_or_empty',
          rawPayload,
          status: 'IGNORED'
        });
      } catch (logErr) {
        console.warn('⚠️ [LOG REPOSITORY WARNING] No se pudo persistir log informativo:', logErr.message);
      }
      return;
    }

    for (const event of events) {
      try {
        await this._processSingleEvent(event, rawPayload);
      } catch (err) {
        console.error(`❌ [WEBHOOK PROCESS ERROR] Fallo procesando evento en canal ${event.channelIdentifier}:`, err.message);
        try {
          await logRepository.logEvent({
            platform: event.platform,
            channelIdentifier: event.channelIdentifier,
            eventType: event.eventType,
            rawPayload: { error: err.message, event },
            status: 'ERROR'
          });
        } catch (innerLogErr) {
          // No relanzar para mantener estabilidad del worker
        }
      }
    }
  },

  /**
   * Procesa un evento atómico normalizado.
   * @private
   */
  async _processSingleEvent(event, rawPayload) {
    // 1. Localizar el canal registrado en el sistema
    let channel = await channelRepository.findByIdentifier(event.channelIdentifier);

    // Fallback de resiliencia: Si no se encuentra activo, verificar si está archivado y reactivarlo
    if (!channel) {
      channel = await channelRepository.findAnyByIdentifier(event.channelIdentifier);
      if (channel) {
        console.log(`♻️ [WEBHOOK] Canal #${channel.id} (${channel.platform}) estaba archivado. Reactivando automáticamente...`);
        await pool.query(
          `UPDATE channels 
           SET deleted_at = NULL, 
               status = 'active', 
               team_id = COALESCE(team_id, 1),
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [channel.id]
        );
        channel.deleted_at = null;
        channel.status = 'active';
        channel.team_id = channel.team_id || 1;
      }
    }

    if (!channel) {
      console.warn(`⚠️ [WEBHOOK] Evento recibido para un canal no registrado: ${event.channelIdentifier} (${event.platform})`);
      try {
        await logRepository.logEvent({
          platform: event.platform,
          channelIdentifier: event.channelIdentifier,
          eventType: event.eventType,
          rawPayload,
          status: 'CHANNEL_NOT_FOUND'
        });
      } catch (logErr) {
        // Ignorar si la base de datos de logs no está disponible en este momento
      }
      return;
    }

    // Auto-sanar canales que no tengan equipo asignado tras la migración multi-tenant
    if (!channel.team_id) {
      console.log(`🔧 [WEBHOOK] Canal #${channel.id} no tenía team_id asignado. Asignando a equipo #1...`);
      await pool.query('UPDATE channels SET team_id = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [channel.id]);
      channel.team_id = 1;
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

    // 2.5. Referido suelto: la persona volvió desde un anuncio pero todavía no
    // escribió nada. Solo se guarda de dónde vino; no hay mensaje que registrar.
    if (event.eventType === 'referral') {
      try {
        const contacto = await contactRepository.findOrCreate({
          channelId: channel.id,
          platform: event.platform,
          platformUserId: event.sender.id,
          name: event.sender.name,
          nameIsPlaceholder: true
        });
        const conversacion = await conversationRepository.findOrCreateByContact(channel.id, contacto.id);
        await conversationRepository.saveAttribution(conversacion.id, event.attribution || {});
        if (event.accountId) await channelRepository.saveAccountId(channel.id, event.accountId);

        // Si el anuncio es de una campaña, el precio lo tiene que estar
        // esperando cuando escriba.
        await detectarCampana({ conversationId: conversacion.id, adId: event.attribution?.adId || null });

        console.log(
          `🎯 [ATRIBUCIÓN] Conversación #${conversacion.id} volvió desde el anuncio ` +
          `${event.attribution?.adId || '(sin id)'} (${event.platform}).`
        );
      } catch (refErr) {
        console.warn('⚠️ [ATRIBUCIÓN] No se pudo guardar el referido:', refErr.message);
      }
      return;
    }

    // 3. Manejar mensajes entrantes o ecos (message / echo)
    if (event.eventType === 'message' || event.eventType === 'echo') {
      let contactName = event.sender.name || `Contacto ${event.sender.id.slice(-4)}`;
      let contactAvatar = null;
      // En Facebook e Instagram el nombre no viene en el webhook: hay que pedirlo
      // aparte. Hasta lograrlo, el nombre es un relleno y así queda marcado.
      let nombreProvisional = event.platform === 'facebook' || event.platform === 'instagram';
      let phoneOrUsername = event.sender.phone || null;

      // Enriquecer perfil de usuario desde Meta Graph API para Facebook e Instagram
      const channelToken = channel.accessToken || channel.access_token;
      if ((event.platform === 'facebook' || event.platform === 'instagram') && channelToken && event.sender.id) {
        try {
          const profile = await graphApiService.fetchUserProfile({
            platform: event.platform,
            platformUserId: event.sender.id,
            accessToken: channelToken
          });
          if (profile?.name) {
            contactName = profile.name;
            nombreProvisional = false;
          }
          if (profile?.avatarUrl) contactAvatar = profile.avatarUrl;
          if (profile?.username) phoneOrUsername = `@${profile.username}`;
        } catch (profileErr) {
          console.warn(`⚠️ [USER PROFILE] No se pudo obtener perfil de ${event.platform} para ${event.sender.id}:`, profileErr.message);
        }
      }

      // A. Buscar o crear el contacto
      const contact = await contactRepository.findOrCreate({
        channelId: channel.id,
        platform: event.platform,
        platformUserId: event.sender.id,
        name: contactName,
        phoneOrUsername,
        avatarUrl: contactAvatar,
        nameIsPlaceholder: nombreProvisional
      });

      // B. Buscar o crear la conversación
      const conversation = await conversationRepository.findOrCreateByContact(channel.id, contact.id);

      // B.2. Guardar de dónde vino, si llegó desde un anuncio. Meta manda el
      // identificador del clic una sola vez, en este webhook: si no se guarda
      // ahora, la venta no se va a poder atribuir al anuncio nunca más.
      if (event.attribution) {
        try {
          await conversationRepository.saveAttribution(conversation.id, event.attribution);
          if (event.attribution.ctwaClid || event.attribution.adId) {
            console.log(
              `🎯 [ATRIBUCIÓN] Conversación #${conversation.id} viene del anuncio ` +
              `${event.attribution.adId || '(sin id)'} (${event.platform}).`
            );
          }
        } catch (attrErr) {
          console.warn('⚠️ [ATRIBUCIÓN] No se pudo guardar el origen de la conversación:', attrErr.message);
        }
      }

      // B.2.b. ¿Este mensaje la mete en una campaña de precio?
      //
      // Va acá, antes de pasarle el chat al guion, por una razón: el guion
      // pide el precio apenas recibe el mensaje, para armar la tarjeta del
      // producto. Si la oferta se anotara después, quien vuelve desde el
      // anuncio de 15 mil vería 19 mil en su primera respuesta.
      //
      // El anuncio de origen de la conversación no sirve para esto: se guarda
      // solo el primero, y el remarketing es justamente alguien que vuelve por
      // un anuncio distinto. Se mira el de ESTE mensaje.
      if (event.eventType === 'message' && !event.isEcho) {
        await detectarCampana({
          conversationId: conversation.id,
          adId: event.attribution?.adId || null,
          texto: event.message?.text || ''
        });
      }

      // B.3. Identificador de la cuenta (la de WhatsApp Business, o la página).
      // No lo sabemos al conectar el canal, pero viene en cada webhook y hace
      // falta para informarle las ventas a Meta.
      if (event.accountId) {
        try {
          await channelRepository.saveAccountId(channel.id, event.accountId);
        } catch (accErr) {
          console.warn('⚠️ [CANAL] No se pudo guardar el identificador de la cuenta:', accErr.message);
        }
      }

      // C. Si es un eco (el operador respondió desde WhatsApp Business móvil o Meta Business Suite):
      // Pausar inmediatamente el bot (Protocolo Handover: handed_over)
      if (event.isEcho) {
        await conversationRepository.updateBotStatus(conversation.id, 'handed_over');
        socketManager.emitBotStatus(channel.id, conversation.id, 'handed_over');
        console.log(`🤖 [HANDOVER] Bot pausado automáticamente para conversación #${conversation.id} por eco de operador.`);
      }

      // D. Descargar archivo multimedia si el mensaje contiene mediaId o mediaDirectUrl
      let localMediaUrl = event.message.mediaUrl || null;
      const token = channel.accessToken || channel.access_token;
      if ((event.message.mediaId || event.message.mediaDirectUrl) && token) {
        try {
          const mediaResult = await mediaService.downloadMedia({
            mediaId: event.message.mediaId,
            accessToken: token,
            directUrl: event.message.mediaDirectUrl,
            mimeType: event.message.mimeType
          });
          // Copia en el almacenamiento externo, si está configurado, para que la
          // foto siga viéndose después de un despliegue.
          const respaldado = await mediaService.respaldar(mediaResult);
          if (respaldado?.localUrl) {
            localMediaUrl = respaldado.localUrl;
          }
        } catch (mediaErr) {
          console.warn(`⚠️ [MEDIA DOWNLOAD ERROR] No se pudo descargar medio ${event.message.mediaId}:`, mediaErr.message);
        }
      }

      // E. Insertar el mensaje con deduplicación estricta y mediaUrl resuelta
      const insertedMessage = await messageRepository.insertMessage({
        conversationId: conversation.id,
        channelId: channel.id,
        metaMessageId: event.message.id,
        direction: event.message.direction,
        senderType: event.message.senderType,
        contentType: event.message.type,
        text: event.message.text,
        mediaUrl: localMediaUrl,
        // Guardamos el identificador del archivo en Meta para poder volver a
        // pedírselo si la copia local desaparece (disco efímero del hosting).
        metaMediaId: event.message.mediaId || null,
        mediaMime: event.message.mimeType || null,
        status: 'delivered',
        timestamp: event.message.timestamp,
        isViewOnce: Boolean(event.message.isViewOnce)
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

      // F. Si es entrante del cliente, actualizar ventana de 24h y evaluar chatbot
      if (!event.isEcho && event.message.direction === 'inbound') {
        await conversationRepository.touchCustomerInteraction(
          conversation.id,
          event.message.text,
          event.message.timestamp
        );

        // Quién contesta depende de AUTOMATION_ENABLED:
        //
        //  - Con la automatización encendida manda n8n. Se le reenvía el mensaje
        //    y él decide qué responder; el saludo interno se calla para que los
        //    dos no hablen encima.
        //  - Apagada, sigue el bot de bienvenida de siempre.
        //
        // El reenvío va con await pero nunca propaga: si n8n está caído, el
        // mensaje del cliente ya quedó guardado y la bandeja lo muestra igual.
        // Qué botón tocó, si tocó uno. No se guarda en la base porque en la
        // bandeja alcanza con el texto del botón; esto viaja solo hasta el
        // guion, que lo usa para rutear sin tener que adivinar a partir de
        // cómo esté redactado el botón hoy.
        insertedMessage.boton_id = event.message.botonId || null;

        if (automationService.estaActiva()) {
          try {
            // El aviso de avería ya no se decide con lo que devuelve esta
            // llamada: lo dispara el propio servicio en el momento en que la
            // llamada a n8n falla, que con la cola de espera ocurre segundos
            // después de que esto haya terminado. Ver `alAvisarAveria`, arriba.
            await automationService.reenviarMensajeEntrante({
              conversation,
              contact,
              channel,
              message: insertedMessage
            });
          } catch (autoErr) {
            console.error(`❌ [AUTOMATION ERROR] Error al reenviar a n8n:`, autoErr);
          }
        } else {
          try {
            await botService.handleInboundMessage({
              channel,
              contact,
              conversation,
              inboundText: event.message.text
            });
          } catch (botErr) {
            console.error(`❌ [BOT SERVICE ERROR] Error al procesar respuesta automática:`, botErr);
          }
        }
      } else if (event.isEcho) {
        await conversationRepository.updateOutboundMessage(
          conversation.id,
          event.message.text
        );
      }

      // G. Notificar a los navegadores conectados en tiempo real vía WebSocket
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

      // H. Registrar auditoría
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
