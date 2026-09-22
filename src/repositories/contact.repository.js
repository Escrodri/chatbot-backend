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
   * Listado de contactos reales, con su última actividad.
   *
   * Los contactos de este sistema no se cargan a mano: aparecen cuando alguien
   * escribe por WhatsApp, Messenger o Instagram. Por eso esto es una consulta y
   * no un CRUD — el directorio refleja quién te habló, no una lista que alguien
   * mantiene.
   */
  async listWithFilters({ teamId = null, platform = null, search = null, assignedChannelIds = null, limit = 200, offset = 0 } = {}) {
    const condiciones = ['ch.deleted_at IS NULL'];
    const params = [];
    let i = 1;

    if (teamId) { 
      condiciones.push(`(ch.team_id = $${i++} OR ch.team_id IS NULL)`); 
      params.push(teamId); 
    }

    if (assignedChannelIds && Array.isArray(assignedChannelIds) && assignedChannelIds.length > 0) {
      condiciones.push(`ct.channel_id = ANY($${i++})`);
      params.push(assignedChannelIds);
    }

    if (platform) {
      const isFbOrMsg = platform.toLowerCase() === 'facebook' || platform.toLowerCase() === 'messenger';
      if (isFbOrMsg) {
        condiciones.push(`(LOWER(ct.platform) = 'facebook' OR LOWER(ct.platform) = 'messenger')`);
      } else {
        condiciones.push(`ct.platform = $${i++}`);
        params.push(platform);
      }
    }

    if (search) {
      condiciones.push(`(ct.name ILIKE $${i} OR ct.phone_or_username ILIKE $${i} OR ct.platform_user_id ILIKE $${i})`);
      params.push(`%${search.trim()}%`);
      i++;
    }

    params.push(Math.min(limit, 500));
    params.push(offset);

    const { rows } = await query(
      `SELECT
         ct.id, ct.channel_id, ct.platform, ct.platform_user_id,
         ct.name, ct.phone_or_username, ct.avatar_url, ct.created_at,
         ch.name AS channel_name,
         c.id AS conversation_id,
         c.last_message_time,
         c.last_message_text,
         o.status AS order_status
       FROM contacts ct
       INNER JOIN channels ch ON ct.channel_id = ch.id
       LEFT JOIN LATERAL (
         SELECT id, last_message_time, last_message_text
         FROM conversations
         WHERE contact_id = ct.id
         ORDER BY last_message_time DESC
         LIMIT 1
       ) c ON TRUE
       LEFT JOIN LATERAL (
         SELECT status FROM orders
         WHERE conversation_id = c.id
         ORDER BY updated_at DESC
         LIMIT 1
       ) o ON TRUE
       WHERE ${condiciones.join(' AND ')}
       ORDER BY c.last_message_time DESC NULLS LAST, ct.id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      params
    );
    return rows;
  },

  /** Totales por plataforma, para la cabecera del directorio. */
  async stats({ teamId = null, assignedChannelIds = null } = {}) {
    const condiciones = ['ch.deleted_at IS NULL'];
    const params = [];
    let i = 1;

    if (teamId) { 
      condiciones.push(`(ch.team_id = $${i++} OR ch.team_id IS NULL)`); 
      params.push(teamId); 
    }

    if (assignedChannelIds && Array.isArray(assignedChannelIds) && assignedChannelIds.length > 0) {
      condiciones.push(`ct.channel_id = ANY($${i++})`);
      params.push(assignedChannelIds);
    }

    const { rows } = await query(
      `SELECT ct.platform, COUNT(*)::int AS cantidad
       FROM contacts ct
       INNER JOIN channels ch ON ct.channel_id = ch.id
       WHERE ${condiciones.join(' AND ')}
       GROUP BY ct.platform`,
      params
    );

    return {
      total: rows.reduce((acc, r) => acc + r.cantidad, 0),
      porPlataforma: rows
    };
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
