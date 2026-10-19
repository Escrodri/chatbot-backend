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
    await query(
      `INSERT INTO visitas_web
        (ts, tipo, ruta, url, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
         sck, src, campaign_id, adset_id, ad_id, placement, site, fbclid, ref, disp, destino, destino_sck, destino_off)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [ev.ts, ev.tipo, ev.ruta, ev.url, ev.utm_source, ev.utm_medium, ev.utm_campaign, ev.utm_content,
        ev.utm_term, ev.sck, ev.src, ev.campaign_id, ev.adset_id, ev.ad_id, ev.placement, ev.site, ev.fbclid,
        ev.ref, ev.disp, ev.destino, ev.destino_sck, ev.destino_off]
    );
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

/** Eventos desde `desde` (Date): los de la base más los que solo están en memoria. */
export async function leerEventos(desde) {
  const enMemoria = memoria.filter((e) => new Date(e.ts) >= desde);
  if (Date.now() < dbPausadaHasta) return { eventos: enMemoria, almacenamiento: 'memoria' };

  try {
    await asegurarTabla();
    const r = await query(
      `SELECT ts, tipo, ruta, url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, sck, src,
              campaign_id, adset_id, ad_id, placement, site, fbclid, ref, disp, destino, destino_sck, destino_off
         FROM visitas_web WHERE ts >= $1 ORDER BY ts DESC LIMIT 50000`,
      [desde.toISOString()]
    );
    const deDb = r.rows.map((f) => ({
      ...f,
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

function diaEn(fecha, zona) {
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
export function resumir(eventos, { ahora = new Date(), dias = 7, zona = ZONA, recientes = 40 } = {}) {
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

  // Serie diaria: todos los días del período, aunque estén en cero.
  const porDia = new Map();
  for (let i = dias - 1; i >= 0; i--) {
    porDia.set(diaEn(new Date(ahora.getTime() - i * 86400000), zona), { dia: '', visitas: 0, clics: 0 });
  }
  for (const [dia, g] of porDia) g.dia = dia;
  for (const e of eventos) {
    const g = porDia.get(diaEn(new Date(e.ts), zona));
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
      .slice(0, recientes)
      .map((e) => ({
        ts: e.ts, tipo: e.tipo, url: e.url, ref: e.ref, disp: e.disp,
        destino: e.destino, destino_sck: e.destino_sck, destino_off: e.destino_off
      }))
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

/** Solo para pruebas. */
export function _reiniciar() {
  memoria.length = 0;
  dbPausadaHasta = 0;
  tablaLista = false;
  modoAlmacen = 'memoria';
}

export default { normalizar, registrar, leerEventos, resumir, claveDelDash, claveValida, estadoAlmacen };
