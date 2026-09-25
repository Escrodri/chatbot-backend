import crypto from 'crypto';
import { config } from '../config/index.js';
import { anuncioRepository } from '../repositories/anuncio.repository.js';

/**
 * Conexión con el Administrador de anuncios (API de Marketing de Meta).
 *
 * Trae dos cosas que el mensaje de WhatsApp no trae:
 *   - el nombre de cada anuncio, su conjunto y su campaña;
 *   - cuánto se gastó en cada anuncio en un período.
 *
 * Con eso el panel puede decir, por anuncio, cuánto costó cada venta de
 * verdad y no solo cada conversación.
 *
 * Es de solo lectura: el token necesita ads_read y nada más. No puede
 * cambiar presupuestos ni apagar anuncios, y así tiene que quedar.
 *
 * Variables:
 *   META_ADS_TOKEN       token de un usuario del sistema del Business Manager
 *   META_AD_ACCOUNT_ID   la cuenta publicitaria (1320909322870539 o act_1320…);
 *                        varias separadas por coma
 *   META_ADS_APP_SECRET  opcional: la clave secreta de la app, si la app pide
 *                        "appsecret_proof" en cada llamada
 */

const API = 'https://graph.facebook.com';
const CACHE_MS = 5 * 60 * 1000;
const SYNC_MS = 60 * 60 * 1000;

const estado = {
  ultimaSincronizacion: null,
  anunciosSincronizados: 0,
  error: null
};
const cache = new Map();
let temporizador = null;

function ajustes() {
  const a = config.metaAds || {};
  return {
    token: a.token || '',
    cuentas: (a.cuentas || []).map(c => (String(c).startsWith('act_') ? String(c) : `act_${c}`)),
    appSecret: a.appSecret || '',
    version: config.meta?.apiVersion || 'v21.0'
  };
}

export function conectado() {
  const { token, cuentas } = ajustes();
  return Boolean(token && cuentas.length);
}

