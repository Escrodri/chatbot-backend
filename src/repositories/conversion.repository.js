import { query } from '../database/index.js';

/**
 * Repositorio de ventas informadas a Meta.
 *
 * Guarda cada venta que marca un operador, tanto si Meta la aceptó como si no.
 * Sirve para dos cosas: tener el historial de lo vendido por conversación, y
 * poder reintentar o auditar lo que Meta rechazó.
 */
export const conversionRepository = {
  /**
   * Registra la venta antes de intentar informarla.
   *
   * @param {{ conversationId: number, channelId: number, registeredBy: number|null,
   *           eventName?: string, eventId: string, value?: number|null,
   *           currency?: string|null, note?: string|null }} datos
   * @returns {Promise<object>}
   */
  async create({ conversationId, channelId, registeredBy = null, eventName = 'Purchase', eventId, value = null, currency = null, note = null }) {
    const { rows } = await query(
      `INSERT INTO conversion_events
         (conversation_id, channel_id, registered_by, event_name, event_id, value, currency, note, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [conversationId, channelId, registeredBy, eventName, eventId, value, currency, note]
    );
    return rows[0];
  },

  /**
   * Deja asentado qué contestó Meta.
   *
   * @param {number} id
   * @param {'sent'|'failed'|'skipped'} status
   * @param {object|null} errorDetails
   * @returns {Promise<object|null>}
   */
  async updateStatus(id, status, errorDetails = null) {
    const { rows } = await query(
      `UPDATE conversion_events
       SET status = $1, error_details = $2::jsonb
       WHERE id = $3
       RETURNING *`,
      [status, errorDetails ? JSON.stringify(errorDetails) : null, id]
    );
    return rows[0] || null;
  },

  /**
   * Ventas registradas en una conversación, de la más reciente a la más vieja.
   *
   * @param {number} conversationId
   * @returns {Promise<object[]>}
   */
  async listByConversation(conversationId) {
    const { rows } = await query(
      `SELECT id, event_name, event_id, value, currency, note, status, error_details, created_at
       FROM conversion_events
       WHERE conversation_id = $1
       ORDER BY created_at DESC`,
      [conversationId]
    );
    return rows;
  }
};

export default conversionRepository;
