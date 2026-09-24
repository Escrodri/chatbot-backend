import { query } from '../database/index.js';

/**
 * Cada captura de comprobante que llega, con lo que se leyó y lo que se decidió.
 *
 * Hasta ahora el pedido guardaba UN número de operación y nada más, y con eso
 * había cuatro cosas que no se podían saber:
 *
 *   - Si la persona pagó en dos partes. Transfería 10.000 y después 9.000, y
 *     cada comprobante por separado era "monto insuficiente": el sistema le
 *     pedía la diferencia dos veces y no le entregaba nunca, aunque ya había
 *     pagado todo.
 *   - Si pagó dos veces. El segundo comprobante llegaba a un pedido ya cobrado
 *     y se descartaba en silencio: la plata de más quedaba sin que nadie se
 *     enterara, hasta el reclamo.
 *   - Si ya había mandado esa misma captura. Se le contestaba lo mismo cada
 *     vez, como si fuera la primera.
 *   - Qué le pasó a cada comprobante, para poder contárselo a la IA cuando la
 *     persona pregunta "¿y lo que te pasé?".
 *
 * `recibido` es la columna que importa: marca los comprobantes que cuentan
 * como plata que llegó a nuestra cuenta para ESTE pedido. Solo esos suman, y
 * solo esos quedan bloqueados para cualquier otro pedido. El índice único
 * parcial sobre `clave` es lo que impide —en la base, no en el código— que una
 * misma transferencia se use dos veces, aunque lleguen las dos en el mismo
 * segundo desde dos chats distintos.
 */

/** Veredictos que cierran el caso de una captura: si vuelve, no se reevalúa. */
export const VEREDICTOS_FINALES = Object.freeze([
  'recibido',
  'destino_no_reconocido',
  'comprobante_viejo',
  'operacion_repetida',
  'moneda_distinta',
  'posible_pago_doble'
]);

export const comprobanteRepository = {
  /**
   * Todos los comprobantes de un pedido, del más viejo al más nuevo.
   *
   * @param {number} orderId
   */
  async delPedido(orderId) {
    const { rows } = await query(
      `SELECT id, order_id, conversation_id, message_id, clave, monto, moneda,
              cuenta, titular, fecha, hora, tipo, veredicto, recibido, created_at,
              precio_aplicado, precio_origen, oferta_id
         FROM comprobantes
        WHERE order_id = $1
        ORDER BY created_at ASC, id ASC`,
      [orderId]
    );
    return rows.map(r => ({ ...r, monto: r.monto === null ? null : Number(r.monto) }));
  },

  /**
   * ¿Esta transferencia ya cuenta para OTRO pedido?
   *
   * @param {string} clave
   * @param {number} orderId El pedido actual, que se excluye
   * @returns {Promise<{order_id:number}|null>}
   */
  async recibidoEnOtroPedido(clave, orderId) {
    if (!clave) return null;
    const { rows } = await query(
      `SELECT order_id
         FROM comprobantes
        WHERE clave = $1
          AND recibido = TRUE
          AND order_id <> $2
        LIMIT 1`,
      [String(clave), orderId]
    );
    return rows[0] || null;
  },

  /**
   * Anota un comprobante.
   *
   * Si se lo anota como `recibido` y esa clave ya está tomada por otro pedido,
   * la base lo rechaza con 23505 y esto devuelve `{ repetido: true }` en vez
   * de lanzar: no es una falla del sistema, es el sistema haciendo su trabajo.
   *
   * @returns {Promise<{ fila: object|null, repetido: boolean }>}
   */
  async registrar({
    orderId,
    conversationId = null,
    messageId = null,
    clave = null,
    monto = null,
    moneda = null,
    cuenta = null,
    titular = null,
    fecha = null,
    hora = null,
    tipo = null,
    veredicto,
    recibido = false,
    precioAplicado = null,
    precioOrigen = null,
    ofertaId = null
  }) {
    try {
      const { rows } = await query(
        `INSERT INTO comprobantes
           (order_id, conversation_id, message_id, clave, monto, moneda,
            cuenta, titular, fecha, hora, tipo, veredicto, recibido,
            precio_aplicado, precio_origen, oferta_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          orderId,
          conversationId,
          messageId,
          clave ? String(clave).slice(0, 80) : null,
          monto,
          moneda,
          cuenta ? String(cuenta).slice(0, 40) : null,
          titular ? String(titular).slice(0, 120) : null,
          fecha ? String(fecha).slice(0, 8) : null,
          hora ? String(hora).slice(0, 4) : null,
          tipo ? String(tipo).slice(0, 20) : null,
          String(veredicto).slice(0, 40),
          Boolean(recibido),
          precioAplicado,
          precioOrigen ? String(precioOrigen).slice(0, 160) : null,
          ofertaId
        ]
      );
      return { fila: rows[0] || null, repetido: false };
    } catch (err) {
      if (err.code === '23505') return { fila: null, repetido: true };
      throw err;
    }
  },

  /**
   * Cuánto llegó para este pedido, según los comprobantes que cuentan.
   *
   * @param {number} orderId
   * @returns {Promise<number>}
   */
  async totalRecibido(orderId) {
    const { rows } = await query(
      `SELECT COALESCE(SUM(monto), 0)::bigint AS total
         FROM comprobantes
        WHERE order_id = $1 AND recibido = TRUE`,
      [orderId]
    );
    return Number(rows[0]?.total || 0);
  }
};

export default comprobanteRepository;
