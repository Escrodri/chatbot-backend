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
   * Lista todos los equipos registrados con métricas de usuarios y canales (para el Superadmin).
   */
  async listAllWithMetrics() {
    const { rows } = await query(
      `SELECT
         t.id, t.name, t.meta_app_id, t.created_at,
         (t.meta_app_secret_encrypted IS NOT NULL) AS has_meta_secret,
         COUNT(DISTINCT u.id)::int AS total_users,
         COUNT(DISTINCT c.id) FILTER (WHERE c.deleted_at IS NULL)::int AS total_channels
       FROM teams t
       LEFT JOIN users u ON u.team_id = t.id
       LEFT JOIN channels c ON c.team_id = t.id
       GROUP BY t.id
       ORDER BY t.id ASC`
    );
    return rows;
  },

  /**
   * Crea un nuevo equipo / empresa en la base de datos.
   * @param {{ name: string, metaAppId?: string, metaAppSecret?: string }} data
   */
  async createTeam({ name, metaAppId = null, metaAppSecret = null }) {
    const cleanName = String(name || '').trim();
    const cleanAppId = (metaAppId && String(metaAppId).trim()) ? String(metaAppId).trim() : null;
    const cleanAppSecret = (metaAppSecret && String(metaAppSecret).trim()) ? String(metaAppSecret).trim() : null;

    let cipherText = null;
    let iv = null;
    let tag = null;

    if (cleanAppSecret) {
      const encrypted = encryptSecret(cleanAppSecret);
      cipherText = encrypted.cipherText;
      iv = encrypted.iv;
      tag = encrypted.tag;
    }

    const { rows } = await query(
      `INSERT INTO teams (name, meta_app_id, meta_app_secret_encrypted, token_iv, token_tag)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, meta_app_id, created_at`,
      [cleanName, cleanAppId, cipherText, iv, tag]
    );

    return rows[0];
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
