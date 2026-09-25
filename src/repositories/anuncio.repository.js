import { query } from '../database/index.js';
import { ETAPAS } from './order.repository.js';

/**
 * Anuncios: de dónde viene cada persona y qué hizo después.
 *
 * Meta manda el identificador del anuncio en el primer mensaje. El nombre que
 * tiene en el Administrador de anuncios no viene nunca, así que se guarda acá
 * cuando el dueño lo carga en el panel. El rendimiento se cuenta por persona
 * que ENTRÓ en el período: de los que escribieron hoy desde el anuncio X,
 * cuántos pidieron datos, cuántos mandaron comprobante y cuántos pagaron. Así
 * se compara con lo que Meta cobró ese mismo día por ese anuncio.
 */

const PAGADO = ['pagado', 'entregado'];
const pos = (etapa) => ETAPAS.indexOf(etapa);

function limpio(valor, max = 160) {
  const t = String(valor ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

export const anuncioRepository = {
  /**
   * Anota que el anuncio trajo a alguien. Guarda lo que Meta mandó (título,
   * texto) sin pisar el nombre que se haya cargado a mano.
   */
  async visto(atribucion, plataforma = null) {
    const adId = limpio(atribucion?.adId, 100);
    if (!adId) return;
    try {
      await query(
        `INSERT INTO anuncios (ad_id, titulo, texto, url, plataforma)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ad_id) DO UPDATE
           SET titulo     = COALESCE(EXCLUDED.titulo, anuncios.titulo),
               texto      = COALESCE(EXCLUDED.texto, anuncios.texto),
               url        = COALESCE(EXCLUDED.url, anuncios.url),
               plataforma = COALESCE(anuncios.plataforma, EXCLUDED.plataforma),
               ultima_vez = CURRENT_TIMESTAMP`,
        [adId, limpio(atribucion.titulo, 500), limpio(atribucion.texto, 2000),
         limpio(atribucion.sourceUrl, 1000), plataforma]
      );
    } catch (err) {
      // Que no se pueda anotar el anuncio nunca puede frenar el mensaje.
      console.warn('⚠️ [ANUNCIOS] No se pudo anotar el anuncio:', err.message);
    }
  },

  /** Pone o cambia el nombre de un anuncio. Un campo vacío lo borra. */
  async nombrar(adId, { nombre, conjunto, campana } = {}) {
    const id = limpio(adId, 100);
    if (!id) return null;
    const { rows } = await query(
      `INSERT INTO anuncios (ad_id, nombre, conjunto, campana, primera_vez, ultima_vez)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (ad_id) DO UPDATE
         SET nombre     = CASE WHEN $5 THEN EXCLUDED.nombre   ELSE anuncios.nombre   END,
             conjunto   = CASE WHEN $6 THEN EXCLUDED.conjunto ELSE anuncios.conjunto END,
             campana    = CASE WHEN $7 THEN EXCLUDED.campana  ELSE anuncios.campana  END,
             updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [id, limpio(nombre), limpio(conjunto), limpio(campana),
       nombre !== undefined, conjunto !== undefined, campana !== undefined]
    );
    return rows[0] || null;
  },

  /**
   * Rendimiento de cada anuncio entre dos fechas.
   *
   * @param {{ desde: Date, hasta: Date, teamId?: number|null }} p
   */
  async rendimiento({ desde, hasta, teamId = null }) {
    const { rows } = await query(
      `SELECT c.id,
              NULLIF(c.source_ad_id, '') AS ad_id,
              c.molesto_at IS NOT NULL AS molesto,
              COALESCE(json_agg(json_build_object(
                'etapa', o.etapa, 'status', o.status,
                'cobrado', COALESCE(o.precio_cobrado, o.amount)
              )) FILTER (WHERE o.id IS NOT NULL), '[]') AS pedidos
         FROM conversations c
         LEFT JOIN channels ch ON ch.id = c.channel_id
         LEFT JOIN orders o ON o.conversation_id = c.id
        WHERE c.created_at >= $1 AND c.created_at < $2
          AND ($3::int IS NULL OR ch.team_id IS NOT DISTINCT FROM $3::int)
        GROUP BY c.id`,
      [desde, hasta, teamId]
    );

    const vacio = () => ({
      conversaciones: 0, vieron_producto: 0, pidieron_comprar: 0, recibieron_datos: 0,
      mandaron_comprobante: 0, compraron: 0, cobrado: 0, molestos: 0
    });
    const porAnuncio = new Map();
    const total = vacio();

    for (const fila of rows) {
      const clave = fila.ad_id || '';
      if (!porAnuncio.has(clave)) porAnuncio.set(clave, vacio());
      const a = porAnuncio.get(clave);

      // Lo más lejos que llegó esta persona, en cualquiera de sus pedidos.
      let lejos = -1;
      let compro = false;
      let cobrado = 0;
      for (const p of fila.pedidos || []) {
        lejos = Math.max(lejos, pos(p.etapa));
        if (PAGADO.includes(p.status)) {
          compro = true;
          cobrado += Number(p.cobrado) || 0;
        }
      }
      if (compro) lejos = Math.max(lejos, pos('pago'));

      for (const destino of [a, total]) {
        destino.conversaciones++;
        if (lejos >= pos('vio_producto')) destino.vieron_producto++;
        if (lejos >= pos('pidio_comprar')) destino.pidieron_comprar++;
        if (lejos >= pos('recibio_datos')) destino.recibieron_datos++;
        if (lejos >= pos('mando_comprobante')) destino.mandaron_comprobante++;
        if (compro) destino.compraron++;
        destino.cobrado += cobrado;
        if (fila.molesto) destino.molestos++;
      }
    }

    const ids = [...porAnuncio.keys()].filter(Boolean);
    const datos = new Map();
    if (ids.length) {
      const { rows: an } = await query(
        `SELECT ad_id, nombre, conjunto, campana, titulo, texto, plataforma
           FROM anuncios WHERE ad_id = ANY($1::text[])`,
        [ids]
      );
      for (const r of an) datos.set(r.ad_id, r);
    }

    const anuncios = [...porAnuncio.entries()].map(([id, n]) => {
      const d = datos.get(id) || {};
      return {
        ad_id: id || null,
        nombre: d.nombre || null,
        conjunto: d.conjunto || null,
        campana: d.campana || null,
        titulo: d.titulo || null,
        texto: d.texto || null,
        ...n
      };
    }).sort((x, y) =>
      (y.compraron - x.compraron) || (y.conversaciones - x.conversaciones)
    );

    return { total, anuncios };
  }
};

/**
 * Lee lo que se pegue en el panel para ponerle nombre a muchos anuncios de
 * una vez.
 *
 * Acepta el informe exportado del Administrador de anuncios (CSV o copiado
 * de la tabla, con columnas "Identificador del anuncio" y "Nombre del
 * anuncio", en español o en inglés) y, si no hay encabezado, líneas sueltas
 * con el número del anuncio y el nombre al lado.
 */
export function leerListaDeAnuncios(texto) {
  const lineas = String(texto || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lineas.length) return [];

  const sep = [ '\t', ';', ',' ].find(s => lineas[0].includes(s)) || null;
  const partir = (linea) => {
    if (!sep) return [linea];
    const celdas = [];
    let actual = '';
    let comillas = false;
    for (let i = 0; i < linea.length; i++) {
      const ch = linea[i];
      if (ch === '"') {
        if (comillas && linea[i + 1] === '"') { actual += '"'; i++; } else comillas = !comillas;
      } else if (ch === sep && !comillas) {
        celdas.push(actual); actual = '';
      } else actual += ch;
    }
    celdas.push(actual);
    return celdas.map(c => c.trim());
  };

  const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const cabecera = partir(lineas[0]).map(norm);
  const col = (...nombres) => cabecera.findIndex(c => nombres.includes(c));
  const iId = col('identificador del anuncio', 'id del anuncio', 'ad id');
  const iNombre = col('nombre del anuncio', 'anuncio', 'ad name');

  const salida = [];
  if (iId >= 0 && iNombre >= 0) {
    const iConjunto = col('nombre del conjunto de anuncios', 'conjunto de anuncios', 'ad set name');
    const iCampana = col('nombre de la campana', 'campana', 'campaign name');
    for (const linea of lineas.slice(1)) {
      const c = partir(linea);
      const id = (c[iId] || '').replace(/\D/g, '');
      if (id.length < 6 || !c[iNombre]) continue;
      salida.push({
        ad_id: id,
        nombre: c[iNombre],
        conjunto: iConjunto >= 0 ? c[iConjunto] || null : undefined,
        campana: iCampana >= 0 ? c[iCampana] || null : undefined
      });
    }
    return salida;
  }

  // Sin encabezado: "120212345678901234  CREATIVO A — CONTROL".
  for (const linea of lineas) {
    const m = linea.match(/\b(\d{10,20})\b/);
    if (!m) continue;
    const nombre = linea.replace(m[0], ' ').replace(/^[\s,;:\t|\-–—]+|[\s,;:\t|\-–—]+$/g, '').replace(/\s+/g, ' ');
    if (nombre) salida.push({ ad_id: m[1], nombre });
  }
  return salida;
}

export default anuncioRepository;
