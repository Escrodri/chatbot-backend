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
    status = 'sent',
    errorDetails = null,
    timestamp = null
  }) {
    const errorDetailsJson = errorDetails ? JSON.stringify(errorDetails) : null;

    const { rows } = await query(
      `INSERT INTO messages (
         conversation_id, channel_id, meta_message_id, direction,
         sender_type, sender_user_id, content_type, text, media_url,
         status, error_details, timestamp
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, CURRENT_TIMESTAMP))
       ON CONFLICT (meta_message_id) DO NOTHING
       RETURNING id, conversation_id, channel_id, meta_message_id, direction, sender_type, sender_user_id, content_type, text, media_url, status, error_details, timestamp`,
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
  }
};

export default messageRepository;
