import { anuncioRepository, leerListaDeAnuncios } from '../repositories/anuncio.repository.js';
import { metaAdsService } from '../services/meta-ads.service.js';

/**
 * De qué anuncio viene la gente y cuánto vende cada uno.
 *
 * Los días se cuentan en hora de Paraguay (UTC-3 todo el año): "hoy" es de
 * medianoche a medianoche de acá, igual que en el Administrador de anuncios
 * de una cuenta configurada en Paraguay. Si no, los números de un lado y del
 * otro no se podrían comparar.
 */
const DIA = 24 * 3600 * 1000;
const PY = 3 * 3600 * 1000;

function inicioDelDiaPY(t) {
  return Math.floor((t - PY) / DIA) * DIA + PY;
}

export function rangoDePeriodo(periodo, ahora = Date.now()) {
  const hoy = inicioDelDiaPY(ahora);
  switch (periodo) {
    case 'ayer': return { desde: new Date(hoy - DIA), hasta: new Date(hoy) };
    case '7d': return { desde: new Date(hoy - 6 * DIA), hasta: new Date(ahora + 60000) };
    case '30d': return { desde: new Date(hoy - 29 * DIA), hasta: new Date(ahora + 60000) };
    case 'todo': return { desde: new Date(0), hasta: new Date(ahora + 60000) };
    case 'hoy':
    default: return { desde: new Date(hoy), hasta: new Date(ahora + 60000) };
  }
}

/**
 * Le suma a cada anuncio lo que Meta dice que se gastó en él. Los anuncios
 * que gastaron y no trajeron a nadie también aparecen: son justo los que hay
 * que apagar.
 */
function sumarGasto(datos, meta) {
  const vistos = new Set();
  for (const a of datos.anuncios) {
    if (!a.ad_id) continue;
    const m = meta.porAnuncio.get(String(a.ad_id));
    vistos.add(String(a.ad_id));
    a.gasto = m?.gasto || 0;
    a.conversaciones_meta = m?.conversaciones_meta || 0;
    if (m && !a.nombre) {
      a.nombre = m.nombre;
      a.conjunto = m.conjunto;
      a.adset_id = m.adset_id;
      a.campana = m.campana;
      a.campaign_id = m.campaign_id;
    }
  }
  for (const [id, m] of meta.porAnuncio) {
    if (vistos.has(id) || !(m.gasto > 0)) continue;
    datos.anuncios.push({
      ad_id: id, nombre: m.nombre, conjunto: m.conjunto, adset_id: m.adset_id,
      campana: m.campana, campaign_id: m.campaign_id, titulo: null, texto: null,
      conversaciones: 0, vieron_producto: 0, pidieron_comprar: 0, recibieron_datos: 0,
      mandaron_comprobante: 0, compraron: 0, cobrado: 0, molestos: 0,
      gasto: m.gasto, conversaciones_meta: m.conversaciones_meta
    });
  }
  datos.total.gasto = meta.gasto;
  datos.meta_desde = meta.desde;
  datos.meta_hasta = meta.hasta;
  datos.anuncios.sort((x, y) =>
    (y.compraron - x.compraron) || ((y.gasto || 0) - (x.gasto || 0)) || (y.conversaciones - x.conversaciones)
  );

  // Recalcular agregación por Conjunto de Anuncios con los datos de gasto
  const vacioCj = () => ({
    anuncios: 0, conversaciones: 0, vieron_producto: 0, pidieron_comprar: 0,
    recibieron_datos: 0, mandaron_comprobante: 0, compraron: 0, cobrado: 0, molestos: 0,
    gasto: 0, conversaciones_meta: 0
  });
  const mapConjuntos = new Map();
  for (const a of datos.anuncios) {
    const cjClave = a.conjunto || (a.adset_id ? `Conjunto ID ${a.adset_id}` : (a.ad_id ? 'Sin conjunto asignado' : 'Directo (sin anuncio)'));
    if (!mapConjuntos.has(cjClave)) {
      mapConjuntos.set(cjClave, {
        conjunto: cjClave,
        adset_id: a.adset_id || null,
        campana: a.campana || null,
        ...vacioCj()
      });
    }
    const cj = mapConjuntos.get(cjClave);
    if (a.ad_id) cj.anuncios++;
    cj.conversaciones += (a.conversaciones || 0);
    cj.vieron_producto += (a.vieron_producto || 0);
    cj.pidieron_comprar += (a.pidieron_comprar || 0);
    cj.recibieron_datos += (a.recibieron_datos || 0);
    cj.mandaron_comprobante += (a.mandaron_comprobante || 0);
    cj.compraron += (a.compraron || 0);
    cj.cobrado += (a.cobrado || 0);
    cj.molestos += (a.molestos || 0);
    cj.gasto += (a.gasto || 0);
    cj.conversaciones_meta += (a.conversaciones_meta || 0);
  }
  datos.conjuntos = [...mapConjuntos.values()].sort((x, y) =>
    (y.compraron - x.compraron) || ((y.gasto || 0) - (x.gasto || 0)) || (y.conversaciones - x.conversaciones)
  );
}

