import { analyticsRepository } from '../repositories/analytics.repository.js';

function calcularRango(periodo, timezone = 'America/Asuncion') {
  const ahora = new Date();
  
  // Formateador YYYY-MM-DD en la zona del negocio
  const formatear = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);

  const hoyStr = formatear(ahora);

  if (periodo === 'hoy') {
    return { desde: hoyStr, hasta: hoyStr, diasTendencia: 7 };
  }

  if (periodo === '7d') {
    const d = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { desde: formatear(d), hasta: hoyStr, diasTendencia: 7 };
  }

  if (periodo === '30d') {
    const d = new Date(ahora.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { desde: formatear(d), hasta: hoyStr, diasTendencia: 14 };
  }

  if (periodo === 'mes') {
    const año = ahora.getFullYear();
    const mes = String(ahora.getMonth() + 1).padStart(2, '0');
    return { desde: `${año}-${mes}-01`, hasta: hoyStr, diasTendencia: 30 };
  }

  // 'todo' o no especificado
  return { desde: null, hasta: null, diasTendencia: 7 };
}

export const analyticsController = {
  /**
   * GET /api/analytics/dashboard
   * Parámetros opcionales:
   * - periodo: 'hoy' | '7d' | '30d' | 'mes' | 'todo' (por defecto '7d')
   * - desde: 'YYYY-MM-DD'
   * - hasta: 'YYYY-MM-DD'
   */
  async getDashboard(req, res) {
    try {
      const teamId = req.user?.team_id || null;
      const { periodo = '7d', timezone = 'America/Asuncion' } = req.query;

      let desde = req.query.desde || null;
      let hasta = req.query.hasta || null;
      let diasTendencia = 7;

      if (!desde && !hasta) {
        const rango = calcularRango(periodo, timezone);
        desde = rango.desde;
        hasta = rango.hasta;
        diasTendencia = rango.diasTendencia;
      }

      const [resumenHoy, productos, asesoresData, canales, tendencia] = await Promise.all([
        analyticsRepository.getResumenHoy({ teamId, timezone }),
        analyticsRepository.getRendimientoPorProducto({ teamId, desde, hasta, timezone }),
        analyticsRepository.getMetricasAsesores({ teamId, desde, hasta, timezone }),
        analyticsRepository.getMetricasCanales({ teamId, desde, hasta, timezone }),
        analyticsRepository.getTendenciaDiaria({ teamId, dias: diasTendencia, timezone })
      ]);

      // Totales del período seleccionado
      const totalIngresosPeriodo = productos.reduce((sum, p) => sum + p.total_ingresos, 0);
      const totalVentasPeriodo = productos.reduce((sum, p) => sum + p.total_ventas, 0);
      const totalLeadsPeriodo = productos.reduce((sum, p) => sum + p.total_leads, 0);
      const conversionPeriodo = totalLeadsPeriodo > 0
        ? Number(((totalVentasPeriodo / totalLeadsPeriodo) * 100).toFixed(1))
        : 0;

      // Identificar producto que más vende y producto que menos vende
      const productosConVentas = productos.filter(p => p.product_id > 0);
      const productoTop = productosConVentas.length > 0 ? productosConVentas[0] : null;
      const productoMenosVendido = productosConVentas.length > 1
        ? productosConVentas[productosConVentas.length - 1]
        : null;

      return res.json({
        periodo_activo: periodo,
        desde,
        hasta,
        timezone,
        hoy: resumenHoy,
        periodo: {
          total_ingresos: totalIngresosPeriodo,
          total_ventas: totalVentasPeriodo,
          total_leads: totalLeadsPeriodo,
          tasa_conversion: conversionPeriodo
        },
        destacados: {
          mas_vendido: productoTop ? {
            id: productoTop.product_id,
            nombre: productoTop.product_name,
            ventas: productoTop.total_ventas,
            ingresos: productoTop.total_ingresos
          } : null,
          menos_vendido: productoMenosVendido ? {
            id: productoMenosVendido.product_id,
            nombre: productoMenosVendido.product_name,
            ventas: productoMenosVendido.total_ventas,
            ingresos: productoMenosVendido.total_ingresos
          } : null
        },
        productos,
        asesores: asesoresData.asesores,
        conversaciones_sin_asignar: asesoresData.conversaciones_sin_asignar,
        canales,
        tendencia
      });
    } catch (error) {
      console.error('❌ [ANALYTICS] Error al generar dashboard:', error);
      return res.status(500).json({ error: 'Error al obtener métricas: ' + error.message });
    }
  }
};

export default analyticsController;
