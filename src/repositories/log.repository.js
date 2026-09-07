import { query } from '../database/index.js';

/**
 * Repositorio de Auditoría de Webhooks: Registro de eventos crudos de Meta en formato JSONB nativo.
 */
export const logRepository = {
  /**
   * Registra un evento recibido desde el webhook de Meta.
   * 
   * @param {{ platform: string, channelIdentifier?: string|null, eventType?: string|null, rawPayload: object|string, status?: string }} data
   * @returns {Promise<object>}
   */
  async logEvent({ platform, channelIdentifier = null, eventType = 'inbound_event', rawPayload, status = 'PROCESSED' }) {
    const payloadJson = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);

    const { rows } = await query(
      `INSERT INTO webhook_logs (platform, channel_identifier, event_type, payload_json, status)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, platform, channel_identifier, event_type, status, created_at`,
      [platform, channelIdentifier, eventType, payloadJson, status]
    );

    return rows[0];
  },

  /**
   * Obtiene los últimos logs registrados para la consola web de administración.
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async listRecent(limit = 100) {
    const { rows } = await query(
      `SELECT id, platform, channel_identifier, event_type, payload_json, status, created_at
       FROM webhook_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  }
};

export default logRepository;
