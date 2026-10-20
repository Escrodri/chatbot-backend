/**
 * Rastro de visitas a la landing (Plan 21 y las que vengan).
 *
 * La landing manda acá, con un POST sin cookies, la dirección con la que entró
 * cada persona (utm_*, sck, ad_id) y la dirección de pago a la que la mandó
 * cuando toca "comprar". Con eso se puede VER de dónde llega la gente y si el
 * enlace de pago a Hotmart lleva el anuncio, sin depender del píxel de Meta
 * (que en la categoría "Salud y bienestar" no recibe parámetros de la URL).
 *
 * Privacidad: no se guarda IP, ni cookies, ni identificadores. El valor de
 * fbclid (que identifica un clic) se descarta: solo se anota que venía.
 *
 * Dónde se guarda: en Postgres (tabla visitas_web, se crea sola) y, siempre,
 * en una memoria circular de los últimos eventos. Si la base de datos no
 * responde, el rastro sigue funcionando en memoria (se pierde al reiniciar el
 * servicio) y se vuelve a intentar con la base cada 5 minutos.
 */
import crypto from 'crypto';
import { query } from '../database/pool.js';
import { config } from '../config/index.js';

const TIPOS = new Set(['visita', 'clic_comprar']);
const MAX_MEMORIA = 20000;
const PAUSA_DB_MS = 5 * 60 * 1000;
const ZONA = 'America/Asuncion';

const memoria = [];          // eventos recibidos desde que arrancó el servicio (más nuevo al final)
let dbPausadaHasta = 0;
let tablaLista = false;
let ultimoAvisoDb = 0;
let modoAlmacen = 'memoria'; // 'postgres' cuando el último intento con la base salió bien

// ───────────────────────── Normalización ─────────────────────────