async function pedir(ruta, parametros = {}) {
  const { token, appSecret, version } = ajustes();
  const url = new URL(ruta.startsWith('http') ? ruta : `${API}/${version}/${ruta}`);
  if (!ruta.startsWith('http')) {
    for (const [k, v] of Object.entries(parametros)) {
      url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    url.searchParams.set('access_token', token);
    if (appSecret) {
      url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', appSecret).update(token).digest('hex'));
    }
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const cuerpo = await res.json().catch(() => ({}));
  if (!res.ok || cuerpo.error) {
    const e = cuerpo.error || {};
    // El token nunca va en el mensaje de error: estos mensajes llegan al panel.
    throw new Error(explicarError(e, res.status));
  }
  return cuerpo;
}

function explicarError(e, status) {
  if (e.code === 190) return 'El token de Meta venció o fue revocado. Generá uno nuevo para el usuario del sistema.';
  if (e.code === 200 || e.code === 10 || e.code === 100 && /permission/i.test(e.message || '')) {
    return 'El token no tiene permiso para leer esta cuenta publicitaria. Asignale la cuenta al usuario del sistema y generá el token con ads_read.';
  }
  if (e.code === 17 || e.code === 80004 || e.code === 613) return 'Meta pidió esperar (demasiadas consultas). Se reintenta solo.';
  return `Meta respondió: ${e.message || `error ${status}`}`;
}

/** Recorre todas las páginas de una respuesta de la API. */
async function todas(ruta, parametros) {
  const filas = [];
  let r = await pedir(ruta, parametros);
  filas.push(...(r.data || []));
  let vueltas = 0;
  while (r.paging?.next && vueltas++ < 40) {
    r = await pedir(r.paging.next);
    filas.push(...(r.data || []));
  }
  return filas;
}

/**
 * Trae el nombre, conjunto y campaña de todos los anuncios de la cuenta y los
 * guarda. Los nombres de Meta mandan sobre los que se hayan cargado a mano.
 */
export async function sincronizarNombres() {
  if (!conectado()) return { conectado: false };
  try {
    let n = 0;
    for (const cuenta of ajustes().cuentas) {
      const ads = await todas(`${cuenta}/ads`, {
        fields: 'id,name,effective_status,adset{id,name},campaign{id,name}',
        limit: '500'
      });
      for (const a of ads) {
        await anuncioRepository.nombrar(a.id, {
          nombre: a.name || null,
          conjunto: a.adset?.name || null,
          adsetId: a.adset?.id || null,
          campana: a.campaign?.name || null,
          campaignId: a.campaign?.id || null
        });
        n++;
      }
    }
    estado.ultimaSincronizacion = new Date();
    estado.anunciosSincronizados = n;
    estado.error = null;
    console.log(`📣 [META ADS] ${n} anuncios sincronizados.`);
    return { conectado: true, anuncios: n };
  } catch (err) {
    estado.error = err.message;
    console.warn('⚠️ [META ADS] No se pudieron traer los anuncios:', err.message);
    return { conectado: true, error: err.message };
  }
}

/** "2026-09-25" en hora de Paraguay. */
function diaPY(fecha) {
  return new Date(new Date(fecha).getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

const CONVERSACION = 'onsite_conversion.messaging_conversation_started_7d';

/**
 * Gasto por anuncio entre dos fechas (días enteros en hora de Paraguay).
 *
 * @returns {Promise<{ porAnuncio: Map<string, {gasto:number, conversaciones_meta:number, impresiones:number}>, gasto:number } | null>}
 *   null si no está conectado o si Meta no respondió.
 */
export async function gastoPorAnuncio({ desde, hasta, todo = false }) {
  if (!conectado()) return null;
  const since = diaPY(desde);
  const until = diaPY(new Date(Math.min(new Date(hasta).getTime(), Date.now()) - 1));
  const clave = todo ? 'todo' : `${since}|${until}`;
  const guardado = cache.get(clave);
  if (guardado && Date.now() - guardado.t < CACHE_MS) return guardado.v;

  try {
    const porAnuncio = new Map();
    let gasto = 0;
    for (const cuenta of ajustes().cuentas) {
      const filas = await todas(`${cuenta}/insights`, {
        level: 'ad',
        fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,actions',
        ...(todo ? { date_preset: 'maximum' } : { time_range: { since, until } }),
        limit: '500'
      });
      for (const f of filas) {
        const g = Math.round(Number(f.spend) || 0);
        const conv = Number((f.actions || []).find(a => a.action_type === CONVERSACION)?.value) || 0;
        porAnuncio.set(String(f.ad_id), {
          gasto: g,
          conversaciones_meta: conv,
          impresiones: Number(f.impressions) || 0,
          nombre: f.ad_name || null,
          conjunto: f.adset_name || null,
          adset_id: f.adset_id || null,
          campana: f.campaign_name || null,
          campaign_id: f.campaign_id || null
        });
        gasto += g;
      }
    }
    const v = { porAnuncio, gasto, desde: since, hasta: until };
    cache.set(clave, { t: Date.now(), v });
    estado.error = null;
    return v;
  } catch (err) {
    estado.error = err.message;
    console.warn('⚠️ [META ADS] No se pudo leer el gasto:', err.message);
    return null;
  }
}

/**
 * Consulta un anuncio específico en Meta Graph API para saber su nombre,
 * conjunto de anuncios (adset) y campaña en tiempo real.
 *
 * Se ejecuta al recibir un primer mensaje de un anuncio para atribuir de
 * inmediato el conjunto al chat.
 */
export async function consultarAnuncioMeta(adId, tokenAlternativo = null) {
  const idLimpio = String(adId || '').replace(/\D/g, '');
  if (!idLimpio || idLimpio.length < 6) return null;

  const { token: adsToken, version, appSecret } = ajustes();
  const tokens = [adsToken, tokenAlternativo].filter(Boolean);
  if (!tokens.length) return null;

  for (const t of tokens) {
    try {
      const url = new URL(`${API}/${version}/${idLimpio}`);
      url.searchParams.set('fields', 'id,name,adset_id,adset{id,name},campaign{id,name}');
      url.searchParams.set('access_token', t);
      if (appSecret && t === adsToken) {
        url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', appSecret).update(t).digest('hex'));
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.id) {
        const datos = {
          nombre: data.name || null,
          conjunto: data.adset?.name || null,
          adsetId: data.adset?.id || data.adset_id || null,
          campana: data.campaign?.name || null,
          campaignId: data.campaign?.id || null
        };
        await anuncioRepository.nombrar(idLimpio, datos);
        return { id: idLimpio, ...datos };
      }
    } catch {
      // Ignorar fallo de este token e intentar con el siguiente
    }
  }

  return null;
}

export function estadoMeta() {
  const { cuentas } = ajustes();
  return {
    conectado: conectado(),
    cuentas: cuentas.map(c => c.replace(/^act_/, '')),
    ultima_sincronizacion: estado.ultimaSincronizacion,
    anuncios_sincronizados: estado.anunciosSincronizados,
    error: estado.error
  };
}

export function olvidarCacheMeta() {
  cache.clear();
}

/** Sincroniza al arrancar y cada hora. */
export function iniciarMetaAds() {
  if (!conectado()) {
    console.log('📣 [META ADS] Sin conectar (faltan META_ADS_TOKEN y META_AD_ACCOUNT_ID). El panel funciona igual, sin gasto por anuncio.');
    return;
  }
  sincronizarNombres();
  if (temporizador) clearInterval(temporizador);
  temporizador = setInterval(sincronizarNombres, SYNC_MS);
  if (typeof temporizador.unref === 'function') temporizador.unref();
}

export const metaAdsService = {
  conectado, sincronizarNombres, gastoPorAnuncio, consultarAnuncioMeta, estadoMeta, olvidarCacheMeta, iniciarMetaAds
};

export default metaAdsService;
