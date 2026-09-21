import { query } from '../database/index.js';

/**
 * Etiquetas de conversación, por equipo.
 *
 * Reemplazan a las que vivían en localStorage. La diferencia que importa: si un
 * asesor marca un chat como "Mayorista", el resto del equipo lo ve.
 */
const SEMILLA = [
  { name: 'Cliente nuevo', color: '#2563eb', sort_order: 0 },
  { name: 'Mayorista',     color: '#7c3aed', sort_order: 1 },
  { name: 'Seguimiento',   color: '#b45309', sort_order: 2 },
  { name: 'Reclamo',       color: '#b91c1c', sort_order: 3 },
  { name: 'Recomendado',   color: '#047857', sort_order: 4 }
];

export const tagRepository = {
  async listByTeam(teamId) {
    const { rows } = await query(
      `SELECT id, team_id, name, color, sort_order
       FROM tags
       WHERE team_id IS NOT DISTINCT FROM $1
       ORDER BY sort_order ASC, name ASC`,
      [teamId]
    );
    return rows;
  },

  /**
   * Devuelve las etiquetas del equipo, sembrando un juego inicial la primera
   * vez. Sin esto el panel abre vacío y no queda claro qué hacer.
   */
  async listOrSeed(teamId) {
    const existentes = await this.listByTeam(teamId);
    if (existentes.length > 0) return existentes;

    for (const t of SEMILLA) {
      await query(
        `INSERT INTO tags (team_id, name, color, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, name) DO NOTHING`,
        [teamId, t.name, t.color, t.sort_order]
      );
    }
    return this.listByTeam(teamId);
  },

  /**
   * Devuelve la etiqueta con ese nombre, y si no existe la crea.
   *
   * La usan las etiquetas que se ponen solas, como "Ya compró". Se busca sin
   * distinguir mayúsculas para no terminar con "Ya compró" y "Ya Compró"
   * conviviendo en la misma lista.
   */
  async asegurar({ teamId, name, color = '#6b7280' }) {
    const { rows } = await query(
      `SELECT * FROM tags WHERE team_id IS NOT DISTINCT FROM $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [teamId, name]
    );
    if (rows[0]) return rows[0];
    return this.create({ teamId, name, color });
  },

  async create({ teamId, name, color = '#6b7280', sortOrder = 0 }) {
    const { rows } = await query(
      `INSERT INTO tags (team_id, name, color, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, name) DO UPDATE SET color = EXCLUDED.color
       RETURNING *`,
      [teamId, name.trim(), color, sortOrder]
    );
    return rows[0];
  },

  async remove(id, teamId) {
    const { rows } = await query(
      `DELETE FROM tags
       WHERE id = $1 AND team_id IS NOT DISTINCT FROM $2
       RETURNING id`,
      [id, teamId]
    );
    return rows[0] || null;
  },

  /** Etiquetas puestas en una conversación. */
  async listByConversation(conversationId) {
    const { rows } = await query(
      `SELECT t.id, t.name, t.color, ct.assigned_at, u.name AS assigned_by_name
       FROM conversation_tags ct
       INNER JOIN tags t ON ct.tag_id = t.id
       LEFT JOIN users u ON ct.assigned_by = u.id
       WHERE ct.conversation_id = $1
       ORDER BY t.sort_order ASC, t.name ASC`,
      [conversationId]
    );
    return rows;
  },

  async assign(conversationId, tagId, userId = null) {
    await query(
      `INSERT INTO conversation_tags (conversation_id, tag_id, assigned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, tag_id) DO NOTHING`,
      [conversationId, tagId, userId]
    );
    return this.listByConversation(conversationId);
  },

  async unassign(conversationId, tagId) {
    await query(
      `DELETE FROM conversation_tags WHERE conversation_id = $1 AND tag_id = $2`,
      [conversationId, tagId]
    );
    return this.listByConversation(conversationId);
  }
};

export default tagRepository;