function texto(valor, max) {
  if (valor === undefined || valor === null) return '';
  // eslint-disable-next-line no-control-regex
  return String(valor).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Los IDs de Meta son solo números: si llega la llave sin reemplazar ({{ad.id}}) no vale. */
function idNumerico(valor) {
  const t = texto(valor, 40);
  return /^\d{5,25}$/.test(t) ? t : '';
}

function hostDe(valor) {
  const t = texto(valor, 200);
  if (!t) return '';
  try { return new URL(t.includes('://') ? t : `https://${t}`).hostname.toLowerCase().slice(0, 80); }
  catch { return t.toLowerCase().slice(0, 80); }
}

/** Quita el valor de fbclid (identifica un clic): se deja la marca de que venía. */
function sinFbclid(cadena) {
  return cadena.replace(/([?&]fbclid=)[^&#]*/i, '$1x');
}

function parametrosDe(direccion) {
  try {
    const u = new URL(direccion, 'https://landing.invalido');
    return { ruta: u.pathname.slice(0, 120), params: u.searchParams, search: u.search };
  } catch {
    return { ruta: '', params: new URLSearchParams(), search: '' };
  }
}

/**
 * Convierte lo que manda la landing en un evento limpio, o null si no sirve.
 * Cuerpo esperado: { t: 'visita'|'clic_comprar', u: '/?utm_...', r: 'host', d: 'm'|'d', dest: 'https://pay...' }
 */
export function normalizar(cuerpo, ahora = new Date()) {
  if (!cuerpo || typeof cuerpo !== 'object') return null;
  if (!TIPOS.has(cuerpo.t)) return null;

  const u = texto(cuerpo.u, 1200);
  if (!u) return null;

  const { ruta, params, search } = parametrosDe(u);
  const dest = texto(cuerpo.dest, 800);
  const destino = dest ? parametrosDe(dest) : null;

  return {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts: ahora.toISOString(),
    tipo: cuerpo.t,
    ruta,
    url: sinFbclid(ruta + search).slice(0, 700),
    utm_source: texto(params.get('utm_source'), 80),
    utm_medium: texto(params.get('utm_medium'), 80),
    utm_campaign: texto(params.get('utm_campaign'), 120),
    utm_content: texto(params.get('utm_content'), 120),
    utm_term: texto(params.get('utm_term'), 120),
    sck: texto(params.get('sck'), 60),
    src: texto(params.get('src'), 60),
    // IDs que Meta rellena con {{campaign.id}}, {{adset.id}} y {{ad.id}} (Parámetros de URL del anuncio).
    campaign_id: idNumerico(params.get('campaign_id')),
    adset_id: idNumerico(params.get('adset_id')),
    ad_id: idNumerico(params.get('ad_id')),
    placement: texto(params.get('placement'), 40),
    site: texto(params.get('site') || params.get('site_source_name'), 40),
    fbclid: params.has('fbclid'),
    ref: hostDe(cuerpo.r),
    disp: cuerpo.d === 'm' || cuerpo.d === 'd' ? cuerpo.d : '',
    destino: destino ? sinFbclid(dest) : '',
    destino_sck: destino ? texto(destino.params.get('sck'), 60) : '',
    destino_off: destino ? texto(destino.params.get('off'), 40) : '',
    enDb: false
  };
}

// ───────────────────────── Guardado ─────────────────────────

async function asegurarTabla() {
  if (tablaLista) return;
  await query(`
    CREATE TABLE IF NOT EXISTS visitas_web (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      tipo VARCHAR(20) NOT NULL,
      ruta VARCHAR(120),
      url TEXT,
      utm_source VARCHAR(80),
      utm_medium VARCHAR(80),
      utm_campaign VARCHAR(120),
      utm_content VARCHAR(120),
      utm_term VARCHAR(120),
      sck VARCHAR(60),
      src VARCHAR(60),
      campaign_id VARCHAR(40),
      adset_id VARCHAR(40),
      ad_id VARCHAR(40),
      placement VARCHAR(40),
      site VARCHAR(40),
      fbclid BOOLEAN NOT NULL DEFAULT FALSE,
      ref VARCHAR(80),
      disp VARCHAR(1),
      destino TEXT,
      destino_sck VARCHAR(60),
      destino_off VARCHAR(40)
    )`);
  await query('CREATE INDEX IF NOT EXISTS idx_visitas_web_ts ON visitas_web (ts DESC)');
  tablaLista = true;
}

function avisarDb(err) {
  const ahora = Date.now();
  if (ahora - ultimoAvisoDb < PAUSA_DB_MS) return;
  ultimoAvisoDb = ahora;
  console.warn(`⚠️ [VISITAS] La base de datos no responde (${err.message}). Se guarda en memoria y se reintenta en 5 minutos.`);
}

async function guardarEnDb(ev) {
  if (Date.now() < dbPausadaHasta) return false;
  try {
    await asegurarTabla();
    const r = await query(
      `INSERT INTO visitas_web
        (ts, tipo, ruta, url, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         sck, src, campaign_id, adset_id, ad_id, placement, site, fbclid, ref, disp, destino, destino_sck, destino_off)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [ev.ts, ev.tipo, ev.ruta, ev.url, ev.utm_source, ev.utm_medium, ev.utm_campaign, ev.utm_content,
        ev.utm_term, ev.sck, ev.src, ev.campaign_id, ev.adset_id, ev.ad_id, ev.placement, ev.site, ev.fbclid,
        ev.ref, ev.disp, ev.destino, ev.destino_sck, ev.destino_off]
    );
    if (r.rows?.[0]?.id) ev.id = String(r.rows[0].id);
    modoAlmacen = 'postgres';
    return true;
  } catch (err) {
    modoAlmacen = 'memoria';
    dbPausadaHasta = Date.now() + PAUSA_DB_MS;
    tablaLista = false;
    avisarDb(err);
    return false;
  }
}

/** Anota el evento en memoria y, si se puede, en la base. Nunca lanza. */
export async function registrar(ev) {
  memoria.push(ev);
  if (memoria.length > MAX_MEMORIA) memoria.splice(0, memoria.length - MAX_MEMORIA);
  ev.enDb = await guardarEnDb(ev);
  return ev;
}

/** Eventos desde `desde` hasta opcional `hasta` (Date): los de la base más los que solo están en memoria. */
export async function leerEventos(desde, hasta = null) {
  const enMemoria = memoria.filter((e) => {
    const t = new Date(e.ts);
    return t >= desde && (!hasta || t <= hasta);
  });
  if (Date.now() < dbPausadaHasta) return { eventos: enMemoria, almacenamiento: 'memoria' };

  try {
    await asegurarTabla();
    let sql = `SELECT id, ts, tipo, ruta, url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, sck, src,
              campaign_id, adset_id, ad_id, placement, site, fbclid, ref, disp, destino, destino_sck, destino_off
         FROM visitas_web WHERE ts >= $1`;
    const params = [desde.toISOString()];
    if (hasta) {
      sql += ' AND ts <= $2';
      params.push(hasta.toISOString());
    }
    sql += ' ORDER BY ts DESC LIMIT 50000';
    const r = await query(sql, params);
    const deDb = r.rows.map((f) => ({
      ...f,
      id: String(f.id),
      ts: new Date(f.ts).toISOString(),
      utm_source: f.utm_source || '', utm_medium: f.utm_medium || '', utm_campaign: f.utm_campaign || '',
      utm_content: f.utm_content || '', utm_term: f.utm_term || '', sck: f.sck || '', src: f.src || '',
      campaign_id: f.campaign_id || '', adset_id: f.adset_id || '', ad_id: f.ad_id || '',
      placement: f.placement || '', site: f.site || '', ref: f.ref || '', disp: f.disp || '', destino: f.destino || '',
      destino_sck: f.destino_sck || '', destino_off: f.destino_off || '', url: f.url || ''
    }));
    // Lo que entró mientras la base no respondía solo existe en memoria.
    const pendientes = enMemoria.filter((e) => !e.enDb);
    modoAlmacen = 'postgres';
    return { eventos: [...deDb, ...pendientes], almacenamiento: 'postgres' };
  } catch (err) {
    dbPausadaHasta = Date.now() + PAUSA_DB_MS;
    tablaLista = false;
    modoAlmacen = 'memoria';
    avisarDb(err);
    return { eventos: enMemoria, almacenamiento: 'memoria' };
  }
}

// ───────────────────────── Resumen para el dash ─────────────────────────

const SIN = '(sin dato)';

export function obtenerInicioDia(fecha, timeZone = ZONA) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });
  const parts = Object.fromEntries(dtf.formatToParts(fecha).map((p) => [p.type, p.value]));
  const h = parts.hour === '24' ? 0 : Number(parts.hour);
  const m = Number(parts.minute);
  const s = Number(parts.second);
  const utcRepresentado = Date.UTC(parts.year, parts.month - 1, parts.day, h, m, s);
  const offsetMs = utcRepresentado - Math.floor(fecha.getTime() / 1000) * 1000;
  const inicioDiaUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - offsetMs;
  return new Date(inicioDiaUtc);
}

export function diaEn(fecha, zona = ZONA) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit' }).format(fecha);
}

function agrupar(eventos, nombreDe) {
  const mapa = new Map();
  for (const e of eventos) {
    const nombre = nombreDe(e) || SIN;
    const g = mapa.get(nombre) || { nombre, visitas: 0, clics: 0 };
    if (e.tipo === 'visita') g.visitas += 1; else g.clics += 1;
    mapa.set(nombre, g);
  }
  return [...mapa.values()]
    .map((g) => ({ ...g, tasa: g.visitas ? Number(((g.clics / g.visitas) * 100).toFixed(1)) : 0 }))
    .sort((a, b) => (b.visitas + b.clics) - (a.visitas + a.clics))
    .slice(0, 25);
}

/** Calcula todo lo que muestra el dash a partir de una lista de eventos. */
export function resumir(eventos, { ahora = new Date(), dias = 7, periodo = '', zona = ZONA, desde = null, hasta = null, recientes = 250 } = {}) {
  const visitas = eventos.filter((e) => e.tipo === 'visita');
  const clics = eventos.filter((e) => e.tipo === 'clic_comprar');

  const cuenta = (lista, fn) => lista.reduce((n, e) => n + (fn(e) ? 1 : 0), 0);
  const pct = (a, b) => (b ? Number(((a / b) * 100).toFixed(1)) : null);

  const conUtm = cuenta(visitas, (e) => e.utm_source);
  const conAnuncio = cuenta(visitas, (e) => e.utm_content);
  const conAdId = cuenta(visitas, (e) => e.ad_id);
  const conAdset = cuenta(visitas, (e) => e.adset_id);
  const conCampaignId = cuenta(visitas, (e) => e.campaign_id);
  const conPlacement = cuenta(visitas, (e) => e.placement);
  const conFbclid = cuenta(visitas, (e) => e.fbclid);
  const clicsConSck = cuenta(clics, (e) => e.destino_sck);

  // Fechas de referencia en la zona horaria indicada
  const diaHoy = diaEn(ahora, zona);
  const inicioHoy = obtenerInicioDia(ahora, zona);
  const diaAyer = diaEn(new Date(inicioHoy.getTime() - 1000), zona);

  // Serie diaria:
  const porDia = new Map();
  if (periodo === 'ayer') {
    porDia.set(diaAyer, { dia: diaAyer, visitas: 0, clics: 0 });
  } else if (periodo === 'hoy') {
    porDia.set(diaHoy, { dia: diaHoy, visitas: 0, clics: 0 });
  } else {
    for (let i = dias - 1; i >= 0; i--) {
      const d = diaEn(new Date(ahora.getTime() - i * 86400000), zona);
      porDia.set(d, { dia: '', visitas: 0, clics: 0 });
    }
  }
  for (const [dia, g] of porDia) g.dia = dia;
  for (const e of eventos) {
    const diaEv = diaEn(new Date(e.ts), zona);
    const g = porDia.get(diaEv);
    if (!g) continue;
    if (e.tipo === 'visita') g.visitas += 1; else g.clics += 1;
  }

  return {
    totales: {
      visitas: visitas.length,
      clics: clics.length,
      tasaClic: pct(clics.length, visitas.length)
    },
    diagnostico: {
      conUtm: { n: conUtm, de: visitas.length, pct: pct(conUtm, visitas.length) },
      conAnuncio: { n: conAnuncio, de: visitas.length, pct: pct(conAnuncio, visitas.length) },
      conAdId: { n: conAdId, de: visitas.length, pct: pct(conAdId, visitas.length) },
      conAdset: { n: conAdset, de: visitas.length, pct: pct(conAdset, visitas.length) },
      conCampaignId: { n: conCampaignId, de: visitas.length, pct: pct(conCampaignId, visitas.length) },
      conPlacement: { n: conPlacement, de: visitas.length, pct: pct(conPlacement, visitas.length) },
      conFbclid: { n: conFbclid, de: visitas.length, pct: pct(conFbclid, visitas.length) },
      clicsConSck: { n: clicsConSck, de: clics.length, pct: pct(clicsConSck, clics.length) }
    },
    porAnuncio: agrupar(eventos, (e) => e.utm_content || e.ad_id),
    porAdId: agrupar(eventos.filter((e) => e.ad_id), (e) => e.ad_id),
    porAdset: agrupar(eventos, (e) => e.utm_term || e.adset_id),
    porCampana: agrupar(eventos, (e) => e.utm_campaign || e.campaign_id),
    porUbicacion: agrupar(eventos, (e) => [e.placement, e.site].filter(Boolean).join(' · ')),
    porFuente: agrupar(eventos, (e) => [e.utm_source, e.utm_medium].filter(Boolean).join(' / ')),
    porReferrer: agrupar(eventos, (e) => e.ref || 'directo'),
    porDispositivo: agrupar(eventos, (e) => (e.disp === 'm' ? 'celular' : e.disp === 'd' ? 'computadora' : '')),
    porDia: [...porDia.values()],
    recientes: [...eventos]
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 250)
      .map((e) => {
        const diaEv = diaEn(new Date(e.ts), zona);
        return {
          id: e.id ? String(e.id) : '',
          ts: e.ts,
          dia_str: diaEv,
          es_hoy: diaEv === diaHoy,
          es_ayer: diaEv === diaAyer,
          tipo: e.tipo,
          url: e.url,
          ref: e.ref,
          disp: e.disp,
          destino: e.destino,
          destino_sck: e.destino_sck,
          destino_off: e.destino_off,
          utm_source: e.utm_source || '',
          utm_medium: e.utm_medium || '',
          utm_campaign: e.utm_campaign || '',
          utm_content: e.utm_content || '',
          utm_term: e.utm_term || '',
          sck: e.sck || '',
          ad_id: e.ad_id || '',
          adset_id: e.adset_id || '',
          campaign_id: e.campaign_id || '',
          placement: e.placement || '',
          site: e.site || ''
        };
      })
  };
}

// ───────────────────────── Acceso al dash ─────────────────────────

/**
 * Clave del dash. Si no se define VISITAS_CLAVE, se deriva de SESSION_SECRET:
 * es estable entre reinicios y no está escrita en el código.
 */
export function claveDelDash() {
  const fija = (process.env.VISITAS_CLAVE || '').trim();
  if (fija) return fija;
  return crypto.createHash('sha256').update(`visitas:${config.security.sessionSecret}`).digest('hex').slice(0, 20);
}

export function claveValida(candidata) {
  if (!candidata) return false;
  const a = crypto.createHash('sha256').update(String(candidata)).digest();
  const b = crypto.createHash('sha256').update(claveDelDash()).digest();
  return crypto.timingSafeEqual(a, b);
}

export function estadoAlmacen() {
  return modoAlmacen;
}

/** Elimina un evento puntual por su ID o fecha/hora. */
export async function eliminarEvento(id, ts) {
  if (id && /^\d+$/.test(String(id))) {
    try {
      await query('DELETE FROM visitas_web WHERE id = $1', [id]);
    } catch (err) {
      console.warn('⚠️ [VISITAS] Error al borrar evento de DB:', err.message);
    }
  } else if (ts) {
    try {
      await query('DELETE FROM visitas_web WHERE ts = $1', [new Date(ts).toISOString()]);
    } catch {}
  }

  // Quitar también de memoria
  const idx = memoria.findIndex((e) => (id && String(e.id) === String(id)) || (ts && e.ts === ts));
  if (idx !== -1) memoria.splice(idx, 1);
  return true;
}

/** Limpia las visitas de prueba: 'todas' borra todo el historial; 'sin_utm' borra solo las que no vinieron de anuncios. */
export async function limpiarEventos({ tipo = 'todas' } = {}) {
  try {
    if (tipo === 'sin_utm') {
      await query("DELETE FROM visitas_web WHERE utm_source IS NULL OR utm_source = ''");
      for (let i = memoria.length - 1; i >= 0; i--) {
        if (!memoria[i].utm_source) memoria.splice(i, 1);
      }
    } else {
      await query('DELETE FROM visitas_web');
      memoria.length = 0;
    }
  } catch (err) {
    console.warn('⚠️ [VISITAS] Error al vaciar eventos de DB:', err.message);
    if (tipo === 'todas') memoria.length = 0;
  }
  return true;
}

/** Solo para pruebas. */
export function _reiniciar() {
  memoria.length = 0;
  dbPausadaHasta = 0;
  tablaLista = false;
  modoAlmacen = 'memoria';
}

export default {
  normalizar,
  registrar,
  leerEventos,
  resumir,
  eliminarEvento,
  limpiarEventos,
  claveDelDash,
  claveValida,
  estadoAlmacen,
  obtenerInicioDia,
  diaEn
};
