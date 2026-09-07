import { query } from '../database/index.js';

/**
 * Repositorio de Configuración del Chatbot: Parámetros de saludo y reglas de auto-respuesta.
 */
export const botRepository = {
  /**
   * Obtiene la configuración del bot para un canal específico o la global por defecto.
   * 
   * @param {number|null} channelId
   * @returns {Promise<object>}
   */
  async getSettingsForChannel(channelId = null) {
    if (channelId) {
      const { rows } = await query(
        'SELECT id, channel_id, is_enabled, welcome_message, inactivity_hours, updated_at FROM bot_settings WHERE channel_id = $1',
        [channelId]
      );
      if (rows.length > 0) return rows[0];
    }

    // Fallback: Configuración global (channel_id IS NULL)
    const { rows: globalRows } = await query(
      'SELECT id, channel_id, is_enabled, welcome_message, inactivity_hours, updated_at FROM bot_settings WHERE channel_id IS NULL LIMIT 1'
    );

    if (globalRows.length > 0) return globalRows[0];

    // Configuración por defecto si aún no se ha creado ningún registro
    return {
      id: null,
      channel_id: null,
      is_enabled: true,
      welcome_message: '¡Hola! Gracias por comunicarte con nosotros. Un asesor te atenderá a la brevedad. ¿En qué podemos ayudarte?',
      inactivity_hours: 24,
      updated_at: new Date()
    };
  },

  /**
   * Actualiza o crea la configuración del bot para un canal específico o global.
   * 
   * @param {{ channelId?: number|null, isEnabled?: boolean, welcomeMessage: string, inactivityHours?: number }} data
   * @returns {Promise<object>}
   */
  async saveSettings({ channelId = null, isEnabled = true, welcomeMessage, inactivityHours = 24 }) {
    // Buscar si ya existe registro previo
    const selectSql = channelId 
      ? 'SELECT id FROM bot_settings WHERE channel_id = $1'
      : 'SELECT id FROM bot_settings WHERE channel_id IS NULL';
    const selectParams = channelId ? [channelId] : [];

    const { rows: existing } = await query(selectSql, selectParams);

    if (existing.length > 0) {
      const { rows } = await query(
        `UPDATE bot_settings 
         SET is_enabled = $1, welcome_message = $2, inactivity_hours = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING *`,
        [isEnabled, welcomeMessage.trim(), inactivityHours, existing[0].id]
      );
      return rows[0];
    } else {
      const { rows } = await query(
        `INSERT INTO bot_settings (channel_id, is_enabled, welcome_message, inactivity_hours)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [channelId, isEnabled, welcomeMessage.trim(), inactivityHours]
      );
      return rows[0];
    }
  }
};

export default botRepository;
