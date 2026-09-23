import { query } from '../database/index.js';

/**
 * El recorrido completo, en orden.
 *
 * Es una escalera: se sube de a un escalón o de varios, pero nunca se baja. Si
 * alguien que ya pidió los datos de pago vuelve a escribir "hola", sigue
 * siendo alguien que pidió los datos de pago — tratarlo otra vez como un
 * curioso sería perder justo el dato que dice que estuvo a punto de comprar.
 *
 * El orden importa más que los nombres: es lo que convierte una lista de
 * etiquetas en un embudo que se puede medir.
 */
export const ETAPAS = Object.freeze([
  'entro',              // Escribió por primera vez
  'vio_producto',       // Recibió la presentación con el precio
  'vio_muestras',       // Pidió ver páginas de muestra
  'pidio_comprar',      // Dijo que sí o tocó el botón de comprar
  'recibio_datos',      // Se le mandaron los datos de la transferencia
  'mando_comprobante',  // Mandó la captura
  'pago',               // El pago quedó confirmado
  'recibio_material'    // Se le entregó el enlace
]);

/**
 * ¿Esta base tiene la columna de equipo en los canales?
 *
 * No en todas existe. La migración multi-tenant agrega `channels.team_id` con
 * una llave foránea a `teams`, y si esa tabla no está, el ALTER falla, se
 * registra un aviso y sigue de largo. Queda entonces una base funcionando
 * perfectamente pero sin esa columna.
 *
 * Escribir el filtro de equipo dando por hecho que existe era romper el
 * tablero de pedidos en cuanto se subiera: la consulta entera falla, no
 * devuelve un pedido de menos. Así que se pregunta una vez, se recuerda la
 * respuesta, y donde no hay equipos simplemente no se filtra por equipo.
 *
 * @returns {Promise<boolean>}
 */
