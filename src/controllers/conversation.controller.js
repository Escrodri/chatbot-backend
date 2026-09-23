import { conversationRepository } from '../repositories/conversation.repository.js';
import { messageRepository } from '../repositories/message.repository.js';
import { channelRepository } from '../repositories/channel.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { contactRepository } from '../repositories/contact.repository.js';
import { graphApiService } from '../services/graph-api.service.js';
import { timeUtil } from '../utils/index.js';
import { socketManager } from '../sockets/index.js';
import { mediaService } from '../services/media.service.js';
import { conversionsService } from '../services/conversions.service.js';
import { conversionRepository } from '../repositories/conversion.repository.js';
import { automationService } from '../services/automation.service.js';
import { esTelefonoDePrueba } from '../config/env.config.js';

export const conversationController = {
  /**
   * Lista conversaciones con filtros, búsqueda y aislamiento IDOR.
   */
  async list(req, res) {
    try {
      const { platform, channel_id, search, limit = 50, offset = 0 } = req.query;

      let assignedChannelIds = null;
      // Control de acceso IDOR: operadores estándar ven sus canales asignados (o todos los de su equipo si no hay restricción explícita)
      if (req.user.role === 'agent') {
        const ids = await userRepository.getAssignedChannelIds(req.user.id);
        if (ids && ids.length > 0) {
          assignedChannelIds = ids;
        }
      }

      const teamId = req.user.role === 'superadmin' ? null : (req.user.team_id || null);

      const conversations = await conversationRepository.listWithFilters({
        teamId,
        platform: platform || null,
        channelId: channel_id ? parseInt(channel_id, 10) : null,
        search: search || null,
        assignedChannelIds,
        limit: Math.min(parseInt(limit, 10) || 50, 100),
        offset: parseInt(offset, 10) || 0
      });

      // Completar foto y nombre real de los contactos de Facebook e Instagram
      // que todavía no los tienen.
      //
      // Esto vive dentro del listado, y el listado se pide cada cinco segundos
      // por cada asesor con la bandeja abierta. Sin freno, un contacto sin foto
      // —que en Instagram es lo normal— generaba una llamada a Meta cada cinco
      // segundos para siempre, porque el fallo no se recordaba en ningún lado.
      // Con cinco por tanda y cinco asesores eran trescientas llamadas por
      // minuto: Meta corta mucho antes de eso, y cuando corta deja de andar
      // también lo que sí importa.
      //
      // Ahora cada contacto se intenta como mucho tres veces, y nunca dos
      // veces dentro de las mismas seis horas.
      const AHORA = Date.now();
      const ESPERA_MS = 6 * 60 * 60 * 1000;
      const MAX_INTENTOS = 3;

      const enrichTargets = conversations.filter(c =>
        (c.platform === 'facebook' || c.platform === 'instagram') &&
        (!c.contact_avatar || /^Usuario\s+\d+$/i.test(c.contact_name || '')) &&
        c.platform_user_id &&
        (c.perfil_intentos || 0) < MAX_INTENTOS &&
        (!c.perfil_ultimo_intento || (AHORA - new Date(c.perfil_ultimo_intento).getTime()) > ESPERA_MS)
      ).slice(0, 2);

      if (enrichTargets.length > 0) {
        await Promise.allSettled(
          enrichTargets.map(async (c) => {
            try {
              // Se anota el intento antes de hacerlo: si se anotara solo al
              // salir bien, el que falla siempre se reintenta siempre.
              await contactRepository.marcarIntentoPerfil(c.contact_id);

              const fullChannel = await channelRepository.findById(c.channel_id);
              if (!fullChannel?.accessToken) return;
              const profile = await graphApiService.fetchUserProfile({
                platform: c.platform,
                platformUserId: c.platform_user_id,
                accessToken: fullChannel.accessToken
              });
              if (profile) {
                await contactRepository.updateProfile(c.contact_id, {
                  name: profile.name,
                  phoneOrUsername: profile.username ? `@${profile.username}` : null,
                  avatarUrl: profile.avatarUrl
                });
                if (profile.name) c.contact_name = profile.name;
                if (profile.avatarUrl) c.contact_avatar = profile.avatarUrl;
                if (profile.username) c.contact_phone = `@${profile.username}`;
              }
            } catch (err) {
              // No bloqueante
            }
          })
        );
      }

      // Añadir cálculo en vivo de ventana de mensajería (24h/7d)
      const mapped = conversations.map(conv => ({
        ...conv,
        window_status: timeUtil.checkMessagingWindow(conv.last_customer_interaction, conv.platform),
        // Marca los chats con los que se prueba el flujo. Es lo único que
        // decide si aparece el botón de reiniciar, que borra mensajes y
        // pedidos: en un chat de un cliente real ese botón no debe existir.
        es_prueba: esTelefonoDePrueba(conv.contact_phone)
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

      // Auto-enriquecer si falta foto o nombre. Con el mismo freno que el
      // listado: tres intentos como máximo, y nunca dos dentro de seis horas.
      const puedeIntentar = (conv.perfil_intentos || 0) < 3 &&
        (!conv.perfil_ultimo_intento ||
          (Date.now() - new Date(conv.perfil_ultimo_intento).getTime()) > 6 * 60 * 60 * 1000);

      if (
        (conv.platform === 'facebook' || conv.platform === 'instagram') &&
        (!conv.contact_avatar || /^Usuario\s+\d+$/i.test(conv.contact_name || '')) &&
        conv.platform_user_id &&
        puedeIntentar
      ) {
        try {
          await contactRepository.marcarIntentoPerfil(conv.contact_id);
          const fullChannel = await channelRepository.findById(conv.channel_id);
          if (fullChannel?.accessToken) {
            const profile = await graphApiService.fetchUserProfile({
              platform: conv.platform,
              platformUserId: conv.platform_user_id,
              accessToken: fullChannel.accessToken
            });
            if (profile) {
              await contactRepository.updateProfile(conv.contact_id, {
                name: profile.name,
                phoneOrUsername: profile.username ? `@${profile.username}` : null,
                avatarUrl: profile.avatarUrl
              });
              if (profile.name) conv.contact_name = profile.name;
              if (profile.avatarUrl) conv.contact_avatar = profile.avatarUrl;
              if (profile.username) conv.contact_phone = `@${profile.username}`;
            }
          }
        } catch (err) {
          // No bloqueante
        }
      }

      // Verificación IDOR
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (!assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      conv.window_status = timeUtil.checkMessagingWindow(conv.last_customer_interaction, conv.platform);
      conv.es_prueba = esTelefonoDePrueba(conv.contact_phone);
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
        if (assigned.length > 0 && !assigned.includes(conv.channel_id)) {
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
      // `buttons` son las opciones que se le muestran al cliente para que
      // conteste tocando en vez de escribiendo. Las manda el guion; un asesor
      // escribiendo a mano no las usa. Llegan como [{id, title}].
      // `media_url` es una imagen que ya vive en una dirección pública, como la
      // portada de un producto. Se usa para el encabezado del mensaje con
      // botones: mandar la misma imagen subiéndola de nuevo en base64 obligaba
      // a bajarla y volver a subirla en cada conversación, y para una portada
      // que no cambia nunca eso es trabajo repetido sin ninguna ganancia.
      const { text, fileBase64, fileName, mimeType, view_once, buttons, media_url } = req.body;

      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      if ((!text || !text.trim()) && !fileBase64 && !/^https?:\/\//i.test(String(media_url || ''))) {
        return res.status(400).json({ error: 'El mensaje debe contener texto o un archivo adjunto' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Verificación IDOR
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (assigned.length > 0 && !assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      // 0. Si se adjuntó un archivo, procesarlo y guardarlo
      let savedMedia = null;
      if (fileBase64) {
        try {
          savedMedia = await mediaService.saveBase64Media({ fileBase64, fileName, mimeType });
        } catch (mediaErr) {
          return res.status(400).json({ error: 'Error al procesar archivo adjunto: ' + mediaErr.message });
        }
      }

      // Copia en el almacenamiento externo, si está configurado: así el archivo
      // sobrevive a los despliegues y Meta puede descargarlo por una dirección
      // pública y estable en vez de por el disco efímero del servidor.
      if (savedMedia) {
        savedMedia = await mediaService.respaldar(savedMedia);
      }

      // Una imagen que ya está publicada en otro lado —la portada del producto,
      // una página de muestra— se usa tal cual.
      //
      // Se exige dirección absoluta: Meta la descarga desde sus servidores, y
      // una ruta relativa que no pueda resolver tumba el mensaje entero en vez
      // de mandarlo sin foto.
      const portadaExterna = (!savedMedia && /^https?:\/\//i.test(String(media_url || '')))
        ? String(media_url)
        : null;

      const contentType = savedMedia ? savedMedia.contentType : (portadaExterna ? 'image' : 'text');
      const mediaUrl = savedMedia ? savedMedia.localUrl : portadaExterna;
      const defaultMediaText = savedMedia ? (savedMedia.contentType === 'audio' ? '🎵 [Nota de voz / Audio]' : `[Archivo: ${savedMedia.fileName}]`) : '';
      const messageText = (text || defaultMediaText).trim();

      // Por esta misma ruta entran dos remitentes muy distintos: un asesor con
      // sesión, y el bot de n8n con token de servicio. Se distinguen porque el
      // middleware marca al segundo con role 'service'.
      const esBot = req.user?.role === 'service';

      // 1. Persistir mensaje en base de datos
      const inserted = await messageRepository.insertMessage({
        conversationId: conv.id,
        channelId: conv.channel_id,
        direction: 'outbound',
        senderType: esBot ? 'bot' : 'agent',
        senderUserId: esBot ? null : req.user.id,
        contentType,
        text: messageText,
        mediaUrl,
        mediaMime: savedMedia ? (savedMedia.mimeType || (contentType === 'image' ? 'image/jpeg' : null)) : null,
        status: 'pending',
        viewOnce: view_once && contentType === 'image'
      });
      inserted.sender_user_name = esBot ? 'Asistente' : (req.user.name || 'Operador');

      // 2. Protocolo Handover: que una PERSONA escriba significa que tomó el
      //    chat, y el bot se calla. Que escriba el bot no significa nada de eso:
      //    si acá también se marcara handed_over, el bot se apagaría a sí mismo
      //    con su primera respuesta y no volvería a contestar nunca.
      if (!esBot) {
        await conversationRepository.updateBotStatus(conv.id, 'handed_over', req.user.id);

        // Y se tira la respuesta que el bot tuviera a medio cocinar. Marcar el
        // handover no alcanza: el temporizador del agrupador ya está corriendo
        // con una copia vieja de la conversación, donde el bot todavía manda.
        // Si no se corta acá, el asesor contesta y ocho segundos después el bot
        // contesta otra cosa encima, al mismo cliente y sobre el mismo tema.
        const enEspera = automationService.cancelarCola(conv.id);
        if (enEspera > 0) {
          console.info(
            `🤖 [HANDOVER] Conversación #${conv.id}: se descartaron ${enEspera} mensaje(s) en cola ` +
            'porque contestó una persona.'
          );
        }
      }
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
            localFilePath: savedMedia?.filePath,
            mimeType: savedMedia?.mimeType,
            lastCustomerInteraction: conv.last_customer_interaction,
            viewOnce: view_once && contentType === 'image',
            buttons
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
        last_message_text: messageText,
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
   * Reintenta el envío de un mensaje que Meta rechazó.
   *
   * Vuelve a despachar el mensaje que ya está guardado, con su adjunto incluido.
   * Antes el botón "Reintentar" del chat mandaba un mensaje nuevo con solo el
   * texto, así que el archivo se perdía y llegaba únicamente su nombre.
   */
  async retryMessage(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      const messageId = parseInt(req.params.messageId, 10);

      if (isNaN(id) || isNaN(messageId)) {
        return res.status(400).json({ error: 'Identificadores inválidos' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Verificación IDOR: un operador solo actúa sobre sus canales.
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (assigned.length > 0 && !assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      const mensaje = await messageRepository.findByIdWithChannel(messageId);
      if (!mensaje || mensaje.conversation_id !== conv.id) {
        return res.status(404).json({ error: 'Mensaje no encontrado en esta conversación' });
      }

      if (mensaje.direction !== 'outbound') {
        return res.status(400).json({ error: 'Solo se pueden reintentar mensajes salientes' });
      }

      if (mensaje.status !== 'failed') {
        return res.status(409).json({ error: 'Este mensaje no está marcado como fallido' });
      }

      const fullChannel = await channelRepository.findById(conv.channel_id);
      if (!fullChannel?.accessToken) {
        return res.status(409).json({
          error: 'El canal de este chat no tiene un token de Meta válido. Volvé a conectarlo en Configuración.',
          code: 'ERR_NO_ACCESS_TOKEN'
        });
      }

      // El texto guardado puede ser el marcador "[Archivo: nombre]" que pusimos
      // nosotros; en ese caso no es un pie de foto real y no se reenvía como texto.
      const marcador = /^\[Archivo:\s*(.+)\]$/.exec((mensaje.text || '').trim());
      const nombreArchivo = marcador ? marcador[1].trim() : null;
      const textoReal = marcador ? '' : (mensaje.text || '');

      let metaMessageId = null;
      let sendError = null;

      try {
        const sendResult = await graphApiService.sendMessage({
          channel: fullChannel,
          recipientId: conv.platform_user_id || conv.contact_phone,
          text: textoReal,
          mediaUrl: mensaje.media_url || null,
          contentType: mensaje.content_type || 'text',
          fileName: nombreArchivo,
          lastCustomerInteraction: conv.last_customer_interaction,
          viewOnce: mensaje.view_once || false
        });
        metaMessageId = sendResult?.metaMessageId || null;

        if (!metaMessageId) {
          sendError = {
            code: 'ERR_NO_META_ID',
            message: 'Meta aceptó la petición pero no devolvió un identificador de mensaje.'
          };
        }
      } catch (graphErr) {
        console.error('❌ [REINTENTO FALLIDO]', graphErr.message);
        sendError = {
          code: graphErr.code || 'ERR_META_SEND_FAILED',
          message: graphErr.message || 'No se pudo entregar el mensaje a Meta.'
        };
      }

      if (sendError) {
        await messageRepository.markFailed(messageId, sendError);
        return res.status(200).json({ success: true, delivered: false, error: sendError });
      }

      await messageRepository.updateStatus(messageId, 'sent', metaMessageId);
      socketManager.emitMessageStatus(conv.channel_id, metaMessageId, 'sent');

      return res.json({
        success: true,
        delivered: true,
        message: { ...mensaje, status: 'sent', meta_message_id: metaMessageId, error_details: null }
      });
    } catch (error) {
      return res.status(500).json({ error: 'Error al reintentar el envío: ' + error.message });
    }
  },

  /**
   * Marca que una conversación terminó en venta y se lo informa a Meta.
   *
   * La venta queda registrada en la base pase lo que pase. Que Meta la acepte o
   * no es un segundo paso, y su resultado se guarda junto al registro: perder
   * el dato de una venta porque falló una llamada a una API sería mucho peor
   * que no poder atribuirla.
   *
   * POST /api/conversations/:id/sale
   */
  async registerSale(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      const { value = null, currency = 'PYG', note = null, product = null, eventName = 'Purchase' } = req.body || {};

      // El monto es opcional, pero si viene tiene que ser un número válido.
      let monto = null;
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        monto = Number(value);
        if (!Number.isFinite(monto) || monto < 0) {
          return res.status(400).json({ error: 'El monto de la venta no es un número válido.' });
        }
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Verificación IDOR: un operador solo actúa sobre sus canales.
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (assigned.length > 0 && !assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      // 1. Registrar la venta antes de hablar con Meta.
      const eventId = conversionsService.generarEventId();
      const registro = await conversionRepository.create({
        conversationId: conv.id,
        channelId: conv.channel_id,
        registeredBy: req.user.id,
        eventName,
        eventId,
        value: monto,
        currency: monto !== null ? currency : null,
        note: note ? String(note).trim().slice(0, 500) : null,
        product: product ? String(product).trim().slice(0, 200) : null
      });

      // 2. Informarla a Meta. El canal puede tener su propio conjunto de datos
      // y su propio token, cargados desde Configuración.
      const canalCompleto = await channelRepository.findById(conv.channel_id);
      const resultado = await conversionsService.informarVenta({
        conversation: conv,
        canal: canalCompleto,
        eventName,
        value: monto,
        currency: monto !== null ? currency : null,
        product: product ? String(product).trim().slice(0, 200) : null,
        eventId
      });

      const estado = resultado.ok ? 'sent' : (resultado.skipped ? 'skipped' : 'failed');
      const actualizado = await conversionRepository.updateStatus(
        registro.id,
        estado,
        resultado.ok ? null : { code: resultado.code, message: resultado.error }
      );

      return res.status(201).json({
        success: true,
        reported: resultado.ok,
        sale: actualizado || registro,
        warning: resultado.ok ? undefined : { code: resultado.code, message: resultado.error }
      });
    } catch (error) {
      // El identificador de evento es único: si alguien hace doble clic, la
      // segunda inserción choca y la venta no se cuenta dos veces.
      if (error?.code === '23505') {
        return res.status(409).json({ error: 'Esa venta ya fue registrada.' });
      }
      return res.status(500).json({ error: 'Error al registrar la venta: ' + error.message });
    }
  },

  /**
   * Ventas ya registradas en una conversación.
   * GET /api/conversations/:id/sales
   */
  async listSales(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (assigned.length > 0 && !assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      const ventas = await conversionRepository.listByConversation(id);
      return res.json({ success: true, sales: ventas });
    } catch (error) {
      return res.status(500).json({ error: 'Error al listar las ventas: ' + error.message });
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
  },

  /**
   * Deja una conversación de prueba en cero para volver a correr el flujo.
   *
   * Probar un guion de venta de punta a punta exige empezar siempre igual: el
   * bot tiene que creer que nunca habló con esa persona. Y eso no se consigue
   * borrando el chat del teléfono, porque lo que el guion consulta es el
   * pedido guardado acá. Mientras el pedido exista, el bot contesta como si la
   * charla viniera de antes y lo que se prueba no es el flujo real.
   *
   * Solo funciona con los números declarados como de prueba, y se verifica
   * acá y no en la pantalla: una dirección que borra mensajes y pedidos no
   * puede quedar abierta porque el botón no se vea.
   *
   * POST /api/conversations/:id/reset
   */
  async reiniciarPrueba(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Mismo aislamiento que el resto de la bandeja: un operador no puede
      // tocar un canal que no tiene asignado.
      if (req.user.role === 'agent') {
        const assigned = await userRepository.getAssignedChannelIds(req.user.id);
        if (!assigned.includes(conv.channel_id)) {
          return res.status(403).json({ error: 'Acceso no autorizado a este canal' });
        }
      }

      if (!esTelefonoDePrueba(conv.contact_phone)) {
        return res.status(403).json({
          error: 'Esta conversación no es de prueba. Reiniciar borra los mensajes y el pedido, así que solo se permite en los números cargados en TEST_PHONES.'
        });
      }

      // Antes de borrar, cortar lo que esté esperando en la cola de respuesta:
      // si no, el despacho pendiente sale igual unos segundos después y
      // contesta sobre un chat que ya no existe.
      const enEspera = automationService.cancelarCola(id);

      const borrado = await conversationRepository.reiniciarParaPrueba(id);

      socketManager.emitConversationUpdated(conv.channel_id, {
        id,
        last_message_text: null,
        last_message_time: null,
        unread_count: 0,
        bot_status: 'active',
        order_status: null,
        order_id: null
      });

      return res.json({ success: true, ...borrado, enEspera });
    } catch (error) {
      return res.status(500).json({ error: 'Error al reiniciar la conversación: ' + error.message });
    }
  },

  /**
   * Marca que esta persona se enojó, o nos trató de estafadores.
   *
   * Lo llama el guion cuando reconoce un insulto o una acusación. No cambia el
   * estado del bot a propósito: el guion le contesta igual, y contestarle bien
   * es lo único que puede dar vuelta un chat así. Callarse y pasárselo a
   * alguien que va a tardar horas en mirarlo es lo que convierte un enojo en
   * una reseña.
   *
   * Lo que sí hace son dos cosas que en el momento no se ven: deja el chat
   * marcado en la bandeja, y lo saca para siempre de la recuperación de
   * abandonos. Un seguimiento automático dos horas después de un insulto no
   * recupera a nadie; confirma lo que la persona acaba de decir.
   *
   * POST /api/conversations/:id/molesto
   */
  async marcarMolesto(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID de conversación inválido' });

      const conv = await conversationRepository.findById(id);
      if (!conv) return res.status(404).json({ error: 'Conversación no encontrada' });

      const cuando = await conversationRepository.marcarMolesto(id);

      console.warn(
        `😠 [MOLESTO] Conversación #${id} (${conv.contact_name || conv.contact_phone || 'sin nombre'}) ` +
        'quedó marcada: sale de la recuperación de abandonos y conviene mirarla.'
      );

      socketManager.emitConversationUpdated(conv.channel_id, { id, molesto_at: cuando });

      return res.json({ success: true, molesto_at: cuando });
    } catch (error) {
      return res.status(500).json({ error: 'Error al marcar la conversación: ' + error.message });
    }
  },

  /**
   * El bot pide ayuda: pasa la conversación a una persona.
   *
   * Lo llama n8n cuando llega algo que no debe resolver solo — un comprobante
   * de pago, un reclamo, un pedido de reembolso. Deja el chat en 'handed_over'
   * (así el bot deja de contestar), avisa a los asesores por WebSocket y, si
   * viene `note`, la deja escrita en el hilo como mensaje de sistema para que
   * el asesor que entra sepa por qué le llegó.
   *
   * POST /api/conversations/:id/handover
   */
  async handover(req, res) {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: 'ID de conversación inválido' });
      }

      const { reason = null, note = null } = req.body || {};

      const conv = await conversationRepository.findById(id);
      if (!conv) {
        return res.status(404).json({ error: 'Conversación no encontrada' });
      }

      // Ya estaba en manos de una persona: no hay nada que hacer, y devolver
      // 200 evita que n8n reintente en loop por un "error" que no lo es.
      if (conv.bot_status === 'handed_over') {
        return res.json({ success: true, botStatus: 'handed_over', yaEstaba: true });
      }

      await conversationRepository.updateBotStatus(id, 'handed_over', null);

      const motivos = {
        comprobante_recibido: '🧾 El cliente envió un comprobante de pago. Verificalo en el banco antes de entregar el producto.',
        reclamo: '⚠️ El cliente presentó un reclamo. Requiere atención humana.',
        reembolso: '⚠️ El cliente pidió un reembolso.',
        fuera_de_alcance: '❓ El asistente no supo resolver la consulta.'
      };

      const textoSistema = note || motivos[reason] || '👤 El asistente pasó la conversación a un asesor.';

      let mensajeSistema = null;
      try {
        mensajeSistema = await messageRepository.insertMessage({
          conversationId: id,
          channelId: conv.channel_id,
          direction: 'outbound',
          senderType: 'bot',
          senderUserId: null,
          contentType: 'system',
          text: textoSistema,
          status: 'sent'
        });
      } catch (notaErr) {
        // La nota es una comodidad, no el objetivo: si falla, el handover vale igual.
        console.warn('⚠️ [HANDOVER] No se pudo dejar la nota de sistema:', notaErr.message);
      }

      socketManager.emitConversationUpdated(conv.channel_id, {
        id,
        bot_status: 'handed_over'
      });

      if (mensajeSistema) {
        socketManager.emitMessageSent(conv.channel_id, mensajeSistema);
      }

      return res.json({ success: true, botStatus: 'handed_over', reason });
    } catch (error) {
      return res.status(500).json({ error: 'Error al pasar a un asesor: ' + error.message });
    }
  }
};

export default conversationController;
