import { query } from '../database/pool.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.aes.js';

export const teamRepository = {
  /**
   * Obtiene la información de un equipo por su ID.
   * @param {number} teamId 
   */
  async findById(teamId) {
    const { rows } = await query(
      'SELECT id, name, meta_app_id, meta_app_secret_encrypted, token_iv, token_tag, created_at FROM teams WHERE id = $1',
      [teamId]
    );
    return rows[0] || null;
  },

  /**
   * Obtiene la configuración de Meta de un equipo (App ID y descifrado de App Secret).
   * @param {number} teamId 
   */
  async getMetaConfig(teamId) {
    const team = await this.findById(teamId);
    if (!team) return { appId: null, appSecret: null, hasAppSecret: false };

    let appSecret = null;
    if (team.meta_app_secret_encrypted && team.token_iv && team.token_tag) {
      try {
        appSecret = decryptSecret(team.meta_app_secret_encrypted, team.token_iv, team.token_tag);
      } catch (err) {
        console.warn(`⚠️ Error al descifrar App Secret del equipo #${teamId}:`, err.message);
      }
    }

    return {
      appId: team.meta_app_id || null,
      appSecret,
      hasAppSecret: Boolean(team.meta_app_secret_encrypted)
    };
  },

  /**
   * Actualiza las credenciales de Meta (App ID y App Secret) de un equipo en la BD.
   * @param {number} teamId 
   * @param {{ appId?: string, appSecret?: string }} config 
   */
  async updateMetaConfig(teamId, { appId, appSecret }) {
    const cleanAppId = (appId && String(appId).trim()) ? String(appId).trim() : null;
    const cleanAppSecret = (appSecret && String(appSecret).trim()) ? String(appSecret).trim() : null;

    if (cleanAppSecret) {
      const encrypted = encryptSecret(cleanAppSecret);
      await query(
        `UPDATE teams 
         SET meta_app_id = COALESCE($1, meta_app_id),
             meta_app_secret_encrypted = $2,
             token_iv = $3,
             token_tag = $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [cleanAppId, encrypted.cipherText, encrypted.iv, encrypted.tag, teamId]
      );
    } else {
      await query(
        `UPDATE teams 
         SET meta_app_id = COALESCE($1, meta_app_id),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [cleanAppId, teamId]
      );
    }

    return this.getMetaConfig(teamId);
  },

  /**
   * Elimina las credenciales de Meta de un equipo.
   * @param {number} teamId 
   */
  async clearMetaConfig(teamId) {
    await query(
      `UPDATE teams 
       SET meta_app_id = NULL,
           meta_app_secret_encrypted = NULL,
           token_iv = NULL,
           token_tag = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [teamId]
    );
  }
};

export default teamRepository;