let _soportaEquipos = null;
async function soportaEquipos() {
  if (_soportaEquipos !== null) return _soportaEquipos;
  try {
    const { rows } = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'team_id'
       LIMIT 1`
    );
    _soportaEquipos = rows.length > 0;
  } catch {
    _soportaEquipos = false;
  }
  return _soportaEquipos;
}

/** Posición de una etapa en la escalera, o -1 si no existe. */
export function posicionEtapa(etapa) {
  return ETAPAS.indexOf(String(etapa || ''));
}

/**
 * La etapa que le corresponde a un estado del pedido, cuando hay una.
 *
 * Existe para que las dos columnas no se contradigan: marcar un pedido como
 * pagado a mano desde el tablero tiene que mover el embudo igual que si lo
 * hubiera movido el guion, o las métricas van a decir que nadie llegó nunca a
 * pagar.
 */
export function etapaSegunEstado(estado) {
  const mapa = {
    comprobante_recibido: 'mando_comprobante',
    pagado: 'pago',
    entregado: 'recibio_material'
  };
  return mapa[estado] || null;
}

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
    const conEquipos = await soportaEquipos();

    const { rows } = await query(
      // El precio viene del producto y no de la columna `amount` del pedido:
      // los pedidos que abre el guion nacen sin monto, así que validar un
      // comprobante contra `amount` sería validarlo contra un nulo.
      //
      // Trae además de quién es el pedido —canal y equipo— porque las tres
      // rutas que lo modifican necesitan comprobarlo antes de cobrar o
      // entregar, y sin esto lo estaban haciendo a ciegas.
      `SELECT o.*, p.name AS product_name, p.slug AS product_slug,
              p.price, p.delivery_url, p.delivery_note,
              c.channel_id, ${conEquipos ? 'ch.team_id' : 'NULL::int AS team_id'}
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       LEFT JOIN conversations c ON o.conversation_id = c.id
       LEFT JOIN channels ch ON c.channel_id = ch.id
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
  async list({ status = null, phone = null, teamId = null, assignedChannelIds = null, limit = 100, offset = 0 } = {}) {
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

    // Aislamiento por equipo. El tablero de pedidos mostraba los pedidos de
    // todos los equipos a cualquiera con sesión: teléfonos, nombres y montos
    // de negocios ajenos. Mientras hay un solo equipo no se nota, y el día que
    // entra el segundo ya es tarde.
    //
    // Solo si la base tiene la columna: donde no está, filtrar por ella no
    // devolvería menos filas, tiraría la consulta entera.
    if (teamId && await soportaEquipos()) {
      params.push(teamId);
      condiciones.push(`ch.team_id = $${params.length}`);
    }

    // Y aislamiento por canal, para el asesor que solo atiende algunos.
    if (assignedChannelIds && Array.isArray(assignedChannelIds)) {
      if (assignedChannelIds.length === 0) return [];
      params.push(assignedChannelIds);
      condiciones.push(`c.channel_id = ANY($${params.length})`);
    }

    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    params.push(Math.min(limit, 500));
    params.push(offset);

    const { rows } = await query(
      `SELECT o.*, p.name AS product_name, p.slug AS product_slug,
              (p.delivery_url IS NOT NULL AND p.delivery_url <> '') AS product_entregable
       FROM orders o
       LEFT JOIN products p ON o.product_id = p.id
       LEFT JOIN conversations c ON o.conversation_id = c.id
       LEFT JOIN channels ch ON c.channel_id = ch.id
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
   * Anota que el pedido llegó hasta una etapa. Nunca lo hace retroceder.
   *
   * El "nunca retrocede" no es un detalle de implementación, es la definición:
   * la etapa mide hasta dónde llegó alguien, y eso no se deshace porque después
   * escriba otra cosa. Se resuelve en la consulta y no en JavaScript para que
   * dos mensajes que llegan al mismo tiempo no puedan pisarse entre sí.
   *
   * @param {number} id
   * @param {string} etapa
   * @returns {Promise<object|null>}
   */
  async marcarEtapa(id, etapa) {
    const destino = posicionEtapa(etapa);
    if (destino < 0) return null;

    const { rows } = await query(
      `UPDATE orders
       SET etapa = $1,
           etapa_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
         AND array_position($3::text[], etapa) < array_position($3::text[], $1)
       RETURNING *`,
      [etapa, id, ETAPAS]
    );

    // Sin filas no es un error: significa que ya estaba en esa etapa o más
    // adelante, que es exactamente lo que tenía que pasar.
    return rows[0] || null;
  },

  /**
   * El embudo completo, y el mismo embudo abierto por anuncio.
   *
   * Es la consulta que contesta la única pregunta que importa cuando hay plata
   * puesta en publicidad: cuál anuncio trae gente que compra, no cuál trae
   * gente que escribe. Dos anuncios pueden abrir la misma cantidad de
   * conversaciones y que uno venda el triple.
   *
   * @param {{ desde?: string|Date|null }} opciones
   */
  async embudo({ desde = null } = {}) {
    const filtro = desde ? 'WHERE o.created_at >= $1' : '';
    const params = desde ? [desde] : [];

    const { rows: total } = await query(
      `SELECT o.etapa, COUNT(*)::int AS cantidad
       FROM orders o
       ${filtro}
       GROUP BY o.etapa`,
      params
    );

    const { rows: porAnuncio } = await query(
      `SELECT COALESCE(c.source_ad_id, 'sin_anuncio') AS anuncio,
              o.etapa,
              COUNT(*)::int AS cantidad
       FROM orders o
       INNER JOIN conversations c ON o.conversation_id = c.id
       ${filtro}
       GROUP BY 1, 2
       ORDER BY 1`,
      params
    );

    // Se devuelve la escalera completa, con ceros incluidos: un embudo al que
    // le faltan los escalones vacíos se lee como si nadie se hubiera caído ahí,
    // cuando es justo al revés.
    const vacio = () => Object.fromEntries(ETAPAS.map(e => [e, 0]));

    const general = vacio();
    for (const f of total) {
      if (f.etapa in general) general[f.etapa] = f.cantidad;
    }

    const anuncios = {};
    for (const f of porAnuncio) {
      if (!anuncios[f.anuncio]) anuncios[f.anuncio] = vacio();
      if (f.etapa in anuncios[f.anuncio]) anuncios[f.anuncio][f.etapa] = f.cantidad;
    }

    return { etapas: ETAPAS, general, anuncios };
  },

  /**
   * Pedidos que se quedaron a mitad de camino y están listos para insistir.
   *
   * @param {{ etapaMinima?: string, desdeMin?: number, hastaMin?: number }} opciones
   */
  async abandonados({ etapaMinima = 'vio_producto', desdeMin = 120, hastaMin = 1380 } = {}) {
    const { rows } = await query(
      `SELECT o.id, o.etapa, o.etapa_at, o.conversation_id, o.product_id, o.contact_phone,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - o.etapa_at)) / 60 AS minutos,
              c.last_customer_interaction, c.bot_status, ch.platform
       FROM orders o
       INNER JOIN conversations c ON o.conversation_id = c.id
       INNER JOIN channels ch ON c.channel_id = ch.id
       WHERE o.status NOT IN ('pagado', 'entregado')
         AND array_position($1::text[], o.etapa) >= array_position($1::text[], $2)
         AND o.etapa_at <= CURRENT_TIMESTAMP - ($3 || ' minutes')::interval
         AND o.etapa_at >= CURRENT_TIMESTAMP - ($4 || ' minutes')::interval
       ORDER BY o.etapa_at ASC`,
      [ETAPAS, etapaMinima, String(desdeMin), String(hastaMin)]
    );

    return rows;
  },

  /**
   * ¿Este número de operación ya se usó para cobrar otro pedido?
   *
   * Una captura de transferencia se reenvía con dos toques. Si el mismo
   * comprobante sirve dos veces, al primero que se dé cuenta le alcanza con
   * pasárselo a quien quiera, y el bot entrega el material cada vez. El número
   * de operación es lo único de esa imagen que el banco no repite.
   *
   * Solo cuentan los pedidos que llegaron a cobrarse: que el mismo número
   * aparezca en uno rechazado no es un fraude, es alguien reintentando.
   *
   * @param {string|null} operacion
   * @param {number|null} exceptoPedidoId Para que un pedido no choque consigo mismo
   * @returns {Promise<object|null>} El pedido que ya lo usó, si existe
   */
  async operacionYaUsada(operacion, exceptoPedidoId = null) {
    const limpio = String(operacion || '').replace(/[^0-9]/g, '');

    // Un número corto no identifica nada: puede ser un recorte de la imagen o
    // una lectura a medias. Darlo por repetido rechazaría pagos legítimos.
    if (limpio.length < 4) return null;

    const { rows } = await query(
      `SELECT id, status, contact_phone, confirmed_at
       FROM orders
       WHERE receipt_operacion = $1
         AND status IN ('pagado', 'entregado')
         AND ($2::int IS NULL OR id <> $2)
       ORDER BY confirmed_at DESC NULLS LAST
       LIMIT 1`,
      [limpio, exceptoPedidoId]
    );

    return rows[0] || null;
  },

  /**
   * Guarda el número de operación del comprobante, sin tocar nada más.
   *
   * Existe porque anotarlo pasando por `cambiarEstado` con el mismo estado que
   * ya tenía no era inocente: esa función vuelve a sellar `confirmed_at` y a
   * poner `confirmed_by` en null cada vez que el estado es 'pagado'. Un
   * reintento del guion borraba así quién había confirmado el cobro y cuándo,
   * que es justo lo que uno quiere poder mirar cuando algo no cierra.
   *
   * @param {number} id
   * @param {string} operacion
   * @returns {Promise<boolean>} false si ese número ya cobró otro pedido
   */
  async guardarOperacion(id, operacion) {
    const limpio = String(operacion || '').replace(/[^0-9]/g, '');
    if (!limpio) return true;

    try {
      await query(
        `UPDATE orders SET receipt_operacion = $1 WHERE id = $2`,
        [limpio, id]
      );
      return true;
    } catch (err) {
      // 23505 es el índice único: ese número ya cobró otro pedido. No es un
      // error del sistema, es el sistema haciendo su trabajo.
      if (err.code === '23505') {
        console.warn(`🚨 [COMPROBANTE] La operación ${limpio} ya cobró otro pedido. Pedido #${id} sin guardar.`);
        return false;
      }
      throw err;
    }
  },

  /**
   * Cambia el estado del pedido.
   *
   * 'pagado' y 'entregado' sellan además la fecha y quién lo confirmó, porque
   * son los dos momentos que después alguien va a querer auditar.
   */
  async cambiarEstado(id, estado, { confirmedBy = null, note = null, receiptCheck = null, receiptMessageId = null, receiptOperacion = null, autoAprobado = null } = {}) {
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

    if (receiptOperacion !== null) {
      // Solo los dígitos: la misma operación puede venir leída como "884512",
      // "Nº 884512" o "884.512" según el banco y el recorte de la captura, y
      // tres formas distintas del mismo número no sirven para detectar que se
      // repite.
      params.push(String(receiptOperacion).replace(/[^0-9]/g, '') || null);
      sets.push(`receipt_operacion = $${params.length}`);
    }

    if (autoAprobado !== null) {
      params.push(Boolean(autoAprobado));
      sets.push(`auto_aprobado = $${params.length}`);
    }

    params.push(id);

    let rows;
    try {
      ({ rows } = await query(
        `UPDATE orders SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      ));
    } catch (err) {
      // El índice único de operación saltó: este comprobante ya cobró otro
      // pedido. Se convierte en un error con nombre para que el controlador
      // pueda contestar algo entendible en vez de un 500.
      if (err.code === '23505' && String(err.constraint || '').includes('operacion')) {
        const repetido = new Error('Ese comprobante ya se usó para cobrar otro pedido.');
        repetido.code = 'ERR_OPERACION_REPETIDA';
        throw repetido;
      }
      throw err;
    }

    const actualizado = rows[0] || null;
    if (!actualizado) return null;

    // Que el estado avance tiene que mover el embudo también. Si no, un pago
    // confirmado a mano desde el tablero no cuenta como venta en las métricas,
    // y el anuncio que lo trajo aparece como si no hubiera vendido nada.
    const etapa = etapaSegunEstado(estado);
    if (etapa) {
      const conEtapa = await this.marcarEtapa(id, etapa);
      if (conEtapa) return conEtapa;
    }

    return actualizado;
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
