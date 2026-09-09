import { query } from '../database/index.js';

/**
 * Repositorio de Mensajes: Persistencia atómica, deduplicación de Meta y paginación por cursor.
 */
export const messageRepository = {
  /**
   * Inserta un mensaje en la base de datos con deduplicación estricta por meta_message_id.
   * Si Meta reintenta el webhook con el mismo ID de mensaje, la consulta ignora la inserción sin error.
   * 
   * @param {{
   *   conversationId: number,
   *   channelId: number,
   *   metaMessageId?: string|null,
   *   direction: 'inbound'|'outbound',
   *   senderType?: 'customer'|'bot'|'agent',
   *   senderUserId?: number|null,
   *   contentType?: 'text'|'image'|'audio'|'document'|'system',
   *   text: string,
   *   mediaUrl?: string|null,
   *   status?: 'pending'|'sent'|'delivered'|'read'|'failed',
   *   errorDetails?: object|null,
   *   timestamp?: Date|string|null
   * }} msgData
   * @returns {Promise<object|null>} Mensaje insertado o null si era un duplicado
   */
  async insertMessage({
    conversationId,
    channelId,
    metaMessageId = null,
    direction,
    senderType = 'customer',
    senderUserId = null,
    contentType = 'text',
    text,
    mediaUrl = null,
    metaMediaId = null,
    mediaMime = null,
    status = 'sent',
    errorDetails = null,
    timestamp = null
  }) {
    const errorDetailsJson = errorDetails ? JSON.stringify(errorDetails) : null;

    const { rows } = await query(
      `INSERT INTO messages (
         conversation_id, channel_id, meta_message_id, direction,
         sender_type, sender_user_id, content_type, text, media_url,
         meta_media_id, media_mime, status, error_details, timestamp
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, CURRENT_TIMESTAMP))
       ON CONFLICT (meta_message_id) DO NOTHING
       RETURNING id, conversation_id, channel_id, meta_message_id, direction, sender_type, sender_user_id, content_type, text, media_url, meta_media_id, media_mime, status, error_details, timestamp`,
      [
        conversationId,
        channelId,
        metaMessageId ? metaMessageId.trim() : null,
        direction,
        senderType,
        senderUserId,
        contentType,
        text,
        mediaUrl,
        metaMediaId,
        mediaMime,
        status,
        errorDetailsJson,
        timestamp
      ]
    );

    // Si ya existía el meta_message_id, ON CONFLICT DO NOTHING devuelve 0 filas
    return rows[0] || null;
  },

  /**
   * Paginación por cursor (Keyset Pagination) para cargar el historial de mensajes de forma fluida.
   * Evita saltos de offset cuando entran mensajes en tiempo real.
   * 
   * @param {number} conversationId
   * @param {number|null} beforeId ID del mensaje más antiguo en pantalla (para cargar mensajes anteriores)
   * @param {number} limit Cantidad de mensajes por lote (por defecto 40)
   * @returns {Promise<Array>} Lista de mensajes ordenados cronológicamente
   */
  async getHistoryKeyset(conversationId, beforeId = null, limit = 40) {
    const conditions = ['conversation_id = $1'];
    const params = [conversationId];
    let pIdx = 2;

    if (beforeId) {
      conditions.push(`id < $${pIdx++}`);
      params.push(parseInt(beforeId, 10));
    }

    params.push(limit);

    const sql = `
      SELECT 
        m.id, m.conversation_id, m.channel_id, m.meta_message_id, m.direction,
        m.sender_type, m.sender_user_id, m.content_type, m.text, m.media_url,
        m.meta_media_id, m.media_mime,
        m.status, m.error_details, m.timestamp,
        u.name as sender_user_name
      FROM messages m
      LEFT JOIN users u ON m.sender_user_id = u.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.id DESC
      LIMIT $${pIdx}
    `;

    const { rows } = await query(sql, params);
    // Invertir para entregar en orden cronológico ascendente a la UI
    return rows.reverse();
  },

  /**
   * Busca un mensaje por su id, con los datos necesarios para entregar su
   * archivo multimedia y verificar permisos.
   *
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async findByIdWithChannel(id) {
    const { rows } = await query(
      `SELECT id, conversation_id, channel_id, content_type, media_url,
              meta_media_id, media_mime, text, direction, status, sender_type
       FROM messages
       WHERE id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Actualiza la URL local descargada para un archivo multimedia.
   * 
   * @param {number} messageId
   * @param {string} mediaUrl
   * @returns {Promise<void>}
   */
  async updateMediaUrl(messageId, mediaUrl) {
    await query(
      `UPDATE messages 
       SET media_url = $1
       WHERE id = $2`,
      [mediaUrl, messageId]
    );
  },

  /**
   * Actualiza el estado de entrega de un mensaje saliente a partir de un webhook de status de Meta.
   * 
   * @param {string} metaMessageId
   * @param {'delivered'|'read'|'failed'} status
   * @param {object|null} errorDetails
   * @returns {Promise<void>}
   */
  async updateStatusByMetaId(metaMessageId, status, errorDetails = null) {
    const errorDetailsJson = errorDetails ? JSON.stringify(errorDetails) : null;
    await query(
      `UPDATE messages 
       SET status = $1, error_details = COALESCE($2, error_details)
       WHERE meta_message_id = $3`,
      [status, errorDetailsJson, metaMessageId]
    );
  },

  /**
   * Marca un mensaje como fallido guardando el motivo, para que la interfaz
   * pueda explicarle al operador por qué no salió (A-02).
   *
   * @param {number} id
   * @param {{ code?: string, message: string }} errorDetails
   * @returns {Promise<object|null>} El mensaje actualizado
   */
  async markFailed(id, errorDetails) {
    const { rows } = await query(
      `UPDATE messages
       SET status = 'failed', error_details = $1::jsonb
       WHERE id = $2
       RETURNING id, conversation_id, channel_id, meta_message_id, direction, sender_type,
                 sender_user_id, content_type, text, media_url, status, error_details, timestamp`,
      [JSON.stringify(errorDetails || { message: 'Error desconocido al enviar' }), id]
    );
    return rows[0] || null;
  },

  /**
   * Actualiza el estado de un mensaje por su ID primario.
   * 
   * @param {number} id
   * @param {'pending'|'sent'|'delivered'|'read'|'failed'} status
   * @param {string|null} metaMessageId
   * @returns {Promise<void>}
   */
  async updateStatus(id, status, metaMessageId = null) {
    // Si el mensaje deja de estar fallido (por ejemplo tras un reintento exitoso),
    // se borra el motivo del error para que el chat no siga mostrando el aviso.
    const limpiarError = status !== 'failed';

    if (metaMessageId) {
      await query(
        `UPDATE messages
         SET status = $1, meta_message_id = $2,
             error_details = CASE WHEN $4::boolean THEN NULL ELSE error_details END
         WHERE id = $3`,
        [status, metaMessageId, id, limpiarError]
      );
    } else {
      await query(
        `UPDATE messages
         SET status = $1,
             error_details = CASE WHEN $3::boolean THEN NULL ELSE error_details END
         WHERE id = $2`,
        [status, id, limpiarError]
      );
    }
  }
};

export default messageRepository;
