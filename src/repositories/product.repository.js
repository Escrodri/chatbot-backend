import { query } from '../database/index.js';

/**
 * Repositorio de Productos Digitales.
 *
 * El catálogo vive acá y en ningún otro lado. La web, el bot de n8n y los
 * asesores leen todos de esta tabla, así que un cambio de precio se hace una
 * sola vez y llega a los tres al mismo tiempo. Antes el catálogo estaba
 * escrito a mano dentro del flujo de n8n: cada cambio obligaba a editar el
 * flujo y era cuestión de tiempo que el bot cotizara un precio viejo.
 */
export const productRepository = {
  /**
   * Lista los productos de un equipo.
   *
   * @param {{ teamId?: number|null, soloActivos?: boolean }} opciones
   * @returns {Promise<object[]>}
   */
  async list({ teamId = null, soloActivos = true } = {}) {
    const condiciones = [];
    const params = [];

    if (teamId) {
      params.push(teamId);
      condiciones.push(`team_id = $${params.length}`);
    }

    if (soloActivos) {
      condiciones.push('is_active = TRUE');
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT id, team_id, slug, name, description, price, currency,
              delivery_url, delivery_note, cover_url, is_active, sort_order,
              created_at, updated_at
       FROM products
       ${where}
       ORDER BY sort_order ASC, id ASC`,
      params
    );

    return rows;
  },

  async findById(id) {
    const { rows } = await query(`SELECT * FROM products WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  async findBySlug(slug) {
    const { rows } = await query(`SELECT * FROM products WHERE slug = $1`, [slug]);
    return rows[0] || null;
  },

  async create({
    teamId = null,
    slug,
    name,
    description = '',
    price,
    currency = 'PYG',
    deliveryUrl = null,
    deliveryNote = null,
    coverUrl = null,
    isActive = true,
    sortOrder = 0
  }) {
    const { rows } = await query(
      `INSERT INTO products
         (team_id, slug, name, description, price, currency,
          delivery_url, delivery_note, cover_url, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [teamId, slug, name, description, price, currency,
       deliveryUrl, deliveryNote, coverUrl, isActive, sortOrder]
    );
    return rows[0];
  },

  /**
   * Actualiza solo los campos presentes en `cambios`.
   * Se construye la sentencia con una lista blanca: lo que no esté acá no se toca.
   */
  async update(id, cambios = {}) {
    const permitidos = {
      slug: 'slug',
      name: 'name',
      description: 'description',
      price: 'price',
      currency: 'currency',
      deliveryUrl: 'delivery_url',
      deliveryNote: 'delivery_note',
      coverUrl: 'cover_url',
      isActive: 'is_active',
      sortOrder: 'sort_order'
    };

    const sets = [];
    const params = [];

    for (const [clave, columna] of Object.entries(permitidos)) {
      if (cambios[clave] !== undefined) {
        params.push(cambios[clave]);
        sets.push(`${columna} = $${params.length}`);
      }
    }

    if (sets.length === 0) return this.findById(id);

    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const { rows } = await query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    return rows[0] || null;
  },

  /**
   * Baja lógica: el producto deja de ofrecerse pero las ventas viejas que lo
   * referencian siguen teniendo sentido.
   */
  async desactivar(id) {
    const { rows } = await query(
      `UPDATE products SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0] || null;
  }
};

export default productRepository;
