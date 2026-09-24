import { query } from '../database/index.js';

/**
 * Campañas de precio y las ofertas que recibe cada persona.
 *
 * Una campaña es la regla ("remarketing de octubre: 15.000 del 1 al 7, para
 * los que vienen del anuncio 1234"). Una oferta es el hecho ("a esta persona
 * le corresponde 15.000 desde el martes 10:14, porque tocó el anuncio 1234,
 * hasta el 7 a medianoche"). Las dos cosas quedan escritas: la regla para
 * poder cambiarla, el hecho para poder explicar después por qué a alguien se
 * le cobró lo que se le cobró.
 */

const COLUMNAS_CAMPANA = `c.id, c.nombre, c.product_id, c.precio, c.desde, c.hasta, c.alcance,
  c.anuncios, c.palabra_clave, c.gracia_horas, c.activa, c.created_at, c.updated_at`;

function numeros(fila) {
  if (!fila) return fila;
  return {
    ...fila,
    precio: fila.precio === null || fila.precio === undefined ? null : Number(fila.precio),
    gracia_horas: fila.gracia_horas === null || fila.gracia_horas === undefined ? null : Number(fila.gracia_horas)
  };
}

export const ofertaRepository = {
  // ── Campañas ──────────────────────────────────────────────────────────

  /**
   * Las campañas de un equipo, con cuánta gente entró y cuánto vendieron.
   *
   * @param {number|null} teamId null en bases sin equipos
   */
  async listarCampanas(teamId = null) {
    const { rows } = await query(
      `SELECT ${COLUMNAS_CAMPANA}, p.name AS product_name, p.price AS product_price,
              (SELECT COUNT(*) FROM ofertas f WHERE f.campana_id = c.id)::int AS personas,
              (SELECT COUNT(*) FROM orders o
                 WHERE o.campana_id = c.id AND o.status IN ('pagado', 'entregado'))::int AS ventas,
              (SELECT COALESCE(SUM(o.precio_cobrado), 0) FROM orders o
                 WHERE o.campana_id = c.id AND o.status IN ('pagado', 'entregado'))::bigint AS recaudado
         FROM campanas c
         JOIN products p ON p.id = c.product_id
        WHERE ($1::int IS NULL OR p.team_id IS NOT DISTINCT FROM $1::int)
        ORDER BY c.activa DESC, c.hasta DESC, c.id DESC`,
      [teamId]
    );
    return rows.map(r => ({
      ...numeros(r),
      product_price: Number(r.product_price),
      recaudado: Number(r.recaudado || 0)
    }));
  },

  async buscarCampana(id) {
    const { rows } = await query(
      `SELECT ${COLUMNAS_CAMPANA}, p.team_id, p.price AS product_price, p.name AS product_name
         FROM campanas c JOIN products p ON p.id = c.product_id
        WHERE c.id = $1`,
      [id]
    );
    return rows[0] ? { ...numeros(rows[0]), product_price: Number(rows[0].product_price) } : null;
  },

  async crearCampana(d) {
    const { rows } = await query(
      `INSERT INTO campanas
         (nombre, product_id, precio, desde, hasta, alcance, anuncios, palabra_clave, gracia_horas, activa, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
       RETURNING *`,
      [d.nombre, d.productId, d.precio, d.desde, d.hasta, d.alcance, d.anuncios || null,
       d.palabraClave || null, d.graciaHoras, d.userId || null]
    );
    return numeros(rows[0]);
  },

  async actualizarCampana(id, d) {
    const { rows } = await query(
      `UPDATE campanas
          SET nombre = $2, precio = $3, desde = $4, hasta = $5, alcance = $6,
              anuncios = $7, palabra_clave = $8, gracia_horas = $9, activa = $10,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *`,
      [id, d.nombre, d.precio, d.desde, d.hasta, d.alcance, d.anuncios || null,
       d.palabraClave || null, d.graciaHoras, d.activa]
    );
    return numeros(rows[0] || null);
  },

  /**
   * Campañas "solo invitados" que están corriendo ahora: las que hay que
   * mirar cuando entra un mensaje, para ver si esta persona llegó por el
   * anuncio o escribió la palabra.
   */
  async campanasInvitadosEnCurso() {
    const { rows } = await query(
      `SELECT ${COLUMNAS_CAMPANA}
         FROM campanas c
        WHERE c.activa = TRUE AND c.alcance = 'invitados'
          AND c.desde <= CURRENT_TIMESTAMP AND c.hasta >= CURRENT_TIMESTAMP`
    );
    return rows.map(numeros);
  },

  /**
   * Campañas de un producto que podrían aplicar en algún momento cercano.
   *
   * Se traen todas las activas del producto y el filtro fino por fecha se
   * hace en el servicio, que es el que sabe qué momentos importan: la hora
   * de la transferencia y la de ahora.
   */
  async campanasDelProducto(productId) {
    if (!productId) return [];
    const { rows } = await query(
      `SELECT ${COLUMNAS_CAMPANA}
         FROM campanas c
        WHERE c.product_id = $1 AND c.activa = TRUE`,
      [productId]
    );
    return rows.map(numeros);
  },

  // ── Ofertas ───────────────────────────────────────────────────────────

  /**
   * Las ofertas de una persona para un producto (y las que valen para
   * cualquier producto), con los datos de su campaña si tiene.
   */
  async deConversacion(conversationId, productId = null) {
    if (!conversationId) return [];
    const { rows } = await query(
      `SELECT f.id, f.conversation_id, f.product_id, f.precio, f.origen, f.campana_id,
              f.detalle, f.desde, f.hasta, f.created_at,
              c.nombre AS campana_nombre, c.gracia_horas, c.activa AS campana_activa
         FROM ofertas f
         LEFT JOIN campanas c ON c.id = f.campana_id
        WHERE f.conversation_id = $1
          AND (f.product_id IS NULL OR $2::int IS NULL OR f.product_id = $2::int)
        ORDER BY f.desde ASC, f.id ASC`,
      [conversationId, productId]
    );
    return rows.map(numeros);
  },

  /**
   * Anota una oferta. Si es de una campaña y la persona ya estaba en ella,
   * no hace nada y devuelve null: entrar dos veces a la misma campaña no
   * cambia la fecha en que entró.
   */
  async crearOferta({ conversationId, productId = null, precio, origen, campanaId = null, detalle = null, desde = null, hasta = null }) {
    const { rows } = await query(
      `INSERT INTO ofertas (conversation_id, product_id, precio, origen, campana_id, detalle, desde, hasta)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, CURRENT_TIMESTAMP), $8)
       ON CONFLICT (conversation_id, campana_id) WHERE campana_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [conversationId, productId, precio, origen, campanaId,
       detalle ? String(detalle).slice(0, 200) : null, desde, hasta]
    );
    return numeros(rows[0] || null);
  }
};

export default ofertaRepository;
