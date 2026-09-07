import { query } from '../database/index.js';

/**
 * Repositorio de Conversaciones: Cabeceras de chats, filtros multi-canal y estados de bot/handover.
 */
export const conversationRepository = {
  /**
   * Busca o crea la conversación asociada a un contacto en un canal determinado.
   * 
   * @param {number} channelId
   * @param {number} contactId
   * @returns {Promise<object>}
   */
  async findOrCreateByContact(channelId, contactId) {
    // Buscar si ya existe
    const { rows: existing } = await query(
      `SELECT * FROM conversations WHERE channel_id = $1 AND contact_id = $2`,
      [channelId, contactId]
    );

    if (existing.length > 0) {
      return existing[0];
    }

    // Crear nueva conversación con bot activo por defecto
    const { rows: created } = await query(
      `INSERT INTO conversations (channel_id, contact_id, bot_status, unread_count)
       VALUES ($1, $2, 'active', 0)
       RETURNING *`,
      [channelId, contactId]
    );

    return created[0];
  },

  /**
   * Obtiene una conversación por su ID con datos del contacto y canal asociados.
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT 
         c.id, c.channel_id, c.contact_id, c.last_message_text, c.last_message_time,
         c.last_customer_interaction, c.unread_count, c.bot_status, c.assigned_user_id, c.created_at,
         ct.name as contact_name, ct.phone_or_username as contact_phone, ct.avatar_url as contact_avatar, ct.platform_user_id,
         ch.platform, ch.name as channel_name, ch.color_tag as channel_color, ch.channel_identifier
       FROM conversations c
       INNER JOIN contacts ct ON c.contact_id = ct.id
       INNER JOIN channels ch ON c.channel_id = ch.id
       WHERE c.id = $1`,
      [id]
    );

    return rows[0] || null;
  },

  /**
   * Actualiza el registro de interacción del cliente (para la regla de ventana de 24h/7d) e incrementa no leídos.
   * 
   * @param {number} conversationId
   * @param {string} lastMessageText
   * @param {Date|string|null} interactionTimestamp
   * @returns {Promise<void>}
   */
  async touchCustomerInteraction(conversationId, lastMessageText, interactionTimestamp = null) {
    await query(
      `UPDATE conversations 
       SET 
         last_message_text = $1,
         last_message_time = COALESCE($2, CURRENT_TIMESTAMP),
         last_customer_interaction = COALESCE($2, CURRENT_TIMESTAMP),
         unread_count = unread_count + 1
       WHERE id = $3`,
      [lastMessageText, interactionTimestamp, conversationId]
    );
  },

  /**
   * Actualiza el último mensaje saliente de la conversación sin modificar last_customer_interaction.
   * 
   * @param {number} conversationId
   * @param {string} lastMessageText
   * @returns {Promise<void>}
   */
  async updateOutboundMessage(conversationId, lastMessageText) {
    await query(
      `UPDATE conversations 
       SET 
         last_message_text = $1,
         last_message_time = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [lastMessageText, conversationId]
    );
  },

  /**
   * Resetea el contador de mensajes no leídos al abrir la conversación en el navegador.
   * @param {number} conversationId
   * @returns {Promise<void>}
   */
  async resetUnreadCount(conversationId) {
    await query(
      `UPDATE conversations SET unread_count = 0 WHERE id = $1`,
      [conversationId]
    );
  },

  /**
   * Conmuta el estado del bot (Protocolo Handover: 'active', 'handed_over', 'disabled').
   * @param {number} conversationId
   * @param {'active'|'handed_over'|'disabled'} botStatus
   * @param {number|null} assignedUserId
   * @returns {Promise<void>}
   */
  async updateBotStatus(conversationId, botStatus, assignedUserId = null) {
    await query(
      `UPDATE conversations 
       SET bot_status = $1, assigned_user_id = COALESCE($2, assigned_user_id)
       WHERE id = $3`,
      [botStatus, assignedUserId, conversationId]
    );
  },

  /**
   * Lista conversaciones para la bandeja lateral estilo WhatsApp Web con filtros avanzados.
   * 
   * @param {{ platform?: string, channelId?: number, search?: string, assignedChannelIds?: number[], limit?: number, offset?: number }} filters
   * @returns {Promise<Array>}
   */
  async listWithFilters({ platform = null, channelId = null, search = null, assignedChannelIds = null, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    let pIdx = 1;

    // Aislamiento IDOR: si el operador tiene canales restringidos
    if (assignedChannelIds && Array.isArray(assignedChannelIds)) {
      if (assignedChannelIds.length === 0) return []; // No tiene canales asignados
      conditions.push(`c.channel_id = ANY($${pIdx++})`);
      params.push(assignedChannelIds);
    }

    if (platform) {
      conditions.push(`ch.platform = $${pIdx++}`);
      params.push(platform);
    }

    if (channelId) {
      conditions.push(`c.channel_id = $${pIdx++}`);
      params.push(parseInt(channelId, 10));
    }

    if (search) {
      conditions.push(`(ct.name ILIKE $${pIdx} OR ct.phone_or_username ILIKE $${pIdx} OR c.last_message_text ILIKE $${pIdx})`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);
    params.push(offset);

    const sql = `
      SELECT 
        c.id, c.channel_id, c.contact_id, c.last_message_text, c.last_message_time,
        c.last_customer_interaction, c.unread_count, c.bot_status, c.assigned_user_id,
        ct.name as contact_name, ct.phone_or_username as contact_phone, ct.avatar_url as contact_avatar,
        ch.platform, ch.name as channel_name, ch.color_tag as channel_color, ch.channel_identifier
      FROM conversations c
      INNER JOIN contacts ct ON c.contact_id = ct.id
      INNER JOIN channels ch ON c.channel_id = ch.id
      ${whereClause}
      ORDER BY c.last_message_time DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `;

    const { rows } = await query(sql, params);
    return rows;
  }
};

export default conversationRepository;
