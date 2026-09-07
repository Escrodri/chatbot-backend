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

              if (msg.type === 'text') {
                contentType = 'text';
                textContent = msg.text?.body || '';
              } else if (msg.type === 'audio') {
                contentType = 'audio';
                mediaId = msg.audio?.id;
                mimeType = msg.audio?.mime_type;
                textContent = '🎵 [Nota de voz / Audio]';
              } else if (msg.type === 'image') {
                contentType = 'image';
                mediaId = msg.image?.id;
                mimeType = msg.image?.mime_type;
                textContent = msg.image?.caption || '📷 [Imagen]';
              } else if (msg.type === 'document') {
                contentType = 'document';
                mediaId = msg.document?.id;
                mimeType = msg.document?.mime_type;
                textContent = msg.document?.filename ? `📄 ${msg.document.filename}` : '📄 [Documento]';
              } else if (msg.type === 'reaction') {
                continue; // Omitir reacciones por el momento
              } else {
                textContent = `[Mensaje no compatible: ${msg.type}]`;
              }

              // Timestamp de Meta viene en segundos UNIX
              const eventDate = msg.timestamp ? new Date(parseInt(msg.timestamp, 10) * 1000) : new Date();

              events.push({
                platform: 'whatsapp',
                channelIdentifier: phoneId,
                eventType: isEcho ? 'echo' : 'message',
                isEcho,
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
                  mimeType
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
        const messagingList = entry.messaging || [];

        for (const item of messagingList) {
          // A. Mensajes entrantes o ecos
          if (item.message) {
            const msg = item.message;
            const isEcho = Boolean(msg.is_echo);
            const senderId = item.sender?.id;
            const recipientId = item.recipient?.id;

            // Si es eco, el cliente es recipient.id y el canal es sender.id
            const customerId = isEcho ? recipientId : senderId;
            const channelId = isEcho ? senderId : (pageId || recipientId);

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

            events.push({
              platform,
              channelIdentifier: String(channelId),
              eventType: isEcho ? 'echo' : 'message',
              isEcho,
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
