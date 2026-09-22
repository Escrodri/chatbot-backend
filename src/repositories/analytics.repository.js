import { query } from '../database/index.js';

const ZONA_DEFAULT = 'America/Asuncion';

export const analyticsRepository = {
  /**
   * Resumen clave del día de hoy en la zona horaria del negocio:
   * - Monto total facturado hoy
   * - Cantidad de pedidos confirmados/pagados hoy
   * - Nuevos leads/pedidos creados hoy
   * - Conversaciones activas hoy
   */
  async getResumenHoy({ teamId = null, timezone = ZONA_DEFAULT } = {}) {
    const params = [timezone];
    let teamFilterOrders = '';
    let teamFilterConvs = '';

    if (teamId) {
      params.push(teamId);
      // El equipo se obtiene a través del canal (channels.team_id) o del producto (products.team_id)
      teamFilterOrders = `AND (ch.team_id = $${params.length} OR p.team_id = $${params.length})`;
      teamFilterConvs = `AND ch.team_id = $${params.length}`;
    }

    // 1. Ventas de hoy: pedidos pagados o entregados confirmados hoy
    const sqlVentasHoy = `
      SELECT 
        COALESCE(SUM(o.amount), 0)::numeric AS monto_hoy,
        COUNT(o.id)::int AS cantidad_ventas_hoy
      FROM orders o
      LEFT JOIN conversations c ON o.conversation_id = c.id
      LEFT JOIN channels ch ON c.channel_id = ch.id
      LEFT JOIN products p ON o.product_id = p.id
      WHERE o.status IN ('pagado', 'entregado')
        AND (COALESCE(o.confirmed_at, o.updated_at) AT TIME ZONE $1)::date = (CURRENT_TIMESTAMP AT TIME ZONE $1)::date
        ${teamFilterOrders}
    `;

    // 2. Leads de hoy: pedidos creados hoy (cualquier estado)
    const sqlLeadsHoy = `
      SELECT 
        COUNT(o.id)::int AS leads_nuevos_hoy
      FROM orders o
      LEFT JOIN conversations c ON o.conversation_id = c.id
      LEFT JOIN channels ch ON c.channel_id = ch.id
      LEFT JOIN products p ON o.product_id = p.id
      WHERE (o.created_at AT TIME ZONE $1)::date = (CURRENT_TIMESTAMP AT TIME ZONE $1)::date
        ${teamFilterOrders}
    `;

    // 3. Conversaciones con actividad hoy
    const sqlConvsHoy = `
      SELECT 
        COUNT(c.id)::int AS conversaciones_hoy
      FROM conversations c
      LEFT JOIN channels ch ON c.channel_id = ch.id
      WHERE (COALESCE(c.last_customer_interaction, c.last_message_time, c.created_at) AT TIME ZONE $1)::date = (CURRENT_TIMESTAMP AT TIME ZONE $1)::date
        ${teamFilterConvs}
    `;

    const [resVentas, resLeads, resConvs] = await Promise.all([
      query(sqlVentasHoy, params),
      query(sqlLeadsHoy, params),
      query(sqlConvsHoy, params)
    ]);

    const ventas = resVentas.rows[0] || { monto_hoy: 0, cantidad_ventas_hoy: 0 };
    const leads = resLeads.rows[0] || { leads_nuevos_hoy: 0 };
    const convs = resConvs.rows[0] || { conversaciones_hoy: 0 };

    const montoHoy = Number(ventas.monto_hoy) || 0;
    const ventasCount = Number(ventas.cantidad_ventas_hoy) || 0;
    const leadsCount = Number(leads.leads_nuevos_hoy) || 0;
    const convsCount = Number(convs.conversaciones_hoy) || 0;

    const conversionRate = leadsCount > 0
      ? Number(((ventasCount / leadsCount) * 100).toFixed(1))
      : 0;

    return {
      monto_hoy: montoHoy,
      ventas_hoy: ventasCount,
      leads_hoy: leadsCount,
      conversaciones_hoy: convsCount,
      tasa_conversion_hoy: conversionRate,
      moneda: 'PYG'
    };
  },

  /**
   * Rendimiento y ranking por producto:
   * Permite ver cuál vende más, cuál vende menos, leads por producto y conversiones.
   */
  async getRendimientoPorProducto({ teamId = null, desde = null, hasta = null, timezone = ZONA_DEFAULT } = {}) {
    const params = [timezone];
    let dateFilter = '';
    let teamFilter = '';

    if (desde) {
      params.push(desde);
      dateFilter += ` AND (o.created_at AT TIME ZONE $1)::date >= $${params.length}::date`;
    }
    if (hasta) {
      params.push(hasta);
      dateFilter += ` AND (o.created_at AT TIME ZONE $1)::date <= $${params.length}::date`;
    }

    if (teamId) {
      params.push(teamId);
      teamFilter = ` AND (p.team_id = $${params.length} OR ch.team_id = $${params.length} OR p.team_id IS NULL)`;
    }

    const sql = `
      SELECT 
        COALESCE(p.id, 0) AS product_id,
        COALESCE(p.name, 'Sin producto asignado') AS product_name,
        COALESCE(p.slug, 'general') AS product_slug,
        COALESCE(p.price, 0)::numeric AS price,
        COALESCE(p.currency, 'PYG') AS currency,
        COUNT(o.id)::int AS total_leads,
        COUNT(o.id) FILTER (WHERE o.status IN ('pagado', 'entregado'))::int AS total_ventas,
        COALESCE(SUM(o.amount) FILTER (WHERE o.status IN ('pagado', 'entregado')), 0)::numeric AS total_ingresos,
        COUNT(o.id) FILTER (WHERE o.status = 'comprobante_recibido')::int AS por_verificar,
        COUNT(o.id) FILTER (WHERE o.status = 'interesado')::int AS interesados,
        COUNT(o.id) FILTER (WHERE o.status = 'rechazado')::int AS rechazados
      FROM orders o
      LEFT JOIN products p ON o.product_id = p.id
      LEFT JOIN conversations c ON o.conversation_id = c.id
      LEFT JOIN channels ch ON c.channel_id = ch.id
      WHERE 1=1
        ${dateFilter}
        ${teamFilter}
      GROUP BY p.id, p.name, p.slug, p.price, p.currency
      ORDER BY total_ventas DESC, total_ingresos DESC, total_leads DESC
    `;

    const { rows } = await query(sql, params);

    const totalIngresosGral = rows.reduce((acc, r) => acc + Number(r.total_ingresos || 0), 0);

    return rows.map(r => {
      const leads = Number(r.total_leads) || 0;
      const ventas = Number(r.total_ventas) || 0;
      const ingresos = Number(r.total_ingresos) || 0;

      return {
        product_id: r.product_id,
        product_name: r.product_name,
        product_slug: r.product_slug,
        price: Number(r.price),
        currency: r.currency,
        total_leads: leads,
        total_ventas: ventas,
        total_ingresos: ingresos,
        por_verificar: Number(r.por_verificar) || 0,
        interesados: Number(r.interesados) || 0,
        rechazados: Number(r.rechazados) || 0,
        tasa_conversion: leads > 0 ? Number(((ventas / leads) * 100).toFixed(1)) : 0,
        participacion_ingresos: totalIngresosGral > 0
          ? Number(((ingresos / totalIngresosGral) * 100).toFixed(1))
          : 0
      };
    });
  },

  /**
   * Productividad de Asesores:
   * Responde "¿Quién tuvo más conversaciones y quién vendió más?"
   */
  async getMetricasAsesores({ teamId = null, desde = null, hasta = null, timezone = ZONA_DEFAULT } = {}) {
    const params = [timezone];
    let dateFilterConv = '';
    let dateFilterOrder = '';
    let dateFilterMsg = '';
    let teamFilterUser = '';

    if (desde) {
      params.push(desde);
      dateFilterConv += ` AND (c.created_at AT TIME ZONE $1)::date >= $${params.length}::date`;
      dateFilterOrder += ` AND (o.confirmed_at AT TIME ZONE $1)::date >= $${params.length}::date`;
      dateFilterMsg += ` AND (m.timestamp AT TIME ZONE $1)::date >= $${params.length}::date`;
    }
    if (hasta) {
      params.push(hasta);
      dateFilterConv += ` AND (c.created_at AT TIME ZONE $1)::date <= $${params.length}::date`;
      dateFilterOrder += ` AND (o.confirmed_at AT TIME ZONE $1)::date <= $${params.length}::date`;
      dateFilterMsg += ` AND (m.timestamp AT TIME ZONE $1)::date <= $${params.length}::date`;
    }

    if (teamId) {
      params.push(teamId);
      teamFilterUser = ` AND u.team_id = $${params.length}`;
    }

    const sql = `
      SELECT 
        u.id AS user_id,
        u.name AS user_name,
        u.email AS user_email,
        u.role AS user_role,
        COALESCE(convs.total_asignadas, 0)::int AS conversaciones_asignadas,
        COALESCE(msgs.total_mensajes, 0)::int AS mensajes_enviados,
        COALESCE(ventas.pedidos_confirmados, 0)::int AS pedidos_confirmados,
        COALESCE(ventas.monto_total, 0)::numeric AS monto_confirmado
      FROM users u
      LEFT JOIN (
        SELECT assigned_user_id, COUNT(id) AS total_asignadas
        FROM conversations c
        WHERE assigned_user_id IS NOT NULL ${dateFilterConv}
        GROUP BY assigned_user_id
      ) convs ON convs.assigned_user_id = u.id
      LEFT JOIN (
        SELECT sender_user_id, COUNT(id) AS total_mensajes
        FROM messages m
        WHERE sender_type = 'agent' AND sender_user_id IS NOT NULL ${dateFilterMsg}
        GROUP BY sender_user_id
      ) msgs ON msgs.sender_user_id = u.id
      LEFT JOIN (
        SELECT confirmed_by, COUNT(id) AS pedidos_confirmados, SUM(amount) AS monto_total
        FROM orders o
        WHERE confirmed_by IS NOT NULL AND status IN ('pagado', 'entregado') ${dateFilterOrder}
        GROUP BY confirmed_by
      ) ventas ON ventas.confirmed_by = u.id
      WHERE u.is_active = TRUE ${teamFilterUser}
      ORDER BY conversaciones_asignadas DESC, pedidos_confirmados DESC, u.name ASC
    `;

    const { rows } = await query(sql, params);

    const sqlSinAsignar = `
      SELECT COUNT(c.id)::int AS sin_asignar
      FROM conversations c
      LEFT JOIN channels ch ON c.channel_id = ch.id
      WHERE c.assigned_user_id IS NULL ${dateFilterConv}
      ${teamId ? `AND ch.team_id = $${params.length}` : ''}
    `;
    const resSinAsignar = await query(sqlSinAsignar, params);

    return {
      asesores: rows.map(r => ({
        user_id: r.user_id,
        user_name: r.user_name,
        user_email: r.user_email,
        user_role: r.user_role,
        conversaciones_asignadas: Number(r.conversaciones_asignadas) || 0,
        mensajes_enviados: Number(r.mensajes_enviados) || 0,
        pedidos_confirmados: Number(r.pedidos_confirmados) || 0,
        monto_confirmado: Number(r.monto_confirmado) || 0
      })),
      conversaciones_sin_asignar: Number(resSinAsignar.rows[0]?.sin_asignar || 0)
    };
  },

  /**
   * Desglose por canal (WhatsApp, Instagram, Messenger)
   */
  async getMetricasCanales({ teamId = null, desde = null, hasta = null, timezone = ZONA_DEFAULT } = {}) {
    const params = [timezone];
    let dateFilter = '';
    let teamFilter = '';

    if (desde) {
      params.push(desde);
      dateFilter += ` AND (c.created_at AT TIME ZONE $1)::date >= $${params.length}::date`;
    }
    if (hasta) {
      params.push(hasta);
      dateFilter += ` AND (c.created_at AT TIME ZONE $1)::date <= $${params.length}::date`;
    }
    if (teamId) {
      params.push(teamId);
      teamFilter = ` AND ch.team_id = $${params.length}`;
    }

    const sql = `
      SELECT 
        ch.id AS channel_id,
        ch.name AS channel_name,
        ch.platform,
        ch.color_tag,
        COUNT(DISTINCT c.id)::int AS total_conversaciones,
        COUNT(DISTINCT o.id)::int AS total_leads,
        COUNT(DISTINCT o.id) FILTER (WHERE o.status IN ('pagado', 'entregado'))::int AS total_ventas,
        COALESCE(SUM(o.amount) FILTER (WHERE o.status IN ('pagado', 'entregado')), 0)::numeric AS total_ingresos
      FROM channels ch
      LEFT JOIN conversations c ON c.channel_id = ch.id ${dateFilter}
      LEFT JOIN orders o ON o.conversation_id = c.id
      WHERE ch.status = 'ACTIVE' ${teamFilter}
      GROUP BY ch.id, ch.name, ch.platform, ch.color_tag
      ORDER BY total_conversaciones DESC, total_ventas DESC
    `;

    const { rows } = await query(sql, params);
    return rows.map(r => ({
      channel_id: r.channel_id,
      channel_name: r.channel_name,
      platform: r.platform,
      color_tag: r.color_tag,
      total_conversaciones: Number(r.total_conversaciones) || 0,
      total_leads: Number(r.total_leads) || 0,
      total_ventas: Number(r.total_ventas) || 0,
      total_ingresos: Number(r.total_ingresos) || 0
    }));
  },

  /**
   * Tendencia diaria de ventas e ingresos en los últimos N días
   */
  async getTendenciaDiaria({ teamId = null, dias = 7, timezone = ZONA_DEFAULT } = {}) {
    const params = [timezone, dias];
    let teamFilter = '';

    if (teamId) {
      params.push(teamId);
      teamFilter = ` AND (ch.team_id = $3 OR p.team_id = $3)`;
    }

    const sql = `
      WITH dias_serie AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE $1)::date - i AS dia
        FROM generate_series(0, $2::int - 1) AS i
      ),
      ventas_por_dia AS (
        SELECT 
          (COALESCE(o.confirmed_at, o.updated_at) AT TIME ZONE $1)::date AS dia,
          COUNT(o.id)::int AS ventas,
          COALESCE(SUM(o.amount), 0)::numeric AS ingresos
        FROM orders o
        LEFT JOIN conversations c ON o.conversation_id = c.id
        LEFT JOIN channels ch ON c.channel_id = ch.id
        LEFT JOIN products p ON o.product_id = p.id
        WHERE o.status IN ('pagado', 'entregado')
          AND (COALESCE(o.confirmed_at, o.updated_at) AT TIME ZONE $1)::date >= (CURRENT_TIMESTAMP AT TIME ZONE $1)::date - ($2::int - 1)
          ${teamFilter}
        GROUP BY 1
      ),
      leads_por_dia AS (
        SELECT 
          (o.created_at AT TIME ZONE $1)::date AS dia,
          COUNT(o.id)::int AS leads
        FROM orders o
        LEFT JOIN conversations c ON o.conversation_id = c.id
        LEFT JOIN channels ch ON c.channel_id = ch.id
        LEFT JOIN products p ON o.product_id = p.id
        WHERE (o.created_at AT TIME ZONE $1)::date >= (CURRENT_TIMESTAMP AT TIME ZONE $1)::date - ($2::int - 1)
          ${teamFilter}
        GROUP BY 1
      )
      SELECT 
        TO_CHAR(d.dia, 'YYYY-MM-DD') AS fecha,
        TO_CHAR(d.dia, 'DD/MM') AS etiqueta_corta,
        COALESCE(v.ventas, 0)::int AS ventas,
        COALESCE(v.ingresos, 0)::numeric AS ingresos,
        COALESCE(l.leads, 0)::int AS leads
      FROM dias_serie d
      LEFT JOIN ventas_por_dia v ON v.dia = d.dia
      LEFT JOIN leads_por_dia l ON l.dia = d.dia
      ORDER BY d.dia ASC
    `;

    const { rows } = await query(sql, params);
    return rows.map(r => ({
      fecha: r.fecha,
      etiqueta: r.etiqueta_corta,
      ventas: Number(r.ventas) || 0,
      ingresos: Number(r.ingresos) || 0,
      leads: Number(r.leads) || 0
    }));
  }
};

export default analyticsRepository;