function esAdmin(req) {
  return ['admin', 'superadmin'].includes(req.user?.role);
}

export const anuncioController = {
  /** GET /api/anuncios?periodo=hoy|ayer|7d|30d|todo */
  async rendimiento(req, res) {
    try {
      const periodo = ['hoy', 'ayer', '7d', '30d', 'todo'].includes(req.query.periodo) ? req.query.periodo : 'hoy';
      const { desde, hasta } = rangoDePeriodo(periodo);
      const teamId = req.user?.role === 'superadmin' ? null : (req.user?.team_id || null);
      const datos = await anuncioRepository.rendimiento({ desde, hasta, teamId });
      const meta = await metaAdsService.gastoPorAnuncio({ desde, hasta, todo: periodo === 'todo' });
      if (meta) sumarGasto(datos, meta);
      return res.json({
        periodo, desde, hasta, ...datos,
        meta: { ...metaAdsService.estadoMeta(), con_gasto: Boolean(meta) }
      });
    } catch (err) {
      return res.status(500).json({ error: 'No se pudo armar el informe de anuncios: ' + err.message });
    }
  },

  /** PATCH /api/anuncios/:adId  { nombre, conjunto?, adsetId?, campana? } */
  async nombrar(req, res) {
    try {
      if (!esAdmin(req)) return res.status(403).json({ error: 'Solo un administrador puede nombrar anuncios.' });
      const adId = String(req.params.adId || '').trim();
      if (!/^\d{6,30}$/.test(adId)) return res.status(400).json({ error: 'Ese no parece el identificador de un anuncio.' });
      const b = req.body || {};
      const fila = await anuncioRepository.nombrar(adId, {
        nombre: b.nombre, conjunto: b.conjunto, adsetId: b.adsetId || b.adset_id, campana: b.campana, campaignId: b.campaignId || b.campaign_id
      });
      return res.json(fila);
    } catch (err) {
      return res.status(500).json({ error: 'No se pudo guardar el nombre: ' + err.message });
    }
  },

  /** GET /api/anuncios/meta — si está conectado al Administrador de anuncios. */
  async estadoMeta(req, res) {
    return res.json(metaAdsService.estadoMeta());
  },

  /** POST /api/anuncios/sincronizar — trae ya los nombres de Meta. */
  async sincronizar(req, res) {
    try {
      if (!esAdmin(req)) return res.status(403).json({ error: 'Solo un administrador puede sincronizar.' });
      if (!metaAdsService.conectado()) {
        return res.status(400).json({ error: 'Falta conectar Meta: cargá META_ADS_TOKEN y META_AD_ACCOUNT_ID en el servidor.' });
      }
      metaAdsService.olvidarCacheMeta();
      const r = await metaAdsService.sincronizarNombres();
      if (r.error) return res.status(502).json({ error: r.error });
      return res.json(r);
    } catch (err) {
      return res.status(500).json({ error: 'No se pudo sincronizar: ' + err.message });
    }
  },

  /** POST /api/anuncios/importar  { texto } */
  async importar(req, res) {
    try {
      if (!esAdmin(req)) return res.status(403).json({ error: 'Solo un administrador puede nombrar anuncios.' });
      const lista = leerListaDeAnuncios(req.body?.texto);
      if (!lista.length) {
        return res.status(400).json({
          error: 'No encontré anuncios en lo que pegaste. Exportá la tabla de Anuncios con la columna "Identificador del anuncio", o pegá una línea por anuncio: número y nombre.'
        });
      }
      for (const a of lista.slice(0, 1000)) {
        await anuncioRepository.nombrar(a.ad_id, a);
      }
      return res.json({ importados: Math.min(lista.length, 1000) });
    } catch (err) {
      return res.status(500).json({ error: 'No se pudieron guardar los nombres: ' + err.message });
    }
  }
};

export default anuncioController;
