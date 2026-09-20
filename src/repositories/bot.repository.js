import { query } from '../database/index.js';

/**
 * Repositorio de Configuración del Chatbot: Parámetros de saludo y reglas de auto-respuesta.
 */
export const botRepository = {
  /**
   * Obtiene la configuración del bot para un canal específico o la del equipo por defecto.
   * 
   * @param {number|null} [teamId=1]
   * @param {number|null} [channelId=null]
   * @returns {Promise<object>}
   */
  async getSettingsForChannel(teamId = 1, channelId = null) {
    if (channelId) {
      const { rows } = await query(
        'SELECT id, team_id, channel_id, is_enabled, welcome_message, inactivity_hours, updated_at FROM bot_settings WHERE channel_id = $1',
        [channelId]
      );
      if (rows.length > 0) return rows[0];
    }

    // Fallback: Configuración a nivel de equipo (channel_id IS NULL)
    const effectiveTeamId = teamId || 1;
    const { rows: teamRows } = await query(
      `SELECT id, team_id, channel_id, is_enabled, welcome_message, inactivity_hours, updated_at 
       FROM bot_settings 
       WHERE (team_id = $1 OR team_id IS NULL) AND channel_id IS NULL 
       ORDER BY team_id DESC NULLS LAST 
       LIMIT 1`,
      [effectiveTeamId]
    );

    if (teamRows.length > 0) return teamRows[0];

    // Configuración por defecto si aún no se ha creado ningún registro
    return {
      id: null,
      team_id: effectiveTeamId,
      channel_id: null,
      is_enabled: true,
      welcome_message: '¡Hola! Gracias por comunicarte con nosotros. Un asesor te atenderá a la brevedad. ¿En qué podemos ayudarte?',
      inactivity_hours: 24,
      updated_at: new Date()
    };
  },

  /**
   * Actualiza o crea la configuración del bot para un canal específico o a nivel de equipo.
   * 
   * @param {{ teamId?: number|null, channelId?: number|null, isEnabled?: boolean, welcomeMessage: string, inactivityHours?: number }} data
   * @returns {Promise<object>}
   */
  async saveSettings({ teamId = null, channelId = null, isEnabled = true, welcomeMessage, inactivityHours = 24 }) {
    let effectiveTeamId = teamId;
    if (!effectiveTeamId && channelId) {
      const { rows: chRows } = await query('SELECT team_id FROM channels WHERE id = $1', [channelId]);
      if (chRows.length > 0) effectiveTeamId = chRows[0].team_id;
    }

    if (!effectiveTeamId) {
      const { rows: tmRows } = await query('SELECT id FROM teams WHERE is_active = true ORDER BY id ASC LIMIT 1');
      effectiveTeamId = tmRows.length > 0 ? tmRows[0].id : 1;
    }

    if (channelId) {
      const { rows } = await query(
        `INSERT INTO bot_settings (team_id, channel_id, is_enabled, welcome_message, inactivity_hours, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (channel_id) DO UPDATE SET
           team_id = EXCLUDED.team_id,
           is_enabled = EXCLUDED.is_enabled,
           welcome_message = EXCLUDED.welcome_message,
           inactivity_hours = EXCLUDED.inactivity_hours,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [effectiveTeamId, channelId, isEnabled, welcomeMessage.trim(), inactivityHours]
      );
      return rows[0];
    } else {
      const { rows: existing } = await query(
        'SELECT id FROM bot_settings WHERE team_id = $1 AND channel_id IS NULL',
        [effectiveTeamId]
      );
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
          `INSERT INTO bot_settings (team_id, channel_id, is_enabled, welcome_message, inactivity_hours)
           VALUES ($1, NULL, $2, $3, $4)
           RETURNING *`,
          [effectiveTeamId, isEnabled, welcomeMessage.trim(), inactivityHours]
        );
        return rows[0];
      }
    }
  }
};

export default botRepository;
