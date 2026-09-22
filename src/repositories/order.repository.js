import { query } from '../database/index.js';

/**
 * Repositorio de Pedidos.
 *
 * Reemplaza a la planilla de "Ventas" y "No Pagados" del flujo viejo. La
 * diferencia no es solo de formato: acá el estado de cada pedido vive al lado
 * de la conversación que lo originó, así que el asesor abre un chat y ve en
 * qué anda esa persona sin cambiar de pestaña.
 *
 * Estados: interesado → comprobante_recibido → pagado → entregado
 *          (o rechazado, si el comprobante no era válido)
 */
export const orderRepository = {
  /**
   * Busca un pedido por conversación y producto.
   * Es el "buscar duplicado" del flujo: si ya existe y está pagado, la persona
   * no tiene que volver a pagar ni el bot tiene que volver a cobrarle.
   */
  async findByConversationAndProduct(conversationId, productId = null) {
    if (productId) {
      const { rows } = await query(
        `SELECT * FROM orders WHERE conversation_id = $1 AND product_id = $2`,
        [conversationId, productId]
      );
      return rows[0] || null;
    }

    const { rows } = await query(
      `SELECT * FROM orders WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
      [conversationId]
    );
    return rows[0] || null;
  },

  /**
   * Un pedido con todo lo que hace falta para entregarlo: el nombre del
   * producto y su enlace de descarga. El enlace vive en el producto, no en el
   * pedido, porque es el mismo para todos los que compran ese material.
   */
  async findConEntrega(id) {
    const { rows } = await query(
      `SELECT o.*, p.name AS product_name, p.slug AS product_slug,
              p.delivery_url, p.delivery_note
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       WHERE o.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  /** Todos los pedidos de una conversación, con el nombre del producto resuelto. */
  async listByConversation(conversationId) {
    const { rows } = await query(
      `SELECT o.*, p.name AS product_name, p.slug AS product_slug,
              p.delivery_url, p.delivery_note
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       WHERE o.conversation_id = $1
       ORDER BY o.id DESC`,
      [conversationId]
    );
    return rows;
  },

  /**
   * Listado general con filtros. Es lo que alimenta el tablero de
   * "quién pagó y quién no".
   */
  async list({ status = null, phone = null, limit = 100, offset = 0 } = {}) {
    const condiciones = [];
    const params = [];

    if (status) {
      params.push(status);
      condiciones.push(`o.status = $${params.length}`);
    }

    if (phone) {
      params.push(`%${phone}%`);
      condiciones.push(`o.contact_phone ILIKE $${params.length}`);
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    params.push(Math.min(limit, 500));
    params.push(offset);

    const { rows } = await query(
      `SELECT o.*, p.name AS product_name, p.slug AS product_slug,
              (p.delivery_url IS NOT NULL AND p.delivery_url <> '') AS product_entregable
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       ${where}
       ORDER BY o.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  },

  /**
   * Crea el pedido o, si ya existía uno para esa conversación y producto,
   * devuelve el que hay. Se usa UPSERT y no un SELECT previo para que dos
   * mensajes que llegan casi juntos no creen dos pedidos.
   */
  async crearOObtener({
    conversationId,
    productId = null,
    contactPhone = null,
    contactName = null,
    amount = null,
    currency = 'PYG',
    status = 'interesado'
  }) {
    const { rows } = await query(
      `INSERT INTO orders
         (conversation_id, product_id, contact_phone, contact_name, amount, currency, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (conversation_id, product_id) DO UPDATE
         SET updated_at = CURRENT_TIMESTAMP,
             -- Cada mensaje que entra sin que el pedido avance suma uno. El
             -- flujo lo usa para saber cuándo el guion dejó de servir.
             bot_intentos = orders.bot_intentos + 1
       RETURNING *`,
      [conversationId, productId, contactPhone, contactName, amount, currency, status]
    );
    return rows[0];
  },

  /**
   * Cambia el estado del pedido.
   *
   * 'pagado' y 'entregado' sellan además la fecha y quién lo confirmó, porque
   * son los dos momentos que después alguien va a querer auditar.
   */
  async cambiarEstado(id, estado, { confirmedBy = null, note = null, receiptCheck = null, receiptMessageId = null } = {}) {
    // Que el pedido avance significa que el guion sí entendió: el contador de
    // intentos vuelve a cero y la IA deja de estar a un paso de intervenir.
    const sets = ['status = $1', 'updated_at = CURRENT_TIMESTAMP', 'bot_intentos = 0'];
    const params = [estado];

    if (estado === 'pagado') {
      sets.push('confirmed_at = CURRENT_TIMESTAMP');
      params.push(confirmedBy);
      sets.push(`confirmed_by = $${params.length}`);
    } else if (estado === 'entregado') {
      sets.push('delivered_at = CURRENT_TIMESTAMP');
    } else {
      // Si se revierte a interesado, comprobante_recibido o rechazado, limpiamos marcas de entrega
      sets.push('delivered_at = NULL');
      if (estado === 'interesado' || estado === 'comprobante_recibido') {
        sets.push('confirmed_at = NULL', 'confirmed_by = NULL');
      }
    }

    if (note !== null) {
      params.push(note);
      sets.push(`note = $${params.length}`);
    }

    if (receiptCheck !== null) {
      params.push(receiptCheck);
      sets.push(`receipt_check = $${params.length}`);
    }

    if (receiptMessageId !== null) {
      params.push(receiptMessageId);
      sets.push(`receipt_message_id = $${params.length}`);
    }

    params.push(id);

    const { rows } = await query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return rows[0] || null;
  },

  /** Resumen para el tablero: cuántos hay en cada estado. */
  async resumen() {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS cantidad, COALESCE(SUM(amount), 0) AS monto
       FROM orders GROUP BY status`
    );
    return rows;
  }
};

export default orderRepository;
