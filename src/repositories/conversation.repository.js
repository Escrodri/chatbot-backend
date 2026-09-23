import { query } from '../database/index.js';

/**
 * Repositorio de Conversaciones: Cabeceras de chats, filtros multi-canal y estados de bot/handover.
 */
export const conversationRepository = {
  /**
   * Busca o crea la conversación asociada a un contacto en un canal determinado.
   * 
   * @param {number} channelId
   * @param {number} contactId
   * @returns {Promise<object>}
   */
  async findOrCreateByContact(channelId, contactId) {
    // Cuándo había escrito esta persona la vez anterior, mirado ANTES de tocar
    // nada.
    //
    // El upsert de abajo pisa last_customer_interaction con la hora actual, y
    // la columna además arranca con CURRENT_TIMESTAMP al crearse la fila. O
    // sea: después de esta consulta, el campo dice "hace un segundo" tanto para
    // alguien que escribe por primera vez en su vida como para alguien que
    // viene charlando hace media hora. Son la misma cosa vistas desde ahí, y
    // por eso el bot nunca saludaba a nadie: preguntaba si era el primer
    // contacto justo después de haber borrado la única prueba de que no lo era.
    const previo = await query(
      `SELECT last_customer_interaction
       FROM conversations
       WHERE channel_id = $1 AND contact_id = $2`,
      [channelId, contactId]
    );

    const { rows } = await query(
      `INSERT INTO conversations (channel_id, contact_id, bot_status, unread_count)
       VALUES ($1, $2, 'active', 0)
       ON CONFLICT (channel_id, contact_id) DO UPDATE
         SET last_customer_interaction = CURRENT_TIMESTAMP
       RETURNING *`,
      [channelId, contactId]
    );

    return {
      ...rows[0],
      // null cuando la conversación no existía: es el primer mensaje de verdad.
      interaccion_previa: previo.rows[0]?.last_customer_interaction || null
    };
  },

  /**
   * Obtiene una conversación por su ID con datos del contacto y canal asociados.
   * @param {number} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    const { rows } = await query(
      `SELECT 
         c.id, c.channel_id, c.contact_id, c.last_message_text, c.last_message_time,
         c.last_customer_interaction, c.unread_count, c.bot_status, c.assigned_user_id, c.created_at,
         c.ctwa_clid, c.source_ad_id, c.source_type, c.source_url,
         ct.name as contact_name, ct.phone_or_username as contact_phone, ct.avatar_url as contact_avatar, ct.platform_user_id,
         COALESCE(ch.platform, ct.platform) as platform, 
         COALESCE(ch.name, 'Canal Desconectado') as channel_name, 
         COALESCE(ch.color_tag, '#1877F2') as channel_color, 
         ch.channel_identifier, ch.waba_id,
         ch.team_id
       FROM conversations c
       INNER JOIN contacts ct ON c.contact_id = ct.id
       LEFT JOIN channels ch ON c.channel_id = ch.id
       WHERE c.id = $1`,
      [id]
    );

    return rows[0] || null;
  },

  /**
   * Guarda de dónde vino la conversación cuando arrancó desde un anuncio.
   *
   * Meta manda el identificador del clic una sola vez, en el webhook del primer
   * mensaje. Se guarda solo si todavía no había uno: si la persona vuelve a
   * escribir más adelante sin pasar por el anuncio, no queremos borrar la
   * atribución original.
   *
   * @param {number} conversationId
   * @param {{ ctwaClid?: string|null, adId?: string|null, sourceType?: string|null, sourceUrl?: string|null }} datos
   * @returns {Promise<void>}
   */
  async saveAttribution(conversationId, { ctwaClid = null, adId = null, sourceType = null, sourceUrl = null } = {}) {
    if (!ctwaClid && !adId) return;

    await query(
      `UPDATE conversations
       SET ctwa_clid = COALESCE(ctwa_clid, $1),
           source_ad_id = COALESCE(source_ad_id, $2),
           source_type = COALESCE(source_type, $3),
           source_url = COALESCE(source_url, $4)
       WHERE id = $5`,
      [ctwaClid, adId, sourceType, sourceUrl, conversationId]
    );
  },

  /**
   * Actualiza el registro de interacción del cliente (para la regla de ventana de 24h/7d) e incrementa no leídos.
   * 
   * @param {number} conversationId
   * @param {string} lastMessageText
   * @param {Date|string|null} interactionTimestamp
   * @returns {Promise<void>}
   */
  async touchCustomerInteraction(conversationId, lastMessageText, interactionTimestamp = null) {
    await query(
      `UPDATE conversations 
       SET 
         last_message_text = $1,
         last_message_time = COALESCE($2, CURRENT_TIMESTAMP),
         last_customer_interaction = COALESCE($2, CURRENT_TIMESTAMP),
         unread_count = unread_count + 1
       WHERE id = $3`,
      [lastMessageText, interactionTimestamp, conversationId]
    );
  },

  /**
   * Actualiza el último mensaje saliente de la conversación sin modificar last_customer_interaction.
   * 
   * @param {number} conversationId
   * @param {string} lastMessageText
   * @returns {Promise<void>}
   */
  async updateOutboundMessage(conversationId, lastMessageText) {
    await query(
      `UPDATE conversations 
       SET 
         last_message_text = $1,
         last_message_time = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [lastMessageText, conversationId]
    );
  },

  /**
   * Resetea el contador de mensajes no leídos al abrir la conversación en el navegador.
   * @param {number} conversationId
   * @returns {Promise<void>}
   */
  async resetUnreadCount(conversationId) {
    await query(
      `UPDATE conversations SET unread_count = 0 WHERE id = $1`,
      [conversationId]
    );
  },

  /**
   * Conmuta el estado del bot (Protocolo Handover: 'active', 'handed_over', 'disabled').
   * @param {number} conversationId
   * @param {'active'|'handed_over'|'disabled'} botStatus
   * @param {number|null} assignedUserId
   * @returns {Promise<void>}
   */
  async updateBotStatus(conversationId, botStatus, assignedUserId = null) {
    const validUserId = Number.isInteger(Number(assignedUserId)) ? Number(assignedUserId) : null;

    if (botStatus === 'active') {
      await query(
        `UPDATE conversations
         SET bot_status = 'active',
             assigned_user_id = NULL,
             handed_over_at = NULL
         WHERE id = $1`,
        [conversationId]
      );
    } else if (botStatus === 'handed_over') {
      await query(
        `UPDATE conversations
         SET bot_status = 'handed_over',
             assigned_user_id = CASE
               WHEN $1::integer IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id = $1::integer) THEN $1::integer
               ELSE assigned_user_id
             END,
             handed_over_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [validUserId, conversationId]
      );
    } else {
      await query(
        `UPDATE conversations
         SET bot_status = $1,
             handed_over_at = NULL
         WHERE id = $2`,
        [botStatus, conversationId]
      );
    }
  },

  /**
   * Estado del bot leído recién de la base, no el que traía la copia en memoria.
   *
   * Entre que llega un mensaje y que el bot contesta pasan unos segundos de
   * espera. En ese hueco el asesor puede haber tomado el chat, y la copia de la
   * conversación que quedó guardada en la cola sigue diciendo que el bot manda.
   * El resultado es el bot contestando encima de la persona, que es justo lo
   * que el handover existe para evitar.
   *
   * @param {number} conversationId
   * @returns {Promise<{bot_status: string, handed_over_at: Date|null}|null>}
   */
  async estadoDelBot(conversationId) {
    const { rows } = await query(
      `SELECT bot_status, handed_over_at FROM conversations WHERE id = $1`,
      [conversationId]
    );
    return rows[0] || null;
  },

  /**
   * Lista conversaciones para la bandeja lateral estilo WhatsApp Web con filtros avanzados.
   * 
   * @param {{ teamId?: number|null, platform?: string, channelId?: number, search?: string, assignedChannelIds?: number[], limit?: number, offset?: number }} filters
   * @returns {Promise<Array>}
   */
  async listWithFilters({ teamId = null, platform = null, channelId = null, search = null, assignedChannelIds = null, limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params = [];
    let pIdx = 1;

    // Aislamiento Multi-Tenant: restringir por equipo pero tolerar canales sin equipo asignado (legacy)
    if (teamId) {
      conditions.push(`(ch.team_id = $${pIdx} OR ch.team_id IS NULL)`);
      params.push(teamId);
      pIdx++;
    }

    // Aislamiento IDOR: si el operador tiene canales restringidos explícitamente
    if (assignedChannelIds && Array.isArray(assignedChannelIds) && assignedChannelIds.length > 0) {
      conditions.push(`c.channel_id = ANY($${pIdx++})`);
      params.push(assignedChannelIds);
    }

    if (platform) {
      const isFbOrMsg = platform.toLowerCase() === 'facebook' || platform.toLowerCase() === 'messenger';
      if (isFbOrMsg) {
        conditions.push(`(
          LOWER(COALESCE(ch.platform, ct.platform)) = 'facebook' OR 
          LOWER(COALESCE(ch.platform, ct.platform)) = 'messenger'
        )`);
      } else {
        conditions.push(`(ch.platform = $${pIdx} OR ct.platform = $${pIdx})`);
        params.push(platform);
        pIdx++;
      }
    }

    if (channelId) {
      conditions.push(`c.channel_id = $${pIdx++}`);
      params.push(parseInt(channelId, 10));
    }

    if (search) {
      conditions.push(`(ct.name ILIKE $${pIdx} OR ct.phone_or_username ILIKE $${pIdx} OR c.last_message_text ILIKE $${pIdx})`);
      params.push(`%${search.trim()}%`);
      pIdx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit);
    params.push(offset);

    const sql = `
      SELECT 
        c.id, c.channel_id, c.contact_id, c.last_message_text, c.last_message_time,
        c.last_customer_interaction, c.unread_count, c.bot_status, c.assigned_user_id,
        c.source_ad_id,
        ct.name as contact_name, ct.phone_or_username as contact_phone, ct.avatar_url as contact_avatar,
        -- Cuántas veces se intentó completar el perfil y cuándo fue la última.
        -- Sin estos dos campos, la bandeja le vuelve a preguntar a Meta por el
        -- mismo contacto cada cinco segundos, para siempre.
        ct.perfil_intentos, ct.perfil_ultimo_intento,
        -- Sin esto el completado de perfiles de la bandeja era código muerto:
        -- filtraba por un campo que esta consulta nunca devolvía, así que
        -- ningún contacto de Instagram salía jamás de "Usuario 4821" sin foto.
        ct.platform_user_id,
        COALESCE(ch.platform, ct.platform) as platform,
        COALESCE(ch.name, 'Canal Desconectado') as channel_name, 
        COALESCE(ch.color_tag, '#1877F2') as channel_color, 
        ch.channel_identifier,
        o.status as order_status, o.id as order_id, o.amount as order_amount, o.currency as order_currency,
        p.name as order_product_name,
        -- Si el producto tiene enlace de entrega cargado. Sin esto la bandeja
        -- no puede avisar ANTES de confirmar un pago que el material no se va
        -- a poder mandar, y el aviso llega cuando ya no sirve.
        (p.delivery_url IS NOT NULL AND p.delivery_url <> '') as order_entregable,
        COALESCE(cli.compras, 0) as compras_previas,
        cli.ultima_compra,
        COALESCE(tg.tags, '[]'::json) as tags
      FROM conversations c
      INNER JOIN contacts ct ON c.contact_id = ct.id
      LEFT JOIN channels ch ON c.channel_id = ch.id
      -- Estado de venta de la conversacion, para etiquetarla en la bandeja.
      -- LATERAL trae solo el pedido mas reciente de cada chat en la MISMA
      -- consulta: sin esto harian falta N consultas extra, una por conversacion.
      LEFT JOIN LATERAL (
        SELECT id, status, amount, currency, product_id
        FROM orders
        WHERE conversation_id = c.id
        ORDER BY
          -- El que necesita atencion humana manda sobre los demas
          CASE status
            WHEN 'comprobante_recibido' THEN 1
            WHEN 'pagado' THEN 2
            WHEN 'entregado' THEN 3
            WHEN 'interesado' THEN 4
            ELSE 5
          END,
          updated_at DESC
        LIMIT 1
      ) o ON TRUE
      LEFT JOIN products p ON o.product_id = p.id
      -- Historial de compras de ESTA PERSONA, no de este chat.
      --
      -- Se cuenta por contacto y no por conversación a propósito: alguien que
      -- compró por WhatsApp y vuelve a escribir por Instagram sigue siendo el
      -- mismo cliente, y tratarlo como desconocido es el error que hace que un
      -- comprador que vuelve se sienta un número.
      --
      -- Con esto la bandeja puede distinguir tres cosas que antes se veían
      -- iguales: el que nunca compró, el que está comprando ahora, y el que ya
      -- compró antes y volvió por otra cosa.
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS compras, MAX(o2.confirmed_at) AS ultima_compra
        FROM orders o2
        INNER JOIN conversations c2 ON o2.conversation_id = c2.id
        WHERE c2.contact_id = c.contact_id
          AND o2.status IN ('pagado', 'entregado')
      ) cli ON TRUE
      -- Etiquetas manuales del equipo. Van agregadas como JSON en la misma
      -- consulta para no disparar una por conversacion al pintar la lista.
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)
                        ORDER BY t.sort_order, t.name) AS tags
        FROM conversation_tags ct2
        INNER JOIN tags t ON ct2.tag_id = t.id
        WHERE ct2.conversation_id = c.id
      ) tg ON TRUE
      ${whereClause}
      ORDER BY c.last_message_time DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `;

    const { rows } = await query(sql, params);
    return rows;
  },

  /**
   * Deja una conversación de prueba como si nunca hubiera existido.
   *
   * Borrar los mensajes no alcanza para volver a probar el flujo. El guion no
   * decide qué contestar mirando el chat: mira la tabla de pedidos. Si el
   * pedido sigue ahí, el bot sabe que ya presentó el producto y contesta como
   * si la charla viniera de antes, aunque en pantalla no haya nada. Por eso
   * acá se borra también el pedido, y con él el contador de intentos que
   * decide cuándo entra la IA.
   *
   * Se van los eventos de conversión (si no, Meta recibe dos veces la misma
   * venta de prueba) y las etiquetas. El contacto se conserva: es la persona,
   * no la charla, y borrarlo obligaría a cargar el número de nuevo.
   *
   * Todo en una sola sentencia, así no puede quedar a medias: no existe el
   * estado en el que los mensajes ya se fueron pero el pedido sigue vivo, que
   * es justo el que dejaría al bot contestando cualquier cosa.
   *
   * @param {number} conversationId
   * @returns {Promise<{mensajes: number, pedidos: number, eventos: number, etiquetas: number}>}
   */
  async reiniciarParaPrueba(conversationId) {
    const { rows } = await query(
      `WITH msg AS (
         DELETE FROM messages WHERE conversation_id = $1 RETURNING 1
       ),
       ord AS (
         DELETE FROM orders WHERE conversation_id = $1 RETURNING 1
       ),
       eve AS (
         DELETE FROM conversion_events WHERE conversation_id = $1 RETURNING 1
       ),
       eti AS (
         DELETE FROM conversation_tags WHERE conversation_id = $1 RETURNING 1
       ),
       conv AS (
         UPDATE conversations
         SET last_message_text = NULL,
             last_message_time = NULL,
             last_customer_interaction = NULL,
             unread_count = 0,
             bot_status = 'active',
             assigned_user_id = NULL,
             ctwa_clid = NULL,
             source_ad_id = NULL,
             source_type = NULL,
             source_url = NULL
         WHERE id = $1
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM msg)::int AS mensajes,
              (SELECT COUNT(*) FROM ord)::int AS pedidos,
              (SELECT COUNT(*) FROM eve)::int AS eventos,
              (SELECT COUNT(*) FROM eti)::int AS etiquetas`,
      [conversationId]
    );

    return rows[0] || { mensajes: 0, pedidos: 0, eventos: 0, etiquetas: 0 };
  }
};

export default conversationRepository;
