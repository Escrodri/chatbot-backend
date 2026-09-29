import { query } from '../database/index.js';

/**
 * ¿La tabla todavía no existe? Pasa en el primer arranque, antes de que corran
 * las migraciones. Un pedido sin extras se cobra y se entrega igual, así que
 * en ese caso se responde "no hay nada sumado" en vez de romper el cobro.
 */
function sinTabla(err) {
  return err?.code === '42P01';
}

/**
 * Lo que se sumó a un pedido además del producto principal.
 *
 * Hoy es el producto extra (order bump) que se acepta antes de recibir los
 * datos de pago. El principal sigue en `orders.product_id`, así los pedidos
 * que ya existen no cambian y todo lo que los lee sigue funcionando.
 *
 * El nombre y el precio se copian al momento de sumarlo: si mañana se cambia
 * el precio del extra en el panel, lo que esta persona tiene que pagar no
 * puede cambiar con él.
 */
export const pedidoItemRepository = {
  /**
   * Suma un producto al pedido. Si ya estaba, no lo duplica ni le cambia el precio.
   *
   * @param {{ orderId:number, productId:number, nombre:string, precio:number, tipo?:string }} item
   * @returns {Promise<object|null>} La fila, nueva o la que ya estaba
   */
  async agregar({ orderId, productId, nombre, precio, tipo = 'extra' }) {
    const { rows } = await query(
      `INSERT INTO pedido_items (order_id, product_id, nombre, precio, tipo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id, product_id) DO NOTHING
       RETURNING *`,
      [orderId, productId, String(nombre || '').slice(0, 255), precio, tipo]
    );
    if (rows[0]) return rows[0];

    const { rows: existentes } = await query(
      `SELECT * FROM pedido_items WHERE order_id = $1 AND product_id = $2`,
      [orderId, productId]
    );
    return existentes[0] || null;
  },

  /**
   * Saca todos los extras del pedido: quien dijo "No" no paga ningún extra,
   * aunque el que había aceptado antes ya no sea el que se ofrece hoy.
   */
  async quitarExtras(orderId) {
    try {
      await query(`DELETE FROM pedido_items WHERE order_id = $1 AND tipo = 'extra'`, [orderId]);
      return true;
    } catch (err) {
      if (sinTabla(err)) return false;
      throw err;
    }
  },

  /** Saca un producto del pedido. */
  async quitar(orderId, productId) {
    try {
      const { rowCount } = await query(
        `DELETE FROM pedido_items WHERE order_id = $1 AND product_id = $2`,
        [orderId, productId]
      );
      return rowCount > 0;
    } catch (err) {
      if (sinTabla(err)) return false;
      throw err;
    }
  },

  /**
   * Lo sumado a un pedido, con lo que hace falta para entregarlo.
   *
   * @param {number} orderId
   * @returns {Promise<object[]>}
   */
  async listar(orderId) {
    let rows = [];
    try {
      ({ rows } = await query(
      `SELECT i.id, i.order_id, i.product_id, i.nombre, i.precio, i.tipo, i.created_at,
              p.name AS product_name, p.delivery_url, p.entregables, p.currency
         FROM pedido_items i
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.order_id = $1
        ORDER BY i.id ASC`,
      [orderId]
      ));
    } catch (err) {
      if (sinTabla(err)) return [];
      throw err;
    }
    return rows;
  },

  /**
   * Cuánto suma lo agregado a un pedido. 0 si no hay nada.
   *
   * @param {number} orderId
   * @returns {Promise<number>}
   */
  async totalExtras(orderId) {
    try {
      const { rows } = await query(
        `SELECT COALESCE(SUM(precio), 0) AS total FROM pedido_items WHERE order_id = $1`,
        [orderId]
      );
      return Number(rows[0]?.total) || 0;
    } catch (err) {
      if (sinTabla(err)) return 0;
      throw err;
    }
  }
};

export default pedidoItemRepository;
