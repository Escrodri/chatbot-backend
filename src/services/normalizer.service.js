/**
 * Servicio de Normalización Multi-Canal (Meta Graph API v21.0)
 * Transforma payloads heterogéneos de WhatsApp Cloud API, Facebook Messenger e Instagram Direct
 * en objetos de evento canónicos unificados e inmutables para el sistema.
 */
export const normalizerService = {
  /**
   * Normaliza un payload crudo de Meta Webhook en una lista de eventos estandarizados.
   * 
   * @param {object} rawPayload JSON deserializado del cuerpo del webhook
   * @returns {Array<object>} Lista de eventos normalizados
   */
  normalizeWebhookPayload(rawPayload) {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return [];
    }

    const events = [];
    const objectType = rawPayload.object;

    // 1. WHATSAPP CLOUD API (object === 'whatsapp_business_account')
    if (objectType === 'whatsapp_business_account') {
      const entries = rawPayload.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field !== 'messages') continue;
          const val = change.value || {};
          const phoneId = val.metadata?.phone_number_id;

          // A. Mensajes entrantes o ecos
          if (Array.isArray(val.messages)) {
            const contacts = val.contacts || [];
            for (const msg of val.messages) {
              const fromNumber = msg.from;
              const contactInfo = contacts.find(c => c.wa_id === fromNumber) || {};
              const contactName = contactInfo.profile?.name || fromNumber;
              const isEcho = Boolean(msg.is_echo);

              let contentType = 'text';
              let textContent = '';
              let mediaId = null;
              let mimeType = null;
              let mediaDirectUrl = null;

              if (msg.type === 'text') {
                contentType = 'text';
                textContent = msg.text?.body || '';
              } else if (msg.type === 'sticker') {
                contentType = 'sticker';
                mediaId = msg.sticker?.id;
                mimeType = msg.sticker?.mime_type || 'image/webp';
                mediaDirectUrl = msg.sticker?.url;
                textContent = '🏷️ [Sticker]';
              } else if (msg.type === 'audio' || msg.type === 'voice') {
                contentType = 'audio';
                const audioObj = msg.audio || msg.voice || {};
                mediaId = audioObj.id;
                mimeType = audioObj.mime_type || 'audio/ogg';
                mediaDirectUrl = audioObj.url;
                textContent = '🎵 [Nota de voz / Audio]';
              } else if (msg.type === 'image') {
                contentType = 'image';
                mediaId = msg.image?.id;
                mimeType = msg.image?.mime_type;
                mediaDirectUrl = msg.image?.url;
                textContent = msg.image?.caption || '📷 [Imagen]';
              } else if (msg.type === 'video') {
                contentType = 'video';
                mediaId = msg.video?.id;
                mimeType = msg.video?.mime_type || 'video/mp4';
                mediaDirectUrl = msg.video?.url;
                textContent = msg.video?.caption || '🎥 [Video]';
              } else if (msg.type === 'document') {
                contentType = 'document';
                mediaId = msg.document?.id;
                mimeType = msg.document?.mime_type;
                mediaDirectUrl = msg.document?.url;
                textContent = msg.document?.filename ? `📄 ${msg.document.filename}` : '📄 [Documento]';
              } else if (msg.type === 'reaction') {
                continue; // Omitir reacciones por el momento
              } else {
                textContent = `[Mensaje no compatible: ${msg.type}]`;
              }

              // Timestamp de Meta viene en segundos UNIX
              const eventDate = msg.timestamp ? new Date(parseInt(msg.timestamp, 10) * 1000) : new Date();

              // Si la persona llegó desde un anuncio de clic a WhatsApp, Meta manda
              // acá el identificador del clic. Solo viene en este primer mensaje: si
              // no se guarda ahora, la venta no se puede atribuir al anuncio nunca más.
              const ref = msg.referral || null;

              const isViewOnce = Boolean(msg.image?.view_once || msg.video?.view_once);

              events.push({
                platform: 'whatsapp',
                channelIdentifier: phoneId,
                eventType: isEcho ? 'echo' : 'message',
                isEcho,
                attribution: ref ? {
                  ctwaClid: ref.ctwa_clid || null,
                  adId: ref.source_id || null,
                  sourceType: ref.source_type || null,
                  sourceUrl: ref.source_url || null
                } : null,
                accountId: entry.id || null, // Identificador de la cuenta de WhatsApp Business
                sender: {
                  id: fromNumber,
                  name: contactName,
                  phone: fromNumber
                },
                message: {
                  id: msg.id,
                  direction: isEcho ? 'outbound' : 'inbound',
                  senderType: isEcho ? 'agent' : 'customer',
                  timestamp: eventDate,
                  type: contentType,
                  text: textContent,
                  mediaId,
                  mimeType,
                  mediaDirectUrl,
                  isViewOnce
                }
              });
            }
          }

          // B. Estados de entrega (sent, delivered, read, failed)
          if (Array.isArray(val.statuses)) {
            for (const st of val.statuses) {
              events.push({
                platform: 'whatsapp',
                channelIdentifier: phoneId,
                eventType: 'status',
                statusUpdate: {
                  metaMessageId: st.id,
                  status: st.status, // 'delivered' | 'read' | 'failed'
                  recipientId: st.recipient_id,
                  timestamp: st.timestamp ? new Date(parseInt(st.timestamp, 10) * 1000) : new Date(),
                  errors: st.errors || null
                }
              });
            }
          }
        }
      }
      return events;
    }

    // 2. FACEBOOK MESSENGER & INSTAGRAM DIRECT (object === 'page' || object === 'instagram')
    if (objectType === 'page' || objectType === 'instagram') {
      const platform = objectType === 'instagram' ? 'instagram' : 'facebook';
      const entries = rawPayload.entry || [];

      for (const entry of entries) {
        const pageId = entry.id; // ID de la Fan Page o Cuenta de Instagram
        // Soporta tanto canal principal (messaging) como canal secundario (standby) de Conversation Routing
        const messagingList = [...(entry.messaging || []), ...(entry.standby || [])];

        for (const item of messagingList) {
          // A. Mensajes entrantes o ecos
          if (item.message) {
            const msg = item.message;
            const isEcho = Boolean(msg.is_echo);
            const senderId = item.sender?.id;
            const recipientId = item.recipient?.id;

            // Si es eco, el cliente es recipient.id y el canal es sender.id.
            // Para mensajes entrantes, recipientId identifica con precisión el canal destino.
            const customerId = isEcho ? recipientId : senderId;
            const channelId = isEcho ? senderId : (recipientId || pageId);

            let contentType = 'text';
            let textContent = msg.text || '';
            let mediaUrl = null;

            if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
              const att = msg.attachments[0];
              contentType = att.type || 'image';
              mediaUrl = att.payload?.url || null;
              if (!textContent) {
                textContent = contentType === 'audio' ? '🎵 [Audio]' : `📎 [${contentType}]`;
              }
            }

            const eventDate = item.timestamp ? new Date(item.timestamp) : new Date();

            // Anuncio de origen, cuando la conversación arrancó desde un anuncio
            // de clic a Messenger o desde un enlace m.me con referencia.
            const ref = item.referral || item.postback?.referral || null;

            events.push({
              platform,
              channelIdentifier: String(channelId),
              eventType: isEcho ? 'echo' : 'message',
              isEcho,
              attribution: ref ? {
                ctwaClid: ref.ctwa_clid || null,
                adId: ref.ad_id || null,
                sourceType: ref.source || ref.type || null,
                sourceUrl: ref.ref || null
              } : null,
              accountId: String(pageId || channelId),
              sender: {
                id: String(customerId),
                name: `Usuario ${String(customerId).slice(-4)}`, // En FB/IG el nombre se obtiene vía Graph API
                phone: null
              },
              message: {
                id: msg.mid,
                direction: isEcho ? 'outbound' : 'inbound',
                senderType: isEcho ? 'agent' : 'customer',
                timestamp: eventDate,
                type: contentType,
                text: textContent,
                mediaUrl
              }
            });
          }

          // A.2. Referido suelto (campo messaging_referrals).
          // Cuando alguien que YA hablaba con la página vuelve desde un anuncio,
          // Meta manda el referido en un evento aparte, sin mensaje adjunto. Si
          // no se atiende acá, se pierde la atribución justo de los clientes que
          // vuelven, que suelen ser los que más compran.
          if (!item.message && item.referral) {
            const clienteId = item.sender?.id;
            if (clienteId) {
              events.push({
                platform,
                channelIdentifier: String(item.recipient?.id || pageId),
                eventType: 'referral',
                sender: {
                  id: String(clienteId),
                  name: `Usuario ${String(clienteId).slice(-4)}`,
                  phone: null
                },
                attribution: {
                  ctwaClid: item.referral.ctwa_clid || null,
                  adId: item.referral.ad_id || null,
                  sourceType: item.referral.source || item.referral.type || null,
                  sourceUrl: item.referral.ref || null
                },
                accountId: String(pageId || item.recipient?.id)
              });
            }
          }

          // B. Confirmaciones de lectura (read)
          if (item.read) {
            events.push({
              platform,
              channelIdentifier: String(pageId || item.recipient?.id),
              eventType: 'status',
              statusUpdate: {
                watermark: item.read.watermark,
                status: 'read',
                recipientId: item.sender?.id,
                timestamp: item.timestamp ? new Date(item.timestamp) : new Date()
              }
            });
          }

          // C. Confirmaciones de entrega (delivery)
          if (item.delivery) {
            const mids = item.delivery.mids || [];
            for (const mid of mids) {
              events.push({
                platform,
                channelIdentifier: String(pageId || item.recipient?.id),
                eventType: 'status',
                statusUpdate: {
                  metaMessageId: mid,
                  status: 'delivered',
                  timestamp: item.timestamp ? new Date(item.timestamp) : new Date()
                }
              });
            }
          }
        }
      }
      return events;
    }

    return events;
  }
};

export default normalizerService;
