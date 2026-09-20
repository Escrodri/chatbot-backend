import { query, pool } from '../database/index.js';

/**
 * Repositorio de Usuarios: Acceso a datos exclusivo para operadores y administradores.
 * Todas las consultas están parametrizadas contra Inyección SQL.
 */
export const userRepository = {
  /**
   * Busca un usuario por su correo electrónico.
   * @param {string} email
   * @returns {Promise<object|null>}
   */
  async findByEmail(email) {
    const { rows } = await query(
      'SELECT id, team_id, email, password_hash, name, role, is_active, created_at FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    return rows[0] || null;
  },

  /**
   * Busca un usuario por su ID único.
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      'SELECT id, team_id, email, name, role, is_active, created_at FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  /**
   * Lista todos los operadores de un equipo (omite password_hash por seguridad).
   * Incluye los IDs de canales asignados para poder pintarlos en el panel.
   * @param {number} [teamId]
   * @returns {Promise<Array>}
   */
  async listAll(teamId) {
    let sql = `SELECT
         u.id, u.team_id, u.email, u.name, u.role, u.is_active, u.created_at,
         COALESCE(
           ARRAY_AGG(a.channel_id ORDER BY a.channel_id) FILTER (WHERE a.channel_id IS NOT NULL),
           '{}'
         ) AS channel_ids
       FROM users u
       LEFT JOIN user_channel_assignments a ON a.user_id = u.id`;
    const params = [];

    if (teamId) {
      sql += ` WHERE u.team_id = $1`;
      params.push(teamId);
    }

    sql += ` GROUP BY u.id ORDER BY u.id ASC`;

    const { rows } = await query(sql, params);
    return rows;
  },

  /**
   * Registra un nuevo operador en la base de datos.
   * @param {{ teamId?: number, email: string, passwordHash: string, name: string, role?: string, isActive?: boolean }} data
   * @returns {Promise<object>}
   */
  async create({ teamId = 1, email, passwordHash, name, role = 'agent', isActive = true }) {
    const { rows } = await query(
      `INSERT INTO users (team_id, email, password_hash, name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, team_id, email, name, role, is_active, created_at`,
      [teamId, email.toLowerCase().trim(), passwordHash, name.trim(), role, isActive]
    );
    return rows[0];
  },

  /**
   * Obtiene la lista de IDs de canales a los que un operador tiene acceso explícito (Aislamiento IDOR).
   * @param {number} userId
   * @returns {Promise<number[]>}
   */
  async getAssignedChannelIds(userId) {
    const { rows } = await query(
      'SELECT channel_id FROM user_channel_assignments WHERE user_id = $1',
      [userId]
    );
    return rows.map(r => r.channel_id);
  },

  /**
   * Asigna un canal a un operador.
   * @param {number} userId
   * @param {number} channelId
   * @returns {Promise<void>}
   */
  async assignChannel(userId, channelId) {
    await query(
      `INSERT INTO user_channel_assignments (user_id, channel_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, channel_id) DO NOTHING`,
      [userId, channelId]
    );
  },

  /**
   * Remueve la asignación de un canal a un operador.
   * @param {number} userId
   * @param {number} channelId
   * @returns {Promise<void>}
   */
  async unassignChannel(userId, channelId) {
    await query(
      'DELETE FROM user_channel_assignments WHERE user_id = $1 AND channel_id = $2',
      [userId, channelId]
    );
  },

  /**
   * Reemplaza por completo los canales asignados a un operador, de forma atómica.
   * Es la operación que usa el panel de administración (A-03).
   *
   * @param {number} userId
   * @param {number[]} channelIds Lista completa y definitiva de canales
   * @returns {Promise<number[]>} Los canales que quedaron asignados
   */
  async setAssignedChannels(userId, channelIds = []) {
    const limpios = [...new Set(
      (channelIds || [])
        .map(id => parseInt(id, 10))
        .filter(id => Number.isInteger(id))
    )];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM user_channel_assignments WHERE user_id = $1', [userId]);

      if (limpios.length > 0) {
        // Solo se asignan canales que existan de verdad.
        await client.query(
          `INSERT INTO user_channel_assignments (user_id, channel_id)
           SELECT $1, c.id FROM channels c WHERE c.id = ANY($2::int[])
           ON CONFLICT (user_id, channel_id) DO NOTHING`,
          [userId, limpios]
        );
      }

      const { rows } = await client.query(
        'SELECT channel_id FROM user_channel_assignments WHERE user_id = $1 ORDER BY channel_id',
        [userId]
      );

      await client.query('COMMIT');
      return rows.map(r => r.channel_id);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  /**
   * Actualiza los datos de un usuario existente.
   * @param {number} userId
   * @param {{ name?: string, email?: string, role?: string, isActive?: boolean, passwordHash?: string, teamId?: number }} data
   * @returns {Promise<object|null>}
   */
  async updateUser(userId, data = {}) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (data.name !== undefined && String(data.name).trim()) {
      fields.push(`name = $${idx++}`);
      values.push(String(data.name).trim());
    }
    if (data.email !== undefined && String(data.email).trim()) {
      fields.push(`email = $${idx++}`);
      values.push(String(data.email).toLowerCase().trim());
    }
    if (data.role !== undefined && ['admin', 'agent', 'superadmin'].includes(data.role)) {
      fields.push(`role = $${idx++}`);
      values.push(data.role);
    }
    if (data.isActive !== undefined) {
      fields.push(`is_active = $${idx++}`);
      values.push(Boolean(data.isActive));
    }
    if (data.passwordHash) {
      fields.push(`password_hash = $${idx++}`);
      values.push(data.passwordHash);
    }
    if (data.teamId !== undefined && Number.isInteger(data.teamId)) {
      fields.push(`team_id = $${idx++}`);
      values.push(data.teamId);
    }

    if (fields.length > 0) {
      values.push(userId);
      await query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`,
        values
      );
    }

    return this.findById(userId);
  },

  /**
   * Alterna el estado activo/inactivo de un usuario (soft toggle).
   * @param {number} userId
   * @returns {Promise<object|null>}
   */
  async toggleStatus(userId) {
    const user = await this.findById(userId);
    if (!user) return null;

    const newStatus = !user.is_active;
    const { rows } = await query(
      `UPDATE users SET is_active = $1 WHERE id = $2 RETURNING id, team_id, email, name, role, is_active, created_at`,
      [newStatus, userId]
    );
    return rows[0] || null;
  }
};

export default userRepository;
