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
   * `soloVendibles` deja afuera los que solo se venden como extra de otro:
   * el bot no los ofrece sueltos ni los muestra en la lista de productos.
   *
   * @param {{ teamId?: number|null, soloActivos?: boolean, soloVendibles?: boolean }} opciones
   * @returns {Promise<object[]>}
   */
  async list({ teamId = null, soloActivos = true, soloVendibles = false } = {}) {
    const condiciones = [];
    const params = [];

    if (teamId) {
      params.push(teamId);
      condiciones.push(`(team_id = $${params.length} OR team_id IS NULL)`);
    }

    if (soloActivos) {
      condiciones.push('is_active = TRUE');
    }

    if (soloVendibles) {
      condiciones.push('COALESCE(solo_extra, FALSE) = FALSE');
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const { rows } = await query(
      `SELECT id, team_id, slug, name, description, resumen, price, currency,
              precio_recuperacion, preview_urls, mensajes,
              delivery_url, delivery_note, entregables, bump, solo_extra,
              cover_url, is_active, sort_order,
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

  /** Varios productos por id, en una sola consulta. */
  async findByIds(ids = []) {
    const limpios = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!limpios.length) return [];
    const { rows } = await query(`SELECT * FROM products WHERE id = ANY($1::int[])`, [limpios]);
    return rows;
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
    resumen = null,
    price,
    currency = 'PYG',
    deliveryUrl = null,
    deliveryNote = null,
    coverUrl = null,
    isActive = true,
    sortOrder = 0,
    precioRecuperacion = null,
    previewUrls = null,
    mensajes = {},
    entregables = [],
    bump = {},
    soloExtra = false
  }) {
    const { rows } = await query(
      `INSERT INTO products
         (team_id, slug, name, description, resumen, price, currency,
          delivery_url, delivery_note, cover_url, is_active, sort_order,
          precio_recuperacion, preview_urls, mensajes, entregables, bump, solo_extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
       RETURNING *`,
      [teamId, slug, name, description, resumen, price, currency,
       deliveryUrl, deliveryNote, coverUrl, isActive, sortOrder,
       precioRecuperacion, previewUrls, JSON.stringify(mensajes || {}),
       JSON.stringify(entregables || []), JSON.stringify(bump || {}), Boolean(soloExtra)]
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
      resumen: 'resumen',
      price: 'price',
      currency: 'currency',
      deliveryUrl: 'delivery_url',
      deliveryNote: 'delivery_note',
      coverUrl: 'cover_url',
      isActive: 'is_active',
      sortOrder: 'sort_order',
      precioRecuperacion: 'precio_recuperacion',
      previewUrls: 'preview_urls',
      mensajes: 'mensajes',
      entregables: 'entregables',
      bump: 'bump',
      soloExtra: 'solo_extra',
      teamId: 'team_id'
    };

    const JSON_COLS = { mensajes: '{}', entregables: '[]', bump: '{}' };

    const sets = [];
    const params = [];

    for (const [clave, columna] of Object.entries(permitidos)) {
      if (cambios[clave] !== undefined) {
        // JSONB va como texto y se castea: si se pasara el objeto tal cual, pg
        // convertiría los arreglos de adentro al formato de arreglo de Postgres.
        const esJson = Object.prototype.hasOwnProperty.call(JSON_COLS, columna);
        params.push(esJson
          ? JSON.stringify(cambios[clave] || JSON.parse(JSON_COLS[columna]))
          : cambios[clave]);
        sets.push(`${columna} = $${params.length}${esJson ? '::jsonb' : ''}`);
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
