import { query } from '../database/index.js';

/**
 * Repositorio de Contactos: Gestión de clientes finales en WhatsApp, Facebook e Instagram.
 */
export const contactRepository = {
  /**
   * Busca o crea un contacto garantizando unicidad por (channel_id, platform_user_id).
   * 
   * @param {{ channelId: number, platform: string, platformUserId: string, name: string, phoneOrUsername?: string, avatarUrl?: string }} data
   * @returns {Promise<object>} Contacto creado o actualizado
   */
  async findOrCreate({ channelId, platform, platformUserId, name, phoneOrUsername = null, avatarUrl = null }) {
    const { rows } = await query(
      `INSERT INTO contacts (channel_id, platform, platform_user_id, name, phone_or_username, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_id, platform_user_id) 
       DO UPDATE SET 
         name = EXCLUDED.name,
         phone_or_username = COALESCE(EXCLUDED.phone_or_username, contacts.phone_or_username),
         avatar_url = COALESCE(EXCLUDED.avatar_url, contacts.avatar_url)
       RETURNING id, channel_id, platform, platform_user_id, name, phone_or_username, avatar_url, created_at`,
      [channelId, platform, platformUserId.trim(), name.trim(), phoneOrUsername, avatarUrl]
    );

    return rows[0];
  },

  /**
   * Busca un contacto por su ID único.
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      'SELECT id, channel_id, platform, platform_user_id, name, phone_or_username, avatar_url, created_at FROM contacts WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }
};

export default contactRepository;
