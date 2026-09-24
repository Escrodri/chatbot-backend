import { ofertaRepository } from '../repositories/oferta.repository.js';
import { envConfig } from '../config/env.config.js';
import { formatoGs } from '../utils/comprobante.util.js';

/**
 * Qué precio le corresponde a una persona, en un momento dado.
 *
 * Con una sola lista de precios la pregunta no existía. Con remarketing sí:
 * el mismo material sale 19.000 para quien escribe hoy desde un anuncio
 * cualquiera y 15.000 para quien vuelve desde el anuncio de la promo, y el
 * comprobante de 15.000 es un pago completo para uno y un pago a medias para
 * el otro. La foto es idéntica; lo que cambia es quién la manda y cuándo.
 *
 * Las reglas, todas en este archivo:
 *
 *   - Precios posibles: el de lista, las ofertas que recibió esa persona
 *     (campaña por anuncio o palabra clave, o el descuento del seguimiento),
 *     y las campañas abiertas a todos. Gana el más bajo que esté vigente.
 *
 *   - "Vigente" se mira en DOS momentos: cuando hizo la transferencia (la
 *     hora que figura en el comprobante) y ahora. Alcanza con uno. Así el que
 *     transfirió a las 23:50 del último día y manda la captura a la mañana
 *     sigue teniendo la promo, porque pagó dentro de ella.
 *
 *   - Cada oferta tiene gracia: unas horas de tolerancia después de vencer
 *     que no se le anuncian a nadie. La de cada campaña la define la campaña;
 *     el resto usa OFERTA_GRACIA_HORAS.
 *
 *   - Una campaña apagada no existe: ni da ofertas nuevas ni respeta las que
 *     ya dio. Si se la apagó es porque algo estaba mal —el precio mal tipeado
 *     es el caso típico— y en ese caso lo último que se quiere es que siga
 *     cobrando ese precio.
 *
 *   - Un precio "especial" más alto que el de lista se ignora. Sería un error
 *     de carga, y cobrarlo sería cobrar de más con la excusa de una promo.
 */

/** Minutos de tolerancia antes del inicio: el reloj del banco y el nuestro no coinciden al segundo. */
const TOLERANCIA_INICIO_MIN = 10;

function ms(x) {
  if (!x) return null;
  const t = x instanceof Date ? x.getTime() : new Date(x).getTime();
  return Number.isNaN(t) ? null : t;
}

function dentro(momento, desde, hasta, graciaHoras) {
  const t = ms(momento);
  if (t === null) return false;
  const d = ms(desde);
  const h = ms(hasta);
  const inicio = d === null ? -Infinity : d - TOLERANCIA_INICIO_MIN * 60000;
  const fin = h === null ? Infinity : h + Math.max(0, Number(graciaHoras) || 0) * 3600000;
  return t >= inicio && t <= fin;
}

