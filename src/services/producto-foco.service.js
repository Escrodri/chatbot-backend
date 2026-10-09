import { query } from '../database/index.js';
import { productRepository } from '../repositories/product.repository.js';
import { orderRepository, posicionEtapa } from '../repositories/order.repository.js';
import { formatoGs } from '../utils/comprobante.util.js';
import { normalizarBump, linksDe } from './producto-textos.js';
import { precioParaPersona } from './precio.service.js';
import {
  intencionExtra,
  pareceEleccion,
  montosDelTexto,
  palabrasDe,
  negadoAntes,
  VENTANA_RESPUESTA_MS
} from './intencion-extra.js';

const formatearMonto = (valor, moneda = 'PYG') => (moneda && moneda !== 'PYG' ? `${moneda} ${Number(valor).toLocaleString('es-PY')}` : formatoGs(valor));

/**
 * De qué producto se está hablando en cada conversación.
 *
 * Con un solo producto no hacía falta preguntárselo a nadie. Con varios, el
 * guion adivinaba en cada mensaje buscando palabras del nombre en el texto, y
 * si no encontraba ninguna agarraba el primero del catálogo. Un "bueno" o la
 * foto del comprobante (una imagen no tiene texto) cambiaban de producto solos:
 * el pago se contaba para el pedido equivocado y se entregaba el libro que no
 * era.
 *
 * Ahora la conversación tiene un producto fijo, que cambia solo por algo que
 * la persona hizo a propósito, en este orden:
 *
 *   1. tocó un botón que lleva el producto adentro ("comprar:12", "prod:12");
 *   2. escribió el nombre de un producto (el mensaje automático del anuncio
 *      "Quiero el PDF de Grandes Historias de la Biblia" es justamente eso);
 *      o nombró el precio de otro producto en un mensaje corto ("el de 19"
 *      en una charla del de 25, si el de 25 no tiene una versión de 19);
 *   3. si no, sigue el que ya tenía la conversación;
 *   4. si mandó una imagen y no tenía ninguno, el de su pedido sin pagar;
 *   5. si el catálogo tiene uno solo, ese;
 *   6. si no, hay que preguntarle cuál quiere. También a quien ya compró y
 *      vuelve a escribir sin nombrar nada: es la oportunidad de mostrarle
 *      los otros materiales.
 */

// Palabras que están en casi todos los nombres y no distinguen un producto
// de otro: con ellas, "quiero el pdf" coincidiría con todo el catálogo.
const COMUNES = new Set([
  'pdf', 'libro', 'libros', 'para', 'colorear', 'pintar', 'material', 'materiales',
  'quiero', 'hola', 'info', 'informacion', 'precio', 'como', 'este', 'esta', 'ese',
  'digital', 'imprimir', 'imprimible', 'ninos', 'nino', 'ninas', 'nina', 'chicos',
  'grandes', 'mejores', 'completo', 'completa', 'desde', 'hasta', 'sobre', 'todo', 'todos',
  'dia', 'dias', 'buen', 'bueno', 'buena', 'buenos', 'buenas', 'tarde', 'tardes',
  'noche', 'noches', 'saludos', 'saludo', 'gracias', 'favor', 'por', 'que', 'con',
  'del', 'las', 'los', 'una', 'uno', 'unas', 'unos', 'mas', 'menos'
]);

