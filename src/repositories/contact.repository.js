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
  async findOrCreate({ channelId, platform, platformUserId, name, phoneOrUsername = null, avatarUrl = null, nameIsPlaceholder = false }) {
    // `nameIsPlaceholder` marca los nombres inventados por nosotros ("Usuario 3088"),
    // que se usan cuando Meta no nos deja leer el perfil de la persona. Un nombre
    // así nunca debe pisar uno de verdad que ya tengamos guardado: si el perfil se
    // pudo leer una vez y la siguiente consulta falla, el nombre bueno se queda.
    const { rows } = await query(
      `INSERT INTO contacts (channel_id, platform, platform_user_id, name, phone_or_username, avatar_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (channel_id, platform_user_id) 
       DO UPDATE SET 
         name = CASE WHEN $7::boolean THEN contacts.name ELSE EXCLUDED.name END,
         phone_or_username = COALESCE(EXCLUDED.phone_or_username, contacts.phone_or_username),
         avatar_url = COALESCE(EXCLUDED.avatar_url, contacts.avatar_url)
       RETURNING id, channel_id, platform, platform_user_id, name, phone_or_username, avatar_url, created_at`,
      [channelId, platform, platformUserId.trim(), name.trim(), phoneOrUsername, avatarUrl, Boolean(nameIsPlaceholder)]
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
  },

  /**
   * Actualiza el perfil enriquecido de un contacto (nombre, username, avatar).
   */
  async updateProfile(id, { name = null, phoneOrUsername = null, avatarUrl = null }) {
    const { rows } = await query(
      `UPDATE contacts
       SET 
         name = COALESCE($1, name),
         phone_or_username = COALESCE($2, phone_or_username),
         avatar_url = COALESCE($3, avatar_url)
       WHERE id = $4
       RETURNING id, channel_id, platform, platform_user_id, name, phone_or_username, avatar_url`,
      [name ? name.trim() : null, phoneOrUsername ? phoneOrUsername.trim() : null, avatarUrl ? avatarUrl.trim() : null, id]
    );
    return rows[0] || null;
  }
};

export default contactRepository;