/** Fecha y hora de Paraguay (UTC-3), como se le escribe a una persona: "30/09 a las 23:59". */
export function fechaParaguay(fecha) {
  const t = ms(fecha);
  if (t === null) return '';
  const d = new Date(t - 3 * 3600000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm} a las ${hh}:${mi}`;
}

function etiquetaOferta(o) {
  if (o.origen === 'campana') return `campaña "${o.campana_nombre || '#' + o.campana_id}"`;
  if (o.origen === 'recuperacion') return 'descuento del seguimiento';
  return o.detalle || 'oferta a mano';
}

/**
 * @param {object} p
 * @param {number} p.conversationId
 * @param {number|null} p.productId
 * @param {number} p.precioLista
 * @param {Array<Date|number|null>} p.momentos Cuándo mirar: la transferencia, ahora…
 * @returns {Promise<{precio:number, lista:number, es_promo:boolean, origen:string, etiqueta:string,
 *   oferta_id:number|null, campana_id:number|null, hasta:string|null, hasta_texto:string,
 *   vencidas:Array, sin_invitacion:Array}>}
 */
export async function precioParaPersona({ conversationId, productId = null, precioLista, momentos = [] }) {
  const lista = Number(precioLista) || 0;
  const cuando = (momentos.length ? momentos : [Date.now()]).filter(m => ms(m) !== null);
  const ahora = Date.now();
  const graciaGeneral = Number(envConfig.ofertas?.graciaHoras ?? 24);

  const base = {
    precio: lista,
    lista,
    es_promo: false,
    origen: 'lista',
    etiqueta: 'precio de lista',
    oferta_id: null,
    campana_id: null,
    hasta: null,
    hasta_texto: '',
    vencidas: [],
    sin_invitacion: []
  };

  if (!lista) return base;

  let ofertas = [];
  let campanas = [];
  try {
    [ofertas, campanas] = await Promise.all([
      ofertaRepository.deConversacion(conversationId, productId),
      ofertaRepository.campanasDelProducto(productId)
    ]);
  } catch (err) {
    // Sin poder leer las ofertas, lo seguro es el precio de lista: se cobra
    // de menos a nadie y, si alguien tenía promo, el faltante queda marcado
    // para revisar en vez de regalarse.
    console.warn('⚠️ [PRECIO] No se pudieron leer las ofertas, se usa el de lista:', err.message);
    return base;
  }

  const candidatos = [];
  const vencidas = [];

  for (const o of ofertas) {
    if (o.campana_id && o.campana_activa === false) continue;
    if (!(o.precio > 0) || o.precio >= lista) continue;

    const gracia = o.campana_id ? Number(o.gracia_horas ?? graciaGeneral) : graciaGeneral;
    const vale = cuando.some(m => dentro(m, o.desde, o.hasta, gracia));
    const item = {
      precio: o.precio,
      origen: o.origen,
      etiqueta: etiquetaOferta(o),
      oferta_id: o.id,
      campana_id: o.campana_id || null,
      hasta: o.hasta || null
    };

    if (vale) candidatos.push(item);
    else if (o.hasta && ms(o.hasta) < ahora) vencidas.push(item);
  }

  for (const c of campanas) {
    if (!(c.precio > 0) || c.precio >= lista) continue;
    const vale = cuando.some(m => dentro(m, c.desde, c.hasta, c.gracia_horas ?? graciaGeneral));

    if (c.alcance === 'todos') {
      const item = {
        precio: c.precio,
        origen: 'campana',
        etiqueta: `campaña "${c.nombre}" (para todos)`,
        oferta_id: null,
        campana_id: c.id,
        hasta: c.hasta
      };
      if (vale) candidatos.push(item);
      else if (ms(c.hasta) < ahora) vencidas.push(item);
    } else if (vale && !ofertas.some(o => o.campana_id === c.id)) {
      // Campaña para invitados que está corriendo, y esta persona no entró.
      // No le da nada: sirve para explicar un pago "de promo" sin promo.
      base.sin_invitacion.push({ precio: c.precio, campana_id: c.id, etiqueta: `campaña "${c.nombre}"` });
    }
  }

  base.vencidas = vencidas;
  if (!candidatos.length) return base;

  // El más barato; si empatan, el que dura más, para decirle la fecha más
  // generosa.
  candidatos.sort((a, b) => a.precio - b.precio || (ms(b.hasta) ?? Infinity) - (ms(a.hasta) ?? Infinity));
  const mejor = candidatos[0];

  return {
    ...base,
    precio: mejor.precio,
    es_promo: true,
    origen: mejor.origen,
    etiqueta: mejor.etiqueta,
    oferta_id: mejor.oferta_id,
    campana_id: mejor.campana_id,
    hasta: mejor.hasta ? new Date(mejor.hasta).toISOString() : null,
    hasta_texto: mejor.hasta ? fechaParaguay(mejor.hasta) : ''
  };
}

/** Texto para el comprobante y el pedido: qué precio se usó y por qué. */
export function describirPrecio(p) {
  if (!p || !p.es_promo) return `lista ${formatoGs(p?.lista || p?.precio || 0)}`;
  return `${formatoGs(p.precio)} por ${p.etiqueta}${p.hasta_texto ? `, vale hasta el ${p.hasta_texto}` : ''} (lista ${formatoGs(p.lista)})`;
}

function normalizarTexto(t) {
  return String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Las campañas para invitados en curso, guardadas medio minuto.
 *
 * Se consultan con CADA mensaje que entra. Con un anuncio andando pueden ser
 * cientos por hora, y la lista cambia solo cuando alguien crea o apaga una
 * campaña desde el panel, que la borra al instante con `olvidarCampanas`.
 */
let enCache = { hasta: 0, filas: null };
const CACHE_MS = 30 * 1000;

async function campanasEnCurso() {
  if (enCache.filas && enCache.hasta > Date.now()) return enCache.filas;
  const filas = await ofertaRepository.campanasInvitadosEnCurso();
  enCache = { hasta: Date.now() + CACHE_MS, filas };
  return filas;
}

/** Se llama al crear, editar o apagar una campaña. */
export function olvidarCampanas() {
  enCache = { hasta: 0, filas: null };
}

/** Los ids de anuncio de una campaña, como lista de strings de dígitos. */
export function idsDeAnuncios(texto) {
  return String(texto || '')
    .split(/[^0-9]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 5);
}

/**
 * ¿Este mensaje mete a la persona en alguna campaña?
 *
 * Se llama con cada mensaje que entra. Dos maneras de entrar:
 *
 *   - Por el anuncio: Meta manda el id del anuncio en el mensaje cuando la
 *     persona llega tocándolo. Es la forma segura, porque no se puede fingir
 *     desde el chat.
 *   - Por la palabra clave: el texto que el anuncio deja escrito en el
 *     mensaje ("Quiero la promo PROMO15"). Sirve cuando Meta no manda el id
 *     —pasa— y para campañas fuera de Meta (un estado de WhatsApp, un grupo).
 *     Es más débil: cualquiera que conozca la palabra entra. Para una promo de
 *     4.000 guaraníes es un riesgo razonable, y queda anotado de dónde entró.
 *
 * Nunca lanza.
 *
 * @returns {Promise<object[]>} Las ofertas nuevas que se crearon
 */
export async function detectarCampana({ conversationId, adId = null, texto = '' }) {
  if (!conversationId) return [];
  try {
    const campanas = (await campanasEnCurso())
      // La caché puede tener una campaña que venció en los últimos segundos.
      .filter(c => ms(c.desde) <= Date.now() && ms(c.hasta) >= Date.now());
    if (!campanas.length) return [];

    const mensaje = normalizarTexto(texto);
    const creadas = [];

    for (const c of campanas) {
      const porAnuncio = adId && idsDeAnuncios(c.anuncios).includes(String(adId).replace(/[^0-9]/g, ''));
      const palabra = normalizarTexto(c.palabra_clave);
      const porPalabra = palabra.length >= 4 && ` ${mensaje} `.includes(` ${palabra} `);
      if (!porAnuncio && !porPalabra) continue;

      const oferta = await ofertaRepository.crearOferta({
        conversationId,
        productId: c.product_id,
        precio: c.precio,
        origen: 'campana',
        campanaId: c.id,
        detalle: porAnuncio ? `llegó por el anuncio ${adId}` : `escribió "${c.palabra_clave}"`,
        hasta: c.hasta
      });

      if (oferta) {
        creadas.push(oferta);
        console.log(
          `🏷️ [CAMPAÑA] Conversación #${conversationId} entró a "${c.nombre}" ` +
          `(${porAnuncio ? 'anuncio ' + adId : 'palabra clave'}): ${formatoGs(c.precio)} hasta ${fechaParaguay(c.hasta)}.`
        );
      }
    }
    return creadas;
  } catch (err) {
    console.warn('⚠️ [CAMPAÑA] No se pudo revisar si el mensaje entra a una campaña:', err.message);
    return [];
  }
}

/**
 * Anota el descuento que ofreció el seguimiento, recién cuando el mensaje
 * salió de verdad.
 *
 * Antes el descuento dependía del escalón del seguimiento, y el escalón sube
 * también cuando el mensaje NO se manda —ventana cerrada, horario de
 * silencio—. Resultado: a gente a la que nunca se le ofreció nada se le
 * cobraba 15.000. Ahora existe solo si se mandó, y vence.
 */
export async function registrarOfertaRecuperacion({ conversationId, productId, precio, nivel }) {
  try {
    const horas = Number(envConfig.ofertas?.recuperacionHoras ?? 72);
    return await ofertaRepository.crearOferta({
      conversationId,
      productId,
      precio,
      origen: 'recuperacion',
      detalle: `mensaje de seguimiento, escalón ${nivel}`,
      hasta: new Date(Date.now() + horas * 3600000)
    });
  } catch (err) {
    console.warn('⚠️ [RECUPERACION] No se pudo anotar la oferta del seguimiento:', err.message);
    return null;
  }
}

export const precioService = {
  olvidarCampanas,
  precioParaPersona,
  describirPrecio,
  detectarCampana,
  registrarOfertaRecuperacion,
  idsDeAnuncios,
  fechaParaguay
};

export default precioService;