function normalizar(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function palabrasClave(p) {
  const base = normalizar(`${p.name} ${(p.slug || '').split('-').join(' ')}`);
  return [...new Set(base.split(' ').filter(w => (w.length >= 3 || /^\d+$/.test(w)) && !COMUNES.has(w)))];
}

function coincideSaludo(texto, saludo) {
  const t = ` ${normalizar(texto)} `;
  const s = normalizar(saludo);
  if (!s || s.length < 4) return false;
  if (t.includes(` ${s} `)) return true;
  const claves = s.split(' ').filter(w => (w.length >= 3 || /^\d+$/.test(w)) && !COMUNES.has(w));
  if (claves.length === 0) return false;
  const aciertos = claves.filter(w => t.includes(` ${w} `)).length;
  return aciertos >= Math.min(2, claves.length);
}

/**
 * El producto que nombra el texto, si nombra a uno solo sin dudas.
 *
 * 1. Primero busca coincidencia con el saludo o frases del anuncio configuradas en el producto.
 * 2. Si no, busca palabras clave del nombre y slug (si una palabra es exclusiva de un producto, 1 acierto alcanza).
 */
export function productoDelTexto(texto, productos) {
  const tLimpio = normalizar(texto);
  if (tLimpio.length < 3) return null;

  // 1. Coincidencia por saludo o frases de anuncio configuradas
  for (const p of productos) {
    const saludo = p.mensajes?.saludo_anuncio;
    if (saludo && coincideSaludo(texto, saludo)) {
      return p;
    }
    const frases = String(p.mensajes?.frases_anuncio || '')
      .split(/[\n,]+/)
      .map(normalizar)
      .filter(f => f.length >= 3);
    for (const f of frases) {
      if (` ${tLimpio} `.includes(` ${f} `)) {
        return p;
      }
    }
  }

  // 2. Coincidencia por palabras clave del nombre / slug
  const t = ` ${tLimpio} `;
  const puntajes = productos.map(p => {
    const claves = palabrasClave(p);
    const acierto = claves.filter(w => t.includes(` ${w} `)).length;
    const nombreEntero = normalizar(p.name).length > 6 && t.includes(` ${normalizar(p.name)} `);
    const tieneExclusiva = claves.some(w => t.includes(` ${w} `) && !productos.some(otro => otro.id !== p.id && palabrasClave(otro).includes(w)));
    const minimo = tieneExclusiva ? 1 : Math.min(2, claves.length || 1);
    return {
      p,
      acierto,
      ok: nombreEntero || (claves.length > 0 && acierto >= minimo),
      extra: nombreEntero ? 100 : (tieneExclusiva ? 50 : 0)
    };
  }).filter(x => x.ok).sort((a, b) => (b.acierto + b.extra) - (a.acierto + a.extra));

  if (!puntajes.length) return null;
  if (puntajes[1] && (puntajes[1].acierto + puntajes[1].extra) === (puntajes[0].acierto + puntajes[0].extra)) return null;
  return puntajes[0].p;
}

/**
 * El id de producto que viaja dentro de un botón: "comprar:12", "prod:12".
 * Los botones del extra llevan el producto principal ("bump_si:12"): la
 * respuesta a la oferta es sobre ese pedido.
 */
export function productoDelBoton(botonId) {
  const m = String(botonId || '').match(/^(comprar|ver_paginas|prod|bump_si|bump_no):(\d+)$/);
  return m ? Number(m[2]) : null;
}

/**
 * Los precios por los que se vende un producto: el de lista, el de
 * recuperación y, si tiene un extra encendido, el total con el extra.
 */
function preciosDe(p) {
  const lista = Number(p.price) || 0;
  const salida = [lista];
  if (p.precio_recuperacion !== null && p.precio_recuperacion !== undefined) salida.push(Number(p.precio_recuperacion));
  const { bump } = normalizarBump(p.bump);
  if (bump.activo && bump.precio) salida.push(...salida.map(v => v + Number(bump.precio)));
  return [...new Set(salida.filter(v => v > 0))];
}

/**
 * "el de 19" cuando la charla es de otro producto: el producto que cuesta
 * eso, si hay uno solo y el de la charla no tiene una versión con ese precio.
 *
 * Solo con mensajes cortos que afirman: "tengo 19 mil nomás" o "¿el de 19 qué
 * trae?" no cambian de producto.
 *
 * @param {string} texto
 * @param {object[]} productos Catálogo (filas de la base)
 * @param {number|null} focoId El producto que ya tiene la charla
 * @returns {object|null}
 */
export function productoDelMonto(texto, productos, focoId = null) {
  if (!pareceEleccion(texto, { maxPalabras: 8 })) return null;
  const monedas = new Set(productos.map(p => p.currency || 'PYG'));
  if (monedas.size !== 1) return null;

  const ignorar = [...productos.map(p => p.name).join(' ').matchAll(/\d+/g)].map(m => Number(m[0]));
  const palabras = palabrasDe(texto);
  const montos = montosDelTexto(texto, { moneda: [...monedas][0], ignorar })
    .filter(m => !negadoAntes(palabras, m.posicion))
    .map(m => m.monto);
  if (montos.length !== 1) return null;
  const monto = montos[0];

  const foco = productos.find(p => Number(p.id) === Number(focoId));
  if (foco && preciosDe(foco).includes(monto)) return null;

  const candidatos = productos.filter(p => Number(p.id) !== Number(focoId) && Number(p.price) === monto);
  return candidatos.length === 1 ? candidatos[0] : null;
}

/**
 * Qué versión eligió, si el producto tiene un extra y lo que escribió elige
 * una: "el de 35", "quiero el plus", "solo el plan". Ver intencion-extra.js.
 *
 * No elige nada (null) cuando:
 *   - el producto no tiene un extra que se pueda vender hoy;
 *   - todavía no se le presentó el producto: primero va la presentación;
 *   - ya mandó un comprobante o ya pagó: cambiar de versión cambiaría lo que pagó;
 *   - ya está en esa versión y ya tiene los datos: repetírselos no suma nada.
 *
 * @returns {Promise<{ intencion: string|null, motivo: string }|null>}
 */
export async function intencionDe({ conversationId, producto, texto }) {
  const { bump } = normalizarBump(producto?.bump);
  if (!bump.activo || !bump.product_id || !bump.precio) return null;
  if (Number(bump.product_id) === Number(producto.id)) return null;

  const pedido = await orderRepository.findByConversationAndProduct(conversationId, producto.id);
  if (!pedido || posicionEtapa(pedido.etapa) <= posicionEtapa('entro')) return { intencion: null, motivo: 'sin_presentar' };
  if (pedido.status !== 'interesado') return { intencion: null, motivo: 'pedido_en_curso' };

  const extra = await productRepository.findById(bump.product_id);
  if (!extra || extra.is_active === false || !linksDe(extra).length) return null;

  const lista = Number(producto.price) || 0;
  let precio = lista;
  try {
    const pp = await precioParaPersona({ conversationId, productId: producto.id, precioLista: lista, momentos: [Date.now()] });
    precio = Number(pp.precio) || lista;
  } catch {
    // Sin ofertas legibles, el de lista.
  }

  const bumpAt = pedido.bump_at ? new Date(pedido.bump_at).getTime() : 0;
  const r = intencionExtra(texto, {
    precio,
    lista,
    precioExtra: bump.precio,
    moneda: producto.currency || 'PYG',
    nombreProducto: producto.name,
    nombreExtra: extra.name,
    botonSi: bump.boton_si,
    bumpEstado: pedido.bump_estado || null,
    ofrecidoReciente: Boolean(bumpAt) && Date.now() - bumpAt < VENTANA_RESPUESTA_MS
  });
  if (!r.intencion) return r;

  const yaTieneDatos = posicionEtapa(pedido.etapa) >= posicionEtapa('recibio_datos');
  if (yaTieneDatos) {
    if (r.intencion === 'comprar') return { intencion: null, motivo: 'ya_tiene_datos' };
    if (r.intencion === 'extra_si' && pedido.bump_estado === 'aceptado') return { intencion: null, motivo: 'ya_estaba' };
    if (r.intencion === 'extra_no' && pedido.bump_estado !== 'aceptado') return { intencion: null, motivo: 'ya_estaba' };
  }
  return r;
}

/** Hasta 24 letras para el título de una opción de lista de WhatsApp. */
export function nombreCorto(nombre, max = 24) {
  const base = String(nombre || '').split(/\s+[—–-]\s+|\s*\(/)[0].trim() || String(nombre || '').trim();
  if (base.length <= max) return base;
  const corte = base.slice(0, max - 1);
  const espacio = corte.lastIndexOf(' ');
  return `${(espacio > 8 ? corte.slice(0, espacio) : corte).trim()}…`;
}

async function catalogoDe(conv) {
  // Los que solo se venden como extra de otro no se ofrecen sueltos.
  const todos = await productRepository.list({ soloActivos: true, soloVendibles: true });
  const equipo = conv.team_id || null;
  return todos.filter(p => !equipo || !p.team_id || p.team_id === equipo);
}

async function guardarFoco(conversationId, productId) {
  await query(
    `UPDATE conversations SET producto_foco_id = $1 WHERE id = $2 AND producto_foco_id IS DISTINCT FROM $1`,
    [productId, conversationId]
  );
}

/** El pedido sin pagar más reciente de la conversación, si hay uno. */
async function pedidoPendiente(conversationId) {
  const { rows } = await query(
    `SELECT product_id FROM orders
      WHERE conversation_id = $1 AND product_id IS NOT NULL
        AND status IN ('interesado', 'comprobante_recibido')
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [conversationId]
  );
  return rows[0]?.product_id || null;
}

/** ¿Ya pagó el pedido de este producto? */
async function yaPagado(conversationId, productId) {
  const { rows } = await query(
    `SELECT 1 FROM orders WHERE conversation_id = $1 AND product_id = $2
        AND status IN ('pagado', 'entregado') LIMIT 1`,
    [conversationId, productId]
  );
  return rows.length > 0;
}

const NO_ES_NOMBRE = /^(solo|dios|amor|bendecida|bendecido|mama|mami|papa|papi|hola|feliz|princesa|reina|negra|negro|gorda|flaca|gordo|lic|dra|dr|sra|sr|profe|senora|señora|la|el|mi|tu|su|yo|fe|ser|by|the|mrs|mr)$/i;

/** El primer nombre, si parece un nombre: nada de ".", emojis ni "solo Dios juzga". */
export function nombrePila(nombre) {
  const n = String(nombre || '').trim();
  if (!n || /^usuario\s*\d*$/i.test(n)) return '';
  const w = (n.split(/\s+/)[0] || '').replace(/[^\p{L}'-]/gu, '');
  if (w.replace(/[^\p{L}]/gu, '').length < 2 || NO_ES_NOMBRE.test(w)) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function armarPregunta(productos, { saludo = 'Hola', nombre = '', esImagen = false } = {}) {
  const lineas = productos.map(p => `• *${p.name}* — ${formatearMonto(p.price, p.currency)}`).join('\n');
  const texto = esImagen
    ? `¡Gracias! 🙌 ¿Para cuál de estos materiales es el pago?\n\n${lineas}\n\nElegilo acá abajo y mandame la captura de nuevo, así lo reviso para ese.`
    : `${saludo}${nombre ? `, ${nombre}` : ''}! 👋 ¿Cuál de estos materiales te interesa?\n\n${lineas}`;

  // Hasta tres entran como botones, que se tocan sin abrir nada. Más de tres
  // van en una lista: WhatsApp no permite más botones que eso.
  if (productos.length <= 3) {
    return {
      text: texto,
      buttons: productos.map(p => ({ id: `prod:${p.id}`, title: nombreCorto(p.mensajes?.nombre_corto || p.name, 20) }))
    };
  }
  return {
    text: texto,
    lista: {
      boton: 'Ver materiales',
      opciones: productos.slice(0, 10).map(p => ({
        id: `prod:${p.id}`,
        title: nombreCorto(p.mensajes?.nombre_corto || p.name, 24),
        description: `${formatearMonto(p.price, p.currency)} · ${p.name}`.slice(0, 72)
      }))
    }
  };
}

/**
 * De qué producto se habla y, si el producto tiene un extra, qué versión
 * eligió con lo que escribió (`intencion`: extra_si, extra_no, comprar o null).
 *
 * @param {{ conversationId:number, texto?:string, botonId?:string, esImagen?:boolean,
 *           saludo?:string, nombre?:string }} p
 * @returns {Promise<{ product_id:number|null, origen:string, elegir:boolean, pregunta?:object,
 *           cantidad:number, intencion?:string|null, intencion_motivo?:string }>}
 */
export async function resolverProducto(p) {
  const r = await resolverSoloProducto(p);
  if (r.product_id) {
    try {
      r.ya_pagado = await yaPagado(p.conversationId, r.product_id);
    } catch {
      r.ya_pagado = false;
    }
  } else {
    r.ya_pagado = false;
  }
  // Un botón ya dice lo que eligió, y una imagen no tiene texto.
  if (!r.product_id || p.esImagen || p.botonId || !String(p.texto || '').trim()) return r;
  try {
    const producto = await productRepository.findById(r.product_id);
    const i = producto ? await intencionDe({ conversationId: p.conversationId, producto, texto: p.texto }) : null;
    if (i) {
      r.intencion = i.intencion;
      r.intencion_motivo = i.motivo;
    }
  } catch (err) {
    // Si no se puede leer la elección, la charla sigue como antes: la IA contesta.
    console.warn(`[producto-foco] No se pudo leer qué versión eligió: ${err.message}`);
  }
  return r;
}

async function resolverSoloProducto({ conversationId, texto = '', botonId = '', esImagen = false, saludo, nombre }) {
  const { rows } = await query(
    `SELECT c.id, c.producto_foco_id, ch.team_id
       FROM conversations c LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.id = $1`,
    [conversationId]
  );
  const conv = rows[0];
  if (!conv) return { product_id: null, origen: 'sin_conversacion', elegir: false, cantidad: 0 };

  const productos = await catalogoDe(conv);
  const existe = (id) => productos.some(p => Number(p.id) === Number(id));
  const listo = async (id, origen) => {
    await guardarFoco(conversationId, Number(id));
    return { product_id: Number(id), origen, elegir: false, cantidad: productos.length };
  };

  const deBoton = productoDelBoton(botonId);
  if (deBoton && existe(deBoton)) return listo(deBoton, 'boton');

  if (!esImagen) {
    const delTexto = productoDelTexto(texto, productos);
    if (delTexto) return listo(delTexto.id, 'texto');

    // "el de 19" en una charla del de 25: el que cuesta eso.
    const delMonto = productoDelMonto(texto, productos, conv.producto_foco_id);
    if (delMonto) return listo(delMonto.id, 'monto');
  }

  if (conv.producto_foco_id && existe(conv.producto_foco_id)) {
    // Una captura de pago cuando el producto en foco ya está pagado y hay
    // otro pedido esperando: el pago es para el que falta.
    if (esImagen && await yaPagado(conversationId, conv.producto_foco_id)) {
      const pendiente = await pedidoPendiente(conversationId);
      if (pendiente && existe(pendiente)) return listo(pendiente, 'pedido_pendiente');
    }
    return { product_id: Number(conv.producto_foco_id), origen: 'conversacion', elegir: false, cantidad: productos.length };
  }

  const pendiente = await pedidoPendiente(conversationId);
  if (pendiente && existe(pendiente)) return listo(pendiente, 'pedido_pendiente');

  if (productos.length === 1) return listo(productos[0].id, 'unico');

  if (!productos.length) return { product_id: null, origen: 'catalogo_vacio', elegir: false, cantidad: 0 };

  return {
    product_id: null,
    origen: 'preguntar',
    elegir: true,
    cantidad: productos.length,
    pregunta: armarPregunta(productos, { saludo: saludo || 'Hola', nombre: nombrePila(nombre), esImagen })
  };
}

export default { resolverProducto, intencionDe, productoDelTexto, productoDelMonto, productoDelBoton, nombreCorto, nombrePila };
